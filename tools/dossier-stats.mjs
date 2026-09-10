#!/usr/bin/env node
// tools/dossier-stats.mjs — 跨任务失败分布/成本/轮次聚合（fable-loop 研究量尺）。
// 只读 state/{queue,done,failed} + dossier/，不触碰 conductor 运行时（不 spawn、不改状态、不搬箱）；
// 唯一的仓内依赖是 lib/records.mjs 的记录合成纯函数——新纪元的 log 契约只有一个解析器。
// 输出 Markdown 摘要或 --json。
// 用途：每轮优化实验后一条命令拿到基线对比（截断率、返工率、committer 提案通过率、失败类型分布），
// 不用重新人肉挖 dossier（fable-loop-STATE.md §4 H12）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRecords } from '../conductor/lib/records.mjs';

const TASK_DIR_RE = /^task-\d{8}-\d{3}$/;
/** 新状态机的判据：案卷里有 router 轮次。一个 dossier 只属于一个纪元。 */
const ROUTER_SPAWN_RE = /^router-r\d+\.json$/;
const PRECOMMIT_STEPS = ['build', 'service', 'unit', 'integration', 'e2e'];
const TIERS = ['unit', 'integration', 'e2e'];

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listTaskIds(boxDir) {
  try {
    return fs.readdirSync(boxDir).filter((n) => TASK_DIR_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** 读 dossier/<id>/events.jsonl（H17 结构化事件流）。缺失返回 []；半行截断逐行容错。 */
function readEvents(dossierDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dossierDir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* 截断残行忽略 */ }
  }
  return events;
}

/** 收集单任务：state 快照 + dossier 轮次证据。缺文件一律容错（历史任务布局可能不全）。 */
export function collectTask(root, box, id) {
  const stateDir = path.join(root, 'state', box, id);
  const dossierDir = path.join(root, 'dossier', id);
  const task = readJsonIf(path.join(stateDir, 'task.json')) ?? {};
  const runtime = readJsonIf(path.join(stateDir, 'runtime.json')) ?? {};

  const makerRounds = [];
  const verifierRounds = [];
  const testGates = [];
  const committerAttempts = [];
  let verifierInvalidFiles = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(dossierDir);
  } catch { /* dossier 缺失（如 parked/极早期任务） */ }

  // 一个案卷只属于一个纪元：新状态机的 `maker-r<n>.json` 是 spawn 记录（配套
  // `maker-r<n>.log.json`），不是旧的 maker 门产物——按旧口径解析只会产生假轮次。
  const isRouter = entries.some((n) => ROUTER_SPAWN_RE.test(n));

  for (const name of isRouter ? [] : entries.sort()) {
    let m;
    if ((m = name.match(/^maker-r(\d+)\.json$/))) {
      const rec = readJsonIf(path.join(dossierDir, name)) ?? {};
      makerRounds.push({
        round: Number(m[1]),
        mode: rec.mode ?? null,
        ok: rec.ok ?? null,
        cost_usd: rec.cost_usd ?? 0,
        subtype: rec.raw?.subtype ?? null,
        max_turns_continuations: rec.max_turns_continuations ?? 0,
        resume_failed: rec.resume_failed === true,
      });
    } else if ((m = name.match(/^verify-r(\d+)\.verdict\.json$/))) {
      const v = readJsonIf(path.join(dossierDir, name)) ?? {};
      verifierRounds.push({ round: Number(m[1]), overall: v.overall ?? null });
    } else if (/^verify-r\d+\.invalid-a\d+\.json$/.test(name)) {
      verifierInvalidFiles++;
    } else if ((m = name.match(/^test-gate-r(\d+)\.json$/))) {
      const g = readJsonIf(path.join(dossierDir, name)) ?? {};
      testGates.push({ round: Number(m[1]), mode: g.mode ?? null, verdict: g.verdict ?? null });
    } else if ((m = name.match(/^committer-r(\d+)\.json$/))) {
      const rec = readJsonIf(path.join(dossierDir, name)) ?? {};
      committerAttempts.push({ attempt: Number(m[1]), subtype: rec.raw?.subtype ?? null, cost_usd: rec.cost_usd ?? 0 });
    }
  }

  // committer 提案有效性：优先读结构化事件流（H17，events.jsonl）；legacy 任务（无事件文件
  // 或无 committer 事件）回退 timeline 文案 grep（E8 口径，保持历史 11 任务可比）。
  let committerValidAttempt = null;
  let committerDegraded = false;
  let sawCommitterEvents = false;
  for (const ev of readEvents(dossierDir)) {
    if (ev.type === 'committer_attempt') {
      sawCommitterEvents = true;
      if (ev.outcome === 'valid' && committerValidAttempt === null) committerValidAttempt = ev.attempt ?? null;
    } else if (ev.type === 'committer_degraded') {
      sawCommitterEvents = true;
      committerDegraded = true;
    }
  }
  if (!sawCommitterEvents) {
    try {
      const timeline = fs.readFileSync(path.join(dossierDir, 'timeline.md'), 'utf8');
      const valid = timeline.match(/committer 提案 a(\d+) 有效/);
      if (valid) committerValidAttempt = Number(valid[1]);
      committerDegraded = timeline.includes('降级机器文案');
    } catch { /* timeline 缺失 */ }
  }

  const router = collectRouterEra(root, id, isRouter);

  return {
    id,
    box,
    kind: task.kind ?? null,
    stage: runtime.stage ?? null,
    last_failure_type: runtime.last_failure_type ?? null,
    maker_miss_count: runtime.maker_miss_count ?? 0,
    spent_usd: runtime.spent_usd ?? 0,
    maker_rounds: makerRounds,
    verifier_rounds: verifierRounds,
    verifier_invalid_files: verifierInvalidFiles,
    test_gates: testGates,
    committer_attempts: committerAttempts,
    committer_valid_attempt: committerValidAttempt,
    committer_degraded: committerDegraded,
    ...router,
  };
}

