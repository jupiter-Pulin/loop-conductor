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
/** reviewer 分诊模式的聚合桶：tests / full 来自 summary 首行，unset = 没有分诊行。 */
const REVIEW_MODES = ['tests', 'full', 'unset'];

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
  const events = readEvents(dossierDir);
  let committerValidAttempt = null;
  let committerDegraded = false;
  let sawCommitterEvents = false;
  for (const ev of events) {
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

  const router = collectRouterEra(root, id, isRouter, events);

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

/** reviewer 分诊模式：summary 首行 `mode=tests|full …`（无 spec 任务的分诊段约定）；没有 → null（未分诊）。 */
const REVIEW_MODE_RE = /^mode=(tests|full)\b/;
function reviewModeOf(rec) {
  const first = String(rec?.summary ?? '').split('\n')[0].trim();
  const m = first.match(REVIEW_MODE_RE);
  return m ? m[1] : null;
}

/** 某轮之前最近一条 reviewer 记录（按轮次），没有 → null。 */
function latestReviewerBefore(records, round) {
  let best = null;
  for (const r of records) {
    if (r.role !== 'reviewer' || !(r.round < round)) continue;
    if (best == null || r.round > best.round) best = r;
  }
  return best;
}

/** 摘要的逐版本元数据（`dossier/<id>/digest/<sha12>.meta.json`，内核写）：尝试次数与当时的校验结果。 */
function collectDigestMeta(dossierDir) {
  const dir = path.join(dossierDir, 'digest');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^[0-9a-f]{12}\.meta\.json$/.test(n))
    .sort()
    .map((n) => {
      const meta = readJsonIf(path.join(dir, n)) ?? {};
      return {
        sha: n.slice(0, 12),
        attempts: Array.isArray(meta.attempts) ? meta.attempts.length : 0,
        valid: meta.valid === true,
      };
    });
}

/** 事件流里按 type 计数（本工具只取关心的几类，其余忽略）。 */
function countEvents(events, types) {
  const counts = Object.fromEntries(types.map((t) => [t, 0]));
  for (const ev of events ?? []) {
    if (Object.hasOwn(counts, ev?.type)) counts[ev.type] += 1;
  }
  return counts;
}

/** 分桶计数：worker 的 profile / outcome 分布都走这一个。 */
function tally(target, key) {
  const k = key ?? 'unset';
  target[k] = (target[k] ?? 0) + 1;
}

/**
 * 新状态机的逐任务证据（AC-029）：router 轮次、precommit 各步与 tier、各角色成本、人闸，
 * 以及 reviewer 的分诊模式与测试审的后效。
 * 记录合成复用 `conductor/lib/records.mjs::composeRecords`——本工具不另写一套 log 解析。
 * P2b 的工作包字段（包数 / 并行轮数 / plan 次数）先按 0 输出并预留，字段名与后续实现对齐。
 *
 * 并行纪元补充：worker（router 派出的委派执行者）与 digest（摘要 agent）两个角色同样进
 * agent_records 与角色成本；worker 另按权限档分布、截断 / 中断 / 自动续跑单独计数——
 * 「续跑」的判据是内核盖的 resume_of，不是文案。
 */
