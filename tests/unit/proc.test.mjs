// 单元：进程身份与收割（lib/proc.mjs）。恢复流程、全局锁、任务锁都靠它回答同一个问题——
// 「记录里的那个进程现在还活着吗」。判错的两个方向代价都不可逆：
//   - 把已被复用的 pid 当成残留 agent 杀掉 → 杀的是陌生人的进程（所以身份必须 pid + 启动时刻都对上）；
//   - 把还活着的残留 agent 当成已退出 → 新旧两个执行者同时改同一个 worktree（所以 alive 必须认得出来）。
// killProcessGroup 同理：claude 是 detached 的组长，它起的测试 / 服务都在组里，收割必须带走整组，
// 而 pid ≤ 1 这种输入必须是 no-op —— kill(0, sig) 打的是**调用方自己所在的整个进程组**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  isPidAlive, pidStartTime, processState, selfIdentity, killProcessGroup,
} from '../../conductor/lib/proc.mjs';

/** 一个确定已退出且已被回收的 pid：spawnSync 返回时子进程已 waitpid 过，不会是僵尸。 */
function reapedPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(Number.isInteger(r.pid) && r.pid > 1, 'spawnSync 应给出子进程 pid');
  return r.pid;
}

const CHILD_LOOP = 'setInterval(() => {}, 1000)';
// 先装好 SIGTERM 处理器再报 ready：node 启动要十几毫秒，不等它就发信号的话，
// 打中的是还没装处理器的进程，走的是默认终止语义，测不到升级路径。
const CHILD_IGNORES_TERM = [
  "process.on('SIGTERM', () => {});",
  "process.stdout.write('ready\\n');",
  CHILD_LOOP,
].join('\n');
// 组长 + 组员：detached 的父进程自成一个进程组，它 spawn 的孙子进程继承这个组。
const CHILD_WITH_GRANDCHILD = [
  "const cp = require('node:child_process');",
  "const g = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "process.stdout.write(String(g.pid) + '\\n');",
  CHILD_LOOP,
].join('\n');

/** 起一个 detached 子进程，并在用例结束时兜底 SIGKILL（测试进程绝不能漏掉子进程）。 */
function spawnDetached(t, code, { pipe = false } = {}) {
  const child = spawn(process.execPath, ['-e', code], {
    detached: true,
    stdio: pipe ? ['ignore', 'pipe', 'ignore'] : 'ignore',
  });
  child.unref();
  child.on('error', () => { /* 收割之后管道出错不该把用例带崩 */ });
  child.stdout?.on('error', () => {});
  t.after(() => {
    for (const target of [-child.pid, child.pid]) {
      try { process.kill(target, 'SIGKILL'); } catch { /* 已经走了 */ }
    }
  });
  return child;
}

function firstLine(child, ms = 3000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('子进程没能在预期时间内报出 pid')), ms);
    child.stdout.on('data', (d) => {
      buf += String(d);
      if (!buf.includes('\n')) return;
      clearTimeout(timer);
      resolve(buf.split('\n')[0].trim());
    });
  });
}

async function waitGone(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isPidAlive(pid);
}

test('processState：pid 与启动时刻都对上 → alive（selfIdentity 写进记录的就是这两个字段）', () => {
  const me = selfIdentity();
  assert.equal(me.pid, process.pid);
  assert.equal(typeof me.pid_started, 'string');
  assert.notEqual(me.pid_started.trim(), '', 'macOS/Linux 上必须取得到启动时刻，否则身份判断整体退化成只看 pid');
  assert.deepEqual(Object.keys(me).sort(), ['pid', 'pid_started']);

  assert.equal(processState(me), 'alive');
  // 记录是 JSON 读回来的，pid 可能是字符串：内核自己会 Number() 一次，这里也必须容得下。
  assert.equal(processState({ pid: String(process.pid), pid_started: me.pid_started }), 'alive');
});

test('processState：已退出的 pid → dead（带不带启动时刻都一样）', () => {
  const dead = reapedPid();
  assert.equal(processState({ pid: dead, pid_started: 'Mon Jan  1 00:00:00 2001' }), 'dead');
  assert.equal(processState({ pid: dead, pid_started: null }), 'dead');
  assert.equal(processState({ pid: dead }), 'dead');

  // 记录里根本没有 pid（旧记录 / 半截记录）也必须落到 dead：NaN 绝不能被当成活着。
  assert.equal(processState({}), 'dead');
  assert.equal(processState(), 'dead');
  assert.equal(processState({ pid: null }), 'dead');
  assert.equal(processState({ pid: 'abc', pid_started: 'x' }), 'dead');
});

test('processState：pid 活着但启动时刻对不上 → reused（这一条拦住内核去杀陌生人的进程）', () => {
  const me = selfIdentity();
  // 同一个 pid，只把启动时刻换成别的：恢复流程只在 alive 时发信号，reused 必须止步。
  assert.equal(processState({ pid: process.pid, pid_started: 'Thu Jan  1 00:00:00 1970' }), 'reused');
  assert.equal(processState({ pid: process.pid, pid_started: `${me.pid_started} ` }), 'reused', '启动时刻是逐字比较，多一个空格就不是同一个进程');
  assert.equal(processState({ pid: String(process.pid), pid_started: 'nope' }), 'reused');
  // 对照：换回正确的启动时刻立刻回到 alive，证明上面的 reused 不是因为别的原因。
  assert.equal(processState({ pid: process.pid, pid_started: me.pid_started }), 'alive');
});

