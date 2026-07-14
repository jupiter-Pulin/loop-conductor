// dashboard/metrics.mjs 单测（P5 AC-001~007）：只读聚合 done+failed 两箱，四类夹具（正常两轮任务、
// 缺 verify/green gate JSON 任务、failed 任务、timeline 缺行+乱序任务）手算数值逐项断言。
// 风格同 tests/unit/dashboard-rounds.test.mjs / tests/unit/dossier-stats.test.mjs：
// fs.mkdtempSync 建临时根，写 state/{done,failed}/<id>/{task.json,runtime.json} 与
// dossier/<id>/{maker,test-gate,green-gate,verify}-r<N>.json + timeline.md 夹具。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNewTask } from '../../conductor/lib/state.mjs';
import { LANE_ORDER } from '../../conductor/dashboard/model.mjs';
import { buildMetrics } from '../../conductor/dashboard/metrics.mjs';

function mkroot(prefix = 'dashboard-metrics-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseCfg(root) {
  return {
    root,
    queueDir: path.join(root, 'state', 'queue'),
    doneDir: path.join(root, 'state', 'done'),
    failedDir: path.join(root, 'state', 'failed'),
    dossierDir: path.join(root, 'dossier'),
  };
}

function ensureDirs(cfg) {
  for (const d of [cfg.queueDir, cfg.doneDir, cfg.failedDir, cfg.dossierDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function baseTask(id, over = {}) {
  return {
    schema_version: 1,
    id,
    kind: 'bugfix',
    title: `标题 ${id}`,
    repo: 'target',
    targetRepo: '/abs/target',
    baseBranch: 'main',
    testCommand: 'node --test',
    created_at: '2026-07-13T00:00:00.000Z',
    ...over,
  };
}

function baseRuntime(stage, over = {}) {
  return {
    schema_version: 1,
    stage,
    maker_miss_count: 0,
    verifier_invalid_count: 0,
    spent_usd: 0,
    approval: null,
    maker_session_id: null,
    current_round: 0,
    last_failure_type: null,
    updated_at: '2026-07-13T00:00:00.000Z',
    ...over,
  };
}

function dossierDirFor(cfg, id) {
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
}

function writeTimeline(dir, lines) {
  fs.writeFileSync(path.join(dir, 'timeline.md'), `${lines.join('\n')}\n`);
}

function makerRecord(round, over = {}) {
  return { role: 'maker', round, ok: true, cost_usd: 1.23, raw: { num_turns: 10 }, ...over };
}

function testGateRecord(round, verdict, over = {}) {
  return { schema_version: 1, round, command: 'node --test', verdict, mode: 'suite', exit_code: 0, mapping_status: 'valid', stdout_tail: '', ...over };
}

function greenGateRecord(round, exitCode, over = {}) {
  return { schema_version: 1, round, command: 'node --test', cwd: 'worktrees/x', exit_code: exitCode, stdout_tail: 'ok\n', stderr_tail: '', ...over };
}

function verdictRecord(round, overall, criteriaResults, over = {}) {
  return { schema_version: 1, round, overall, criteria_results: criteriaResults, non_ac_findings: [], ...over };
}

// ---- 综合夹具：5 个 done/failed 任务，逐盘手算数值 ----
//
// A（done, bugfix, spent 2.0）：单轮 pass，timeline 覆盖 6 泳道各一段（60/120/240/480/960/1920 秒）。
// B（done, feature, spent 5.5）：两轮（r1 test-gate vacuous + green-gate fail，r2 pass），
//   timeline 贡献 maker=1200s、verify=300s、merge=900s。
// C（failed, bugfix, spent 3.25）：单轮 maker.ok=false 且 verifier fail → primaryRejectDoor=verifier，
//   timeline 贡献 maker=120s、verify=480s。
// D（done, bugfix, spent 1.0）：仅 maker-r1，无 test-gate/green-gate/verify（AC-006 隔离夹具）。
// E（done, probe, spent 0.75）：无 maker 轮；timeline 含缺行（非法行）与乱序区间（应被跳过），
//   仅保留一段有效 verify 区间 900s。
function buildFixture(cfg) {
  const a = 'task-20260713-950';
  const aDir = dossierDirFor(cfg, a);
  writeNewTask(cfg.doneDir, baseTask(a, { kind: 'bugfix' }), baseRuntime('DONE', { spent_usd: 2.0 }));
  writeJson(aDir, 'maker-r1.json', makerRecord(1, { cost_usd: 1.5 }));
  writeJson(aDir, 'test-gate-r1.json', testGateRecord(1, 'falsifies'));
  writeJson(aDir, 'green-gate-r1.json', greenGateRecord(1, 0));
  writeJson(aDir, 'verify-r1.verdict.json', verdictRecord(1, 'pass', [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }]));
  writeTimeline(aDir, [
    '- 2026-07-01T00:00:00.000Z stage → NEEDS_TARGET_SETUP (created)',
    '- 2026-07-01T00:01:00.000Z stage → NEEDS_FEASIBILITY (setup approved)',
    '- 2026-07-01T00:03:00.000Z stage → NEEDS_SPEC (feasibility approved)',
    '- 2026-07-01T00:07:00.000Z stage → READY (spec approved)',
    '- 2026-07-01T00:15:00.000Z stage → VERIFY (maker r1 done)',
    '- 2026-07-01T00:31:00.000Z stage → AWAIT_HUMAN_MERGE (verify pass)',
    '- 2026-07-01T01:03:00.000Z stage → DONE (merged)',
  ]);

  const b = 'task-20260713-951';
  const bDir = dossierDirFor(cfg, b);
  writeNewTask(cfg.doneDir, baseTask(b, { kind: 'feature' }), baseRuntime('DONE', { spent_usd: 5.5 }));
  writeJson(bDir, 'maker-r1.json', makerRecord(1, { cost_usd: 1.0 }));
  writeJson(bDir, 'test-gate-r1.json', testGateRecord(1, 'vacuous'));
  writeJson(bDir, 'green-gate-r1.json', greenGateRecord(1, 1));
  writeJson(bDir, 'maker-r2.json', makerRecord(2, { cost_usd: 2.0 }));
  writeJson(bDir, 'green-gate-r2.json', greenGateRecord(2, 0));
  writeJson(bDir, 'verify-r2.verdict.json', verdictRecord(2, 'pass', [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }]));
  writeTimeline(bDir, [
    '- 2026-07-02T00:00:00.000Z stage → READY (spec approved)',
    '- 2026-07-02T00:05:00.000Z stage → FIXING (test gate vacuous r1)',
    '- 2026-07-02T00:20:00.000Z stage → VERIFY (maker r2 done)',
    '- 2026-07-02T00:25:00.000Z stage → AWAIT_HUMAN_MERGE (verify pass)',
    '- 2026-07-02T00:40:00.000Z stage → DONE (merged)',
  ]);

  const c = 'task-20260713-952';
  const cDir = dossierDirFor(cfg, c);
  writeNewTask(cfg.failedDir, baseTask(c, { kind: 'bugfix' }), baseRuntime('FAILED_BOX', { spent_usd: 3.25, last_failure_type: 'verifier_invalid_exhausted' }));
  writeJson(cDir, 'maker-r1.json', makerRecord(1, { ok: false, cost_usd: 0.5 }));
  writeJson(cDir, 'test-gate-r1.json', testGateRecord(1, 'falsifies'));
  writeJson(cDir, 'green-gate-r1.json', greenGateRecord(1, 0));
  writeJson(cDir, 'verify-r1.verdict.json', verdictRecord(1, 'fail', [{ ac_id: 'AC-001', status: 'fail', reason: 'no', evidence: [] }]));
  writeTimeline(cDir, [
    '- 2026-07-03T00:00:00.000Z stage → READY (spec approved)',
    '- 2026-07-03T00:02:00.000Z stage → VERIFY (maker r1 done)',
    '- 2026-07-03T00:10:00.000Z stage → FAILED_BOX (verifier exhausted)',
  ]);

  const d = 'task-20260713-953';
  const dDir = dossierDirFor(cfg, d);
  writeNewTask(cfg.doneDir, baseTask(d, { kind: 'bugfix' }), baseRuntime('DONE', { spent_usd: 1.0 }));
  writeJson(dDir, 'maker-r1.json', makerRecord(1));
  // 缺 test-gate/green-gate/verify：AC-006 隔离夹具。

  const e = 'task-20260713-954';
  const eDir = dossierDirFor(cfg, e);
  writeNewTask(cfg.doneDir, baseTask(e, { kind: 'probe' }), baseRuntime('DONE', { spent_usd: 0.75 }));
  writeTimeline(eDir, [
    '- 2026-07-05T00:10:00.000Z stage → READY (note1)',
    '不是 timeline 格式的一行',
    '- 2026-07-05T00:05:00.000Z stage → VERIFY (乱序，早于上一条)',
    '- 2026-07-05T00:20:00.000Z stage → DONE (note2)',
  ]);

  return { a, b, c, d, e };
}

test('buildMetrics：totals 与夹具逐项对得上——taskCount/totalSpentUsd/spentPercentiles/avgByKind（AC-002）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  buildFixture(cfg);

  const metrics = buildMetrics(cfg);
  assert.deepEqual(metrics.totals.taskCount, { done: 4, failed: 1 });
  assert.equal(metrics.totals.totalSpentUsd, 2.0 + 5.5 + 3.25 + 1.0 + 0.75);
  assert.deepEqual(metrics.totals.spentPercentiles, { p50: 2.0, p90: 5.5, max: 5.5, n: 5 });
  assert.equal(metrics.totals.avgByKind.bugfix.n, 3);
  assert.equal(metrics.totals.avgByKind.bugfix.mean, (2.0 + 3.25 + 1.0) / 3);
  assert.deepEqual(metrics.totals.avgByKind.feature, { mean: 5.5, n: 1 });
  assert.deepEqual(metrics.totals.avgByKind.probe, { mean: 0.75, n: 1 });
});

