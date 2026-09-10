// 集成：verifier prompt 的 diff 字节上限（verifierDiffMaxBytes）。
// 超限 → 降级为 name-status 变更清单 + 按文件自查指令（不内嵌 diff hunk），任务照常推进；
// 默认上限 → diff 全量内嵌（对照）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, promptOf, verifierStep, DEFAULT_BUGFIX_SPEC } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

/** bugfix 快乐路径剧本：maker 修掉预埋 bug + verifier 两 AC 全 pass。 */
function happyScenario(env) {
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1', cost: 0.1, result: 'done' },                     // 0 maker
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }),  // 1 verifier
  ]);
}

/** new 一个 bugfix 任务并填默认验收标准，返回 id。 */
function newBugfixTask(env) {
  const created = env.run('new', '--kind', 'bugfix', '--title', 'median 偶数分支错误');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);
  env.writeQueueSpec(id, DEFAULT_BUGFIX_SPEC);
  return id;
}

test('diff 超 verifierDiffMaxBytes：verifier prompt 降级为 name-status 清单，任务仍推进', (t) => {
  const env = makeEnv(t, { config: { verifierDiffMaxBytes: 10 } }); // 极小上限，必超
  env.writeApprovedSetupProfile();
  happyScenario(env);
  const id = newBugfixTask(env);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  // 降级只影响 prompt 形态，不影响推进（verifier 可用 git diff 自查）
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const calls = env.calls();
  assert.equal(calls.length, 2);
  const vprompt = promptOf(calls[1]);
  assert.ok(vprompt.includes('超过上限 10 字节'), 'prompt 含降级说明（实际字节数与上限）');
  assert.ok(vprompt.includes('git diff --name-status main...HEAD'), 'prompt 说明清单来源');
  assert.ok(vprompt.includes('lib/stats.mjs'), 'prompt 含变更文件清单');
  assert.ok(vprompt.includes('git diff main...HEAD -- <file>'), 'prompt 指示按文件自查');
  assert.ok(!vprompt.includes('@@'), '降级后不内嵌 diff hunk');
});

test('默认上限：diff 全量内嵌（对照）', (t) => {
  const env = makeEnv(t); // 不覆盖 verifierDiffMaxBytes，用默认 200000
  env.writeApprovedSetupProfile();
  happyScenario(env);
  const id = newBugfixTask(env);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const vprompt = promptOf(env.calls()[1]);
  assert.ok(vprompt.includes('@@'), '默认上限下 diff hunk 全量内嵌');
  assert.ok(!vprompt.includes('超过上限'), '未超限不出现降级说明');
});
