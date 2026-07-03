import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, isStaleLock, lockDirPath, STALE_MS, startLockHeartbeat } from '../../conductor/lib/lock.mjs';

function tmpStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('获取 → 占用 → 释放 → 再获取', (t) => {
  const stateDir = tmpStateDir(t);
  const first = acquireLock(stateDir);
  assert.equal(first.acquired, true);
  const info = JSON.parse(fs.readFileSync(path.join(lockDirPath(stateDir), 'info.json'), 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.ok(info.acquired_at);

  const second = acquireLock(stateDir);
  assert.equal(second.acquired, false);
  assert.equal(second.stale, false);
  assert.equal(second.info.pid, process.pid);

  releaseLock(stateDir);
  assert.equal(fs.existsSync(lockDirPath(stateDir)), false);
  assert.equal(acquireLock(stateDir).acquired, true);
});

test('stale 判定：mtime 超 30 分钟', (t) => {
  const stateDir = tmpStateDir(t);
  assert.equal(acquireLock(stateDir).acquired, true);
  const lockDir = lockDirPath(stateDir);
  assert.equal(isStaleLock(lockDir), false);

  const old = (Date.now() - STALE_MS - 60_000) / 1000;
  fs.utimesSync(lockDir, old, old);
  assert.equal(isStaleLock(lockDir), true);

  const attempt = acquireLock(stateDir);
  assert.equal(attempt.acquired, false); // stale 也只是告警，不抢锁
  assert.equal(attempt.stale, true);
});

test('isStaleLock 对不存在的锁返回 false', () => {
  assert.equal(isStaleLock('/nonexistent/.lock'), false);
});

test('releaseLock 对不存在的锁不抛错', (t) => {
  const stateDir = tmpStateDir(t);
  assert.doesNotThrow(() => releaseLock(stateDir));
});

test('startLockHeartbeat：周期刷新锁目录 mtime', async (t) => {
  const stateDir = tmpStateDir(t);
  assert.equal(acquireLock(stateDir).acquired, true);
  const lockDir = lockDirPath(stateDir);
  const old = (Date.now() - STALE_MS - 60_000) / 1000;
  fs.utimesSync(lockDir, old, old);
  assert.equal(isStaleLock(lockDir), true);

  const stop = startLockHeartbeat(stateDir, 20);
  t.after(() => stop());
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(isStaleLock(lockDir), false);
});
