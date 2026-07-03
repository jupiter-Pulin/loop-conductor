// 集成（新）：green gate 失败不再直接 FAILED_BOX，而是写 repair-context(green_gate) → FIXING，
// 走 maker miss 阶梯（契约 §6/§11，AC-005/006/014）。失败轮不得 spawn verifier。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const NOFIX = { session_id: 'sess-m1', cost: 0.1, result: 'attempted but tests still red' };
const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

test('green gate 失败 → repair-context(green_gate) → FIXING → 修复 → pass', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260620-601';
  env.writeTask(id);
  env.setScenario([
    NOFIX, // 0 maker r1：什么都没改，worktree 仍是预埋 bug → green gate 必红
    { actions: [FIX], session_id: 'sess-m1', cost: 0.08, result: 'r2 修好' }, // 1 maker r2（resume）
    verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' }), // 2 verifier r2 pass
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // green gate r1 失败：写 green-gate-r1.json，exit 非 0
  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gg1.round, 1);
  assert.notEqual(gg1.exit_code, 0, 'green gate r1 必红');

  // AC-006：green gate 失败的轮次不得 spawn verifier
  assert.ok(!env.exists(env.dossier(id, 'verifier-r1.json')), '失败轮不得 spawn verifier');

  // repair-context-r1：source green_gate、failed_criteria 空；存储层只存 green_gate_ref，不复制 tail
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'green_gate');
  assert.deepEqual(ctx.failed_criteria, []);
  assert.equal(ctx.green_gate, null);
  assert.equal(ctx.green_gate_ref, 'green-gate-r1.json');

  // miss 阶梯：green 失败计入 maker_miss_count（AC-005），路由 FIXING 而非直接收箱
  // 最终 r2 修好 → green pass → verifier pass → AWAIT_HUMAN_MERGE
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, 'green 失败消耗一次 maker miss');

  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker r1 + maker r2(resume) + verifier r2');
  assert.equal(resumeIdOf(calls[1]), 'sess-m1', 'FIXING 第一档 resume 原 maker');
  const repairPrompt = promptOf(calls[1]);
  assert.ok(repairPrompt.includes('"green_gate_ref": "green-gate-r1.json"'), 'repair prompt 保留 green_gate_ref');
  assert.ok(repairPrompt.includes('"green_gate"'), 'repair prompt 展开 green_gate 摘要给 maker');
  assert.ok(repairPrompt.includes('"stdout_tail"') && repairPrompt.includes('"stderr_tail"'), 'repair prompt 展开测试 tail');
  const gg2 = env.readJson(env.dossier(id, 'green-gate-r2.json'));
  assert.equal(gg2.exit_code, 0, 'green gate r2 转绿');
  assert.ok(env.exists(env.dossier(id, 'verify-r2.verdict.json')), '修复轮才 spawn verifier');
});

test('green-gate tail 有界；repair-context 只存 green_gate_ref（AC-014）', (t) => {
  const TAIL = 40;
  // maxMakerMisses=1：第一次 green 失败即耗尽阶梯收箱，只 spawn 一次 maker，断言更聚焦。
  const env = makeEnv(t, { config: { greenGateOutputTailBytes: TAIL, maxMakerMisses: 1 } });
  const id = 'task-20260620-602';
  env.writeTask(id);
  env.setScenario([NOFIX]); // 只跑一次 maker，不修 → green 失败 → 收箱

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted');

  // green-gate-r1.json 的 tail ≤ TAIL；repair-context 只存 ref，不复制 tail
  const gg = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.ok(Buffer.byteLength(gg.stdout_tail, 'utf8') <= TAIL, 'green-gate stdout_tail 有界');
  assert.ok(Buffer.byteLength(gg.stderr_tail, 'utf8') <= TAIL, 'green-gate stderr_tail 有界');
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.green_gate, null);
  assert.equal(ctx.green_gate_ref, 'green-gate-r1.json');
  // node --test 失败输出远大于 40 字节，确实发生了截断
  assert.ok(Buffer.byteLength(gg.stdout_tail, 'utf8') > 0, 'tail 非空（确有输出被截断保留）');
});
