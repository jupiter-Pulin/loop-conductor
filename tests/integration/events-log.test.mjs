// 集成：结构化事件流（R5-H17 + router 纪元）。契约：
//   1) router 纪元的事实事件（router_decision / human_gate_opened / human_decision / merged …）
//      不受 `eventsLogEnabled` 约束——它们是内核事实，不是观测选项；
//   2) `stage` 事件仍归观测开关：默认关不写，开启才写；
//   3) 事件流是观测面：开关开与关的任务路由完全一致；
//   4) 每条事件都有 ts / type。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

function readEvents(env, id) {
  try {
    return fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return null; // 文件不存在
  }
}

function fullRun(env) {
  return [
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ];
}

test('契约1+2：默认关——router 事实事件照写，stage 事件不写；路由不变', (t) => {
  const { env, id } = newRouterEnv(t, { config: { eventsLogEnabled: false } });
  env.setScenario(fullRun(env));
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');
  assert.equal(env.run('approve', id).status, 0);
  assert.equal(env.findTask(id).box, 'done');

  const events = readEvents(env, id);
  assert.ok(Array.isArray(events) && events.length > 0, 'router 纪元恒有事件流');
  assert.equal(events.filter((e) => e.type === 'stage').length, 0, '默认关不写 stage 事件');
  assert.ok(events.some((e) => e.type === 'router_decision'), 'router_decision 不受开关约束');
  assert.ok(events.some((e) => e.type === 'merged'), 'merged 不受开关约束');
});

test('契约2+3+4：开启——stage 事件补齐，字段完整，路由与关闭时一致', (t) => {
  const { env, id } = newRouterEnv(t, { config: { eventsLogEnabled: true } });
  env.setScenario(fullRun(env));
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge', '开关不影响路由');
  assert.equal(env.run('approve', id).status, 0);
  assert.equal(env.findTask(id).box, 'done');

  const events = readEvents(env, id);
  for (const ev of events) {
    assert.ok(typeof ev.ts === 'string' && typeof ev.type === 'string', '每条事件都有 ts/type');
  }
  const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.ok(stages.includes('AWAIT_HUMAN'), 'stage 事件覆盖开人闸');
  assert.ok(stages.includes('DONE'), 'stage 事件覆盖 merge 归档');

  const decisions = events.filter((e) => e.type === 'router_decision');
  assert.deepEqual(decisions.map((d) => d.action), ['maker', 'review', 'precommit', 'merge']);

  const gate = events.filter((e) => e.type === 'human_gate_opened');
  assert.deepEqual(gate.map((g) => g.kind), ['merge']);
  const decided = events.filter((e) => e.type === 'human_decision');
  assert.deepEqual(decided.map((d) => [d.kind, d.decision]), [['merge', 'approved']]);
  assert.equal(events.filter((e) => e.type === 'precommit_result').length, 1);
});