test('processState：活着但记录里没有启动时刻 → unknown（旧格式记录不得被当成 alive 去杀）', () => {
  assert.equal(processState({ pid: process.pid }), 'unknown');
  assert.equal(processState({ pid: process.pid, pid_started: null }), 'unknown');
  assert.equal(processState({ pid: process.pid, pid_started: undefined }), 'unknown');
  // unknown 与 alive 必须是两个值：recovery 只对 alive 调 killProcessGroup，
  // 两者一旦被合并，身份存疑的进程就会挨刀。
  assert.notEqual(processState({ pid: process.pid }), 'alive');
});

test('isPidAlive：只认正整数 pid；0 / 负数 / 小数 / 字符串一律 false', () => {
  assert.equal(isPidAlive(process.pid), true);
  // EPERM = 进程在、只是没权限发信号（如 launchd）。没权限不等于不存在，必须算活着，
  // 否则锁会把活着的持有者当成残锁删掉。
  assert.equal(isPidAlive(1), true);

  // 0 与负数是信号语义里的「整个进程组 / 特殊目标」，绝不能被当成一个普通 pid 判活。
  for (const bad of [0, -1, -process.pid, 1.5, NaN, Infinity, null, undefined, '', {}, [], String(process.pid)]) {
    assert.equal(isPidAlive(bad), false, `isPidAlive(${JSON.stringify(bad)}) 必须为 false`);
  }

  assert.equal(isPidAlive(reapedPid()), false);
});

test('pidStartTime：非法 pid 与已退出的进程返回 null；同一进程两次取值必须逐字相同', () => {
  const a = pidStartTime(process.pid);
  assert.equal(typeof a, 'string');
  assert.notEqual(a, '');
  assert.equal(a, a.trim(), '返回值已 trim：两侧空白会让相等比较误判成 reused');
  assert.equal(pidStartTime(process.pid), a, '不稳定的启动时刻会让活着的进程被判成 reused');

  assert.equal(pidStartTime(reapedPid()), null, '进程没了 → ps 非零退出 → null（processState 据此判 dead）');
  for (const bad of [0, -1, 1.5, NaN, null, undefined, String(process.pid)]) {
    assert.equal(pidStartTime(bad), null, `pidStartTime(${JSON.stringify(bad)}) 必须为 null`);
  }
});

test('killProcessGroup：pid ≤ 1 是 no-op，直接 true（绝不对 0 / -1 / 1 发信号）', async () => {
  // 这条不是形式主义：signal() 里发的是 process.kill(-n, …)，n=0 就是「当前进程组」，
  // n=1 是 init。真发出去的话，第一个被杀的是跑内核的这个进程自己。
  for (const bad of [0, 1, -1, -process.pid, NaN, null, undefined, 'abc', 1.5]) {
    assert.equal(await killProcessGroup(bad, { graceMs: 50, pollMs: 10 }), true, `killProcessGroup(${JSON.stringify(bad)}) 应是 no-op`);
  }
  assert.equal(isPidAlive(process.pid), true, '测试进程自己必须毫发无伤（没有信号被发到本进程组）');
});

test('killProcessGroup：真的收走 detached 子进程的整个进程组（组长 + 它起的子进程）', async (t) => {
  const parent = spawnDetached(t, CHILD_WITH_GRANDCHILD, { pipe: true });
  const grandchild = Number(await firstLine(parent));
  assert.ok(Number.isInteger(grandchild) && grandchild > 1, '孙子进程 pid 应可读到');
  assert.equal(isPidAlive(parent.pid), true);
  assert.equal(isPidAlive(grandchild), true);

  const ok = await killProcessGroup(parent.pid, { graceMs: 2000, pollMs: 20 });
  assert.equal(ok, true, '收割成功必须如实返回 true');
  assert.equal(isPidAlive(parent.pid), false, '组长必须真的没了，而不是「发过信号就算数」');
  // 组员是 claude 起的测试 / 服务：只杀组长的话它们会活下来继续占端口、继续写 worktree。
  assert.equal(await waitGone(grandchild), true, '同组的孙子进程也必须被带走');
});

test('killProcessGroup：SIGTERM 不走的进程，宽限期到了升级 SIGKILL', async (t) => {
  const child = spawnDetached(t, CHILD_IGNORES_TERM, { pipe: true });
  assert.equal(await firstLine(child), 'ready', 'SIGTERM 处理器已就位才开始收割');
  assert.equal(isPidAlive(child.pid), true);

  const started = Date.now();
  const ok = await killProcessGroup(child.pid, { graceMs: 150, pollMs: 20 });
  const elapsed = Date.now() - started;

  assert.equal(ok, true);
  assert.equal(isPidAlive(child.pid), false, '赖着不走的 agent 最终必须被 SIGKILL 带走，否则恢复会永远等下去');
  assert.ok(elapsed >= 150, `应先给满宽限期再升级（实际 ${elapsed}ms）——直接 SIGKILL 会让 agent 没机会收尾`);
  assert.ok(elapsed < 3000, `升级后不该再空等（实际 ${elapsed}ms）`);
});

test('killProcessGroup：已经退出的 pid 立刻返回 true，不空等宽限期', async () => {
  const dead = reapedPid();
  const started = Date.now();
  // 故意给一个很长的宽限期：实现必须在第一次存活检查就返回，否则崩溃恢复会被残留记录拖死。
  const ok = await killProcessGroup(dead, { graceMs: 30_000, pollMs: 10 });
  const elapsed = Date.now() - started;
  assert.equal(ok, true);
  assert.ok(elapsed < 500, `已退出的进程应立刻返回（实际 ${elapsed}ms）`);
});
