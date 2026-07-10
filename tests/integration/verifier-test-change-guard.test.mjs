// 集成：既有测试改动守卫（R5-H16，观测型防线）。契约：
//   1) 默认关：maker 改了既有测试，verifier prompt 也无守卫段、timeline 无守卫行（旧行为）；
//   2) 开启且命中：verifier prompt 含守卫段（列出被改文件）+ timeline 行；stage 照常推进
//      （观测不 block）；merge 时 stdout 高亮 + timeline 摘要行；
//   3) 开启但只新增测试/只改源码：A 不入清单 → 无守卫段、无 timeline 行（不制造噪声）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep, promptOf } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
// 覆写既有 test/stats.test.mjs：断言仍钉 median 偶数分支（基线红 / 修复后绿），但内容被动过 → M
const MODIFIED_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.mjs';

test('median even length averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
`;
const MODIFY_EXISTING_TEST = { type: 'writeFile', path: 'test/stats.test.mjs', content: MODIFIED_TEST };
const ADD_NEW_TEST = {
  type: 'writeFile',
  path: 'test/extra.test.mjs',
  content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { median } from '../lib/stats.mjs';\n\ntest('median odd passthrough', () => { assert.equal(median([5]), 5); });\n",
};

function timelineOf(env, id) {
  try { return fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'); } catch { return ''; }
}

test('契约1：默认关——既有测试被改也无守卫段/守卫 timeline（旧行为）', (t) => {
  const env = makeEnv(t); // 不设 testChangeGuardEnabled → 默认 false
  const id = 'task-20260708-980';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX, MODIFY_EXISTING_TEST], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  const verifierPrompt = promptOf(env.calls()[1]);
  assert.ok(!verifierPrompt.includes('既有测试改动守卫'), '默认关闭不得注入守卫段');
  assert.ok(!timelineOf(env, id).includes('test-change guard'), '默认关闭不得写守卫 timeline');
});

test('契约2：开启且命中——prompt 守卫段 + timeline + stage 照常 + merge 高亮', (t) => {
  const env = makeEnv(t, { config: { testChangeGuardEnabled: true } });
  const id = 'task-20260708-981';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX, MODIFY_EXISTING_TEST], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.01, result: JSON.stringify({ subject: 'fix(stats): median 偶数分支取平均', body: '守卫集成测试用提案。\n\n验证：node --test 全绿。' }) },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', '守卫是观测型，绝不 block 推进');

  const verifierPrompt = promptOf(env.calls()[1]);
  assert.ok(verifierPrompt.includes('既有测试改动守卫'), 'prompt 应含守卫段');
  assert.ok(verifierPrompt.includes('"test/stats.test.mjs"'), '守卫段应列出被改的既有测试文件');
  assert.match(timelineOf(env, id), /test-change guard：modified 1 \/ deleted 0 \/ renamed 0/);

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  assert.ok(merge.stdout.includes('既有测试改动'), 'merge stdout 应高亮守卫清单');
  assert.ok(merge.stdout.includes('M test/stats.test.mjs'), 'merge 高亮应逐文件列出');
  assert.equal(env.findTask(id).box, 'done', '高亮不 block merge');
  assert.match(timelineOf(env, id), /merge 摘要：既有测试改动 modified 1/);
});

test('契约3：开启但只新增测试——A 不入清单，无守卫段无 timeline（不制造噪声）', (t) => {
  const env = makeEnv(t, { config: { testChangeGuardEnabled: true } });
  const id = 'task-20260708-982';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX, ADD_NEW_TEST], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  const verifierPrompt = promptOf(env.calls()[1]);
  assert.ok(!verifierPrompt.includes('既有测试改动守卫'), '仅新增测试不触发守卫段');
  assert.ok(!timelineOf(env, id).includes('test-change guard'), '仅新增测试不写守卫 timeline');
});
