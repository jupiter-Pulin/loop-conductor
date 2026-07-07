// 集成（新）：verify/spec_verify 的 verifier spawn 基建失败（非零退出 / 瞬态重试耗尽）
// 不是协议失败——不得写 *.invalid-a<m>.json、不得动 invalid 计数，任务留在原 stage
// 等下次 run 重 spawn（changed:false）。协议失败（res.ok=true 但内容非法）仍走原阶梯，见
// verifier-invalid.test.mjs / verifier-fail.test.mjs。
// 非零退出且无 result 事件（不透明失败）现按疑似瞬态重试（见 lib/claude.mjs::isTransientFailure）；
// 这里把 spawnRetries 收窄到 0，使其在预算内立即耗尽，仍落到同一条「基建失败」路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep, specVerifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const NO_RETRY = { spawnRetries: 0, spawnBackoffMs: [0] };

test('verifier 非零退出（不透明失败，重试预算耗尽）→ 基建失败，留 VERIFY，不计 invalid', (t) => {
  const env = makeEnv(t, { config: NO_RETRY });
  const id = 'task-20260704-501';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'fixed' }, // 0 maker r1（green 绿）
    { exitCode: 1, stderr: 'boom: fake CLI crash' },                       // 1 verifier 非零退出
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'queue', '基建失败不收箱');
  assert.equal(after.runtime.stage, 'VERIFY', '留在 VERIFY 等下次 run 重试');
  assert.equal(after.runtime.verifier_invalid_count, 0, '基建失败不计协议失败计数');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.invalid-a1.json')), '不得产生 invalid 产物');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.verdict.json')), '无合法 verdict');

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /verifier r1 基建失败/, 'timeline 记录基建失败原因');

  assert.equal(env.calls().length, 2, 'maker r1 + verifier×1（retries=0，一次即耗尽）');
});

test('verifier 瞬态错误连续耗尽重试 → 基建失败，留 VERIFY；下次 run 重 spawn 后正常通过', (t) => {
  const env = makeEnv(t);
  env.writeConfig({ spawnRetries: 2, spawnBackoffMs: [0] }); // 测试内退避归零，重试次数收窄
  const id = 'task-20260704-502';
  env.writeTask(id);
  const T502 = { cost: 0.01, extra: { is_error: true, api_error_status: 502, num_turns: 1 } };
  const initialSteps = [
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'fixed' }, // 0 maker r1
    T502, // 1 verifier 尝试1（瞬态）
    T502, // 2 verifier 尝试2（瞬态，重试）
    T502, // 3 verifier 尝试3（瞬态，重试耗尽 retries=2 → 3 次后 ok=false）
  ];
  env.setScenario(initialSteps);

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);

  const mid = env.findTask(id);
  assert.equal(mid.box, 'queue', '基建失败不收箱');
  assert.equal(mid.runtime.stage, 'VERIFY', '留在 VERIFY');
  assert.equal(mid.runtime.verifier_invalid_count, 0, '瞬态耗尽不算协议失败');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.invalid-a1.json')), '不得产生 invalid 产物');

  const timeline1 = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline1, /verifier r1 transient retry attempt 2 \(status=502\)/, 'onRetry 在 timeline 留痕');
  assert.match(timeline1, /verifier r1 transient retry attempt 3 \(status=502\)/);
  assert.match(timeline1, /verifier r1 基建失败/);

  assert.equal(env.calls().length, 4, 'maker r1 + verifier×3（原始 1 次 + 重试 2 次）');

  // 下次 run：追加一个合法 pass verdict，counter 不重置（延续上次已消费的调用数）
  env.setScenario([...initialSteps, verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' })], { reset: false });
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '下次 run 重 spawn 后正常通过');
  assert.equal(env.calls().length, 5, '追加一次合法 verifier 调用');
});

test('spec-verifier 非零退出（不透明失败，重试预算耗尽）→ 基建失败，留 SPEC_VERIFY，不计 invalid', (t) => {
  const env = makeEnv(t, { config: NO_RETRY });
  const id = 'task-20260704-503';
  env.writeTask(id, { kind: 'feature', stage: 'SPEC_VERIFY', currentRound: 0 });
  // SPEC_VERIFY 要求 current_spec_round>=1 且 specs/<id>.md 已存在：直接落盘草稿并补 runtime 字段。
  const specPath = `${env.root}/specs/${id}.md`;
  fs.writeFileSync(specPath, '# spec 草稿\n\n## 验收标准\n\n- AC-001 占位\n');
  const rt = env.readRuntime(id);
  rt.current_spec_round = 1;
  fs.writeFileSync(`${env.findTask(id).dir}/runtime.json`, `${JSON.stringify(rt, null, 2)}\n`);

  env.setScenario([
    { exitCode: 1, stderr: 'boom: fake CLI crash' }, // 0 spec-verifier 非零退出
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'queue', '基建失败不收箱');
  assert.equal(after.runtime.stage, 'SPEC_VERIFY', '留在 SPEC_VERIFY');
  assert.equal(after.runtime.spec_verifier_invalid_count ?? 0, 0, '基建失败不计协议失败计数');
  assert.ok(!env.exists(env.dossier(id, 'spec-verify-r1.invalid-a1.json')), '不得产生 invalid 产物');

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /spec-verifier r1 基建失败/, 'timeline 记录基建失败原因');
  assert.equal(env.calls().length, 1);
});
