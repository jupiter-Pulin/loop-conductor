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

export function tryAcquireTaskLock(cfg, id) {
  const lockDir = taskLockDir(cfg, id);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (err) {
    if (err.code === 'EEXIST') return { acquired: false, lockDir };
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
