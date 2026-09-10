// dashboard/metrics.mjs — 只读跨任务聚合层（P5）：对 done+failed 两箱任务做花费/良率/阶段耗时/
// 逐任务明细四盘聚合，供 /api/metrics 与前端指标视图消费。复用 rounds.mjs::buildRoundsView 与
// model.mjs::parseTimeline/laneForStage；只读磁盘，无写盘、无跨调用缓存句柄。任意输入（缺失/半途/
// 损坏/乱序）永不抛错，最坏退化为良构空结构。
import fs from 'node:fs';
import * as state from '../lib/state.mjs';
import { buildRoundsView } from './rounds.mjs';
import { parseTimeline, laneForStage, LANE_ORDER, columnForStage, COLUMN_ORDER } from './model.mjs';

/** nearest-rank 分位：percentile(s,p) = s[clamp(ceil(p/100*n)-1, 0, n-1)]；空数组返回 null。 */
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n) - 1, 0), n - 1);
  return sortedAsc[idx];
}

const STAGE_TOKEN_RE = /^stage → (\S+)/;

/** timelineEntries → 按原序排列的合法 stage 转移序列 { ts, stage }；未匹配到 stage token
 *  或 ts 不可 Date.parse 的条目跳过（不当作转移，也不当作空档丢弃其它条目）。 */
function extractStageTransitions(timelineEntries) {
  const out = [];
  for (const entry of timelineEntries) {
    if (entry.ts == null || Number.isNaN(Date.parse(entry.ts))) continue;
    const m = STAGE_TOKEN_RE.exec(entry.text ?? '');
    if (!m) continue;
    out.push({ ts: entry.ts, stage: m[1] });
  }
  return out;
}

/**
 * 转移序列 → 该任务各分组总时长（毫秒）；乱序（d<0）或分组不可判定的区间跳过。
 * `keyOf` 决定分组口径：旧任务按泳道（laneForStage），新任务按 stage 列（columnForStage）。
 */
function taskDurationsBy(timelineEntries, keyOf) {
  const transitions = extractStageTransitions(timelineEntries);
  const sums = new Map();
  for (let i = 0; i < transitions.length - 1; i++) {
    const cur = transitions[i];
    const next = transitions[i + 1];
    const d = Date.parse(next.ts) - Date.parse(cur.ts);
    if (d < 0) continue;
    const key = keyOf(cur.stage);
    if (key == null) continue;
    sums.set(key, (sums.get(key) ?? 0) + d);
  }
  return sums;
}

/**
 * 单任务 → 聚合原料；容错读取，缺失均降级。
 * 新旧两类口径并存：旧任务看 `rounds`（四门轮次）与泳道耗时，新任务看 `records`
 * （router 轮次 + maker/reviewer/precommit 记录）与 stage 列耗时。同一仓库混装互不干扰。
 */
function collectTaskRecord(cfg, ts) {
  const id = ts.id;
  const kind = ts.task?.kind ?? null;
  const box = ts.box;
  const spentRaw = ts.runtime?.spent_usd;
  const spentUsd = typeof spentRaw === 'number' && Number.isFinite(spentRaw) ? spentRaw : null;
  const { rounds, records } = buildRoundsView(cfg, id);
  const maxRound = rounds.length ? Math.max(...rounds.map((r) => r.round)) : 0;
  const isRouter = records.length > 0;
  const routerMaxRound = isRouter ? Math.max(...records.map((r) => r.round ?? 0)) : 0;
  let timelineText = '';
  try { timelineText = fs.readFileSync(state.dossierPath(cfg, id, 'timeline.md'), 'utf8'); } catch { /* timeline 可不存在 */ }
  const entries = parseTimeline(timelineText);
  return {
    id,
    kind,
    box,
    spentUsd,
    rounds,
    maxRound,
    records,
    isRouter,
    routerMaxRound,
    durationsByLane: taskDurationsBy(entries, laneForStage),
    durationsByColumn: taskDurationsBy(entries, columnForStage),
  };
}

function buildTotals(records) {
  const done = records.filter((r) => r.box === 'done').length;
  const failed = records.filter((r) => r.box === 'failed').length;
  const spentValues = records.map((r) => r.spentUsd).filter((v) => v != null);
  const totalSpentUsd = spentValues.reduce((s, v) => s + v, 0);
  const sortedSpent = [...spentValues].sort((a, b) => a - b);
  const spentPercentiles = {
    p50: percentile(sortedSpent, 50),
    p90: percentile(sortedSpent, 90),
    max: sortedSpent.length ? sortedSpent[sortedSpent.length - 1] : null,
    n: sortedSpent.length,
  };
  const avgByKind = {};
  for (const kind of ['bugfix', 'feature', 'probe']) {
    const values = records.filter((r) => r.kind === kind).map((r) => r.spentUsd).filter((v) => v != null);
    avgByKind[kind] = { mean: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null, n: values.length };
  }
  return { taskCount: { done, failed }, totalSpentUsd, spentPercentiles, avgByKind };
}

