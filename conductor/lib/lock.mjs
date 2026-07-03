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

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 返回 { acquired, stale?, info?, selfHealed? }。失败不抛错，由调用方决定退出。 */
export function acquireLock(stateDir, { onSelfHeal = null } = {}) {
  const lockDir = lockDirPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.mkdirSync(lockDir); // 原子：已存在则 EEXIST
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8')); } catch { /* 锁内无 info 也算占用 */ }
    if (info?.pid != null && !isPidAlive(Number(info.pid))) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      if (onSelfHeal) onSelfHeal(info);
      try {
        fs.mkdirSync(lockDir);
      } catch (retryErr) {
        if (retryErr.code !== 'EEXIST') throw retryErr;
        let retryInfo = null;
        try { retryInfo = JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8')); } catch { /* ignore */ }
        return { acquired: false, stale: isStaleLock(lockDir), info: retryInfo };
      }
      writeJsonAtomic(path.join(lockDir, 'info.json'), {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        self_healed_from_pid: info.pid,
      });
      return { acquired: true, selfHealed: true, info };
    }
    return { acquired: false, stale: isStaleLock(lockDir), info };
  }
  writeJsonAtomic(path.join(lockDir, 'info.json'), { pid: process.pid, acquired_at: new Date().toISOString() });
  return { acquired: true };
}

export function releaseLock(stateDir) {
  fs.rmSync(lockDirPath(stateDir), { recursive: true, force: true });
}

export function startLockHeartbeat(stateDir, intervalMs) {
  const lockDir = lockDirPath(stateDir);
  const ms = Math.max(1, Number(intervalMs) || 1);
  const touch = () => {
    try {
      const now = new Date();
      fs.utimesSync(lockDir, now, now);
    } catch {
      // 锁可能已释放；心跳停止时无需额外噪音。
    }
  };
  touch();
  const timer = setInterval(touch, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