test('buildMetrics：yield 六率与夹具逐项对得上，各带 n（AC-003）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  buildFixture(cfg);

  const metrics = buildMetrics(cfg);
  // firstPassRate：done 且 ≥1 maker 轮的任务 {A,B,D} 为分母（n=3）；仅 A（maxRound=1 且 verify-r1 pass）计入分子。
  assert.deepEqual(metrics.yield.firstPassRate, { value: 1 / 3, n: 3 });
  // avgRounds：{A:1, B:2, C:1, D:1}（E 无 maker 轮不计入），均值 5/4。
  assert.deepEqual(metrics.yield.avgRounds, { value: 1.25, n: 4 });
  // makerMissRate：全部 maker 轮 {A-r1,B-r1,B-r2,C-r1,D-r1}=5，其中 C-r1 ok=false。
  assert.deepEqual(metrics.yield.makerMissRate, { value: 1 / 5, n: 5 });
  // verifierRejectRate：全部 verify verdict {A-r1 pass,B-r2 pass,C-r1 fail}=3，其中 1 个 fail。
  assert.deepEqual(metrics.yield.verifierRejectRate, { value: 1 / 3, n: 3 });
  // testGateRejectRate：全部 test-gate {A-r1 falsifies,B-r1 vacuous,C-r1 falsifies}=3，其中 1 个 vacuous。
  assert.deepEqual(metrics.yield.testGateRejectRate, { value: 1 / 3, n: 3 });
  // greenGateFailRate：全部 green-gate {A-r1 pass,B-r1 fail,B-r2 pass,C-r1 pass}=4，其中 1 个 fail。
  assert.deepEqual(metrics.yield.greenGateFailRate, { value: 1 / 4, n: 4 });
});

