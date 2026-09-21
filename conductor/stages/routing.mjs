// stages/routing.mjs — 状态机的心脏（AC-002 / 003 / 004 / 005）。
//
// 每一轮就是一句话：内核给事实，router 从闭集里选一个动作，内核校前置、执行、记录。
//   恢复上次没收尾的事 → 复核获批 spec 没被动过 → 补齐当前版本的摘要 → 停滞 / 轮次 / 预算闸
//   → 拼 prompt（brief + spec 位置与摘要 + 工作记忆 + 记录 + 内核事实）
//   → spawn router（只读三件 + Write；读范围与写白名单都由 hook 收口，没有任何执行能力）
//   → 合成记录 → 校验 action 与前置 → 执行 → timeline + 事件 router_decision
//
// router 是负责人，不是开关：它读得到摘要、能按引用回到 spec 原文 / 代码 / diff / 执行产物，
// 能用 dispatch 把具体指导逐字交给多个 subagent，能根据回来的证据改计划。它改不了的东西由内核守着：
// spec（只有人能批）、权限档（由 profile 决定，不由文字决定）、预算与轮次上限、版本门与两道人闸。
//
// 内核自行发起的转移：spec 通过校验 → AWAIT_HUMAN(spec)（actions/spec.mjs）；限额 →
// FAILED_BOX(rate_limited)；保险丝（同签名连击 / 连续无硬进展）→ FAILED_BOX(fuse_no_progress)；
// 预算 → FAILED_BOX(budget_exhausted)；轮次上限 → FAILED_BOX(round_cap)；router 失效连击、
// 获批 spec 被动过、执行越界 → AWAIT_HUMAN(help, requested_by=kernel)。其余一切转移都由 router 的动作触发。
//
// 「失效」有两种，合并计一根连击线（Invariant 3 的唯一例外）：router 记录 product ≠ ok，或它选的
// 动作被前置拒掉。连续 2 次 → 内核开 help 闸——router 是唯一的裁判，裁判缺席时没有别人可以判断。

import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { ACTIONS } from '../lib/log-contract.mjs';
import { composeRecords, renderFacts, renderRecordsForRouter } from '../lib/records.mjs';
import { mergeAllowed, needPrecommit, needReview, reviewerTierAt } from '../lib/version-gate.mjs';
import { buildRouterPrompt } from '../lib/prompts.mjs';
import { logPathFor, routerNotesPath } from '../lib/agent-settings.mjs';
import { currentSpec, shortSha, verifyApprovedSpec } from '../lib/spec-version.mjs';
import { digestSourcePath, digestStateFor } from '../lib/digest-store.mjs';
import { renderDigestForRouter } from '../lib/digest-contract.mjs';
import { listLedgers, renderAssignmentTable } from '../lib/dispatch-ledger.mjs';
import { renderCoverage } from '../lib/review-ledger.mjs';
import { readNotesForPrompt, settleNotes } from '../lib/router-notes.mjs';
import { recoverTask } from '../lib/recovery.mjs';
import { treeOf } from '../lib/git.mjs';
import {
  HARNESS_ARTIFACTS, accountSpawnCost, canStartSpawn, failToBox, rateLimitedToBox, reconcileSpent, worktreePath,
} from './shared.mjs';
import {
  allocateRound, checkBudgetAndBox, checkFuseAndBox, checkRoundCapAndBox, checkStallAndBox, cleanupTaskArtifacts,
  everProducedSpec, helpSummaries, openHumanGate, readBriefText, readRouterState, relRef, revParseOrNull,
  reviewStateFor, spawnAgentRound, spawnSkipped, taskBranchName, taskCfg, taskHasDiff, writeRouterState,
} from './router-kernel.mjs';
import specAction from './actions/spec.mjs';
import makerAction from './actions/maker.mjs';
import reviewAction, { materializeDiffView } from './actions/review.mjs';
import precommitAction from './actions/precommit.mjs';
import dispatchAction, { closeLedger, dispatchPrecondition } from './actions/dispatch.mjs';
import { ensureDigest } from './actions/digest.mjs';

const TIER_ORDER = { unit: 1, integration: 2, e2e: 3 };

/** 连续几次失效开 help 闸（spec：2）。 */
export const ROUTER_FAILURE_LIMIT = 2;

