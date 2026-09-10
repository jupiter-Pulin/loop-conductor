// 集成：调度并发——maxConcurrentTasks 决定同一次 run 里几个任务同时在飞。
// 每个任务只用一个 router 轮次（选 human 开闸即停），两步剧本完全同形，
// 因此跨任务的消费顺序不影响断言，被测的只有「起跑时刻是否重叠」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { routerEnv, routerStep } from '../helpers/router-env.mjs';

function routerCalls(env) {
  return env.calls().filter((c) => c.argv.includes('--max-turns'));
}

test('两个 ROUTING 任务在 maxConcurrentTasks>=2 时并行推进', (t) => {
  const env = routerEnv(t, { config: { maxConcurrentTasks: 2 } });
  const a = 'task-20260611-640';
  const b = 'task-20260611-641';
  env.writeRouterTask(a);
  env.writeRouterTask(b);
  env.setScenario([
    { delayMs: 220, ...routerStep('human', { summary: 'a 求助' }) },
    { delayMs: 220, ...routerStep('human', { summary: 'b 求助' }) },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(a).runtime.stage, 'AWAIT_HUMAN');
  assert.equal(env.findTask(b).runtime.stage, 'AWAIT_HUMAN');
  const routers = routerCalls(env);
  assert.equal(routers.length, 2);
  assert.ok(
    Math.abs(routers[1].started_at_ms - routers[0].started_at_ms) < 180,
    `router starts should overlap, got ${routers.map((c) => c.started_at_ms).join(', ')}`,
  );
});

test('maxConcurrentTasks=1 时退化为串行', (t) => {
  const env = routerEnv(t, { config: { maxConcurrentTasks: 1 } });
  const a = 'task-20260611-642';
  const b = 'task-20260611-643';
  env.writeRouterTask(a);
  env.writeRouterTask(b);
  env.setScenario([
    { delayMs: 180, ...routerStep('human', { summary: 'a 求助' }) },
    { delayMs: 180, ...routerStep('human', { summary: 'b 求助' }) },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const routers = routerCalls(env);
  assert.equal(routers.length, 2);
  assert.ok(
    routers[1].started_at_ms - routers[0].started_at_ms >= 160,
    `serial router starts should be separated, got ${routers.map((c) => c.started_at_ms).join(', ')}`,
  );
});
