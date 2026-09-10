// 集成：活性护栏——无输出（inactivity）与超墙钟（wall-clock）都必须 kill 掉 spawn，
// 并把「花了多少钱不知道」如实记进 spawn 记录（cost_unknown），绝不静默按 0 入账。
//
// router 纪元的去向面：被 kill 的一轮只留下一条 product=missing 的记录，内核不自动重派、
// 也不自己收箱（契约第三条 + AC-005），下一轮由 router 决定怎么办。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

const FAST_LIVENESS = {
  inactivityTimeoutMs: 200,
  spawnWallClockMs: 1000,
  spawnRetries: 0,
  spawnBackoffMs: [0],
};

const HELP = routerStep('human', { summary: '上一轮 maker 被 kill，交人裁决' });

test('inactivity 无输出 → kill，记录标 killed/cost_unknown，任务留在 ROUTING 由 router 处置', (t) => {
  const { env, id } = newRouterEnv(t, { config: FAST_LIVENESS });
  env.setScenario([routerStep('maker'), { hang: true }, HELP]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue', '内核不因 spawn 被 kill 而收箱');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN', 'r2 的 router 开了 help 闸');

  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, 'inactivity');
  assert.equal(marker.cost_unknown, true);
  assert.equal(marker.cost_usd, 0);
  assert.match(fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'), /cost unknown/);
  assert.ok(!env.exists(env.dossier(id, 'maker-r1.log.json')), '被 kill 的一轮没有 log');
});

test('持续有输出但超过 wall-clock → killed=wall_clock', (t) => {
  const { env, id } = newRouterEnv(t, {
    config: { ...FAST_LIVENESS, inactivityTimeoutMs: 500, spawnWallClockMs: 150 },
  });
  env.setScenario([routerStep('maker'), { slowAlive: true, intervalMs: 40, count: 20 }, HELP]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, 'wall_clock');
  assert.equal(marker.cost_unknown, true);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');
});

test('慢而活着：输出间隔小于 inactivity 且未超 wall-clock，正常完成', (t) => {
  const { env, id } = newRouterEnv(t, {
    config: { ...FAST_LIVENESS, inactivityTimeoutMs: 400, spawnWallClockMs: 3000 },
  });
  env.setScenario([
    routerStep('maker'),
    makerStep({ slowAlive: true, intervalMs: 40, count: 4 }),
    routerStep('human', { summary: '停在 help 闸' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, null);
  assert.equal(marker.cost_unknown, undefined);
  assert.ok(env.exists(env.dossier(id, 'maker-r1.stream.jsonl')));
  assert.ok(env.exists(env.dossier(id, 'maker-r1.log.json')), '正常完成的一轮留下 log');
});
