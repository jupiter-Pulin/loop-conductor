// lib/proc.mjs — 进程身份与收割：恢复流程判断「记录里的那个进程还活着吗」的唯一口径。
//
// 只看 pid 不够：runner 崩溃几小时后，同一个 pid 可能已经被系统分给了别的进程。所以身份 =
// pid + 进程启动时刻（`ps -o lstart=`）。两者都对上才算「就是它」：
//   - 对上且活着 → 它是上一个 runner 留下的残留 agent，先收割再恢复，绝不与新执行者并行；
//   - pid 活着但启动时刻对不上 → pid 被复用了，原进程早已不在，**不能杀**（那是别人的进程）；
//   - 记录里没有启动时刻（旧格式）→ 只能退回 pid 存活判断，且不主动杀。
// 锁同理（lib/lock.mjs / task-lock.mjs）：活锁绝不当残锁删，残锁也不因 pid 被复用而永远删不掉。

import { spawnSync } from 'node:child_process';

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 进程启动时刻（原样字符串，仅用于相等比较）。取不到返回 null。 */
export function pidStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && out !== '' ? out : null;
  } catch {
    return null;
  }
}

/** 当前进程的身份（写进锁与 spawn 记录）。 */
export function selfIdentity() {
  return { pid: process.pid, pid_started: pidStartTime(process.pid) };
}

/**
 * 记录里的进程现在的状态：
 *   'alive'   —— 同一个进程还活着
 *   'dead'    —— 已退出
 *   'reused'  —— pid 活着但不是同一个进程（启动时刻不同）→ 视同已退出，且不得对它发信号
 *   'unknown' —— pid 活着但记录里没有启动时刻，无法确认身份
 */
export function processState({ pid, pid_started: startedAt = null } = {}) {
  const n = Number(pid);
  if (!isPidAlive(n)) return 'dead';
  if (startedAt == null) return 'unknown';
  const now = pidStartTime(n);
  if (now == null) return 'dead'; // 查的瞬间退出了
  return now === startedAt ? 'alive' : 'reused';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 收割一个进程组（claude 子进程是 detached 的组长，组里可能还有它起的测试 / 服务）。
 * 先 SIGTERM，宽限期内没退再 SIGKILL。只在身份确认为 'alive' 时调用。返回是否已退出。
 */
export async function killProcessGroup(pid, { graceMs = 10_000, pollMs = 100 } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return true;
  const signal = (sig) => {
    try { process.kill(-n, sig); } catch {
      try { process.kill(n, sig); } catch { /* 已不在 */ }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(n)) return true;
    await sleep(pollMs);
  }
  signal('SIGKILL');
  const hardDeadline = Date.now() + 5000;
  while (Date.now() < hardDeadline) {
    if (!isPidAlive(n)) return true;
    await sleep(pollMs);
  }
  return !isPidAlive(n);
}