/** router prompt 里带 summary 全文的记录条数；更早的只给索引行（原文都在案卷里，可按名 Read）。 */
export const DEFAULT_ROUTER_RECORD_WINDOW = 14;

/** 记录里最近一条某角色的记录（按轮次），没有返回 null。 */
function latestOf(records, role, predicate = () => true) {
  let best = null;
  for (const r of records ?? []) {
    if (r.role !== role || !predicate(r)) continue;
    if (best == null || r.round >= best.round) best = r;
  }
  return best;
}

/**
 * 一次失效入账。达到上限 → 内核开 help 闸（requested_by: kernel），summary 列出两次原因；
 * 否则只把原因记进 router-state，下一轮的事实段会带上它。
 */
function registerFailure(ts, cfg, round, reason, { lastActionRejected = null } = {}) {
  const id = ts.id;
  const prev = readRouterState(cfg, id);
  const failures = [...prev.failures, `r${round}: ${reason}`];
  state.appendTimeline(cfg, id, `router r${round} 失效（${failures.length}/${ROUTER_FAILURE_LIMIT}）：${reason}`);
  if (failures.length < ROUTER_FAILURE_LIMIT) {
    writeRouterState(cfg, id, { failures, last_action_rejected: lastActionRejected ?? prev.last_action_rejected });
    return { changed: true };
  }
  writeRouterState(cfg, id, { failures: [], last_action_rejected: lastActionRejected });
  return openHumanGate(ts, cfg, {
    kind: 'help',
    requestedBy: 'kernel',
    summary: `router 连续 ${failures.length} 次失效，内核请人裁决：\n${failures.map((f) => `- ${f}`).join('\n')}`,
    refs: [relRef(cfg, state.dossierPath(cfg, id, `router-r${round}.log.json`))],
    round,
  });
}

/** 动作被前置拒：无副作用，写事件 action_rejected，计一次失效。 */
function rejectAction(ts, cfg, round, action, reason) {
  state.appendEventAlways(cfg, ts.id, 'action_rejected', { round, action, reason });
  return registerFailure(ts, cfg, round, `action_rejected(${action}): ${reason}`, {
    lastActionRejected: `r${round} ${action}：${reason}`,
  });
}

/** 成功决策：清零连击与「最近被拒原因」。 */
function clearFailures(cfg, id) {
  writeRouterState(cfg, id, { failures: [], last_action_rejected: null });
}

/** 内核事实段的全部输入：全部来自 git / 案卷 / runtime，没有一项来自 agent 的自述。 */
function collectFacts(ts, cfg, { records }) {
  const repo = taskCfg(ts, cfg).targetRepo;
  const base = ts.task.baseBranch;
  const branch = taskBranchName(ts.id);
  const head = revParseOrNull(repo, branch);
  const baseSha = revParseOrNull(repo, base);
  const st = readRouterState(cfg, ts.id);
  const review = reviewStateFor(ts, cfg, records, head);
  return {
    repo,
    base,
    branch,
    head,
    baseSha,
    review,
    needReview: needReview(records, head, { coverage: review.coverage }),
    needPrecommit: needPrecommit(records, head, baseSha),
    hasDiff: taskHasDiff(repo, base, branch),
    lastActionRejected: st.last_action_rejected,
    notesError: st.notes_error ?? null,
    stallRounds: st.progress?.stall_rounds ?? 0,
  };
}

/** 停滞保险丝的硬进展指纹（见 router-kernel.mjs::checkStallAndBox）。 */
function progressFingerprint(ts, cfg, facts, records) {
  const repo = facts.repo;
  const cov = facts.review.coverage;
  const pre = latestOf(records, 'precommit');
  return JSON.stringify([
    // 任务分支还不存在时用 base 的 tree：「第一次派工顺手建了分支」不是进展。
    treeOf(repo, facts.head ?? facts.baseSha ?? 'HEAD'),
    cov ? [Object.keys(cov.judged).length, cov.fails.join(',')] : latestOf(records, 'reviewer')?.outcome ?? null,
    pre ? [pre.outcome, pre.tier, pre.head_sha, pre.base_sha] : null,
    (records ?? []).filter((r) => r.role === 'human' && r.decision).length,
    ts.runtime.spec_sha256 ?? null,
    ts.runtime.spec_approved === true,
  ]);
}

