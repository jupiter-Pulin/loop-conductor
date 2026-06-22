// lib/lock.mjs — 并发锁：mkdir 是 POSIX 原子操作。
// 获锁失败直接退出（由调用方决定）；mtime 超 30 分钟仅打印 stale 告警，demo 阶段人工删除。
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MS = 30 * 60 * 1000;

export function lockDirPath(stateDir) {
  return path.join(stateDir, '.lock');
}

export function isStaleLock(lockDir, now = Date.now(), staleMs = STALE_MS) {
  try {
    return now - fs.statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** 返回 { acquired, stale?, info? }。失败不抛错，由调用方决定退出。 */
export function acquireLock(stateDir) {
  const lockDir = lockDirPath(stateDir);
  try {
    fs.mkdirSync(lockDir); // 原子：已存在则 EEXIST
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8')); } catch { /* 锁内无 info 也算占用 */ }
    return { acquired: false, stale: isStaleLock(lockDir), info };
  }
  fs.writeFileSync(
    path.join(lockDir, 'info.json'),
    `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return { acquired: true };
}

export function releaseLock(stateDir) {
  fs.rmSync(lockDirPath(stateDir), { recursive: true, force: true });
}
