// 集成：verifier/spec-verifier 协议耗尽收箱后 retry 应回 VERIFY/SPEC_VERIFY，不重跑无辜的
// maker/spec-agent（AC-001/AC-002/AC-003）。worktree/spec 草稿缺失时仍走全量重置（AC-004）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, verifierStep, verdictJson, specVerifierStep, specVerifierJson } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
// 叙事 + JSON 混排 → parseStrictJson 整段解析失败 → invalid（沿用 verifier-invalid.test.mjs 手法）。
const INVALID_VERIFIER = { cost: 0.02, result: `我认为应该通过。\n${verdictJson(1, { 'AC-001': 'pass', 'AC-002': 'pass' })}` };
const INVALID_SPEC_VERIFIER = { cost: 0.02, result: `我认为可以过审。\n${specVerifierJson(1, 'pass')}` };
const SPEC_GOOD = '# spec good\n\n## 验收标准\n\n- AC-001 `node --test` 全绿\n';

test('verifier_protocol_exhausted 收箱后 retry → VERIFY（不重跑 maker），随后 run 只重跑 verifier', (t) => {
  const env = makeEnv(t); // 默认 maxVerifierInvalidRetries=2 → 容忍初始+2=3 次尝试后收箱
  const id = 'task-20260704-801';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'fixed' }, // 0 maker r1（green 绿）
    INVALID_VERIFIER, // 1 verifier invalid #1
    INVALID_VERIFIER, // 2 verifier invalid #2
    INVALID_VERIFIER, // 3 verifier invalid #3 → 收箱
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { session_id: 'sess-v-final' }), // 4 retry 后合法 pass
  ]);

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);

  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.stage, 'FAILED_BOX');
  assert.equal(boxed.runtime.last_failure_type, 'verifier_protocol_exhausted');
  assert.equal(boxed.runtime.maker_miss_count, 0, 'maker 完全无辜');
  assert.ok(env.exists(env.dossier(id, 'maker-r1.json')), 'maker 产物在案');
  assert.ok(env.exists(env.dossier(id, 'green-gate-r1.json')), 'green gate 产物在案');
  for (const m of [1, 2, 3]) {
    assert.ok(env.exists(env.dossier(id, `verify-r1.invalid-a${m}.json`)), `invalid-a${m} 留档`);
  }
  assert.ok(env.exists(env.worktree(id)), 'worktree 仍存在（maker 产出未清）');

  // ---- AC-001：retry → VERIFY，maker/green-gate 产出原位保留，miss 不动 ----
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'VERIFY');
  assert.equal(revived.runtime.verifier_invalid_count, 0);
  assert.equal(revived.runtime.maker_miss_count, 0, 'miss 未被碰');
  assert.equal(revived.runtime.last_failure_type, null);

  assert.ok(env.exists(env.dossier(id, 'maker-r1.json')), 'retry 后 maker 产物仍在根目录（未归档）');
  assert.ok(env.exists(env.dossier(id, 'green-gate-r1.json')), 'retry 后 green gate 产物仍在根目录');
  for (const m of [1, 2, 3]) {
    assert.ok(!env.exists(env.dossier(id, `verify-r1.invalid-a${m}.json`)), `invalid-a${m} 已移出根目录`);
  }
  const archivedEntries = fs.readdirSync(env.dossier(id, 'attempts'), { recursive: true });
  for (const m of [1, 2, 3]) {
    assert.ok(archivedEntries.some((p) => p.endsWith(`verify-r1.invalid-a${m}.json`)), `invalid-a${m} 归档到 attempts/`);
  }

  // ---- AC-002：随后 run 只重跑 verifier，verdict 合法即可正常走到 AWAIT_HUMAN_MERGE ----
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const done = env.findTask(id);
  assert.equal(done.runtime.stage, 'AWAIT_HUMAN_MERGE', 'verdict 合法 pass 直接走到人工闸门');

  const calls = env.calls();
  assert.equal(calls.length, 5, 'maker×1 + verifier×4（3 invalid + 1 合法），不得因 retry 多出 maker spawn');
  assert.ok(!env.exists(env.dossier(id, 'maker-r2.json')), '不得重跑 maker');
});

