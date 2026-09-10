// 集成：新状态机下 spawn 基建失败的处置（契约第三条）。
// 缺 log 不是异常路径，只是记录里的一个字段：product=missing 原样交给 router，
// 内核**不自动重派**、不收箱、不推断 outcome。router 是唯一决定「要不要再来一轮」的人。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptOf } from '../helpers/env.mjs';
import { newRouterEnv, routerStep } from '../helpers/router-env.mjs';

test('maker spawn 基建失败 → 记录 product=missing，内核不重派，router 自行决定下一步', (t) => {
  const { env, id } = newRouterEnv(t, { config: { spawnRetries: 0 } });
  env.setScenario([
    routerStep('maker'),
    { exitCode: 3, stderr: 'boom: CLI 挂了' }, // maker r1：没写 log 就死了
    routerStep('maker', { summary: '上轮无 log，续做' }),
    { actions: [{ type: 'writeLog', content: { role: 'maker', outcome: 'ok', summary: 'AC-001 done' } }], cost: 0.1, result: 'ok' },
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);

  // 第一次 maker：spawn 留了档（含 error），但没有 log。
  const failed = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(failed.ok, false);
  assert.ok(!env.exists(env.dossier(id, 'maker-r1.log.json')));

  // 每个 router 轮次恰好一次 maker spawn：内核没有偷偷重派。
  const makerCalls = env.calls().filter((c) => /maker-r\d+\.log\.json/.test(promptOf(c)));
  assert.equal(makerCalls.length, 2);

  // 第二轮 router 的记录段里，那一轮是 product=missing。
  const secondRouterPrompt = promptOf(env.calls()[2]);
  assert.match(secondRouterPrompt, /r1 maker\s+outcome=-.*product=missing/);

  // 任务既没进箱也没转 stage，仍在 queue 上由 router 推进。
  const ts = env.findTask(id);
  assert.equal(ts.box, 'queue');
  assert.equal(ts.runtime.awaiting.kind, 'help');
  assert.equal(ts.runtime.last_failure_type, null);
});

test('router 自己 spawn 失败两次 → 内核开 help 闸（失效连击），不无限重试', (t) => {
  const { env, id } = newRouterEnv(t, { config: { spawnRetries: 0 } });
  env.setScenario([
    { exitCode: 3, stderr: 'boom' },
    { exitCode: 3, stderr: 'boom' },
  ]);
  assert.equal(env.run('run').status, 0);

  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'AWAIT_HUMAN');
  assert.equal(ts.runtime.awaiting.kind, 'help');
  const gate = env.readJson(env.dossier(id, 'human-r2.json'));
  assert.equal(gate.requested_by, 'kernel');
  assert.match(gate.summary, /product=missing/);
});
