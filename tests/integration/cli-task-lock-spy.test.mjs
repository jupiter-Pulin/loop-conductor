// 集成：per-task 锁与 spy。run 推进某任务时，该任务持锁；此刻 CLI 的写操作（retry）
// 短重试后失败并说明原因，而只读的 spy 照常看得见「谁在跑第几轮」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONDUCTOR, FAKE_CLAUDE } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

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

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timeout');
}

test('运行中 step 持 per-task 锁：CLI retry 短重试后失败；spy 可只读查看 active role', async (t) => {
  const { env, id } = newRouterEnv(t, {
    config: { inactivityTimeoutMs: 2000, spawnWallClockMs: 20000 },
  });
  env.setScenario([
    routerStep('maker'),
    makerStep({ slowAlive: true, intervalMs: 80, count: 12 }),
    routerStep('human', { summary: '停在 help 闸' }),
  ]);

  const run = spawnConductor(env, 'run');
  t.after(() => run.child.kill('SIGTERM'));
  await waitFor(() => fs.existsSync(env.dossier(id, 'maker-r1.json')));
  await waitFor(() => fs.existsSync(path.join(env.root, 'dossier', id, '.lock')));

  const spy = env.run('spy');
  assert.equal(spy.status, 0, spy.stderr);
  assert.match(spy.stdout, new RegExp(id));
  assert.match(spy.stdout, /maker r1/);
  assert.match(spy.stdout, /ROUTING/);

  const retry = env.run('retry', id);
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /任务正被推进/);

  const done = await run.done;
  assert.equal(done.status, 0, done.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');
});
