import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

function makerCalls(env) {
  return env.calls().filter((c) => c.cwd.includes('/worktrees/') && c.argv.includes('--permission-mode'));
}

test('两个 READY 任务在 maxConcurrentTasks>=2 时并行推进', (t) => {
  const env = makeEnv(t, { config: { maxConcurrentTasks: 2 } });
  const a = 'task-20260611-640';
  const b = 'task-20260611-641';
  env.writeTask(a);
  env.writeTask(b);
  env.setScenario([
    { delayMs: 220, actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'm1', cost: 0.1, result: 'fixed' },
    { delayMs: 220, actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'm2', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(a).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.findTask(b).runtime.stage, 'AWAIT_HUMAN_MERGE');
  const makers = makerCalls(env);
  assert.equal(makers.length, 2);
  assert.ok(
    Math.abs(makers[1].started_at_ms - makers[0].started_at_ms) < 180,
    `maker starts should overlap, got ${makers.map((c) => c.started_at_ms).join(', ')}`,
  );
});

test('maxConcurrentTasks=1 时退化为串行', (t) => {
  const env = makeEnv(t, { config: { maxConcurrentTasks: 1 } });
  const a = 'task-20260611-642';
  const b = 'task-20260611-643';
  env.writeTask(a);
  env.writeTask(b);
  env.setScenario([
    { delayMs: 180, actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'm1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
    { delayMs: 180, actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'm2', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const makers = makerCalls(env);
  assert.equal(makers.length, 2);
  assert.ok(
    makers[1].started_at_ms - makers[0].started_at_ms >= 160,
    `serial maker starts should be separated, got ${makers.map((c) => c.started_at_ms).join(', ')}`,
  );
});
