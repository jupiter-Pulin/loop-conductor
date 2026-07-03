import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FAST_LIVENESS = {
  inactivityTimeoutMs: 120,
  spawnWallClockMs: 1000,
  spawnRetries: 0,
  spawnBackoffMs: [0],
};

test('inactivity 无输出 → kill，record 标记 killed/cost_unknown，重试耗尽收箱', (t) => {
  const env = makeEnv(t, { config: FAST_LIVENESS });
  const id = 'task-20260611-620';
  env.writeTask(id);
  env.setScenario([{ hang: true }]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'spawn_transient_exhausted');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, 'inactivity');
  assert.equal(marker.cost_unknown, true);
  assert.equal(marker.cost_usd, 0);
  assert.match(fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'), /cost unknown/);
});

test('inactivity kill 的部分流含 session_id 且 num_turns>1 → 重试使用 -r resume', (t) => {
  const env = makeEnv(t, {
    config: { ...FAST_LIVENESS, spawnRetries: 1, spawnBackoffMs: [0] },
  });
  const id = 'task-20260611-621';
  env.writeTask(id);
  env.setScenario([
    { hang: true, events: [{ type: 'assistant', session_id: 's-mid', num_turns: 3, message: 'partial' }] },
    {
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 's-mid',
      cost: 0.1,
      result: 'continued',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  const calls = env.calls();
  assert.equal(resumeIdOf(calls[1]), 's-mid');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.cost_unknown, true);
  assert.equal(marker.attempts[0].killed, 'inactivity');
  assert.equal(marker.attempts[1].transient, false);
});

test('持续有输出但超过 wall-clock → killed=wall_clock', (t) => {
  const env = makeEnv(t, {
    config: { ...FAST_LIVENESS, inactivityTimeoutMs: 500, spawnWallClockMs: 120 },
  });
  const id = 'task-20260611-622';
  env.writeTask(id);
  env.setScenario([{ slowAlive: true, intervalMs: 40, count: 20 }]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, 'wall_clock');
  assert.equal(marker.cost_unknown, true);
  assert.equal(env.findTask(id).box, 'failed');
});

test('慢而活着：输出间隔小于 inactivity 且未超 wall-clock，正常完成', (t) => {
  const env = makeEnv(t, {
    config: { ...FAST_LIVENESS, inactivityTimeoutMs: 120, spawnWallClockMs: 1000, spawnRetries: 1 },
  });
  const id = 'task-20260611-623';
  env.writeTask(id);
  env.setScenario([
    {
      slowAlive: true,
      intervalMs: 40,
      count: 4,
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 's-ok',
      cost: 0.1,
      result: 'fixed',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.killed, null);
  assert.equal(marker.cost_unknown, undefined);
  assert.ok(env.exists(env.dossier(id, 'maker-r1.stream.jsonl')));
});