/**
 * 新状态机的逐任务证据（AC-029）：router 轮次、precommit 各步与 tier、各角色成本、人闸。
 * 记录合成复用 `conductor/lib/records.mjs::composeRecords`——本工具不另写一套 log 解析。
 * P2b 的工作包字段（包数 / 并行轮数 / plan 次数）先按 0 输出并预留，字段名与后续实现对齐。
 */
function collectRouterEra(root, id, isRouter) {
  const empty = {
    is_router: false,
    router_rounds: [],
    agent_records: [],
    precommit_rounds: [],
    human_gates: [],
    role_cost_usd: {},
    packages_count: 0,
    parallel_rounds: 0,
    plan_runs: 0,
  };
  if (!isRouter) return empty;

  let records = [];
  try {
    records = composeRecords({ dossierDir: path.join(root, 'dossier') }, id);
  } catch { return empty; }

  const roleCost = {};
  for (const r of records) {
    if (r.role === 'human') continue;
    roleCost[r.role] = round6((roleCost[r.role] ?? 0) + (r.cost_usd ?? 0));
  }

  return {
    is_router: true,
    router_rounds: records.filter((r) => r.role === 'router').map((r) => ({
      round: r.round, action: r.action, tier: r.tier, product: r.product, cost_usd: r.cost_usd ?? 0,
    })),
    agent_records: records
      .filter((r) => r.role === 'spec' || r.role === 'maker' || r.role === 'reviewer')
      .map((r) => ({
        round: r.round, role: r.role, package: r.package, mode: r.mode, outcome: r.outcome,
        tier: r.tier, product: r.product, truncated: r.truncated === true, cost_usd: r.cost_usd ?? 0,
      })),
    precommit_rounds: records.filter((r) => r.role === 'precommit').map((r) => ({
      round: r.round,
      outcome: r.outcome,
      tier: r.tier,
      steps: (r.steps ?? []).map((s) => ({ step: s.step ?? null, status: s.status ?? null })),
      conflict_files: (r.conflict_files ?? []).length,
    })),
    human_gates: records.filter((r) => r.role === 'human').map((r) => ({
      round: r.round, kind: r.kind, decision: r.decision,
    })),
    role_cost_usd: roleCost,
    // P2b 预留：本阶段 packagesEnabled=false，恒为 0。
    packages_count: 0,
    parallel_rounds: 0,
    plan_runs: records.filter((r) => r.role === 'spec' && r.mode === 'plan').length,
  };
}