function renderFactsText(ts, cfg, facts, records, { round, spec, digest, ledgers, patchPath }) {
  const base = renderFacts({
    stage: 'ROUTING',
    round,
    head: facts.head,
    base: facts.baseSha,
    needReview: facts.needReview,
    needPrecommit: facts.needPrecommit,
    hasDiff: facts.hasDiff,
    lastActionRejected: facts.lastActionRejected,
    rateLimit: ts.runtime.rate_limit ?? null,
    spentUsd: ts.runtime.spent_usd ?? 0,
    budgetUsd: cfg.budgetUsd ?? null,
    records,
    packageRows: [],
    acOwners: {},
  });
  const lines = [base];
  const runBudget = cfg.__runBudget;
  const extra = [];
  if (runBudget?.limit != null) extra.push(`本次运行额度：已花 $${Number(runBudget.spent).toFixed(2)} / 上限 $${Number(runBudget.limit).toFixed(2)}`);
  if (Number.isInteger(cfg.maxRoundsPerTask)) extra.push(`轮次：已用 ${round} / 上限 ${cfg.maxRoundsPerTask}`);
  if ((ts.runtime.unknown_cost_spawns ?? 0) > 0) {
    extra.push(`成本未知的会话 ${ts.runtime.unknown_cost_spawns} 次（其中估计入账 $${Number(ts.runtime.estimated_cost_usd ?? 0).toFixed(2)}；不是免费）`);
  }
  if (facts.stallRounds > 0) extra.push(`连续 ${facts.stallRounds} 轮没有硬进展（上限 ${cfg.fuseStallRounds ?? 8}）：代码 tree、review 覆盖、precommit、人的裁决都没变`);
  if (facts.notesError) extra.push(`上一轮的工作记忆不合格，已还原为上一份：${facts.notesError}`);
  if (extra.length > 0) lines.push(extra.join('\n'));

  if (spec) {
    const total = facts.review.acIds.length;
    lines.push(`整体 review（对当前 H 与 spec ${shortSha(spec.sha256)}，共 ${total} 条 AC）：${renderCoverage(facts.review.coverage, total) || '尚无判决'}`);
  }
  const table = renderAssignmentTable(ledgers, { currentSpecSha: spec?.sha256 ?? null });
  if (table) lines.push(`委派台账（内核事实；state 是执行与集成状态，不是验收结论）：\n${table}`);

  const readable = [`案卷目录（你的 cwd，可直接用文件名 Read）：${state.dossierPath(cfg, ts.id)}`];
  if (fs.existsSync(worktreePath(cfg, ts.id))) readable.push(`任务 worktree（任务分支当前代码）：${worktreePath(cfg, ts.id)}`);
  if (patchPath) readable.push(`任务分支相对 base 的完整 diff：${patchPath}`);
  if (digest?.state === 'valid') readable.push(`摘要 JSON：${digest.path}`);
  lines.push(`你可以读的位置（其余路径会被拒）：\n${readable.map((l) => `- ${l}`).join('\n')}`);
  return lines.join('\n\n');
}

function specInfoText(cfg, ts, spec) {
  if (!spec) {
    return everProducedSpec(cfg, ts.id)
      ? '本任务曾产出 spec，但当前没有可用的草稿或冻结稿（被人打回后归档了）。'
      : '';
  }
  return [
    `状态：${spec.status === 'approved' ? '已批准并冻结' : '草稿（尚未批准）'}；版本 ${shortSha(spec.sha256)}；${spec.lines} 行`,
    `原文：${spec.path}`,
    `（摘要里的行号引用对应这一版；同内容的快照在 ${digestSourcePath(cfg, ts.id, spec.sha256)}）`,
    '验收依据永远是这份原文与人的裁决，不是摘要。',
  ].join('\n');
}

function digestText(digest) {
  if (!digest || digest.state === 'none') return '';
  if (digest.state === 'valid') return renderDigestForRouter(digest.digest);
  // 显式降级：绝不给空摘要、过期摘要或内核猜的内容。
  return `【摘要不可用：${digest.state}】这一版 spec 没有通过机械校验的摘要`
    + `${digest.errors?.length ? `（最近的校验错误：${digest.errors.slice(0, 3).join('；')}）` : ''}。`
    + '请直接 Read 上面的 spec 原文再做决定；不要凭 brief 或记忆猜 AC。';
}

// ---- 前置校验（「内核前置」列） ----

