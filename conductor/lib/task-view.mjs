// lib/task-view.mjs — 「这个任务现在怎么样了」的唯一聚合口径：CLI（status / show）与看板共用。
//
// 只读盘，不写盘，不推进任何东西。回答人最关心的几件事，且每一件都能追到案卷里的出处：
//   当前目标与计划（router 的工作记忆）、活动的 subagent、做完了什么 / 还剩什么（委派台账 +
//   review 覆盖）、卡在哪里、最近为什么调整计划、花了多少 / 还剩多少额度、摘要的状态与版本。
// 以及一个明确的**阶段**——不再只有一个长期不变的「运行中」：
//   running                 运行中：判断型角色在工作（router / spec / digest / reviewer）
//   waiting_result          等待结果：执行者在跑（maker / worker），或 precommit 在跑
//   interrupted_recoverable 可恢复中断：上一个 runner 退出时有事没收尾；`conductor run` 会先恢复再继续
//   ready                   待运行：可以推进，但此刻没有 runner 在跑
//   waiting_resource        等待资源：平台限额 / 本次运行额度 / 调度槽位
//   waiting_human           等待人：spec / merge / help 闸，或人暂停了它
//   terminated              已终止：完成、放弃、预算 / 轮次用尽、保险丝
// 每个停下来的阶段都带 reason（为什么停）、retained（留下了什么）、next（怎么继续）。

import fs from 'node:fs';
import path from 'node:path';
import * as state from './state.mjs';
import { composeRecords } from './records.mjs';
import { needPrecommit, needReview } from './version-gate.mjs';
import { currentSpec, shortSha } from './spec-version.mjs';
import { digestStateFor } from './digest-store.mjs';
import { latestAssignments, listLedgers, resumableSpawn } from './dispatch-ledger.mjs';
import { reviewCoverage, renderCoverage } from './review-ledger.mjs';
import { unfinishedSpawns } from './recovery.mjs';
import { processState } from './proc.mjs';
import { readRunSession } from './run-session.mjs';
import { lockDirPath } from './lock.mjs';
import { git } from './git.mjs';

