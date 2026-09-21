import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTaskLock, TaskLockBusyError, taskLockDir, tryAcquireTaskLock } from '../../conductor/lib/task-lock.mjs';
import { selfIdentity } from '../../conductor/lib/proc.mjs';

function tmpCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dossierDir: path.join(root, 'dossier') };
}

/** 伪造一把「别的进程留下的」任务锁：只造目录 + info.json，绕开 tryAcquireTaskLock 自己写的身份。 */
function seedTaskLock(cfg, id, info) {
  const lockDir = taskLockDir(cfg, id);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
  return lockDir;
}

function readInfo(lockDir) {
  return JSON.parse(fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8'));
}

// 一个不可能是真实启动时刻的 `ps -o lstart=` 串：用它伪造「pid 对得上、身份对不上」。
const ALIEN_STARTED = 'Mon Jan  1 00:00:00 2001';

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

// ---- 持锁者身份 = pid + 启动时刻（lib/proc.mjs）：pid 被复用不许把任务永远卡死，活锁不许被抢 ----

test('E10+身份: pid 活着但 pid_started 对不上（pid 被系统复用）→ 残锁被接管', (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260920-960';
  // 崩溃的 conductor 留下 pid=72273 的锁，几小时后系统把 72273 发给了别的进程：单看 pid 存活，
  // 这把锁永远是「活」的，run/retry 永远 TaskLockBusy。身份对不上必须判残锁，否则只能人工 rm。
  const lockDir = seedTaskLock(cfg, id, { pid: process.pid, pid_started: ALIEN_STARTED, acquired_at: '2026-07-07T00:00:00Z' });

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, true, 'pid 复用 = 原持锁进程早已不在，必须接管');
  assert.equal(lock.lockDir, lockDir, '接管后仍返回同一把锁的路径');
  assert.equal(typeof lock.release, 'function', '拿到锁才有 release 句柄');

  const info = readInfo(lockDir);
  assert.equal(info.pid, process.pid);
  assert.equal(info.pid_started, selfIdentity().pid_started, '接管后写自己的真实启动时刻：下一个进程才判得出这把锁的死活');
  assert.notEqual(info.pid_started, ALIEN_STARTED);
  assert.ok(info.acquired_at);

  lock.release();
  assert.equal(fs.existsSync(lockDir), false, 'release 必须把锁目录整个删掉');
});

test('E10+身份: 旧格式锁（无 pid_started）+ 活 pid → 不接管，且锁内容原封不动', (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260920-961';
  // processState → 'unknown'：无法确认身份时抢锁 = 可能有两个进程同时推同一个任务的 worktree。
  const lockDir = seedTaskLock(cfg, id, { pid: process.pid, acquired_at: '2026-07-07T00:00:00Z' });

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, false, '确认不了身份就不得假设持有者已死');
  assert.equal(lock.lockDir, lockDir, 'busy 也要把锁路径交回上层（报错信息要指得出是哪把锁）');
  assert.equal(lock.release, undefined, '没拿到锁就绝不能给 release 句柄——误调会删掉别人的活锁');
  assert.deepEqual(readInfo(lockDir), { pid: process.pid, acquired_at: '2026-07-07T00:00:00Z' }, '锁内容一个字节都不该变');
});

test('E10+身份: pid 活着且 pid_started 一致 → 活锁；withTaskLock 重试到底仍抛 TaskLockBusyError', async (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260920-962';
  const lockDir = seedTaskLock(cfg, id, { ...selfIdentity(), acquired_at: '2026-07-07T00:00:00Z' });

  const lock = tryAcquireTaskLock(cfg, id);
  assert.equal(lock.acquired, false, '身份完全对上 = 持有者真的还在跑，绝不抢');
  assert.equal(lock.release, undefined);

  // 上层 withTaskLock 的重试只是等对方释放，不是「等够次数就抢」：到点必须以 busy 失败。
  const err = await withTaskLock(cfg, id, async () => 'stolen', { retries: 2, retryDelayMs: 5 })
    .then(() => null, (e) => e);
  assert.ok(err instanceof TaskLockBusyError, `应抛 TaskLockBusyError，实得 ${err}`);
  assert.equal(err.id, id);
  assert.equal(err.lockDir, lockDir);
  assert.deepEqual(readInfo(lockDir), { ...selfIdentity(), acquired_at: '2026-07-07T00:00:00Z' }, '锁内容原封不动');
});

test('E10+身份: withTaskLock 遇 pid 复用残锁 → 正常接管并执行，退出后锁已释放', async (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260920-963';
  const lockDir = seedTaskLock(cfg, id, { pid: process.pid, pid_started: ALIEN_STARTED, acquired_at: '2026-07-07T00:00:00Z' });

  // 端到端：残锁不能只是「能接管」，还要让任务真的推得下去（这才是 E10 事故的解除条件）。
  const out = await withTaskLock(cfg, id, async () => {
    assert.equal(readInfo(lockDir).pid_started, selfIdentity().pid_started, '临界区内持有的是自己的锁');
    return 'ran';
  });
  assert.equal(out, 'ran');
  assert.equal(fs.existsSync(lockDir), false, 'fn 返回后锁必须释放');
});