function checkPrecondition(ts, cfg, decision, { records, facts }) {
  const id = ts.id;
  switch (decision.action) {
    case 'spec':
    case 'abandon':
      return null;
    case 'plan':
      // 静态工作包方案（P2b）已被 dispatch 取代，阶段闸恒关。
      if (cfg.packagesEnabled !== true) return 'packagesEnabled=false：本阶段不支持工作包方案（多任务委派请用 dispatch）';
      if (ts.runtime.spec_approved !== true) return 'spec 尚未批准，不能补方案';
      if (ts.runtime.plan_active === true) return '已有生效方案，不支持替换';
      return null;
    case 'maker': {
      if (readBriefText(ts).trim() === '') return 'brief 不存在或为空';
      if (everProducedSpec(cfg, id) && ts.runtime.spec_approved !== true) {
        return '本任务曾产出 spec，必须先过 spec 人闸';
      }
      if (ts.runtime.plan_active !== true && decision.packages != null) {
        return '无方案任务不得点名 packages';
      }
      return null;
    }
    case 'dispatch':
      return dispatchPrecondition(ts, cfg, decision);
    case 'review':
      return facts.hasDiff ? null : '任务分支相对 base 没有 diff，无可审内容';
    case 'precommit': {
      // review 之前也可以跑（集成检查，层级由 router 选）；一旦 reviewer 在当前 HEAD 声明过层级，
      // 就不得低于它。merge 资格另由 needPrecommit 再卡一次层级下界，这里放开不会开后门。
      if (!facts.hasDiff) return '任务分支相对 base 没有 diff，无可验证内容';
      const tier = reviewerTierAt(records, facts.head);
      if (tier != null && (TIER_ORDER[decision.tier] ?? 0) < (TIER_ORDER[tier] ?? 0)) {
        return `tier=${decision.tier} 低于 reviewer 在当前 HEAD 声明的 ${tier}`;
      }
      return null;
    }
    case 'human': {
      const summary = decision.summary ?? '';
      return helpSummaries(cfg, id).includes(summary) ? 'duplicate_help' : null;
    }
    case 'merge':
      return mergeAllowed(records, facts.head, facts.baseSha, { coverage: facts.review.coverage })
        ? null
        : `版本规则未满足：need_review=${facts.needReview} need_precommit=${facts.needPrecommit}`
          + `${facts.review.coverage ? `（review：${renderCoverage(facts.review.coverage, facts.review.acIds.length)}）` : ''}`;
    default:
      return `未知动作：${decision.action}`;
  }
}

// ---- 动作执行 ----

async function executeAction(ts, cfg, decision, { round, records, facts }) {
  const id = ts.id;
  switch (decision.action) {
    case 'spec':
      return specAction(ts, cfg, { round, records });
    case 'maker': {
      const r = await makerAction(ts, cfg, { round, records, decision });
      return afterNewRecord(ts, cfg, r);
    }
    case 'dispatch': {
      const r = await dispatchAction(ts, cfg, { round, decision, records });
      return afterNewRecord(ts, cfg, r);
    }
    case 'review': {
      const r = await reviewAction(ts, cfg, { round, records });
      return afterNewRecord(ts, cfg, r);
    }
    case 'precommit': {
      const r = await precommitAction(ts, cfg, { round, decision });
      return afterNewRecord(ts, cfg, r);
    }
    case 'human':
      return openHumanGate(ts, cfg, {
        kind: 'help',
        requestedBy: 'router',
        summary: decision.summary,
        refs: [],
        round,
      });
    case 'merge': {
      const reviewer = latestOf(records, 'reviewer', (r) => r.head_sha === facts.head);
      const precommit = latestOf(records, 'precommit', (r) => r.outcome === 'ok' && r.head_sha === facts.head);
      const refs = [];
      if (reviewer) refs.push(relRef(cfg, state.dossierPath(cfg, id, `reviewer-r${reviewer.round}.log.json`)));
      if (precommit) refs.push(relRef(cfg, state.dossierPath(cfg, id, `precommit-r${precommit.round}.json`)));
      return openHumanGate(ts, cfg, {
        kind: 'merge',
        requestedBy: 'kernel',
        summary: decision.summary,
        refs,
        round,
      });
    }
    case 'abandon':
      cleanupTaskArtifacts(ts, cfg, { deleteTaskBranch: true, force: true });
      return failToBox(ts, cfg, `router 选择 abandon：${decision.summary}`, 'abandoned');
    default:
      return { changed: true };
  }
}