test('buildMetrics：durations.lanes 顺序恒为六泳道，各带 p50/p90/n；note 剥离与乱序区间跳过均生效（AC-004）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  buildFixture(cfg);

  const metrics = buildMetrics(cfg);
  assert.deepEqual(metrics.durations.lanes.map((l) => l.lane), LANE_ORDER);

  const byLane = Object.fromEntries(metrics.durations.lanes.map((l) => [l.lane, l]));
  assert.deepEqual(byLane.setup, { lane: 'setup', p50: 60, p90: 60, n: 1 });
  assert.deepEqual(byLane.feasibility, { lane: 'feasibility', p50: 120, p90: 120, n: 1 });
  assert.deepEqual(byLane.spec, { lane: 'spec', p50: 240, p90: 240, n: 1 });
  // maker 池：{A:480, B:300+900=1200, C:120}，升序 [120,480,1200] → p50=480, p90=1200。
  assert.deepEqual(byLane.maker, { lane: 'maker', p50: 480, p90: 1200, n: 3 });
  // verify 池：{A:960, B:300, C:480, E:900（E 的乱序区间 -300000ms 已被跳过，仅保留 VERIFY→DONE 的 900s）}，
  // 升序 [300,480,900,960] → p50=480, p90=960。
  assert.deepEqual(byLane.verify, { lane: 'verify', p50: 480, p90: 960, n: 4 });
  // merge 池：{A:1920, B:900}，升序 [900,1920] → p50=900, p90=1920。
  assert.deepEqual(byLane.merge, { lane: 'merge', p50: 900, p90: 1920, n: 2 });
});