/** 全库聚合：逐任务明细 + 系统级汇总（研究基线用的比率都在 summary 里）。 */
export function collectStats(root) {
  const tasks = [];
  for (const box of ['queue', 'done', 'failed']) {
    for (const id of listTaskIds(path.join(root, 'state', box))) {
      tasks.push(collectTask(root, box, id));
    }
  }

  const makerAll = tasks.flatMap((t) => t.maker_rounds);
  const makerR1 = makerAll.filter((r) => r.round === 1);
  const failureTypes = {};
  for (const t of tasks) {
    if (t.last_failure_type) failureTypes[t.last_failure_type] = (failureTypes[t.last_failure_type] ?? 0) + 1;
  }
  const withCommitter = tasks.filter(
    (t) => t.committer_attempts.length > 0 || t.committer_valid_attempt !== null || t.committer_degraded,
  );

  const summary = {
    tasks_total: tasks.length,
    tasks_by_box: {
      queue: tasks.filter((t) => t.box === 'queue').length,
      done: tasks.filter((t) => t.box === 'done').length,
      failed: tasks.filter((t) => t.box === 'failed').length,
    },
    failure_types: failureTypes,
    maker: {
      rounds_total: makerAll.length,
      r1_total: makerR1.length,
      r1_max_turns_cutoff: makerR1.filter((r) => r.subtype === 'error_max_turns').length,
      rounds_with_continuation: makerAll.filter((r) => r.max_turns_continuations > 0).length,
      cold_degraded: makerAll.filter((r) => r.mode === 'cold-degraded' || r.resume_failed).length,
      tasks_needing_r2plus: tasks.filter((t) => t.maker_rounds.some((r) => r.round >= 2)).length,
      cost_usd: round6(makerAll.reduce((s, r) => s + (r.cost_usd ?? 0), 0)),
    },
    verifier: {
      rounds_total: tasks.reduce((s, t) => s + t.verifier_rounds.length, 0),
      fails: tasks.reduce((s, t) => s + t.verifier_rounds.filter((r) => r.overall === 'fail').length, 0),
      invalid_files: tasks.reduce((s, t) => s + t.verifier_invalid_files, 0),
    },
    test_gate: {
      vacuous: tasks.reduce((s, t) => s + t.test_gates.filter((g) => g.verdict === 'vacuous').length, 0),
      per_ac_rounds: tasks.reduce((s, t) => s + t.test_gates.filter((g) => g.mode === 'per-ac').length, 0),
    },
    committer: {
      merges_with_proposal: withCommitter.length,
      valid_a1: withCommitter.filter((t) => t.committer_valid_attempt === 1).length,
      degraded: withCommitter.filter((t) => t.committer_degraded).length,
    },
    router: collectRouterSummary(tasks),
    spent_usd_total: round6(tasks.reduce((s, t) => s + (t.spent_usd ?? 0), 0)),
  };
  return { tasks, summary };
}