/**
 * 产生了新记录（maker / worker / reviewer / precommit）之后跑同签名保险丝（AC-024）。
 * 任务已经因为限额 / 预算 / 越界搬箱或进闸时（不在 ROUTING）不再叠加判定。
 */
function afterNewRecord(ts, cfg, result) {
  if (ts.box !== 'queue' || ts.runtime.stage !== 'ROUTING') return result;
  const tripped = checkFuseAndBox(ts, cfg, composeRecords(cfg, ts.id, { planActive: ts.runtime.plan_active === true }));
  return tripped ?? result;
}

/** 恢复流程需要的 stages 层能力（lib/recovery.mjs 不反向依赖 stages）。 */
export function recoveryDeps(cfg) {
  return {
    closeLedger,
    accountUnknown: (ts, base, round, rec) => accountSpawnCost(ts, cfg, base, round, { costUsd: 0, costUnknown: true, error: 'runner_crashed' }, rec),
    reconcileSpent,
    taskRepo: (ts) => taskCfg(ts, cfg).targetRepo,
    taskWorktree: (id) => worktreePath(cfg, id),
    taskBranch: taskBranchName,
    excludePatterns: HARNESS_ARTIFACTS.patterns,
  };
}

/** 获批 spec 的完整性复核：被动过 → 内核开 help 闸，任何 agent 都不会再读到那份被改过的「契约」。 */
function guardApprovedSpec(ts, cfg) {
  const check = verifyApprovedSpec(cfg, ts);
  if (check.ok) {
    if (check.backfill) {
      // 升级前批准的任务：第一次见到时把冻结稿的哈希补记下来，之后照常复核。
      ts.runtime.spec_sha256 = check.sha256;
      state.saveRuntime(ts);
      state.appendTimeline(cfg, ts.id, `补记获批 spec 的版本哈希 ${shortSha(check.sha256)}（升级前批准的任务）`);
    }
    return null;
  }
  state.appendEventAlways(cfg, ts.id, 'spec_tampered', { reason: check.reason, expected: check.expected, actual: check.actual });
  return openHumanGate(ts, cfg, {
    kind: 'help',
    requestedBy: 'kernel',
    summary: `获批 spec 的冻结稿与批准时不一致（${check.reason}：批准时 ${shortSha(check.expected) ?? '-'}，现在 ${shortSha(check.actual) ?? '缺失'}）。`
      + `内核已停止派工。请把 dossier/${ts.id}/spec.md 恢复成批准时的内容（specs/archive/ 下有 ${ts.id}-approved-* 副本）后 resume；`
      + '确实要改需求，请 resume 并在 notes 里要求 router 走 spec 动作重新送审。',
    refs: [relRef(cfg, state.dossierPath(cfg, ts.id, 'spec.md'))],
    round: allocateRound(ts),
  });
}

// ---- handler ----

