import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from '../helpers/env.mjs';

test('两个 NEEDS_TARGET_SETUP 任务并发时同 repo 仅 spawn 一次 setup-agent', (t) => {
  const env = makeEnv(t, { config: { maxConcurrentTasks: 2 } });
  const a = 'task-20260611-650';
  const b = 'task-20260611-651';
  env.writeTask(a, { stage: 'NEEDS_TARGET_SETUP' });
  env.writeTask(b, { stage: 'NEEDS_TARGET_SETUP' });
  env.setScenario([
    { delayMs: 120, session_id: 'setup-1', cost: 0.1, result: '# Setup Profile\n\n- run node --test\n' },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(a).runtime.stage, 'AWAIT_SETUP_APPROVAL');
  assert.equal(env.findTask(b).runtime.stage, 'AWAIT_SETUP_APPROVAL');
  assert.equal(env.calls().length, 1, 'setup-agent 应只 spawn 一次');
  assert.match(env.run('status').stdout, /AWAIT_SETUP_APPROVAL/);
});