test('spec_verifier_protocol_exhausted 收箱后 retry → SPEC_VERIFY（不重跑 spec-agent）', (t) => {
  const env = makeEnv(t); // 默认 maxSpecVerifierInvalidRetries=2 → 容忍初始+2=3 次尝试后收箱
  const id = 'task-20260704-802';
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', '统计能力 spec');
  assert.equal(created.status, 0, created.stderr);
  const taskId = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(taskId);
  const specAbs = path.join(env.root, 'specs', `${taskId}.md`);

  env.setScenario([
    { actions: [{ type: 'writeFile', path: specAbs, content: SPEC_GOOD }], session_id: 'sess-spec-1', cost: 0.03, result: 'spec written' }, // 0 spec-agent
    INVALID_SPEC_VERIFIER, // 1 invalid #1
    INVALID_SPEC_VERIFIER, // 2 invalid #2
    INVALID_SPEC_VERIFIER, // 3 invalid #3 → 收箱
    specVerifierStep(1, 'pass', { session_id: 'sess-sv-final' }), // 4 retry 后合法 pass
  ]);

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);

  const boxed = env.findTask(taskId);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.stage, 'FAILED_BOX');
  assert.equal(boxed.runtime.last_failure_type, 'spec_verifier_protocol_exhausted');
  assert.ok(env.exists(env.dossier(taskId, 'spec-agent-r1.json')), 'spec-agent 产物在案');
  assert.equal(fs.readFileSync(specAbs, 'utf8'), SPEC_GOOD, 'spec 草稿在案');
  for (const m of [1, 2, 3]) {
    assert.ok(env.exists(env.dossier(taskId, `spec-verify-r1.invalid-a${m}.json`)), `invalid-a${m} 留档`);
  }

  // ---- AC-003：spec 草稿保留、只归档 spec-verify invalid 产物、spec_verifier_invalid_count=0 ----
  const retry = env.run('retry', taskId);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(taskId);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'SPEC_VERIFY');
  assert.equal(revived.runtime.spec_verifier_invalid_count, 0);
  assert.equal(revived.runtime.current_spec_round, 1, '轮次对齐不变');
  assert.equal(revived.runtime.last_failure_type, null);
  assert.equal(fs.readFileSync(specAbs, 'utf8'), SPEC_GOOD, 'retry 后 spec 草稿未被归档/重写');
  assert.ok(env.exists(env.dossier(taskId, 'spec-agent-r1.json')), 'retry 后 spec-agent 产物仍在根目录');
  for (const m of [1, 2, 3]) {
    assert.ok(!env.exists(env.dossier(taskId, `spec-verify-r1.invalid-a${m}.json`)), `invalid-a${m} 已移出根目录`);
  }

  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const done = env.findTask(taskId);
  assert.equal(done.runtime.stage, 'AWAIT_SPEC_APPROVAL', 'spec-verifier 合法 pass 直接走到人工闸门');

  const calls = env.calls();
  assert.equal(calls.length, 5, 'spec-agent×1 + spec-verifier×4（3 invalid + 1 合法），不得因 retry 多出 spec-agent spawn');
  assert.ok(!env.exists(env.dossier(taskId, 'spec-agent-r2.json')), '不得重跑 spec-agent');
});

test('AC-004：verifier_protocol_exhausted 但 worktree 已缺失 → 仍走原全量重置', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-803';
  env.writeTask(id, { stage: 'FAILED_BOX', invalid: 3, lastFailureType: 'verifier_protocol_exhausted' });
  fs.renameSync(path.join(env.root, 'state', 'queue', id), path.join(env.root, 'state', 'failed', id));
  assert.ok(!env.exists(env.worktree(id)), '前置条件：worktree 确实不存在');

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'READY', 'worktree 缺失时行为与修改前一致：全量重置回 READY');
  assert.equal(revived.runtime.verifier_invalid_count, 0);
  assert.equal(revived.runtime.last_failure_type, null);
});
