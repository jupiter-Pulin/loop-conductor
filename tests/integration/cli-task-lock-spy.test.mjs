import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeEnv, CONDUCTOR, FAKE_CLAUDE, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

function conductorEnv(env) {
  const childEnv = {
    ...process.env,
    CONDUCTOR_ROOT: env.root,
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_SCRIPT: env.scenarioPath,
    FAKE_CLAUDE_LOG: env.logPath,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  return childEnv;
}

function spawnConductor(env, ...args) {
  const child = spawn(process.execPath, [CONDUCTOR, ...args], {
    encoding: 'utf8',
    env: conductorEnv(env),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const done = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(fn, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timeout');
}

test('运行中 step 持 per-task 锁：CLI retry 短重试后失败；spy 可只读查看 active role', async (t) => {
  const env = makeEnv(t, {
    config: {
      inactivityTimeoutMs: 500,
      spawnWallClockMs: 5000,
    },
  });
  const id = 'task-20260611-660';
  env.writeTask(id);
  env.setScenario([
    {
      slowAlive: true,
      intervalMs: 80,
      count: 8,
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'slow-maker',
      cost: 0.1,
      result: 'fixed',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = spawnConductor(env, 'run');
  t.after(() => run.child.kill('SIGTERM'));
  await waitFor(() => fs.existsSync(env.dossier(id, 'maker-r1.json')));
  await waitFor(() => fs.existsSync(path.join(env.root, 'dossier', id, '.lock')));

  const spy = env.run('spy');
  assert.equal(spy.status, 0, spy.stderr);
  assert.match(spy.stdout, new RegExp(id));
  assert.match(spy.stdout, /maker r1/);

  const retry = env.run('retry', id);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /任务正被推进/);

  const done = await run.done;
  assert.equal(done.status, 0, done.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
});
