// dashboard/metrics.mjs — 只读跨任务聚合层（P5）：对 done+failed 两箱任务做花费/良率/阶段耗时/
// 逐任务明细四盘聚合，供 /api/metrics 与前端指标视图消费。复用 rounds.mjs::buildRoundsView 与
// model.mjs::parseTimeline/laneForStage；只读磁盘，无写盘、无跨调用缓存句柄。任意输入（缺失/半途/
// 损坏/乱序）永不抛错，最坏退化为良构空结构。
import fs from 'node:fs';
import * as state from '../lib/state.mjs';
import { buildRoundsView } from './rounds.mjs';
import { parseTimeline, laneForStage, LANE_ORDER } from './model.mjs';

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

/** 转移序列 → 该任务各泳道总时长（毫秒）；乱序（d<0）或泳道不可判定的区间跳过。 */
function taskDurationsByLane(timelineEntries) {
  const transitions = extractStageTransitions(timelineEntries);
  const sums = new Map();
  for (let i = 0; i < transitions.length - 1; i++) {
    const cur = transitions[i];
    const next = transitions[i + 1];
    const d = Date.parse(next.ts) - Date.parse(cur.ts);
    if (d < 0) continue;
    const lane = laneForStage(cur.stage);
    if (lane == null) continue;
    sums.set(lane, (sums.get(lane) ?? 0) + d);
  }
  return sums;
}

/** 单任务 → { id, kind, box, spentUsd, rounds, maxRound, durationsByLane }；容错读取，缺失均降级。 */
function collectTaskRecord(cfg, ts) {
  const id = ts.id;
  const kind = ts.task?.kind ?? null;
  const box = ts.box;
  const spentRaw = ts.runtime?.spent_usd;
  const spentUsd = typeof spentRaw === 'number' && Number.isFinite(spentRaw) ? spentRaw : null;
  const { rounds } = buildRoundsView(cfg, id);
  const maxRound = rounds.length ? Math.max(...rounds.map((r) => r.round)) : 0;
  let timelineText = '';
  try { timelineText = fs.readFileSync(state.dossierPath(cfg, id, 'timeline.md'), 'utf8'); } catch { /* timeline 可不存在 */ }
  const durationsByLane = taskDurationsByLane(parseTimeline(timelineText));
  return { id, kind, box, spentUsd, rounds, maxRound, durationsByLane };
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

function buildTable(records) {
  return records.map((r) => ({
    id: r.id, kind: r.kind, box: r.box, rounds: r.maxRound, spentUsd: r.spentUsd,
    primaryRejectDoor: primaryRejectDoorForTask(r),
  }));
}

function buildDurations(records) {
  const pools = new Map(LANE_ORDER.map((lane) => [lane, []]));
  for (const r of records) {
    for (const [lane, ms] of r.durationsByLane) {
      pools.get(lane)?.push(ms / 1000);
    }
  }
  const lanes = LANE_ORDER.map((lane) => {
    const arr = pools.get(lane).slice().sort((a, b) => a - b);
    return {
      lane,
      p50: arr.length ? Math.round(percentile(arr, 50)) : null,
      p90: arr.length ? Math.round(percentile(arr, 90)) : null,
      n: arr.length,
    };
  });
  return { lanes };
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
    durations: { lanes: LANE_ORDER.map((lane) => ({ lane, p50: null, p90: null, n: 0 })) },
    table: [],
    isEmpty: true,
  };
}

/**
 * done+failed 两箱（queue 不计入）→ { totals, yield, durations, table, isEmpty }（契约见 spec.md §Contract）。
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
      durations: buildDurations(records),
      table: buildTable(records),
      isEmpty,
    };
  } catch {
    return emptyMetrics();
  }
}
