// 集成：绿门失败签名连续性策略接线（AC-006/007/008）。
// AC-006：连续两轮同签名且环境类（EADDRINUSE）→ 短路收箱 env_failure_repeated，不 spawn 第三轮 maker。
// AC-007：连续两轮同签名但无环境 token（纯断言失败）→ 不短路，repair-context 注入 same_signature_streak。
// AC-008：env_failure_repeated 窄恢复：retry → READY(miss=0)，maker 产物不归档；随后一次 run 只复跑绿门。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
// maker 做什么都无所谓的一次真实失败：median 偶数分支挂（复用既有 target-fixture 的确定性 bug）。
const NOFIX = { session_id: 'sess-m1', cost: 0.1, result: 'attempted but tests still red' };

// 环境类失败模拟：新增一个只要 ENV_BUSY 标记文件存在就必炸的测试——真实代表「代码怎么改都救不了
// 的外部环境冲突」（如观察面板占用 4400 端口，见 spec 背景事故 1）。ENV_BUSY 不是测试文件，
// test-gate 的 overlay glob 不会把它带进基线探针，因此不影响 test gate 判定。
const ENV_BROKEN_TEST_FILE = [
  "import test from 'node:test';",
  "import fs from 'node:fs';",
  '',
  "test('端口常年被占用', () => {",
  "  if (fs.existsSync('./ENV_BUSY')) {",
  "    const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:59999');",
  "    err.code = 'EADDRINUSE';",
  '    throw err;',
  '  }',
  '});',
  '',
].join('\n');
const WRITE_ENV_BROKEN_TEST = { type: 'writeFile', path: 'test/env-broken.test.mjs', content: ENV_BROKEN_TEST_FILE };
const WRITE_ENV_BUSY_FLAG = { type: 'writeFile', path: 'ENV_BUSY', content: '1' };
// r1：顺带修好 median 真 bug，但新增了这个「环境常驻失败」探针——之后无论怎么改代码都救不了。
const ENV_R1 = { actions: [FIX, WRITE_ENV_BROKEN_TEST, WRITE_ENV_BUSY_FLAG], session_id: 'sess-m1', cost: 0.1, result: 'r1: median 修好 + 加了端口探针' };
const ENV_R2_NOOP = { session_id: 'sess-m1', cost: 0.05, result: 'r2: 尝试过，但端口还是被占' };

test('AC-006：绿门连续两轮同签名且环境类 → 短路收箱 env_failure_repeated，不 spawn 第三轮 maker', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260706-601';
  env.writeTask(id);
  env.setScenario([ENV_R1, ENV_R2_NOOP]); // 只给 2 步：若基线代码仍会 spawn 第三轮，fake-claude 会因缺步报错

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed', '应收箱');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'env_failure_repeated');

  const calls = env.calls();
  assert.equal(calls.length, 2, '不得 spawn 第三轮 maker（本应短路，而非烧尽 miss 阶梯）');
  assert.ok(!env.exists(env.dossier(id, 'maker-r3.json')), '不存在第三轮 maker 产物');

  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  const gg2 = env.readJson(env.dossier(id, 'green-gate-r2.json'));
  assert.ok(gg1.signature, 'green-gate-r1 应带 signature');
  assert.equal(gg1.signature.hash, gg2.signature.hash, '两轮失败签名应相等');
  assert.ok(gg2.signature.errorTokens.includes('EADDRINUSE'), '错误词层应含 EADDRINUSE');

  // 失败信息含错误 token 与失败测试名（timeline 是人类排查的落点）
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.match(timeline, /EADDRINUSE/);
  assert.match(timeline, /env-broken\.test\.mjs/);

  assert.ok(env.exists(env.worktree(id)), 'worktree 应保留（供 retry 窄恢复）');
});

test('AC-007：连续两轮同签名但无环境 token（纯断言失败）→ 不短路，repair-context 注入 same_signature_streak', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260706-701';
  env.writeTask(id);
  env.setScenario([
    NOFIX, // 0 maker r1：什么都没改，median 偶数用例挂
    { session_id: 'sess-m1', cost: 0.05, result: 'r2 尝试过，仍然红' }, // 1 maker r2（resume，同一断言失败原样复现）
    { session_id: 'sess-m1', cost: 0.05, result: 'r3 冷启动，仍然红' }, // 2 maker r3（冷启动，阶梯耗尽前最后一次）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  // 关键：不应被误判为环境类短路——阶梯正常耗尽，而非 env_failure_repeated
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted');
  assert.equal(after.runtime.maker_miss_count, 3);

  const calls = env.calls();
  assert.equal(calls.length, 3, '未短路：三轮 maker 均照常 spawn');

  // repair-context-r2（round2 失败时写入，此时 streak 已达 2）应注入 same_signature_streak 与失败测试清单提示
  const ctx2 = env.readJson(env.dossier(id, 'repair-context-r2.json'));
  assert.equal(ctx2.source, 'green_gate');
  assert.equal(ctx2.same_signature_streak, 2, 'streak 应为 2（round1/round2 同签名）');
  assert.match(ctx2.same_signature_hint, /失败签名完全未变/);
  assert.match(ctx2.same_signature_hint, /stats\.test\.mjs/, '提示应含失败测试清单');

  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  const gg2 = env.readJson(env.dossier(id, 'green-gate-r2.json'));
  assert.equal(gg1.signature.hash, gg2.signature.hash, '两轮签名应相等（同一断言失败）');
  assert.deepEqual(gg2.signature.errorTokens, [], '纯断言失败，无环境 token');
});

test('AC-008：env_failure_repeated 窄恢复：retry → READY(miss=0)，maker 产物保留；随后一次 run 只复跑绿门', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260706-801';
  env.writeTask(id);
  env.setScenario([
    ENV_R1,        // 0 maker r1（cold）
    ENV_R2_NOOP,   // 1 maker r2（resume）→ 同签名连败 → 短路收箱
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }), // 2 retry 后绿门转绿，round 复位为 1 → verifier
  ]);

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.last_failure_type, 'env_failure_repeated');
  assert.ok(env.exists(env.dossier(id, 'maker-r1.json')));
  assert.ok(env.exists(env.dossier(id, 'maker-r2.json')));

  // 人工修好环境：直接在 worktree 里删掉占用标记（模拟「端口已被释放」，不经 maker）
  fs.rmSync(env.worktree(id, 'ENV_BUSY'), { force: true });

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'READY');
  assert.equal(revived.runtime.maker_miss_count, 0);
  assert.equal(revived.runtime.last_failure_type, null);
  assert.ok(env.exists(env.dossier(id, 'maker-r1.json')), 'maker 轮次产物未被归档');
  assert.ok(env.exists(env.dossier(id, 'maker-r2.json')), 'maker 轮次产物未被归档');
  assert.ok(!env.exists(env.dossier(id, 'attempts')), '不应产生 attempts/ 归档目录（narrow retry 不归档）');

  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const calls = env.calls();
  assert.equal(calls.length, 3, '不应新 spawn maker，只多一次 verifier spawn');
  assert.ok(!env.exists(env.dossier(id, 'maker-r3.json')), '不得重跑 maker');

  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gg1.exit_code, 0, '复跑绿门应通过（人工已修好环境）');

  const done = env.findTask(id);
  assert.equal(done.runtime.stage, 'AWAIT_HUMAN_MERGE', '绿门通过后正常进 test-gate/VERIFY，拿到 pass verdict');
});
