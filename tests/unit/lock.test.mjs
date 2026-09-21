import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, isStaleLock, lockDirPath, STALE_MS, startLockHeartbeat } from '../../conductor/lib/lock.mjs';
import { selfIdentity } from '../../conductor/lib/proc.mjs';

function tmpStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 手工伪造一把「别的进程留下的」锁：只造目录 + info.json，绕开 acquireLock 自己写的身份。 */
function seedLock(stateDir, info, name = '.lock') {
  const lockDir = lockDirPath(stateDir, name);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
  return lockDir;
}

function readInfo(lockDir) {
  return JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
}

// 一个不可能是真实启动时刻的 `ps -o lstart=` 串：用它伪造「pid 对得上、身份对不上」。
const ALIEN_STARTED = 'Mon Jan  1 00:00:00 2001';

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

// ---- 持锁者身份 = pid + 启动时刻（lib/proc.mjs）：残锁要删得掉，活锁绝不许抢 ----

test('身份判定：pid 活着但 pid_started 对不上（pid 被系统复用）→ 残锁，自愈接管', (t) => {
  const stateDir = tmpStateDir(t);
  // 当前进程必然活着，所以单看 pid 这把锁会被永远判成「有人正在持有」——崩溃的 runner 几小时后
  // pid 被系统发给别的进程，run 就再也拿不到锁。身份对不上必须判定为残锁，否则只能人工 rm。
  const lockDir = seedLock(stateDir, {
    pid: process.pid, pid_started: ALIEN_STARTED, acquired_at: '2026-01-01T00:00:00.000Z',
  });

  const healed = [];
  const res = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });

  assert.equal(res.acquired, true, 'pid 被复用 = 原持有者早已退出，锁必须可接管');
  assert.equal(res.selfHealed, true, '接管必须打 selfHealed 标记，让上层把「抢了谁的锁」留痕');
  assert.equal(res.info.pid_started, ALIEN_STARTED, 'res.info 返回的是被接管的旧持有者，不是自己');
  assert.equal(res.info.acquired_at, '2026-01-01T00:00:00.000Z');
  assert.equal(healed.length, 1, 'onSelfHeal 恰好回调一次');
  assert.equal(healed[0].pid_started, ALIEN_STARTED, '回调拿到的同样是旧持有者 info');

  const now = readInfo(lockDir);
  assert.equal(now.pid, process.pid);
  assert.equal(now.pid_started, selfIdentity().pid_started, '新锁写自己的真实启动时刻；写错身份 = 下一个进程判不出残锁');
  assert.notEqual(now.pid_started, ALIEN_STARTED);
  assert.equal(now.self_healed_from_pid, process.pid, '留下被接管的 pid 供事后追溯（此处与自己同号只因伪造用了本进程 pid）');
  assert.ok(now.acquired_at);
});

test('身份判定：旧格式锁（无 pid_started）+ 活 pid → 不接管（确认不了身份就不许假设持有者已死）', (t) => {
  const stateDir = tmpStateDir(t);
  // processState → 'unknown'：这把锁可能真的正被一个老版本 runner 持有。抢它 = 两个 runner 并行
  // 推同一个任务，worktree 与 state 会被互相踩烂——宁可 busy 退出让人来看。
  const lockDir = seedLock(stateDir, { pid: process.pid, acquired_at: '2026-01-01T00:00:00.000Z' });

  const healed = [];
  const res = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });

  assert.equal(res.acquired, false, "holder='unknown' 不是残锁");
  assert.equal(res.selfHealed, undefined, '未接管就不得出现 selfHealed 标记');
  assert.equal(res.stale, false, 'mtime 还新，stale 告警也不该亮');
  assert.equal(res.info.pid, process.pid, '仍要把占用者 info 交回上层打印');
  assert.equal(healed.length, 0, '不接管就不许触发 onSelfHeal');

  const after = readInfo(lockDir);
  assert.equal(after.acquired_at, '2026-01-01T00:00:00.000Z', '锁内容必须原封不动（没被重写 = 确实没抢）');
  assert.equal(after.pid_started, undefined);
});

test('身份判定：pid 活着且 pid_started 一致 → 活锁，即便 mtime 已 stale 也绝不抢', (t) => {
  const stateDir = tmpStateDir(t);
  const lockDir = seedLock(stateDir, { ...selfIdentity(), acquired_at: '2026-01-01T00:00:00.000Z' });

  const healed = [];
  const first = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });
  assert.equal(first.acquired, false, '身份完全对上 = 持有者真的还在跑');
  assert.equal(first.selfHealed, undefined);
  assert.equal(first.info.pid_started, selfIdentity().pid_started);
  assert.equal(healed.length, 0);

  // mtime 超 30 分钟只是「疑似卡住」的告警，不是身份判定：活锁被 stale 顺手删掉就是并行事故。
  const old = (Date.now() - STALE_MS - 60_000) / 1000;
  fs.utimesSync(lockDir, old, old);
  const second = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });
  assert.equal(second.acquired, false, 'stale 告警不得升级成抢锁');
  assert.equal(second.stale, true);
  assert.equal(second.selfHealed, undefined);
  assert.equal(healed.length, 0);
  assert.equal(readInfo(lockDir).acquired_at, '2026-01-01T00:00:00.000Z', '锁内容原封不动');
});

test('身份判定：pid 已死（带 pid_started）→ 残锁自愈；info.json 无 pid → 按占用处理不抢', (t) => {
  const stateDir = tmpStateDir(t);
  // 死 pid：身份字段齐全也照样判死，自愈路径不是只靠「pid 复用」才走得到。
  const deadDir = seedLock(stateDir, { pid: 999999999, pid_started: ALIEN_STARTED, acquired_at: '2026-01-01T00:00:00.000Z' });
  const healed = [];
  const res = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });
  assert.equal(res.acquired, true);
  assert.equal(res.selfHealed, true);
  assert.equal(healed.length, 1);
  assert.equal(readInfo(deadDir).self_healed_from_pid, 999999999);
  releaseLock(stateDir);

  // info.json 里根本没有 pid（写锁的竞态窗口 / 残缺文件）：连身份都无从谈起，一律按占用处理。
  seedLock(stateDir, { acquired_at: '2026-01-01T00:00:00.000Z' });
  const noPid = acquireLock(stateDir, { onSelfHeal: (info) => healed.push(info) });
  assert.equal(noPid.acquired, false, '没有 pid 就没有「已死」的证据');
  assert.equal(noPid.selfHealed, undefined);
  assert.equal(healed.length, 1, 'onSelfHeal 不得被再次触发');
});

test('身份判定：precommit 串行锁（自定义锁名）走同一套自愈口径', (t) => {
  const stateDir = tmpStateDir(t);
  // 同一协议两把锁：run 的 `.lock` 与 precommit 的 `.precommit.lock`。身份判定必须对锁名无感，
  // 否则 precommit 锁一旦残留就只能人工删。
  const lockDir = seedLock(stateDir, { pid: process.pid, pid_started: ALIEN_STARTED }, '.precommit.lock');
  const res = acquireLock(stateDir, { name: '.precommit.lock' });
  assert.equal(res.acquired, true);
  assert.equal(res.selfHealed, true);
  assert.equal(readInfo(lockDir).pid_started, selfIdentity().pid_started);

  // 而 `.lock` 不受影响：两把锁互不串门。
  assert.equal(acquireLock(stateDir).acquired, true);
  assert.equal(acquireLock(stateDir, { name: '.precommit.lock' }).acquired, false, '刚自愈拿到的 precommit 锁现在是活锁');
});
