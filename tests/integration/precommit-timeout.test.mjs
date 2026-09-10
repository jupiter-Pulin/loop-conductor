import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('green gate 超时：timed_out + exit_code=null，按 gate fail 进入 FIXING', (t) => {
  const env = makeEnv(t, {
    config: {
      greenGateTimeoutMs: 100,
      maxStepsPerTask: 1,
    },
  });
  const id = 'task-20260611-630';
  env.writeTask(id, { testCommand: 'node -e "setInterval(()=>{},1000)"' });
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 's1',
      cost: 0.1,
      result: 'fixed',
    },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'FIXING');
  assert.equal(after.runtime.maker_miss_count, 1);
  assert.notEqual(after.runtime.last_failure_type, 'spawn_transient_exhausted');
  const gate = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gate.timed_out, true);
  assert.equal(gate.exit_code, null);
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'green_gate');
});
