// 集成：precommit 全局串行锁（AC-050）。
// 端口、数据库这类共享资源不容两个候选同时跑：第二个必须等锁；等不到就记 lock_timeout
// 让 router 直接重试；持有者进程已死的残锁被接管，接管时锁里记着的服务 pid 先被终止
// ——否则新候选一起来就撞上旧候选还占着的端口，红得莫名其妙。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPrecommit, precommitLockDir, PRECOMMIT_LOCK_NAME } from '../../conductor/lib/precommit.mjs';
import { validateLog } from '../../conductor/lib/log-contract.mjs';
import { lockDirPath } from '../../conductor/lib/lock.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { makePrecommitEnv, waitFor, pidAlive, UNIT_CHECKS_FIX, CMD_OK } from '../helpers/precommit-env.mjs';

const OK_PROFILE = { build: null, service: null, unit: CMD_OK, integration: null, e2e: null };

function lockInfoPath(env) {
  return path.join(precommitLockDir(env.cfg.stateDir), 'info.json');
}

/** 手工占锁（模拟另一个 conductor 进程持有它）。holderPid 默认本测试进程（活着 = 不是残锁）。 */
function holdLock(env, { holderPid = process.pid, servicePid = null } = {}) {
  const dir = precommitLockDir(env.cfg.stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockInfoPath(env), `${JSON.stringify({
    pid: holderPid, acquired_at: new Date().toISOString(), task_id: 'other-task', service_pid: servicePid,
  }, null, 2)}\n`);
  return dir;
}

/** 起一个空转进程当「旧候选的服务」，并保证测试结束时它一定不在。 */
function spawnIdleProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经没了 */ } });
  return child.pid;
}

/** 一个确定已死的 pid：起一个立刻退出的进程，等它退完再用它的 pid。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

test('锁名就是 state/.precommit.lock，且与 run 的全局锁互不干扰', (t) => {
  const env = makePrecommitEnv(t);
  assert.equal(PRECOMMIT_LOCK_NAME, '.precommit.lock');
  assert.equal(precommitLockDir(env.cfg.stateDir), path.join(env.cfg.stateDir, '.precommit.lock'));
  assert.notEqual(precommitLockDir(env.cfg.stateDir), lockDirPath(env.cfg.stateDir));
});

test('第二个 precommit 等锁：前一个释放后照常跑完', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitLockTimeoutMs: 10_000 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  holdLock(env); // 持有者是本进程：活着，绝不该被当残锁抢走

  const releaseAt = Date.now() + 1200;
  const timer = setTimeout(() => fs.rmSync(precommitLockDir(env.cfg.stateDir), { recursive: true, force: true }), 1200);
  t.after(() => clearTimeout(timer));

  const startedAt = Date.now();
  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    profile: { ...OK_PROFILE, unit: UNIT_CHECKS_FIX },
  });

  assert.ok(Date.now() >= releaseAt, '必须一直等到锁被释放');
  assert.ok(Date.now() - startedAt >= 1000, `等锁时间应覆盖持锁窗口，实际 ${Date.now() - startedAt}ms`);
  assert.equal(record.outcome, 'ok');
  assert.equal(fs.existsSync(precommitLockDir(env.cfg.stateDir)), false, '跑完必须把锁还回去');
});

test('等锁超时：outcome fail、steps 全部 not_run、summary 为 lock_timeout，别人的锁原样不动', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitLockTimeoutMs: 400 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  holdLock(env);
  t.after(() => fs.rmSync(precommitLockDir(env.cfg.stateDir), { recursive: true, force: true }));

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 3, tier: 'integration',
    profile: { build: CMD_OK, service: null, unit: CMD_OK, integration: CMD_OK, e2e: null },
  });

  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(record.outcome, 'fail');
  assert.equal(record.summary, 'lock_timeout');
  assert.deepEqual(record.steps.map((s) => s.status), ['not_run', 'not_run', 'not_run', 'not_run']);
  assert.equal(record.candidate_sha, null);
  assert.deepEqual(record.conflict_files, []);
  assert.equal(record.head_sha, env.sha(env.taskBranch), '事实字段照记：router 要看得见版本');
  assert.equal(record.base_sha, env.sha('main'));
  assert.deepEqual(env.record(3), record);

  // 没抢到锁就绝不能碰锁与候选
  assert.equal(fs.existsSync(precommitLockDir(env.cfg.stateDir)), true);
  assert.equal(JSON.parse(fs.readFileSync(lockInfoPath(env), 'utf8')).task_id, 'other-task');
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});

test('残锁接管：持有者已死时先终止锁里记着的服务 pid，再接管锁', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitLockTimeoutMs: 10_000 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  const zombieService = spawnIdleProcess(t);
  const holder = await deadPid();
  holdLock(env, { holderPid: holder, servicePid: zombieService });
  assert.equal(pidAlive(zombieService), true, '前置：旧服务还活着');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    profile: { ...OK_PROFILE, unit: UNIT_CHECKS_FIX },
  });

  assert.equal(record.outcome, 'ok', '残锁不该把后来的任务饿死');
  assert.ok(await waitFor(() => !pidAlive(zombieService)), '接管前必须把旧候选的服务终止掉');
  assert.equal(fs.existsSync(precommitLockDir(env.cfg.stateDir)), false);
});

test('持有者活着的锁不会被当成残锁抢走（哪怕锁里记着服务 pid）', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitLockTimeoutMs: 400 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  const liveService = spawnIdleProcess(t);
  holdLock(env, { holderPid: process.pid, servicePid: liveService });
  t.after(() => fs.rmSync(precommitLockDir(env.cfg.stateDir), { recursive: true, force: true }));

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit', profile: OK_PROFILE,
  });

  assert.equal(record.summary, 'lock_timeout');
  assert.equal(pidAlive(liveService), true, '别人还在跑的服务绝不能被杀');
});

test('跑赢锁之后锁里记着自己的 pid 与服务 pid（接管的依据）', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitLockTimeoutMs: 5_000 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  const seen = [];

  await runPrecommit({
    cfg: env.cfg,
    id: env.id,
    task: env.task(),
    round: 1,
    tier: 'unit',
    profile: {
      build: null,
      service: { start: `node -e 'setInterval(()=>{},1000)'`, ready: { command: CMD_OK }, ready_timeout_ms: 5000 },
      unit: CMD_OK,
      integration: null,
      e2e: null,
    },
    // 服务起来之后、清理之前，锁里必须能读到持有者 pid 与服务 pid
    runCommand: async (command, cwd, opts) => {
      seen.push(JSON.parse(fs.readFileSync(lockInfoPath(env), 'utf8')));
      const { defaultRunCommand } = await import('../../conductor/lib/precommit.mjs');
      return defaultRunCommand(command, cwd, opts);
    },
  });

  const duringUnit = seen.at(-1);
  assert.equal(duringUnit.pid, process.pid);
  assert.ok(Number.isInteger(duringUnit.service_pid) && duringUnit.service_pid > 0);
  assert.equal(duringUnit.task_id, env.id);
  assert.ok(await waitFor(() => !pidAlive(duringUnit.service_pid)));
});