test('buildMetrics：table 每行字段与夹具逐项对得上（AC-005）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const ids = buildFixture(cfg);

  const metrics = buildMetrics(cfg);
  const byId = Object.fromEntries(metrics.table.map((r) => [r.id, r]));
  assert.deepEqual(byId[ids.a], { id: ids.a, kind: 'bugfix', box: 'done', rounds: 1, spentUsd: 2.0, primaryRejectDoor: null });
  assert.deepEqual(byId[ids.b], { id: ids.b, kind: 'feature', box: 'done', rounds: 2, spentUsd: 5.5, primaryRejectDoor: null });
  assert.deepEqual(byId[ids.c], { id: ids.c, kind: 'bugfix', box: 'failed', rounds: 1, spentUsd: 3.25, primaryRejectDoor: 'verifier' });
  assert.deepEqual(byId[ids.d], { id: ids.d, kind: 'bugfix', box: 'done', rounds: 1, spentUsd: 1.0, primaryRejectDoor: null });
  assert.deepEqual(byId[ids.e], { id: ids.e, kind: 'probe', box: 'done', rounds: 0, spentUsd: 0.75, primaryRejectDoor: null });
});

test('buildMetrics：缺 gate JSON 的任务不使聚合抛错，只把该任务从受影响指标样本剔除，不污染其它指标（AC-006）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const ids = buildFixture(cfg);

  assert.doesNotThrow(() => buildMetrics(cfg));
  const metrics = buildMetrics(cfg);

  // D：有 maker/花费，但缺 verify verdict —— 计入花费盘 n，不计入 verifierRejectRate 的 n。
  const dRow = metrics.table.find((r) => r.id === ids.d);
  assert.equal(dRow.spentUsd, 1.0);
  assert.ok(metrics.totals.spentPercentiles.n >= 5, 'D 应计入花费盘样本');
  assert.equal(metrics.yield.verifierRejectRate.n, 3, 'D 无 verify verdict，不应计入 verifierRejectRate 分母');
});