function rateOf(items, isHit) {
  return { value: items.length ? items.filter(isHit).length / items.length : null, n: items.length };
}

function buildYield(records) {
  const allRounds = records.flatMap((r) => r.rounds);

  const doneWithRounds = records.filter((r) => r.box === 'done' && r.maxRound >= 1);
  const firstPassRate = rateOf(doneWithRounds, (r) => {
    if (r.maxRound !== 1) return false;
    const round1 = r.rounds.find((x) => x.round === 1);
    return round1?.verifier?.status === 'ok' && round1.verifier.overall === 'pass';
  });

  const withRounds = records.filter((r) => r.maxRound >= 1);
  const avgRounds = {
    value: withRounds.length ? withRounds.reduce((s, r) => s + r.maxRound, 0) / withRounds.length : null,
    n: withRounds.length,
  };

  const makerOk = allRounds.filter((r) => r.maker?.status === 'ok');
  const makerMissRate = rateOf(makerOk, (r) => r.maker.ok === false);

  const verifierOk = allRounds.filter((r) => r.verifier?.status === 'ok');
  const verifierRejectRate = rateOf(verifierOk, (r) => r.verifier.overall === 'fail');

  const testGateOk = allRounds.filter((r) => r.testGate?.status === 'ok');
  const testGateRejectRate = rateOf(testGateOk, (r) => r.testGate.verdict === 'vacuous');

  const greenGateOk = allRounds.filter((r) => r.greenGate?.status === 'ok');
  const greenGateFailRate = rateOf(greenGateOk, (r) => !r.greenGate.pass);

  return { firstPassRate, avgRounds, makerMissRate, verifierRejectRate, testGateRejectRate, greenGateFailRate };
}

/** 任务最大 maker 轮 → 主要打回门；有序判据：verifier→test-gate→green-gate→maker→null。 */
function primaryRejectDoorForTask(record) {
  if (record.maxRound === 0) return null;
  const round = record.rounds.find((r) => r.round === record.maxRound);
  if (!round) return null;
  if (round.verifier?.status === 'ok' && round.verifier.overall === 'fail') return 'verifier';
  if (round.testGate?.status === 'ok' && round.testGate.verdict === 'vacuous') return 'test-gate';
  if (round.greenGate?.status === 'ok' && !round.greenGate.pass) return 'green-gate';
  if (round.maker?.status === 'ok' && round.maker.ok === false) return 'maker';
  return null;
}

/**
 * 新任务的主要打回门：最后一轮的记录说了算，有序判据 precommit→reviewer→maker→null。
 * 与旧口径共用 `table.primaryRejectDoor` 列，取值域不同（新任务只出现 precommit/reviewer/maker）。
 */
function routerRejectDoorForTask(record) {
  if (record.routerMaxRound === 0) return null;
  const last = record.records.filter((r) => r.round === record.routerMaxRound);
  const bad = (role) => last.some((r) => r.role === role && (r.outcome === 'fail' || r.product !== 'ok'));
  if (bad('precommit')) return 'precommit';
  if (bad('reviewer')) return 'reviewer';
  if (last.some((r) => r.role === 'maker' && (r.outcome !== 'ok' || r.product !== 'ok'))) return 'maker';
  return null;
}

function buildTable(records) {
  return records.map((r) => (r.isRouter
    ? {
      id: r.id, kind: r.kind, box: r.box, rounds: r.routerMaxRound, spentUsd: r.spentUsd,
      primaryRejectDoor: routerRejectDoorForTask(r),
    }
    : {
      id: r.id, kind: r.kind, box: r.box, rounds: r.maxRound, spentUsd: r.spentUsd,
      primaryRejectDoor: primaryRejectDoorForTask(r),
    }));
}

function poolPercentiles(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  return {
    p50: sorted.length ? Math.round(percentile(sorted, 50)) : null,
    p90: sorted.length ? Math.round(percentile(sorted, 90)) : null,
    n: sorted.length,
  };
}

function buildDurations(records) {
  const lanePools = new Map(LANE_ORDER.map((lane) => [lane, []]));
  const columnPools = new Map(COLUMN_ORDER.map((column) => [column, []]));
  for (const r of records) {
    for (const [lane, ms] of r.durationsByLane) lanePools.get(lane)?.push(ms / 1000);
    for (const [column, ms] of r.durationsByColumn) columnPools.get(column)?.push(ms / 1000);
  }
  return {
    lanes: LANE_ORDER.map((lane) => ({ lane, ...poolPercentiles(lanePools.get(lane)) })),
    columns: COLUMN_ORDER.map((column) => ({ column, ...poolPercentiles(columnPools.get(column)) })),
  };
}

