// 集成：预算耗尽（AC-005 的六条转移之一）。
// 每次 spawn 前查一次：超出即 FAILED_BOX(budget_exhausted) + 事件，绝不先烧完这一轮再说。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

test('预算耗尽 → FAILED_BOX(budget_exhausted)，retry 后回 ROUTING', (t) => {
  const { env, id } = newRouterEnv(t, { config: { budgetUsd: 0.5 } });
  env.setScenario([
    routerStep('maker', { cost: 0.2 }),
    makerStep({ cost: 0.4 }), // 累计 $0.6 ≥ $0.5：下一轮 router 还没派出去就该收箱
    routerStep('review'),
  ]);
  assert.equal(env.run('run').status, 0);

  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.last_failure_type, 'budget_exhausted');
  const ev = env.events(id).filter((e) => e.type === 'budget_exhausted');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].budget_usd, 0.5);
  assert.equal(env.calls().length, 2, '收箱发生在第三次 spawn 之前');

  // 预算没调高就 retry：回 ROUTING，但 CLI 明说下次还会再进箱。
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');
  assert.match(retry.stderr, /仍 >= budgetUsd/);

  env.writeConfig({ budgetUsd: 50 });
  env.appendScenario([routerStep('human', { summary: '预算调高后继续' })]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
});
