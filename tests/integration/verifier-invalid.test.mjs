// 集成（新）：verifier 协议/schema 失败不是 maker 失败（契约 §11，AC-010/011）。
// invalid → 写 verify-r<n>.invalid-a<m>.json、verifier_invalid_count++、留 VERIFY 重试 verifier，
// 不 spawn maker、不增 maker_miss_count；超 maxVerifierInvalidRetries → FAILED_BOX(verifier_protocol_exhausted)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, verifierStep, verdictJson } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const READONLY = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*)';
const isVerifier = (c) => c.argv[c.argv.indexOf('--tools') + 1] === READONLY;

// 叙事 + JSON 混排：parseStrictJson 整段解析失败 → invalid（绝不打捞）。
const INVALID = { cost: 0.02, result: `我认为应该通过。\n${verdictJson(1, { 'AC-001': 'pass', 'AC-002': 'pass' })}` };

test('verifier invalid → 重试 verifier，不 spawn maker、不增 miss，随后合法 pass', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260620-701';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'fixed' }, // 0 maker r1（green 绿）
    INVALID,                                                                // 1 verifier 协议失败
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),                // 2 verifier 重试→合法 pass
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // invalid 留档
  const inv = env.readJson(env.dossier(id, 'verify-r1.invalid-a1.json'));
  assert.equal(inv.attempt, 1);
  assert.ok(Array.isArray(inv.errors) && inv.errors.length > 0, 'invalid 记录解析/校验错误');
  assert.ok('raw_result' in inv, 'invalid 留原始输出引用');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '重试后合法 pass → 人类闸门');
  assert.equal(after.runtime.maker_miss_count, 0, 'verifier 协议失败不算 maker miss');
  assert.equal(after.runtime.verifier_invalid_count, 0, '消费有效 verdict 后重置');

  // 不 spawn maker 重跑：maker 只有一轮
  assert.ok(!env.exists(env.dossier(id, 'maker-r2.json')), '不得因 invalid 重 spawn maker');
  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker r1 + verifier×2');
  assert.ok(isVerifier(calls[1]) && isVerifier(calls[2]), '第 2/3 次都是 verifier 重试');
  // 最终 verdict 落盘（合法那次）
  const verdict = env.readJson(env.dossier(id, 'verify-r1.verdict.json'));
  assert.equal(verdict.overall, 'pass');
});

test('verifier invalid 超过 maxVerifierInvalidRetries → FAILED_BOX(verifier_protocol_exhausted)', (t) => {
  const env = makeEnv(t); // 默认 maxVerifierInvalidRetries=2 → 容忍初始+2=3 次，第 3 次后收箱
  const id = 'task-20260620-702';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'fixed' }, // 0 maker r1
    INVALID, // 1 verifier invalid #1（count→1，留）
    INVALID, // 2 verifier invalid #2（count→2，留）
    INVALID, // 3 verifier invalid #3（count→3 >2，收箱）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'verifier_protocol_exhausted');
  assert.equal(after.runtime.maker_miss_count, 0, '协议失败始终不碰 maker miss');
  // 收箱时 verifier_invalid_count 落盘为递增后的值（3），与 invalid-a1/a2/a3 产物及 timeline 对齐
  assert.equal(after.runtime.verifier_invalid_count, 3, 'verifier_invalid_count 落盘与产物/timeline 一致');

  // 三次 invalid 各自留档
  for (const m of [1, 2, 3]) {
    assert.ok(env.exists(env.dossier(id, `verify-r1.invalid-a${m}.json`)), `invalid-a${m} 留档`);
  }
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.verdict.json')), '无合法 verdict');
  assert.equal(env.calls().length, 4, 'maker r1 + verifier×3');
});
