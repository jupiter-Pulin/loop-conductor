// 集成：独立 Reviewer 影子阶段（R6-H21）。契约：
//   1) 默认 reviewStage='off'：零 reviewer 调用、零 review 产物（旧行为）；
//   2) shadow + gate=ready：产物齐全（review-r<n>.json + compare + spawn 双标记 + 事件），
//      stage 不受影响，reviewer 成本入账；
//   3) shadow + gate=blocked（P1/AC fail）：compare 记 high_risk（false-pass 候选），
//      主路由仍 AWAIT_HUMAN_MERGE——shadow 绝不 block；
//   4) shadow + 协议失败（叙事输出）：review-r<n>.invalid.json 留证，不计 verifier_invalid_count、
//      无 repair-context；
//   5) 只在主 verdict pass 的轮触发：fail 轮不 spawn reviewer，修复后 pass 轮才对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

function reviewJson(over = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    stage: 'review-diff',
    gate: 'ready',
    findings: [],
    acCoverage: [
      { acId: 'AC-001', status: 'pass', evidence: 'lib/stats.mjs 偶数分支已取平均' },
      { acId: 'AC-002', status: 'pass', evidence: '探针 falsifies，套件全绿' },
    ],
    tests: { run: [], suggested: [] },
    residualRisk: false,
    ...over,
  });
}

const BLOCKED_REVIEW = reviewJson({
  gate: 'blocked',
  findings: [{
    severity: 'P1', file: 'lib/stats.mjs', line: 8, title: '空数组未防护',
    impact: 'median([]) 返回 NaN 而非有意义错误', trigger: '空数组输入',
    evidence: 'diff 未含空输入分支', fix: '入口加空数组守卫',
  }],
  acCoverage: [
    { acId: 'AC-001', status: 'pass', evidence: '偶数分支已取平均' },
    { acId: 'AC-002', status: 'fail', evidence: '边界输入未被任何测试钉住' },
  ],
});

test('契约1：默认 off——零 reviewer 调用、零 review 产物', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260708-870';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.calls().length, 2, 'maker + verifier，无 reviewer');
  assert.ok(!env.exists(env.dossier(id, 'review-r1.compare.json')));
  assert.ok(!env.exists(env.dossier(id, 'review-r1.json')));
});

test('契约2：shadow + ready——产物齐全、stage 不变、成本入账、事件落盘', (t) => {
  const env = makeEnv(t, { config: { reviewStage: 'shadow', eventsLogEnabled: true } });
  const id = 'task-20260708-871';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }),
    { cost: 0.03, result: reviewJson() }, // reviewer
  ]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '主 verdict 唯一裁判');
  assert.equal(after.runtime.verifier_invalid_count, 0);
  assert.equal(after.runtime.spent_usd, 0.15, 'reviewer 成本入账（0.1+0.02+0.03）');

  const report = env.readJson(env.dossier(id, 'review-r1.json'));
  assert.equal(report.gate, 'ready');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.metrics.p1, 0);

  const compare = env.readJson(env.dossier(id, 'review-r1.compare.json'));
  assert.equal(compare.main.overall, 'pass');
  assert.equal(compare.review.valid, true);
  assert.equal(compare.disagreement, false);
  assert.equal(compare.high_risk, false);

  const spawnRec = env.readJson(env.dossier(id, 'reviewer-r1.json'));
  assert.ok(spawnRec.started && spawnRec.done, 'reviewer spawn 双标记齐全');
  assert.ok(env.exists(env.dossier(id, 'reviewer-r1.stream.jsonl')));

  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ev = events.filter((e) => e.type === 'review_shadow');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].gate, 'ready');
  assert.equal(ev[0].high_risk, false);
});

test('契约3：shadow + blocked——high_risk 记录，主路由不受影响', (t) => {
  const env = makeEnv(t, { config: { reviewStage: 'shadow' } });
  const id = 'task-20260708-872';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.03, result: BLOCKED_REVIEW },
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', 'shadow 绝不 block');

  const compare = env.readJson(env.dossier(id, 'review-r1.compare.json'));
  assert.equal(compare.review.gate, 'blocked');
  assert.equal(compare.disagreement, true);
  assert.equal(compare.high_risk, true, 'verifier pass + review blocked = false-pass 候选');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /HIGH-RISK（false-pass 候选）/);
  assert.ok(!env.exists(env.dossier(id, 'repair-context-r1.json')), 'shadow 不产生 repair-context');
});

test('契约4：shadow + 协议失败——invalid 留证，不污染主链计数', (t) => {
  const env = makeEnv(t, { config: { reviewStage: 'shadow' } });
  const id = 'task-20260708-873';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.03, result: '我觉得这个 diff 写得不错（非 JSON 叙事）' },
  ]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.verifier_invalid_count, 0, 'review 协议失败绝不计主 invalid');

  const invalid = env.readJson(env.dossier(id, 'review-r1.invalid.json'));
  assert.equal(invalid.kind, 'protocol');
  assert.ok(!env.exists(env.dossier(id, 'review-r1.json')), '无效输出不得落 report');
  const compare = env.readJson(env.dossier(id, 'review-r1.compare.json'));
  assert.equal(compare.review.valid, false);
  assert.equal(compare.disagreement, null);
});

test('契约5：只在主 verdict pass 轮触发——fail 轮不 spawn，修复后 pass 轮对照', (t) => {
  const env = makeEnv(t, { config: { reviewStage: 'shadow' } });
  const id = 'task-20260708-874';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'fail' }, { cost: 0.02 }), // r1 fail → 不跑 review
    { session_id: 'sess-m1', cost: 0.05, result: 'r2 修复' },                 // FIXING maker
    verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }), // r2 pass → 跑 review
    { cost: 0.03, result: reviewJson() },
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.calls().length, 5, 'maker + verifier(fail) + maker + verifier(pass) + reviewer');
  assert.ok(!env.exists(env.dossier(id, 'review-r1.compare.json')), 'fail 轮无 review 产物');
  assert.ok(env.exists(env.dossier(id, 'review-r2.compare.json')), 'pass 轮才对照');
  assert.equal(env.readJson(env.dossier(id, 'review-r2.compare.json')).review.gate, 'ready');
});
