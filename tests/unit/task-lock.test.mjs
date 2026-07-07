import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTaskLock, TaskLockBusyError, taskLockDir, tryAcquireTaskLock } from '../../conductor/lib/task-lock.mjs';

function tmpCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dossierDir: path.join(root, 'dossier') };
}

test('withTaskLock：持锁期间第二个调用失败，释放后可重入', async (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260611-701';
  let release;
  const first = withTaskLock(cfg, id, async () => {
    await new Promise((resolve) => { release = resolve; });
    return 'done';
  });
  while (!fs.existsSync(taskLockDir(cfg, id))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await assert.rejects(
    () => withTaskLock(cfg, id, async () => 'second', { retries: 1, retryDelayMs: 5 }),
    TaskLockBusyError,
  );
  release();
  assert.equal(await first, 'done');
  assert.equal(await withTaskLock(cfg, id, async () => 'again'), 'again');
});

test('E10: 持锁 pid 已死 → 残锁被接管（真实案例：崩溃 conductor 留永久锁）', (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260707-950';
  // 手工伪造一个死进程残锁：pid 取一个必然不存在的值
  const lockDir = taskLockDir(cfg, id);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 999999999, acquired_at: '2026-07-07T00:00:00Z' }));

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, true, '死 pid 残锁必须被接管');
  const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
  assert.equal(info.pid, process.pid, '接管后 info.json 写当前进程');
  lock.release();
});

test('E10: 持锁 pid 存活 → 仍然 busy（回归守卫：活锁绝不被抢）', (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260707-951';
  const lockDir = taskLockDir(cfg, id);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, acquired_at: '2026-07-07T00:00:00Z' }));

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, false, '活 pid 的锁不得接管');
});

test('E10: info.json 缺失（mkdir 与 writeInfo 竞态窗口）→ 按活锁处理不抢', (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260707-952';
  fs.mkdirSync(taskLockDir(cfg, id), { recursive: true });

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, false, 'info 不可读宁可 busy');
});
