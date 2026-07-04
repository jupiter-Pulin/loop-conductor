// 集成：test gate（基线空转测试探针，docs/features/test-gate/tech-spec.md）。
// green gate 通过后，conductor 把改动的测试文件叠加到 baseBranch 基线的 detached worktree 复跑
// testCommand；基线仍绿 ⇒ vacuous ⇒ 不进 VERIFY，走 maker miss 阶梯（AC-001~005）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS, TEST_FILE } from '../helpers/target-fixture.mjs';

// 削弱版套件：删掉会在预埋 bug 上失败的偶数用例 → 含 bug 代码也全绿。
const WEAK_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.mjs';

test('median of odd-length array', () => {
  assert.equal(median([3, 1, 2]), 2);
});
`;

const TRIVIAL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';

test('trivially green', () => {
  assert.equal(1, 1);
});
`;

test('削弱测试骗过 green gate → test gate 判 vacuous → FIXING → 真修复 → pass（AC-001/002）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260703-701';
  env.writeTask(id);
  env.setScenario([
    // 0 maker r1：不修 bug，反而削弱测试 → 任务 worktree 全绿
    { actions: [{ type: 'writeFile', path: 'test/stats.test.mjs', content: WEAK_TEST }], session_id: 'sess-m1', cost: 0.1, result: 'r1 削弱测试' },
    // 1 maker r2（resume）：真修复 + 恢复原测试
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: 'test/stats.test.mjs', content: TEST_FILE },
      ],
      session_id: 'sess-m1', cost: 0.08, result: 'r2 真修复',
    },
    verifierStep(2), // 2 verifier r2 pass
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // r1：green gate 被削弱套件骗绿
  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gg1.exit_code, 0, 'green gate r1 被削弱套件骗绿');

  // test gate r1：改动的测试文件叠回基线 → 基线也绿 → vacuous
  const tg1 = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg1.round, 1);
  assert.equal(tg1.exit_code, 0);
  assert.equal(tg1.verdict, 'vacuous');
  assert.ok(tg1.overlay.copied.includes('test/stats.test.mjs'), '削弱的测试文件被叠加到基线');
  assert.ok(tg1.base_commit, '记录基线 commit（merge-base）');

  // AC-002：vacuous 轮不得 spawn verifier；repair-context source=test_gate，存储层只存 ref
  assert.ok(!env.exists(env.dossier(id, 'verifier-r1.json')), 'vacuous 轮不得 spawn verifier');
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'test_gate');
  assert.deepEqual(ctx.failed_criteria, []);
  assert.equal(ctx.test_gate, null);
  assert.equal(ctx.test_gate_ref, 'test-gate-r1.json');

  // 阶梯：vacuous 消耗一次 maker miss；FIXING 第一档 resume 原 maker，prompt 展开 test_gate 摘要
  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker r1 + maker r2(resume) + verifier r2');
  assert.equal(resumeIdOf(calls[1]), 'sess-m1', 'FIXING 第一档 resume 原 maker');
  const repairPrompt = promptOf(calls[1]);
  assert.ok(repairPrompt.includes('"source": "test_gate"'), 'repair prompt 带 test_gate 修复上下文');
  assert.ok(repairPrompt.includes('"test_gate_ref": "test-gate-r1.json"'), 'repair prompt 保留 test_gate_ref');
  assert.ok(repairPrompt.includes('"exit_code": 0'), 'repair prompt 展开基线探针摘要');

  // r2：真修复 → green 绿；测试恢复为与基线相同 → overlay 空 → 基线红（原红套件）→ falsifies → verifier
  const tg2 = env.readJson(env.dossier(id, 'test-gate-r2.json'));
  assert.equal(tg2.verdict, 'falsifies');
  assert.deepEqual(tg2.overlay.copied, [], '测试与基线相同时 overlay 为空');
  assert.notEqual(tg2.exit_code, 0, '原套件在基线上必红');
  assert.ok(env.exists(env.dossier(id, 'verify-r2.verdict.json')), 'falsifies 轮才 spawn verifier');

  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, 'vacuous 消耗一次 maker miss');

  // AC-001：探针 worktree 不残留
  assert.ok(!env.exists(env.worktree(`${id}.test-gate`)), '探针 worktree 已清理');
});

test('删除红测试换 trivial 绿测试也被拦：vacuous 耗尽阶梯 → FAILED_BOX（AC-002/003）', (t) => {
  // maxMakerMisses=1：第一次 vacuous 即耗尽阶梯，同时验证阶梯耗尽收箱路径。
  const env = makeEnv(t, { config: { maxMakerMisses: 1 } });
  const id = 'task-20260703-702';
  env.writeTask(id);
  env.setScenario([
    {
      actions: [
        { type: 'deleteFile', path: 'test/stats.test.mjs' },
        { type: 'writeFile', path: 'test/basic.test.mjs', content: TRIVIAL_TEST },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 删红测试',
    },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.verdict, 'vacuous');
  assert.ok(tg.overlay.deleted.includes('test/stats.test.mjs'), '基线探针同步删除被删的测试');
  assert.ok(tg.overlay.copied.includes('test/basic.test.mjs'), '新增的 trivial 测试被叠加');

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted');
  assert.equal(after.runtime.maker_miss_count, 1);
  assert.ok(!env.exists(env.dossier(id, 'verifier-r1.json')), 'vacuous 轮不得 spawn verifier');
  assert.ok(!env.exists(env.worktree(`${id}.test-gate`)), '探针 worktree 已清理');
});

test('testGateEnabled=false：完全跳过探针，行为与现状一致（AC-005）', (t) => {
  const env = makeEnv(t, { config: { testGateEnabled: false } });
  const id = 'task-20260703-703';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  assert.ok(!env.exists(env.dossier(id, 'test-gate-r1.json')), '关闭时不产生探针产物');
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0);
});

test('默认开启：真修复轮（无测试改动）探针 falsifies 放行，产物完备（AC-001/004）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260703-704';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.round, 1);
  assert.equal(tg.verdict, 'falsifies', '基线红套件天然 falsifies');
  assert.deepEqual(tg.overlay.copied, []);
  assert.deepEqual(tg.overlay.deleted, []);
  assert.equal(tg.command, 'node --test');
  assert.equal(tg.base_branch, 'main');
  assert.ok(typeof tg.stdout_tail === 'string', '基线运行输出留 tail');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0, 'falsifies 不计 miss');
  assert.ok(!env.exists(env.worktree(`${id}.test-gate`)), '探针 worktree 已清理');
});
