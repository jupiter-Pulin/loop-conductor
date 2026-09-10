// stages/routing.mjs — 新状态机的心脏（AC-002 / 003 / 004 / 005）。
//
// 每一轮就是一句话：内核给事实，router 从闭集里选一个动作，内核校前置、执行、记录。
//   拼 prompt（brief + 记录 + 内核事实）→ spawn router（--tools Write，白名单只放它自己的 log）
//   → 合成记录 → 校验 action 与前置 → 执行 → timeline + 事件 router_decision
//
// 内核自行发起的转移只有 AC-005 枚举的六条，本文件占其中四条：
//   spec 通过校验 → AWAIT_HUMAN(spec)（在 actions/spec.mjs）；限额 → FAILED_BOX(rate_limited)；
//   保险丝 → FAILED_BOX(fuse_no_progress)；预算 → FAILED_BOX(budget_exhausted)；
//   router 失效连击 → AWAIT_HUMAN(help)。其余一切转移都由 router 的动作触发。
//
// 「失效」有两种，合并计一根连击线（spec §router 失效连击，Invariant 3 的唯一例外）：
// router 记录 product ≠ ok，或它选的动作被前置拒掉。连续 2 次 → 内核开 help 闸——
// router 是唯一的裁判，裁判缺席时没有别人可以判断。任一次成功决策清零。

import * as state from '../lib/state.mjs';
import { taskCfg } from '../lib/task-cfg.mjs';
import { ACTIONS } from '../lib/log-contract.mjs';
import { composeRecords, renderFacts, renderRecordsForRouter } from '../lib/records.mjs';
import { mergeAllowed, needPrecommit, needReview, reviewerTierAt } from '../lib/version-gate.mjs';
import { buildRouterPrompt } from '../lib/prompts.mjs';
import { logPathFor } from '../lib/agent-settings.mjs';
import { canStartSpawn, failToBox, rateLimitedToBox } from './shared.mjs';
import {
  checkBudgetAndBox, checkFuseAndBox, cleanupTaskArtifacts, everProducedSpec, helpSummaries,
  openHumanGate, readBriefText, readRouterState, relRef, revParseOrNull, spawnAgentRound,
  taskBranchName, taskHasDiff, writeRouterState,
} from './router-kernel.mjs';
import specAction from './actions/spec.mjs';
import makerAction from './actions/maker.mjs';
import reviewAction from './actions/review.mjs';
import precommitAction from './actions/precommit.mjs';

const TIER_ORDER = { unit: 1, integration: 2, e2e: 3 };

/** 连续几次失效开 help 闸（spec：2）。 */
export const ROUTER_FAILURE_LIMIT = 2;

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

/** 内核事实段的全部输入（Invariant 2：spec 正文、diff、代码永不进这里）。 */
function collectFacts(ts, cfg, { records, round }) {
  const repo = taskCfg(ts, cfg).targetRepo;
  const base = ts.task.baseBranch;
  const branch = taskBranchName(ts.id);
  const head = revParseOrNull(repo, branch);
  const baseSha = revParseOrNull(repo, base);
  const st = readRouterState(cfg, ts.id);
  return {
    repo,
    base,
    branch,
    head,
    baseSha,
    needReview: needReview(records, head),
    needPrecommit: needPrecommit(records, head, baseSha),
    hasDiff: taskHasDiff(repo, base, branch),
    lastActionRejected: st.last_action_rejected,
    round,
  };
}

function renderFactsText(ts, cfg, facts, records) {
  return renderFacts({
    stage: 'ROUTING',
    round: facts.round,
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
    packageRows: [], // P2b 才有工作包
    acOwners: {},
  });
}

// ---- 前置校验（spec §router 动作闭集 的「内核前置」列） ----

function checkPrecondition(ts, cfg, decision, { records, facts }) {
  const id = ts.id;
  switch (decision.action) {
    case 'spec':
    case 'abandon':
      return null;
    case 'plan':
      // P2 阶段闸：packagesEnabled 默认 false，plan 一律拒（AC-044）。
      if (cfg.packagesEnabled !== true) return 'packagesEnabled=false：本阶段不支持工作包方案';
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
    case 'review':
      return facts.hasDiff ? null : '任务分支相对 base 没有 diff，无可审内容';
    case 'precommit': {
      const tier = reviewerTierAt(records, facts.head);
      if (tier == null) return `当前 HEAD（${facts.head ? facts.head.slice(0, 6) : '无'}）上没有 reviewer 记录`;
      if ((TIER_ORDER[decision.tier] ?? 0) < (TIER_ORDER[tier] ?? 0)) {
        return `tier=${decision.tier} 低于 reviewer 在当前 HEAD 声明的 ${tier}`;
      }
      return null;
    }
    case 'human': {
      const summary = decision.summary ?? '';
      return helpSummaries(cfg, id).includes(summary) ? 'duplicate_help' : null;
    }
    case 'merge':
      return mergeAllowed(records, facts.head, facts.baseSha)
        ? null
        : `版本规则未满足：need_review=${facts.needReview} need_precommit=${facts.needPrecommit}`;
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
      const r = await makerAction(ts, cfg, { round, records });
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
      const reviewer = latestOf(records, 'reviewer', (r) => r.outcome === 'ok' && r.head_sha === facts.head);
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
 * 产生了新记录（maker / reviewer / precommit）之后跑保险丝（AC-024）。
 * 任务已经因为限额/预算搬箱时（box 已不是 queue）不再叠加判定。
 */
function afterNewRecord(ts, cfg, result) {
  if (ts.box !== 'queue' || ts.runtime.stage !== 'ROUTING') return result;
  const tripped = checkFuseAndBox(ts, cfg, composeRecords(cfg, ts.id, { planActive: ts.runtime.plan_active === true }));
  return tripped ?? result;
}

// ---- handler ----

export default async function routingHandler(ts, cfg) {
  const id = ts.id;
  const planActive = ts.runtime.plan_active === true;

  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;
  if (!canStartSpawn(ts, cfg, 'router')) return { changed: false };

  const round = (ts.runtime.current_round ?? 0) + 1;
  let records = composeRecords(cfg, id, { planActive });
  const facts = collectFacts(ts, cfg, { records, round });

  const prompt = buildRouterPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'router', round),
    brief: readBriefText(ts),
    records: renderRecordsForRouter(records),
    facts: renderFactsText(ts, cfg, facts, records),
  });

  ts.runtime.current_round = round;
  state.saveRuntime(ts); // 轮次先落盘：spawn 中途崩溃时下一轮用新编号，不覆盖案卷
  const res = await spawnAgentRound(ts, cfg, { role: 'router', round, prompt, planActive });
  const limited = rateLimitedToBox(ts, cfg, 'router', res);
  if (limited) return limited;

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
    summary: decision.summary ?? null,
  });
  state.appendTimeline(cfg, id, `router r${round} → ${decision.action}${decision.tier ? `(${decision.tier})` : ''}：${decision.summary ?? ''}`);

  const rejected = checkPrecondition(ts, cfg, decision, { records, facts });
  if (rejected) return rejectAction(ts, cfg, round, decision.action, rejected);

  clearFailures(cfg, id);
  return executeAction(ts, cfg, decision, { round, records, facts });
}
