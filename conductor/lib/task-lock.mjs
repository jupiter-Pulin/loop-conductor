// lib/task-lock.mjs — 单任务写锁。路径在 dossier/<id> 下，跨 state box rename 稳定。
import fs from 'node:fs';
import path from 'node:path';

export class TaskLockBusyError extends Error {
  constructor(id, lockDir) {
    super(`任务正被推进：${id}`);
    this.name = 'TaskLockBusyError';
    this.id = id;
    this.lockDir = lockDir;
  }
}

export function taskLockDir(cfg, id) {
  return path.join(cfg.dossierDir, id, '.lock');
}

function writeInfo(lockDir) {
  const tmp = path.join(lockDir, `.info.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, path.join(lockDir, 'info.json'));
}

/** 持锁进程是否存活。EPERM 表示存在但无权限（仍算活）；ESRCH/非法 pid 算死。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 死锁判定：info.json 可读且持锁 pid 已死才算 stale。info.json 缺失/损坏一律按活锁处理
 * （可能是 mkdir 与 writeInfo 之间的竞态窗口，宁可 busy 也不抢）。
 */
function isStaleLock(lockDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
    return !pidAlive(info.pid);
  } catch {
    return false;
  }
}

export function tryAcquireTaskLock(cfg, id, { _tookOver = false } = {}) {
  const lockDir = taskLockDir(cfg, id);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 崩溃的 conductor 会留下永不释放的残锁（真实案例：task-20260706-002 被杀后
      // pid 72273 的锁把任务卡死，run/retry 全部 TaskLockBusy）。持锁 pid 已死则接管一次。
      if (!_tookOver && isStaleLock(lockDir)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return tryAcquireTaskLock(cfg, id, { _tookOver: true });
      }
      return { acquired: false, lockDir };
    }
    throw err;
  }
  writeInfo(lockDir);
  return {
    acquired: true,
    lockDir,
    release() {
      fs.rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTaskLock(cfg, id, fn, { retries = 0, retryDelayMs = 0 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const lock = tryAcquireTaskLock(cfg, id);
    last = lock;
    if (lock.acquired) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    if (attempt < retries) await delay(retryDelayMs);
  }
  throw new TaskLockBusyError(id, last?.lockDir ?? taskLockDir(cfg, id));
}