function collectRouterEra(root, id, isRouter, events = []) {
  const empty = {
    is_router: false,
    router_rounds: [],
    agent_records: [],
    precommit_rounds: [],
    human_gates: [],
    role_cost_usd: {},
    precommit_fail_after_tests_review: 0,
    merge_rejected_after_tests_review: 0,
    packages_count: 0,
    parallel_rounds: 0,
    plan_runs: 0,
    worker: { rounds: 0, by_profile: {}, outcomes: {}, truncated: 0, interrupted: 0, auto_continue: 0, product_not_ok: 0 },
    digest: { spawns: 0, cost_usd: 0, versions: 0, valid_versions: 0, attempts: 0, ready: 0, invalid: 0, failed: 0 },
    event_counts: { boundary_violation: 0, recovered: 0 },
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

  // 测试审的后效：一次 mode=tests 的 review 之后 precommit 红了、或 merge 闸被人打回，各计一次——
  // 两者都是「轻审可能放过了什么」的可观测代理；合并后才发现的问题不进案卷，没有更好的数据源。
  let precommitFailAfterTests = 0;
  let mergeRejectedAfterTests = 0;
  for (const r of records) {
    const precommitFail = r.role === 'precommit' && r.outcome === 'fail';
    const mergeRejected = r.role === 'human' && r.kind === 'merge' && r.decision === 'rejected';
    if (!precommitFail && !mergeRejected) continue;
    if (reviewModeOf(latestReviewerBefore(records, r.round)) !== 'tests') continue;
    if (precommitFail) precommitFailAfterTests += 1;
    else mergeRejectedAfterTests += 1;
  }

  const workerRecords = records.filter((r) => r.role === 'worker');
  const worker = {
    rounds: workerRecords.length,
    by_profile: {},
    outcomes: {},
    truncated: workerRecords.filter((r) => r.truncated === true).length,
    interrupted: workerRecords.filter((r) => r.interrupted === true).length,
    // 自动续跑 = 内核标了 resume_of 的那一次 spawn（接着上一次会话做，不是重新派工）。
    auto_continue: workerRecords.filter((r) => r.resume_of != null).length,
    product_not_ok: workerRecords.filter((r) => r.product !== 'ok').length,
  };
  for (const r of workerRecords) {
    tally(worker.by_profile, r.profile);
    tally(worker.outcomes, r.outcome);
  }

  const digestRecords = records.filter((r) => r.role === 'digest');
  const digestMeta = collectDigestMeta(path.join(root, 'dossier', id));
  const digestEvents = countEvents(events, ['digest_ready', 'digest_invalid', 'digest_failed']);
  const digest = {
    spawns: digestRecords.length,
    cost_usd: round6(digestRecords.reduce((s, r) => s + (r.cost_usd ?? 0), 0)),
    versions: digestMeta.length,
    valid_versions: digestMeta.filter((m) => m.valid).length,
    attempts: digestMeta.reduce((s, m) => s + m.attempts, 0),
    ready: digestEvents.digest_ready,
    invalid: digestEvents.digest_invalid,
    failed: digestEvents.digest_failed,
  };

  return {
    is_router: true,
    router_rounds: records.filter((r) => r.role === 'router').map((r) => ({
      round: r.round, action: r.action, tier: r.tier, product: r.product, cost_usd: r.cost_usd ?? 0,
    })),
    agent_records: records
      .filter((r) => ['spec', 'maker', 'reviewer', 'worker', 'digest'].includes(r.role))
      .map((r) => ({
        round: r.round, role: r.role, package: r.package, mode: r.mode, outcome: r.outcome,
        tier: r.tier, product: r.product, truncated: r.truncated === true, cost_usd: r.cost_usd ?? 0,
        duration_ms: r.duration_ms ?? null,
        review_mode: r.role === 'reviewer' ? reviewModeOf(r) : null,
        // worker 专属的内核事实（谁、按什么权限档、做什么、接着谁做、集成了没有）。
        key: r.key ?? null,
        profile: r.profile ?? null,
        intent: r.intent ?? null,
        interrupted: r.interrupted === true,
        resume_of: r.resume_of ?? null,
        integration: r.integration ?? null,
      })),
    worker,
    digest,
    event_counts: countEvents(events, ['boundary_violation', 'recovered']),
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
    precommit_fail_after_tests_review: precommitFailAfterTests,
    merge_rejected_after_tests_review: mergeRejectedAfterTests,
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

  // reviewer 按分诊模式聚合：轮数 / fail / 成本 / 时长。summary 首行没有 mode 的（有 spec 的任务、
  // 分诊段落地前的旧案卷）归 unset，旧案卷的数字不因新口径而变。
  const byMode = Object.fromEntries(REVIEW_MODES.map((m) => [m, { rounds: 0, fails: 0, cost_usd: 0, duration_ms: 0 }]));
  for (const r of agents) {
    if (r.role !== 'reviewer') continue;
    const b = byMode[r.review_mode ?? 'unset'];
    b.rounds += 1;
    if (r.outcome === 'fail') b.fails += 1;
    b.cost_usd = round6(b.cost_usd + (r.cost_usd ?? 0));
    b.duration_ms += r.duration_ms ?? 0;
  }

  // worker / digest / 边界与恢复事件：逐任务已经分好桶，这里只做加法，口径不在两处各写一遍。
  const worker = { rounds: 0, by_profile: {}, outcomes: {}, truncated: 0, interrupted: 0, auto_continue: 0, product_not_ok: 0 };
  const digest = { spawns: 0, cost_usd: 0, versions: 0, valid_versions: 0, attempts: 0, ready: 0, invalid: 0, failed: 0 };
  const eventCounts = { boundary_violation: 0, recovered: 0 };
  for (const t of routerTasks) {
    for (const k of ['rounds', 'truncated', 'interrupted', 'auto_continue', 'product_not_ok']) {
      worker[k] += t.worker?.[k] ?? 0;
    }
    for (const [bucket, key] of [['by_profile', 'by_profile'], ['outcomes', 'outcomes']]) {
      for (const [name, n] of Object.entries(t.worker?.[key] ?? {})) worker[bucket][name] = (worker[bucket][name] ?? 0) + n;
    }
    for (const k of ['spawns', 'versions', 'valid_versions', 'attempts', 'ready', 'invalid', 'failed']) {
      digest[k] += t.digest?.[k] ?? 0;
    }
    digest.cost_usd = round6(digest.cost_usd + (t.digest?.cost_usd ?? 0));
    for (const k of Object.keys(eventCounts)) eventCounts[k] += t.event_counts?.[k] ?? 0;
  }

  return {
    tasks: routerTasks.length,
    rounds_total: routerRounds.length,
    actions,
    router_product_not_ok: routerRounds.filter((r) => r.product !== 'ok').length,
    maker_product_not_ok: agents.filter((r) => r.role === 'maker' && r.product !== 'ok').length,
    maker_truncated: agents.filter((r) => r.role === 'maker' && r.truncated).length,
    worker,
    digest,
    event_counts: eventCounts,
    reviewer_fails: agents.filter((r) => r.role === 'reviewer' && r.outcome === 'fail').length,
    reviewer_rounds: agents.filter((r) => r.role === 'reviewer').length,
    reviewer_by_mode: byMode,
    precommit_fail_after_tests_review: routerTasks.reduce((s, t) => s + t.precommit_fail_after_tests_review, 0),
    merge_rejected_after_tests_review: routerTasks.reduce((s, t) => s + t.merge_rejected_after_tests_review, 0),
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

/** `a×2，b×1` 形式的分桶文案（多的在前、同数按名字）；空桶给「（无）」。
 *  显式排序而不是靠插入顺序：插入顺序取决于记录合成的次序，同一批数据不该渲染出两种文案。 */
function bucketText(bucket) {
  const entries = Object.entries(bucket ?? {}).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([k, v]) => `${k}×${v}`).join('，') : '（无）';
}

/** worker / 摘要 / 边界与恢复三行（并行纪元的量尺）；没有数据时也照常出现，口径不随数据漂移。 */
function renderWorkerLines(router) {
  const w = router.worker ?? { rounds: 0, by_profile: {}, outcomes: {}, truncated: 0, interrupted: 0, auto_continue: 0, product_not_ok: 0 };
  const d = router.digest ?? { spawns: 0, cost_usd: 0, versions: 0, valid_versions: 0, attempts: 0, ready: 0, invalid: 0, failed: 0 };
  const e = router.event_counts ?? { boundary_violation: 0, recovered: 0 };
  return [
    `- worker：${w.rounds} 轮（权限档：${bucketText(w.by_profile)}；结果：${bucketText(w.outcomes)}）；`
    + `截断 ${w.truncated}，中断 ${w.interrupted}，自动续跑 ${w.auto_continue}，无交付 ${w.product_not_ok}`,
    `- 摘要：${d.spawns} 次会话（$${d.cost_usd}）；spec 版本 ${d.versions}（有效 ${d.valid_versions}），尝试 ${d.attempts} 次；`
    + `事件 ready ${d.ready} / invalid ${d.invalid} / failed ${d.failed}`,
    `- 边界与恢复：越界改动 ${e.boundary_violation} 次；崩溃后恢复 ${e.recovered} 次`,
  ];
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function minutes(ms) {
  return Math.round(((ms ?? 0) / 60000) * 10) / 10;
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
  const modes = REVIEW_MODES.map((m) => {
    const b = router.reviewer_by_mode[m];
    return `${m === 'unset' ? '未分诊' : m}×${b.rounds}（$${b.cost_usd}，${minutes(b.duration_ms)} min，fail ${b.fails}）`;
  }).join('；');
  L.push(`- reviewer 分诊：${modes}；tests 审后 precommit 红 ${router.precommit_fail_after_tests_review} 次、merge 闸打回 ${router.merge_rejected_after_tests_review} 次`);
  L.push(`- precommit：${router.precommit.runs} 次（ok ${router.precommit.ok} / fail ${router.precommit.fail}）；tier 分布：${tiers}`);
  L.push(`- precommit 各步：${steps}`);
  L.push(`- 人闸：spec×${router.human_gates.spec}，merge×${router.human_gates.merge}，help×${router.human_gates.help}`);
  L.push(...renderWorkerLines(router));
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
    const workers = t.agent_records.filter((r) => r.role === 'worker');
    lines.push(`worker: ${workers.map((r) => `r${r.round} ${r.key ?? '?'}/${r.profile ?? '?'}/${r.intent ?? '?'} ${r.outcome ?? '未知'}`
      + `${r.truncated ? ' truncated' : ''}${r.interrupted ? ' interrupted' : ''}${r.resume_of ? ` resume_of:r${r.resume_of}` : ''}`
      + `${r.integration ? ` integration:${r.integration}` : ''}`).join('；') || '-'}`);
    lines.push(`worker 汇总: ${t.worker.rounds} 轮（权限档 ${bucketText(t.worker.by_profile)}）；`
      + `截断 ${t.worker.truncated} / 中断 ${t.worker.interrupted} / 自动续跑 ${t.worker.auto_continue}`);
    lines.push(`摘要: ${t.digest.spawns} 次会话（$${t.digest.cost_usd}）；版本 ${t.digest.versions}（有效 ${t.digest.valid_versions}）；`
      + `尝试 ${t.digest.attempts}；事件 ready ${t.digest.ready} / invalid ${t.digest.invalid} / failed ${t.digest.failed}`);
    lines.push(`边界与恢复: 越界改动 ${t.event_counts.boundary_violation} / 恢复 ${t.event_counts.recovered}`);
    lines.push(`各角色成本: ${Object.entries(t.role_cost_usd).map(([k, v]) => `${k} $${v}`).join('，') || '-'}`);
    const reviews = t.agent_records.filter((r) => r.role === 'reviewer');
    lines.push(`reviewer 模式: ${reviews.map((r) => `r${r.round} ${r.review_mode ?? '未分诊'}（$${r.cost_usd}，${minutes(r.duration_ms)} min）`).join('，') || '-'}`);
    lines.push(`tests 审后: precommit 红 ${t.precommit_fail_after_tests_review} / merge 打回 ${t.merge_rejected_after_tests_review}`);
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
