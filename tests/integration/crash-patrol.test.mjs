// 集成：run 启动巡检——queue 里 stage 已是终态（FAILED_BOX / DONE）却没搬箱的僵尸任务，
// 由 patrolBoxStageConsistency 自动补搬，并留痕 timeline。崩在搬箱前的进程不该留下永久滞留。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routerEnv } from '../helpers/router-env.mjs';

test('run 启动巡检：queue/stage=FAILED_BOX 僵尸自动补搬 failed，retry 可复活到 ROUTING', (t) => {
  const env = routerEnv(t);
  const id = 'task-20260611-610';
  env.writeRouterTask(id, { stage: 'FAILED_BOX', lastFailureType: 'fuse_no_progress' });
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /box\/stage 巡检自愈/);
  let after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.match(fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'), /box\/stage 巡检/);

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'ROUTING');
});

test('run 启动巡检：queue/stage=DONE 僵尸自动补搬 done', (t) => {
  const env = routerEnv(t);
  const id = 'task-20260611-611';
  env.writeRouterTask(id, { stage: 'DONE' });
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');
  assert.match(fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'), /queue\/task-20260611-611 → done\/task-20260611-611/);
});
