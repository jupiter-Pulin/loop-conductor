// 集成：reviewer prompt 的 diff 字节上限（verifierDiffMaxBytes）。
// 超限 → 降级为 name-status 变更清单（不内嵌 diff hunk），任务照常推进——reviewer 有
// `Bash(git diff:*)`，可以自己按文件看；默认上限 → diff 全量内嵌（对照）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptOf } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

function reviewScenario(env) {
  env.setScenario([
    routerStep('maker'),
    makerStep(),
    routerStep('review'),
    reviewerStep(),
    routerStep('human', { summary: '停在 help 闸' }),
  ]);
}

function reviewerPrompt(env) {
  const call = env.calls().find((c) => promptOf(c).includes('reviewer-r2.log.json'));
  assert.ok(call, 'r2 应派出 reviewer');
  return promptOf(call);
}

test('diff 超 verifierDiffMaxBytes：reviewer prompt 降级为 name-status 清单，任务仍推进', (t) => {
  const { env, id } = newRouterEnv(t, { config: { verifierDiffMaxBytes: 10 } }); // 极小上限，必超
  reviewScenario(env);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  // 降级只影响 prompt 形态，不影响推进
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  const prompt = reviewerPrompt(env);
  assert.ok(prompt.includes('超过 10 字节上限'), 'prompt 含降级说明（含上限数字）');
  assert.ok(prompt.includes('git diff main...HEAD'), 'prompt 指示 reviewer 自己按需细看');
  assert.ok(prompt.includes('lib/stats.mjs'), 'prompt 含变更文件清单');
  assert.ok(!prompt.includes('@@'), '降级后不内嵌 diff hunk');
});

test('默认上限：diff 全量内嵌（对照）', (t) => {
  const { env, id } = newRouterEnv(t); // 不覆盖 verifierDiffMaxBytes，用默认 200000
  reviewScenario(env);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  const prompt = reviewerPrompt(env);
  assert.ok(prompt.includes('@@'), '默认上限下 diff hunk 全量内嵌');
  assert.ok(!prompt.includes('字节上限'), '未超限不出现降级说明');
});