test('buildMetrics：花费口径统一取任务级 runtime.spent_usd，门级 maker cost_usd 不参与花费盘（AC-007）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260713-960';
  const dir = dossierDirFor(cfg, id);
  writeNewTask(cfg.doneDir, baseTask(id), baseRuntime('DONE', { spent_usd: 9 }));
  writeJson(dir, 'maker-r1.json', makerRecord(1, { cost_usd: 0.01 }));

  const metrics = buildMetrics(cfg);
  assert.equal(metrics.totals.totalSpentUsd, 9);
  assert.equal(metrics.table[0].spentUsd, 9);
  assert.notEqual(metrics.totals.totalSpentUsd, 0.01);
});

test('buildMetrics：stage token 正确剥离 note 尾缀，不把整段 "READY (spec approved)" 当作 stage 喂给 laneForStage（AC-004）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260713-961';
  const dir = dossierDirFor(cfg, id);
  writeNewTask(cfg.doneDir, baseTask(id), baseRuntime('DONE', { spent_usd: 1 }));
  writeTimeline(dir, [
    '- 2026-07-06T00:00:00.000Z stage → READY (spec approved)',
    '- 2026-07-06T00:10:00.000Z stage → VERIFY (maker r1 done)',
  ]);

  const metrics = buildMetrics(cfg);
  const makerLane = metrics.durations.lanes.find((l) => l.lane === 'maker');
  assert.deepEqual(makerLane, { lane: 'maker', p50: 600, p90: 600, n: 1 });
});

// ---- AC-001：四类夹具（正常两轮任务、缺 gate JSON 任务、failed 任务、timeline 缺行+乱序任务）
// 均返回含五个契约字段的结果且全程不抛错；queue 任务与损坏任务目录不计入。 ----

test('buildMetrics：四类夹具全程不抛错，返回含 totals/yield/durations/table/isEmpty 五字段的对象（AC-001）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  buildFixture(cfg);

  // queue 任务：不应计入任何聚合。
  writeNewTask(cfg.queueDir, baseTask('task-20260713-970'), baseRuntime('READY', { spent_usd: 999 }));

  // 损坏任务目录（task.json 非法 JSON）：listTaskStates 会把它标记为 error，metrics 应跳过而非抛错。
  const badDir = path.join(cfg.doneDir, 'task-20260713-971');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'task.json'), '{ not json');
  fs.writeFileSync(path.join(badDir, 'runtime.json'), '{}');

  // dossier 内损坏 JSON 门（不应使整体聚合抛错）。
  const corruptId = 'task-20260713-972';
  const corruptDir = dossierDirFor(cfg, corruptId);
  writeNewTask(cfg.doneDir, baseTask(corruptId), baseRuntime('DONE', { spent_usd: 0.5 }));
  writeJson(corruptDir, 'maker-r1.json', makerRecord(1));
  fs.writeFileSync(path.join(corruptDir, 'verify-r1.verdict.json'), '{ not valid json');

  assert.doesNotThrow(() => buildMetrics(cfg));
  const metrics = buildMetrics(cfg);
  for (const key of ['totals', 'yield', 'durations', 'table', 'isEmpty']) {
    assert.ok(key in metrics, key);
  }
  assert.equal(metrics.isEmpty, false);
  assert.ok(!metrics.table.some((r) => r.id === 'task-20260713-970'), 'queue 任务不应出现在明细表');
  assert.ok(!metrics.table.some((r) => r.id === 'task-20260713-971'), '损坏任务目录不应出现在明细表');
  assert.equal(metrics.totals.taskCount.done + metrics.totals.taskCount.failed, 6, '5 个正常任务 + 1 个损坏 verify 的任务');
});

test('buildMetrics：done/failed 皆空时返回良构空结构，isEmpty:true，计数为 0，分位为 null，明细表为 []（AC-001 对应空前提）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  const metrics = buildMetrics(cfg);
  assert.deepEqual(metrics, {
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
  });
});

test('buildMetrics：state/dossier 目录完全不存在时不抛错，退化为良构空结构（核心不变量）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root); // 未 ensureDirs：目录压根不存在
  assert.doesNotThrow(() => buildMetrics(cfg));
  assert.equal(buildMetrics(cfg).isEmpty, true);
});
