// 集成：并发锁——锁被占用时第二个 conductor run 直接退出，不碰任何任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('双开 conductor：第二个直接退出（exit 1），状态零变化', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-401';
  env.writeTask(id);
  env.setScenario([]);

  // 模拟第一个 conductor 正持锁
  const lockDir = path.join(env.root, 'state', '.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, acquired_at: '2026-06-11T12:00:00Z' }));

  const run = env.run('run');
  assert.equal(run.status, 1, '获锁失败应以非零退出');
  assert.match(run.stderr, /锁被占用/);
  assert.match(run.stderr, new RegExp(String(process.pid)));
  assert.equal(env.findTask(id).runtime.stage, 'READY', '任务不被触碰');
  assert.equal(env.calls().length, 0);
  assert.ok(fs.existsSync(lockDir), '不抢别人的锁');

  // 锁释放后恢复正常
  fs.rmSync(lockDir, { recursive: true });
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 's1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(!fs.existsSync(lockDir), 'run 结束释放锁');
});

test('stale 锁（mtime 超 30 分钟）打印告警但仍不抢锁', (t) => {
  const env = makeEnv(t);
  env.setScenario([]);
  const lockDir = path.join(env.root, 'state', '.lock');
  fs.mkdirSync(lockDir);
  const old = (Date.now() - 31 * 60 * 1000) / 1000;
  fs.utimesSync(lockDir, old, old);

  const run = env.run('run');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /stale/);
  assert.ok(fs.existsSync(lockDir), 'demo 阶段 stale 锁由人工删除');
});

test('死 pid 残锁：自动清除并正常获锁推进', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-402';
  env.writeTask(id);
  const lockDir = path.join(env.root, 'state', '.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 99999999, acquired_at: '2026-06-11T12:00:00Z' }));
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 's1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /已自动清除残锁/);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(!fs.existsSync(lockDir), 'run 结束释放新锁');
});