const JUDGING_ROLES = new Set(['router', 'spec', 'digest', 'reviewer']);

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function revParse(repo, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', ref], repo);
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

function runnerInfo(cfg) {
  const info = readJsonIf(path.join(lockDirPath(cfg.stateDir), 'info.json'));
  if (!info?.pid) return { active: false, pid: null };
  const st = processState({ pid: Number(info.pid), pid_started: info.pid_started ?? null });
  return { active: st === 'alive' || st === 'unknown', pid: info.pid };
}

function localTime(unixSec) {
  return Number.isFinite(unixSec) ? new Date(unixSec * 1000).toLocaleString() : '未知';
}

function phaseOf(cfg, ts, ctx) {
  const id = ts.id;
  const rt = ts.runtime;
  const retainedAll = `案卷 dossier/${id}/ 与任务分支 task/${id} 原样保留`;
  if (ts.box === 'done') return { code: 'terminated', label: '已完成', reason: '已合并并归档', retained: `案卷 dossier/${id}/`, next: null };
  if (ts.box === 'failed') {
    const type = rt.last_failure_type ?? 'unknown';
    if (type === 'rate_limited') {
      const at = rt.rate_limit?.resets_at;
      return {
        code: 'waiting_resource', label: '等待资源（平台限额）',
        reason: `命中 ${rt.rate_limit?.type ?? '未知'} 限额，重置时刻 ${localTime(at)}`,
        retained: retainedAll, next: `到点后 conductor retry ${id}（或 retry --rate-limited），再 conductor run`,
      };
    }
    const why = {
      budget_exhausted: [`任务预算用尽（已花 $${Number(rt.spent_usd ?? 0).toFixed(2)} ≥ budgetUsd=$${cfg.budgetUsd}）`, `调高 conductor.config.json 的 budgetUsd 后 conductor retry ${id}`],
      round_cap: [`轮次上限用尽（${rt.current_round} ≥ maxRoundsPerTask=${cfg.maxRoundsPerTask}）`, `调高 maxRoundsPerTask 后 conductor retry ${id}`],
      fuse_no_progress: ['保险丝：同因失败连击，或连续多轮没有任何硬进展', `看 timeline 末尾的原因，必要时改 brief / spec，再 conductor retry ${id}`],
      abandoned: ['已放弃（worktree 与任务分支已清理）', `conductor retry ${id} 可回到 ROUTING 重新开始`],
    }[type] ?? [`收箱：${type}`, '此类型不可自动恢复，见 timeline'];
    return { code: 'terminated', label: `已终止（${type}）`, reason: why[0], retained: type === 'abandoned' ? `案卷 dossier/${id}/` : retainedAll, next: why[1] };
  }
  if (ctx.paused) {
    return { code: 'waiting_human', label: '等待人（已暂停）', reason: '人要求暂停；不派工、不花钱', retained: retainedAll, next: `conductor unpause ${id}` };
  }
  if (rt.stage === 'AWAIT_HUMAN') {
    const kind = rt.awaiting?.kind ?? '?';
    const gate = readJsonIf(state.dossierPath(cfg, id, `human-r${rt.awaiting?.round}.json`));
    const next = kind === 'help'
      ? `conductor resume ${id} [--notes "…"]`
      : `conductor approve ${id} [--notes "…"] ｜ conductor reject ${id} --notes "…"`;
    return { code: 'waiting_human', label: `等待人（${kind} 闸）`, reason: gate?.summary ?? `${kind} 闸`, retained: retainedAll, next };
  }
  if (rt.stage !== 'ROUTING') {
    return { code: 'terminated', label: `遗留任务（${rt.stage}）`, reason: '旧状态机的任务，只读', retained: `案卷 dossier/${id}/`, next: null };
  }
  const alive = ctx.active.filter((a) => a.process === 'alive' || a.process === 'unknown');
  if (ctx.runner.active && alive.length > 0) {
    const judging = alive.every((a) => JUDGING_ROLES.has(a.role));
    return judging
      ? { code: 'running', label: '运行中', reason: `${alive.map((a) => a.name).join(', ')} 在工作`, retained: null, next: null }
      : { code: 'waiting_result', label: '等待结果', reason: `${alive.length} 个执行者在跑：${alive.map((a) => a.name).join(', ')}`, retained: null, next: null };
  }
  const precommitLock = readJsonIf(path.join(cfg.stateDir, '.precommit.lock', 'info.json'));
  if (ctx.runner.active && precommitLock?.task_id === id) {
    return { code: 'waiting_result', label: '等待结果', reason: 'precommit 在合并候选上跑 build / 测试', retained: null, next: null };
  }
  if (!ctx.runner.active && (ctx.active.length > 0 || ctx.openDispatch.length > 0)) {
    return {
      code: 'interrupted_recoverable', label: '可恢复中断',
      reason: `上一个 runner 退出时有事没收尾：${[...ctx.active.map((a) => `${a.name}（进程 ${a.process}）`), ...ctx.openDispatch.map((n) => `dispatch r${n} 未关账`)].join('；')}`,
      retained: `${retainedAll}；已落盘的改动与增量 log 都在`,
      next: 'conductor run（启动时先收割残留、提交并集成已有工作、对账，再继续）；conductor recover --dry-run 可先看会做什么',
    };
  }
  if (ctx.runner.active) {
    return { code: 'waiting_resource', label: '等待资源（调度槽位）', reason: 'runner 在跑，本任务在等调度 / spawn 槽位或下一批次', retained: null, next: null };
  }
  const session = ctx.runSession;
  if (session?.end_reason === 'run_budget_exhausted') {
    return { code: 'waiting_resource', label: '等待资源（运行额度）', reason: `上一次运行的额度 runBudgetUsd=$${session.limit_usd} 已用尽`, retained: retainedAll, next: '再次 conductor run 即一次新的授权（或调高 runBudgetUsd）' };
  }
  if (session != null && session.ended_at == null) {
    return { code: 'interrupted_recoverable', label: '可恢复中断', reason: '上一次运行没有正常收尾（runner 崩溃或被强杀）', retained: retainedAll, next: 'conductor run（会接管上一次的运行账本，额度不清零）' };
  }
  return { code: 'ready', label: '待运行', reason: '可以继续推进，但此刻没有 runner 在跑', retained: retainedAll, next: 'conductor run --continuous（或 --watch）' };
}

function phaseContext(cfg, ts) {
  const id = ts.id;
  const active = ts.box === 'queue' ? unfinishedSpawns(cfg, id).map((u) => ({
    name: `${u.base} r${u.round}`,
    role: u.record.role ?? u.base,
    key: u.record.key ?? null,
    profile: u.record.profile ?? null,
    title: u.record.title ?? null,
    started: u.record.started,
    pid: u.record.pid ?? null,
    process: u.record.pid != null ? processState({ pid: Number(u.record.pid), pid_started: u.record.pid_started ?? null }) : 'dead',
  })) : [];
  const ledgers = listLedgers(cfg, id); // 收箱 / 完成的任务也要看得到它的委派历史
  return {
    ledgers,
    ctx: {
      active,
      openDispatch: ledgers.filter((l) => l.closed !== true).map((l) => l.round),
      runner: runnerInfo(cfg),
      runSession: readRunSession(cfg),
      paused: fs.existsSync(path.join(ts.dir, 'PAUSED')),
    },
  };
}

/**
 * 只要阶段（任务表 / 看板卡片用）：不起 git 子进程、不合成记录、不算 review 覆盖率。
 * 看板每 1.5s 轮询一次且不缓存——整份视图里每个任务两次 `git rev-parse` 的代价在这里付不起。
 */
export function buildTaskPhase(cfg, ts) {
  const { ctx } = phaseContext(cfg, ts);
  return { ...phaseOf(cfg, ts, ctx), paused: ctx.paused };
}

/** 任务视图。ts 来自 state.readTaskState / listTaskStates。 */
export function buildTaskView(cfg, ts) {
  const id = ts.id;
  const dossier = state.dossierPath(cfg, id);
  const records = composeRecords(cfg, id, { planActive: ts.runtime.plan_active === true });
  const repo = ts.task?.targetRepo ?? cfg.targetRepo;
  const head = ts.box === 'queue' ? revParse(repo, `task/${id}`) : null;
  const base = ts.box === 'queue' ? revParse(repo, ts.task?.baseBranch ?? 'main') : null;

  const spec = currentSpec(cfg, ts);
  const digest = spec ? digestStateFor(cfg, id, spec) : null;
  const acIds = spec ? state.enumerateAcceptanceCriteria(spec.text).map((a) => a.ac_id) : [];
  const coverage = spec && ts.runtime.spec_approved === true
    ? reviewCoverage({ dossierDir: dossier, records, head, specSha: spec.sha256, acIds })
    : undefined;

  const { ctx, ledgers } = phaseContext(cfg, ts);
  const active = ctx.active;

  const notes = readJsonIf(path.join(dossier, 'router-notes.json'));
  const decisions = records.filter((r) => r.role === 'router' && r.product === 'ok').slice(-3)
    .map((r) => ({ round: r.round, action: r.action, summary: r.summary }));
  const digestCost = records.filter((r) => r.role === 'digest').reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const routerState = readJsonIf(path.join(dossier, 'router-state.json'));

  return {
    id,
    title: ts.task?.title ?? null,
    box: ts.box,
    stage: ts.runtime.stage,
    awaiting: ts.runtime.awaiting ?? null,
    paused: ctx.paused,
    phase: phaseOf(cfg, ts, ctx),
    objective: notes?.objective ?? null,
    plan: Array.isArray(notes?.plan) ? notes.plan : [],
    open_questions: Array.isArray(notes?.questions) ? notes.questions.filter((q) => q.status !== 'answered') : [],
    last_plan_change: Array.isArray(notes?.changelog) && notes.changelog.length > 0 ? notes.changelog[notes.changelog.length - 1] : null,
    recent_decisions: decisions,
    active,
    assignments: latestAssignments(ledgers).map((a) => {
      const last = a.spawns?.length ? a.spawns[a.spawns.length - 1] : null;
      return {
        key: a.key, title: a.title, profile: a.profile, intent: a.intent, state: a.state,
        dispatched_round: a.dispatch_round, last_round: last?.round ?? null, outcome: last?.outcome ?? null,
        truncated: last?.truncated === true, interrupted: last?.interrupted === true,
        resumable_round: resumableSpawn(a)?.round ?? null,
        conflict_files: a.conflict_files ?? [], note: a.note ?? null,
      };
    }),
    spec: spec ? { status: spec.status, sha: spec.sha256, short: shortSha(spec.sha256), path: path.relative(cfg.root, spec.path), lines: spec.lines, acs: acIds.length } : null,
    digest: digest ? {
      state: digest.state,
      path: digest.path ? path.relative(cfg.root, digest.path) : null,
      source_snapshot: spec ? path.relative(cfg.root, path.join(dossier, 'digest', `${shortSha(spec.sha256)}.source.md`)) : null,
      attempts: digest.attempts,
      model: digest.meta?.model ?? cfg.models?.digest ?? null,
      prompt_sha: digest.meta?.prompt_sha256 ? shortSha(digest.meta.prompt_sha256) : null,
      errors: digest.errors ?? [],
      cost_usd: Math.round(digestCost * 1e6) / 1e6,
      stats: digest.stats ?? null,
    } : null,
    review: {
      head: head ? head.slice(0, 7) : null,
      base: base ? base.slice(0, 7) : null,
      need_review: ts.box === 'queue' ? needReview(records, head, { coverage }) : null,
      need_precommit: ts.box === 'queue' ? needPrecommit(records, head, base) : null,
      coverage: coverage ? renderCoverage(coverage, acIds.length) : null,
      remaining: coverage?.remaining ?? [],
      fails: coverage?.fails ?? [],
    },
    budget: {
      spent_usd: ts.runtime.spent_usd ?? 0,
      budget_usd: cfg.budgetUsd ?? null,
      remaining_usd: cfg.budgetUsd != null ? Math.max(0, Math.round((cfg.budgetUsd - (ts.runtime.spent_usd ?? 0)) * 1e6) / 1e6) : null,
      estimated_usd: ts.runtime.estimated_cost_usd ?? 0,
      unknown_cost_spawns: ts.runtime.unknown_cost_spawns ?? 0,
      rounds_used: ts.runtime.current_round ?? 0,
      max_rounds: cfg.maxRoundsPerTask ?? null,
      stall_rounds: routerState?.progress?.stall_rounds ?? 0,
      run_session: ctx.runSession ? {
        spent_usd: ctx.runSession.spent_usd ?? 0, limit_usd: ctx.runSession.limit_usd ?? null,
        ended: ctx.runSession.ended_at != null, end_reason: ctx.runSession.end_reason ?? null,
      } : null,
    },
  };
}

/** `conductor show <id>` 的纯文本渲染。 */
export function renderTaskView(v) {
  const L = [];
  L.push(`${v.id}  ${v.title ?? ''}`);
  L.push(`阶段：${v.phase.label}（stage=${v.stage}${v.awaiting ? `/${v.awaiting.kind}` : ''}，box=${v.box}）`);
  if (v.phase.reason) L.push(`  原因：${v.phase.reason}`);
  if (v.phase.retained) L.push(`  保留：${v.phase.retained}`);
  if (v.phase.next) L.push(`  继续：${v.phase.next}`);
  if (v.objective) L.push(`当前目标：${v.objective}`);
  if (v.last_plan_change) L.push(`最近一次调整计划（r${v.last_plan_change.round}）：${v.last_plan_change.why}`);
  if (v.recent_decisions.length > 0) {
    L.push('最近的决策：');
    for (const d of v.recent_decisions) L.push(`  r${d.round} → ${d.action}：${d.summary ?? ''}`);
  }
  if (v.active.length > 0) {
    L.push('活动中的 agent：');
    for (const a of v.active) L.push(`  ${a.name}${a.title ? `「${a.title}」` : ''}${a.profile ? ` profile=${a.profile}` : ''}  进程=${a.process}  自 ${a.started}`);
  }
  if (v.assignments.length > 0) {
    L.push('委派（做完了什么 / 还剩什么）：');
    for (const a of v.assignments) {
      L.push(`  ${a.key}「${a.title ?? ''}」 ${a.profile}/${a.intent}  state=${a.state}  outcome=${a.outcome ?? '未知'}`
        + `${a.truncated ? '  truncated' : ''}${a.interrupted ? '  interrupted' : ''}${a.resumable_round ? `  可续接(r${a.resumable_round})` : ''}`
        + `${a.conflict_files.length ? `  conflict=${a.conflict_files.join(',')}` : ''}${a.note ? `  —— ${a.note}` : ''}`);
    }
  }
  if (v.plan.length > 0) {
    L.push('router 的计划（它自己的记录，不是执行事实）：');
    for (const p of v.plan) L.push(`  [${p.status}] ${p.key} ${p.title}${p.note ? ` —— ${p.note}` : ''}`);
  }
  if (v.open_questions.length > 0) {
    L.push('未决问题：');
    for (const q of v.open_questions) L.push(`  (${q.status}) ${q.text}`);
  }
  if (v.spec) L.push(`spec：${v.spec.status} 版本 ${v.spec.short}  AC×${v.spec.acs}  ${v.spec.path}`);
  if (v.digest) {
    L.push(`摘要：${v.digest.state}  尝试 ${v.digest.attempts} 次  模型 ${v.digest.model ?? '-'}  prompt ${v.digest.prompt_sha ?? '-'}  花费 $${v.digest.cost_usd.toFixed(3)}`);
    if (v.digest.path) L.push(`  摘要：${v.digest.path}    原文快照：${v.digest.source_snapshot}`);
    if (v.digest.state !== 'valid' && v.digest.errors.length > 0) L.push(`  最近的校验错误：${v.digest.errors.slice(0, 3).join('；')}`);
    if (v.digest.state === 'exhausted') L.push(`  已降级：router 直接读原文；conductor digest ${v.id} --force 可重做`);
  }
  if (v.box === 'queue') {
    L.push(`验收门：H=${v.review.head ?? '-'} B=${v.review.base ?? '-'}  need_review=${v.review.need_review}  need_precommit=${v.review.need_precommit}`);
    if (v.review.coverage) L.push(`  整体 review：${v.review.coverage}`);
  }
  const b = v.budget;
  L.push(`花费：$${Number(b.spent_usd).toFixed(3)} / 预算 $${b.budget_usd ?? '-'}（剩 $${b.remaining_usd ?? '-'}）`
    + `${b.unknown_cost_spawns > 0 ? `；成本未知的会话 ${b.unknown_cost_spawns} 次，其中估计入账 $${Number(b.estimated_usd).toFixed(3)}` : ''}`
    + `；轮次 ${b.rounds_used}/${b.max_rounds ?? '-'}${b.stall_rounds > 0 ? `；连续 ${b.stall_rounds} 轮无硬进展` : ''}`);
  if (b.run_session) {
    L.push(`运行账本：已花 $${Number(b.run_session.spent_usd).toFixed(3)}${b.run_session.limit_usd != null ? ` / 额度 $${b.run_session.limit_usd}` : '（未设 runBudgetUsd）'}`
      + `${b.run_session.ended ? `；上次结束原因：${b.run_session.end_reason}` : '；未正常收尾或仍在运行'}`);
  }
  return L.join('\n');
}