/** 新状态机的系统级汇总：router 轮次与动作分布、precommit 各步与 tier、角色成本、人闸。 */
function collectRouterSummary(tasks) {
  const routerTasks = tasks.filter((t) => t.is_router);
  const routerRounds = routerTasks.flatMap((t) => t.router_rounds);
  const agents = routerTasks.flatMap((t) => t.agent_records);
  const precommits = routerTasks.flatMap((t) => t.precommit_rounds);

  const actions = {};
  for (const r of routerRounds) {
    const key = r.action ?? 'invalid';
    actions[key] = (actions[key] ?? 0) + 1;
  }

  const byStep = {};
  for (const step of PRECOMMIT_STEPS) byStep[step] = { ok: 0, fail: 0, skipped: 0, not_run: 0 };
  for (const p of precommits) {
    for (const s of p.steps) {
      if (byStep[s.step] && Object.hasOwn(byStep[s.step], s.status)) byStep[s.step][s.status] += 1;
    }
  }

  const tierCounts = Object.fromEntries(TIERS.map((tier) => [tier, 0]));
  for (const p of precommits) if (Object.hasOwn(tierCounts, p.tier)) tierCounts[p.tier] += 1;

  const humanGates = { spec: 0, merge: 0, help: 0 };
  for (const t of routerTasks) {
    for (const g of t.human_gates) if (Object.hasOwn(humanGates, g.kind)) humanGates[g.kind] += 1;
  }

  const roleCost = {};
  for (const t of routerTasks) {
    for (const [role, c] of Object.entries(t.role_cost_usd)) {
      roleCost[role] = round6((roleCost[role] ?? 0) + c);
    }
  }

  return {
    tasks: routerTasks.length,
    rounds_total: routerRounds.length,
    actions,
    router_product_not_ok: routerRounds.filter((r) => r.product !== 'ok').length,
    maker_product_not_ok: agents.filter((r) => r.role === 'maker' && r.product !== 'ok').length,
    maker_truncated: agents.filter((r) => r.role === 'maker' && r.truncated).length,
    reviewer_fails: agents.filter((r) => r.role === 'reviewer' && r.outcome === 'fail').length,
    reviewer_rounds: agents.filter((r) => r.role === 'reviewer').length,
    precommit: {
      runs: precommits.length,
      ok: precommits.filter((p) => p.outcome === 'ok').length,
      fail: precommits.filter((p) => p.outcome === 'fail').length,
      by_step: byStep,
      by_tier: tierCounts,
    },
    human_gates: humanGates,
    role_cost_usd: roleCost,
    // P2b 预留列：工作包尚未实现，恒为 0（字段名与 packages-status.json 对齐）。
    packages_total: routerTasks.reduce((s, t) => s + t.packages_count, 0),
    parallel_rounds: routerTasks.reduce((s, t) => s + t.parallel_rounds, 0),
    plan_runs: routerTasks.reduce((s, t) => s + t.plan_runs, 0),
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function pct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : 'n/a';
}

/** Markdown 渲染（人读）；机器消费走 --json。 */
export function renderMarkdown({ tasks, summary }) {
  const lines = [];
  lines.push('# dossier 统计');
  lines.push('');
  lines.push(`任务：${summary.tasks_total}（queue ${summary.tasks_by_box.queue} / done ${summary.tasks_by_box.done} / failed ${summary.tasks_by_box.failed}）；累计花费 $${summary.spent_usd_total}`);
  lines.push('');
  lines.push('## 系统级比率（实验基线对照用）');
  lines.push('');
  lines.push(`- maker r1 max-turns 截断率：${summary.maker.r1_max_turns_cutoff}/${summary.maker.r1_total}（${pct(summary.maker.r1_max_turns_cutoff, summary.maker.r1_total)}）`);
  lines.push(`- maker 续跑使用轮数：${summary.maker.rounds_with_continuation}/${summary.maker.rounds_total}；cold-degraded：${summary.maker.cold_degraded}`);
  lines.push(`- 需要 r2+ 的任务：${summary.maker.tasks_needing_r2plus}/${summary.tasks_total}（${pct(summary.maker.tasks_needing_r2plus, summary.tasks_total)}）`);
  lines.push(`- verifier：${summary.verifier.rounds_total} 轮（fail ${summary.verifier.fails}，协议 invalid 留档 ${summary.verifier.invalid_files}）`);
  lines.push(`- test gate：vacuous 拦截 ${summary.test_gate.vacuous} 次，per-AC 模式 ${summary.test_gate.per_ac_rounds} 轮`);
  lines.push(`- committer：a1 一次通过 ${summary.committer.valid_a1}/${summary.committer.merges_with_proposal}（${pct(summary.committer.valid_a1, summary.committer.merges_with_proposal)}），降级 ${summary.committer.degraded}`);
  const ft = Object.entries(summary.failure_types).map(([k, v]) => `${k}×${v}`).join('，') || '（无）';
  lines.push(`- 失败类型分布：${ft}`);
  lines.push('');
  lines.push(...renderRouterSection(summary.router));
  lines.push('## 逐任务');
  lines.push('');
  lines.push('| id | box | kind | maker 轮 | 截断腿 | verifier | committer | router 轮 | precommit | 包/并行/plan | $ | 失败类型 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of tasks) {
    const cuts = t.maker_rounds.filter((r) => r.subtype === 'error_max_turns').length;
    const ver = t.verifier_rounds.map((r) => r.overall?.[0] ?? '?').join('') || '-';
    const com = t.committer_valid_attempt ? `a${t.committer_valid_attempt}` : (t.committer_degraded ? 'degraded' : '-');
    const routerRounds = t.is_router ? String(t.router_rounds.length) : '-';
    const pre = t.is_router
      ? (t.precommit_rounds.map((p) => `${p.tier ?? '?'}:${p.outcome?.[0] ?? '?'}`).join(',') || '-')
      : '-';
    const pkg = t.is_router ? `${t.packages_count}/${t.parallel_rounds}/${t.plan_runs}` : '-';
    lines.push(`| ${t.id} | ${t.box} | ${t.kind ?? '-'} | ${t.maker_rounds.length} | ${cuts} | ${ver} | ${com} | ${routerRounds} | ${pre} | ${pkg} | ${t.spent_usd} | ${t.last_failure_type ?? '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 新状态机小节：没有 router 任务时也照常出现（一行「（无）」），保持输出形状稳定。 */
function renderRouterSection(router) {
  const L = ['## 新状态机（router）', ''];
  if (!router || router.tasks === 0) {
    L.push('（本库没有 router 纪元的任务）', '');
    return L;
  }
  const actions = Object.entries(router.actions).map(([k, v]) => `${k}×${v}`).join('，') || '（无）';
  const steps = PRECOMMIT_STEPS
    .map((step) => {
      const c = router.precommit.by_step[step];
      return `${step} ok${c.ok}/fail${c.fail}/skip${c.skipped}/not_run${c.not_run}`;
    })
    .join('；');
  const tiers = TIERS.map((tier) => `${tier}×${router.precommit.by_tier[tier]}`).join('，');
  const roles = Object.entries(router.role_cost_usd).map(([k, v]) => `${k} $${v}`).join('，') || '（无）';
  L.push(`- router 任务：${router.tasks}；router 轮次：${router.rounds_total}；动作分布：${actions}`);
  L.push(`- router 失效（product≠ok）：${router.router_product_not_ok}；maker 无交付：${router.maker_product_not_ok}；maker 截断：${router.maker_truncated}`);
  L.push(`- reviewer：${router.reviewer_rounds} 轮（fail ${router.reviewer_fails}）`);
  L.push(`- precommit：${router.precommit.runs} 次（ok ${router.precommit.ok} / fail ${router.precommit.fail}）；tier 分布：${tiers}`);
  L.push(`- precommit 各步：${steps}`);
  L.push(`- 人闸：spec×${router.human_gates.spec}，merge×${router.human_gates.merge}，help×${router.human_gates.help}`);
  L.push(`- 各角色成本：${roles}`);
  L.push(`- 工作包（P2b 预留）：包数 ${router.packages_total}；并行轮数 ${router.parallel_rounds}；plan 次数 ${router.plan_runs}`);
  L.push('');
  return L;
}

/**
 * 解析 argv 得到 `{ taskId, taskIdInvalid, asJson, root }`。
 * `--task` 的值先于 root 位置参数被消费，避免 id 被误当作 root（见 spec「当前 root 位置参数的陷阱」）。
 * `--task` 缺值或其后紧跟 `--` 开头 flag 时 `taskIdInvalid = true`，`taskId` 不设。
 */
export function parseArgs(argv) {
  const args = [...argv];
  const taskIdx = args.indexOf('--task');
  let taskId;
  let taskIdInvalid = false;
  if (taskIdx !== -1) {
    const val = args[taskIdx + 1];
    if (val === undefined || val.startsWith('--')) {
      taskIdInvalid = true;
      args.splice(taskIdx, 1);
    } else {
      taskId = val;
      args.splice(taskIdx, 2);
    }
  }
  const asJson = args.includes('--json');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = rootArg
    ? path.resolve(rootArg)
    : (process.env.CONDUCTOR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  return { taskId, taskIdInvalid, asJson, root };
}

/** 任务 id 所在的箱（queue/done/failed），三处均无则 null。 */
export function findTaskBox(root, id) {
  for (const box of ['queue', 'done', 'failed']) {
    if (fs.existsSync(path.join(root, 'state', box, id))) return box;
  }
  return null;
}

/** 复用 collectTask 选中单任务；未找到返回 null。不做独立于 collectStats 的重复聚合。 */
export function selectTask(root, id) {
  const box = findTaskBox(root, id);
  if (!box) return null;
  return collectTask(root, box, id);
}

/** 单任务详情：沿用逐任务表既有字段，逐行「字段: 值」呈现（见 spec AC-002）。 */
export function renderTaskDetail(t) {
  const cuts = t.maker_rounds.filter((r) => r.subtype === 'error_max_turns').length;
  const ver = t.verifier_rounds.map((r) => r.overall?.[0] ?? '?').join('') || '-';
  const com = t.committer_valid_attempt ? `a${t.committer_valid_attempt}` : (t.committer_degraded ? 'degraded' : '-');
  const lines = [
    `id: ${t.id}`,
    `box: ${t.box}`,
    `kind: ${t.kind ?? '-'}`,
    `纪元: ${t.is_router ? 'router' : 'legacy'}`,
    `maker 轮次数: ${t.maker_rounds.length}`,
    `截断腿数: ${cuts}`,
    `verifier: ${ver}`,
    `committer: ${com}`,
  ];
  if (t.is_router) {
    lines.push(`router 轮次数: ${t.router_rounds.length}`);
    lines.push(`router 动作: ${t.router_rounds.map((r) => r.action ?? '?').join(',') || '-'}`);
    lines.push(`precommit: ${t.precommit_rounds.map((p) => `r${p.round} ${p.tier ?? '?'} ${p.outcome ?? '?'}`).join('；') || '-'}`);
    lines.push(`precommit 各步: ${t.precommit_rounds.map((p) => p.steps.map((s) => `${s.step}:${s.status}`).join(',')).join('；') || '-'}`);
    lines.push(`人闸: ${t.human_gates.map((g) => `${g.kind}:${g.decision ?? 'pending'}`).join('，') || '-'}`);
    lines.push(`各角色成本: ${Object.entries(t.role_cost_usd).map(([k, v]) => `${k} $${v}`).join('，') || '-'}`);
    lines.push(`工作包(P2b 预留): 包数 ${t.packages_count} / 并行轮数 ${t.parallel_rounds} / plan 次数 ${t.plan_runs}`);
  }
  lines.push(`成本(spent_usd): ${t.spent_usd}`);
  lines.push(`失败类型: ${t.last_failure_type ?? '-'}`);
  return lines.join('\n');
}

/** CLI 入口：纯函数，argv → `{ code, stdout, stderr }`，供单测断言退出码/流向。 */
export function runCli(argv) {
  const { taskId, taskIdInvalid, asJson, root } = parseArgs(argv);
  if (taskIdInvalid) {
    return { code: 1, stdout: '', stderr: '--task 需要一个任务 id 参数\n' };
  }
  if (taskId) {
    const task = selectTask(root, taskId);
    if (!task) {
      return { code: 1, stdout: '', stderr: `任务 ${taskId} 在 queue/done/failed 三处均未找到\n` };
    }
    const out = asJson ? `${JSON.stringify(task, null, 2)}\n` : `${renderTaskDetail(task)}\n`;
    return { code: 0, stdout: out, stderr: '' };
  }
  const stats = collectStats(root);
  const out = asJson ? `${JSON.stringify(stats, null, 2)}\n` : `${renderMarkdown(stats)}\n`;
  return { code: 0, stdout: out, stderr: '' };
}

// ---- CLI：node tools/dossier-stats.mjs [--json] [--task <id>] [root]（root 缺省 = 本仓库根 / CONDUCTOR_ROOT） ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