/**
 * 新状态机的良率盘（旧任务不进这里，旧口径也不受它影响）：
 * router 轮数、reviewer / precommit 打回率、maker 交付缺失率、人闸次数与角色成本。
 */
function buildRouterYield(records) {
  const routerTasks = records.filter((r) => r.isRouter);
  const all = routerTasks.flatMap((r) => r.records);
  const roleRecords = (role) => all.filter((r) => r.role === role);

  const avgRounds = {
    value: routerTasks.length
      ? routerTasks.reduce((s, r) => s + r.routerMaxRound, 0) / routerTasks.length
      : null,
    n: routerTasks.length,
  };

  const humanGates = { spec: 0, merge: 0, help: 0 };
  for (const r of all) {
    if (r.role === 'human' && Object.hasOwn(humanGates, r.kind)) humanGates[r.kind] += 1;
  }

  const costByRole = {};
  for (const r of all) {
    if (r.role === 'human') continue;
    costByRole[r.role] = Math.round(((costByRole[r.role] ?? 0) + (r.cost_usd ?? 0)) * 1e6) / 1e6;
  }

  const tierDistribution = { unit: 0, integration: 0, e2e: 0 };
  for (const r of roleRecords('precommit')) {
    if (Object.hasOwn(tierDistribution, r.tier)) tierDistribution[r.tier] += 1;
  }

  return {
    taskCount: {
      done: routerTasks.filter((r) => r.box === 'done').length,
      failed: routerTasks.filter((r) => r.box === 'failed').length,
    },
    avgRounds,
    reviewerFailRate: rateOf(roleRecords('reviewer').filter((r) => r.product === 'ok'), (r) => r.outcome === 'fail'),
    precommitFailRate: rateOf(roleRecords('precommit').filter((r) => r.product === 'ok'), (r) => r.outcome === 'fail'),
    makerProductMissRate: rateOf(roleRecords('maker'), (r) => r.product !== 'ok'),
    humanGates,
    costByRole,
    tierDistribution,
  };
}

function emptyMetrics() {
  return {
    totals: {
      taskCount: { done: 0, failed: 0 },
      totalSpentUsd: 0,
      spentPercentiles: { p50: null, p90: null, max: null, n: 0 },
      avgByKind: { bugfix: { mean: null, n: 0 }, feature: { mean: null, n: 0 }, probe: { mean: null, n: 0 } },
    },
    yield: {
      firstPassRate: { value: null, n: 0 },
      avgRounds: { value: null, n: 0 },
      makerMissRate: { value: null, n: 0 },
      verifierRejectRate: { value: null, n: 0 },
      testGateRejectRate: { value: null, n: 0 },
      greenGateFailRate: { value: null, n: 0 },
    },
    routerYield: {
      taskCount: { done: 0, failed: 0 },
      avgRounds: { value: null, n: 0 },
      reviewerFailRate: { value: null, n: 0 },
      precommitFailRate: { value: null, n: 0 },
      makerProductMissRate: { value: null, n: 0 },
      humanGates: { spec: 0, merge: 0, help: 0 },
      costByRole: {},
      tierDistribution: { unit: 0, integration: 0, e2e: 0 },
    },
    durations: {
      lanes: LANE_ORDER.map((lane) => ({ lane, p50: null, p90: null, n: 0 })),
      columns: COLUMN_ORDER.map((column) => ({ column, p50: null, p90: null, n: 0 })),
    },
    table: [],
    isEmpty: true,
  };
}

/**
 * done+failed 两箱（queue 不计入）→ { totals, yield, routerYield, durations, table, isEmpty }
 * （契约见 spec.md §Contract）。`yield` 是旧四门口径，`routerYield` 是新记录口径；两类任务
 * 混在一个仓库里各算各的，谁都不污染谁，也都不抛错。
 * 全程容错：任意磁盘状态（缺失/半途/损坏/乱序）永不抛错，最坏退化为良构空结构。
 */
export function buildMetrics(cfg) {
  try {
    const doneStates = state.listTaskStates(cfg.doneDir, 'done').filter((ts) => !ts.error);
    const failedStates = state.listTaskStates(cfg.failedDir, 'failed').filter((ts) => !ts.error);
    const records = [...doneStates, ...failedStates].map((ts) => collectTaskRecord(cfg, ts));
    const totals = buildTotals(records);
    const isEmpty = totals.taskCount.done + totals.taskCount.failed === 0;
    return {
      totals,
      yield: buildYield(records),
      routerYield: buildRouterYield(records),
      durations: buildDurations(records),
      table: buildTable(records),
      isEmpty,
    };
  } catch {
    return emptyMetrics();
  }
}