export default async function routingHandler(ts, cfg) {
  const id = ts.id;
  const planActive = ts.runtime.plan_active === true;

  // 人要求暂停（`conductor pause <id>` 在任务目录里放一个 PAUSED 标记）：不派工、不花钱、不改状态，
  // `conductor unpause` 后原地继续。标记是文件而不是 runtime 字段——runner 正持着任务锁跑一个长
  // dispatch 时人也能暂停，下一步开头就生效。
  if (fs.existsSync(path.join(ts.dir, 'PAUSED'))) return { changed: false };

  // 1. 先把上一个 runner 没收尾的事收掉（残留 agent、没关账的 dispatch、没提交的改动、没对上的账）。
  await recoverTask(ts, cfg, recoveryDeps(cfg));

  const boxed = checkBudgetAndBox(ts, cfg) ?? checkRoundCapAndBox(ts, cfg);
  if (boxed) return boxed;
  if (!canStartSpawn(ts, cfg, 'router')) return { changed: false };

  // 2. 获批 spec 没被动过；当前适用版本有摘要（没有就补，补不出来就明确降级）。
  const tampered = guardApprovedSpec(ts, cfg);
  if (tampered) return tampered;
  const spec = currentSpec(cfg, ts);
  if (spec && ts.runtime.spec_approved === true && cfg.digestEnabled !== false) {
    const before = digestStateFor(cfg, id, spec).state;
    if (before === 'missing' || before === 'invalid') {
      const d = await ensureDigest(ts, cfg, spec);
      if (d.result) return d.result;
      if (d.state === 'skipped') return { changed: false };
      if (d.state === 'missing' || d.state === 'invalid') return { changed: true }; // 还有重试额度：下一步再试，期间重新过各道闸
    }
  }
  const digest = spec && cfg.digestEnabled !== false ? digestStateFor(cfg, id, spec) : null;

  // 3. 停滞保险丝：数硬进展，不数轮数。
  let records = composeRecords(cfg, id, { planActive });
  const facts = collectFacts(ts, cfg, { records });
  const stall = checkStallAndBox(ts, cfg, progressFingerprint(ts, cfg, facts, records));
  if (stall.boxed) return stall.boxed;
  facts.stallRounds = stall.stall;

  // 4. 问 router。
  const round = allocateRound(ts); // 轮次先落盘：spawn 中途崩溃时下一轮用新编号，不覆盖案卷
  const ledgers = listLedgers(cfg, id);
  const wt = worktreePath(cfg, id);
  const patchPath = facts.hasDiff && fs.existsSync(wt) ? materializeDiffView(cfg, id, wt, ts.task.baseBranch, facts.head) : null;
  const notesPath = routerNotesPath(cfg, id);
  const prompt = buildRouterPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'router', round),
    notesPath,
    brief: readBriefText(ts),
    specInfo: specInfoText(cfg, ts, spec),
    digest: digestText(digest),
    notes: readNotesForPrompt(notesPath),
    records: renderRecordsForRouter(records, { window: cfg.routerRecordWindow ?? DEFAULT_ROUTER_RECORD_WINDOW }),
    facts: renderFactsText(ts, cfg, facts, records, { round, spec, digest, ledgers, patchPath }),
  });

  const readRoots = [
    state.dossierPath(cfg, id),
    ...(spec ? [spec.path] : []),
    ...(fs.existsSync(wt) ? [wt] : []),
  ];
  const res = await spawnAgentRound(ts, cfg, { role: 'router', round, prompt, planActive, readRoots });
  if (spawnSkipped(res)) return { changed: false }; // run 级闸门（上面已查过一次，这里是兜底）
  const limited = rateLimitedToBox(ts, cfg, 'router', res);
  if (limited) return limited;

  // 工作记忆：合格就留快照，写坏了就还原（不算 router 失效）。
  const notes = settleNotes(notesPath, round);
  writeRouterState(cfg, id, { notes_error: notes.status === 'restored' ? notes.errors.slice(0, 3).join('；') : null });
  if (notes.status === 'restored') state.appendTimeline(cfg, id, `router r${round} 的工作记忆不合格，已还原上一份（${notes.errors[0] ?? ''}）`);

  records = composeRecords(cfg, id, { planActive });
  const decision = records.find((r) => r.role === 'router' && r.round === round && r.package == null);

  if (!decision || decision.product !== 'ok') {
    const why = decision?.product_error?.join('; ') ?? (decision ? decision.product : 'router 记录缺失');
    return registerFailure(ts, cfg, round, `router 记录 product=${decision?.product ?? 'missing'}（${why}）`);
  }
  if (!ACTIONS.includes(decision.action)) {
    return registerFailure(ts, cfg, round, `action 不在闭集内：${JSON.stringify(decision.action)}`);
  }

  state.appendEventAlways(cfg, id, 'router_decision', {
    round,
    action: decision.action,
    tier: decision.tier ?? null,
    packages: decision.packages ?? null,
    assignments: decision.assignments?.map((a) => ({ key: a.key, profile: a.profile, intent: a.intent, title: a.title })) ?? null,
    summary: decision.summary ?? null,
  });
  state.appendTimeline(cfg, id, `router r${round} → ${decision.action}${decision.tier ? `(${decision.tier})` : ''}`
    + `${decision.assignments ? `[${decision.assignments.map((a) => `${a.key}:${a.profile}`).join(', ')}]` : ''}：${decision.summary ?? ''}`);

  const rejected = checkPrecondition(ts, cfg, decision, { records, facts });
  if (rejected) return rejectAction(ts, cfg, round, decision.action, rejected);

  clearFailures(cfg, id);
  return executeAction(ts, cfg, decision, { round, records, facts });
}
