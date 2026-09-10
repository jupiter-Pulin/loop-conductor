// 集成：precommit 的 service 步四条路径与进程清理（AC-049）。
// 用 tests/fixtures/fake-service.mjs 起真进程：就绪 / 永不就绪 / 就绪前崩溃 / 清理。
// 每条路径结束后都断言「没有残留进程」——孤儿服务占着端口，会让下一个任务的 precommit 恒红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runPrecommit } from '../../conductor/lib/precommit.mjs';
import { validateLog } from '../../conductor/lib/log-contract.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { makePrecommitEnv, waitFor, pidAlive, FAKE_SERVICE, CMD_OK } from '../helpers/precommit-env.mjs';

/** 先占一个端口再让开：ready.url 形态需要事先知道端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function serviceEnv(env, extra = {}) {
  return {
    FAKE_SERVICE_PORT_FILE: path.join(env.root, 'service.port'),
    ...extra,
  };
}

const startCmd = `node ${FAKE_SERVICE}`;
const probeCmd = (env) => `node ${FAKE_SERVICE} --probe ${path.join(env.root, 'service.port')}`;

async function runWithService(env, { service, unit = null, tier = 'unit', round = 1 }) {
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  return runPrecommit({
    cfg: env.cfg,
    id: env.id,
    task: env.task(),
    round,
    tier,
    profile: { build: null, service, unit: unit ?? CMD_OK, integration: null, e2e: null },
  });
}

test('就绪（ready.url 2xx）：记 ready_ms 与 pid，服务在测试步期间还活着，结束后被清理', async (t) => {
  const env = makePrecommitEnv(t);
  const port = await freePort();
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { url: `http://127.0.0.1:${port}/health` },
      ready_timeout_ms: 20_000,
      env: serviceEnv(env, { FAKE_SERVICE_PORT: String(port), FAKE_SERVICE_READY_DELAY_MS: '300' }),
    },
    // 测试步反过来探一次服务：服务必须还在跑（AC-049「服务在测试步期间保持运行」）
    unit: probeCmd(env),
  });

  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(record.outcome, 'ok');
  const svc = env.stepOf(record, 'service');
  assert.equal(svc.status, 'ok');
  assert.ok(svc.ready_ms >= 0 && svc.ready_ms < 20_000, `ready_ms 应落在就绪窗口内，实际 ${svc.ready_ms}`);
  assert.ok(Number.isInteger(svc.pid) && svc.pid > 0);
  assert.equal(svc.stopped, true);
  assert.equal(svc.timed_out, false);
  assert.equal(env.stepOf(record, 'unit').status, 'ok', '测试步能连上服务，说明它一直活着');
  assert.match(record.summary, /service ready \d/);

  // stdout/stderr 落 dossier
  const log = env.serviceLog(1);
  assert.match(log, /fake-service: listening on \d+/);
  assert.match(log, /stderr 也要落进 service\.log/);

  assert.ok(await waitFor(() => !pidAlive(svc.pid)), '服务进程必须已经不在了');
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});

test('就绪（ready.command exit 0）：随机端口 + 端口文件，同样判 ok', async (t) => {
  const env = makePrecommitEnv(t);
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { command: probeCmd(env) },
      ready_timeout_ms: 20_000,
      env: serviceEnv(env, { FAKE_SERVICE_READY_DELAY_MS: '200' }),
    },
  });

  assert.equal(record.outcome, 'ok');
  const svc = env.stepOf(record, 'service');
  assert.equal(svc.status, 'ok');
  assert.equal(svc.stopped, true);
  assert.ok(await waitFor(() => !pidAlive(svc.pid)));
});

test('永不就绪：ready_timeout_ms 到点判 fail，测试步 not_run，进程被清理', async (t) => {
  const env = makePrecommitEnv(t);
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { command: probeCmd(env) },
      ready_timeout_ms: 2500,
      env: serviceEnv(env, { FAKE_SERVICE_MODE: 'never' }),
    },
  });

  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(record.outcome, 'fail');
  const svc = env.stepOf(record, 'service');
  assert.equal(svc.status, 'fail');
  assert.equal(svc.timed_out, true);
  assert.equal(svc.ready_ms, null);
  assert.equal(svc.exit_code, null, '超时不是「进程退出」');
  assert.equal(svc.stopped, true);
  assert.ok(svc.duration_ms >= 2000, `就绪轮询应跑满窗口，实际 ${svc.duration_ms}ms`);
  assert.equal(env.statusMap(record).unit, 'not_run');
  assert.match(record.summary, /service fail: 就绪超时/);
  assert.ok(await waitFor(() => !pidAlive(svc.pid)), '超时也必须把进程清掉');
});

test('就绪前崩溃：记退出码与输出 tail，测试步 not_run', async (t) => {
  const env = makePrecommitEnv(t);
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { command: probeCmd(env) },
      ready_timeout_ms: 20_000,
      env: serviceEnv(env, { FAKE_SERVICE_MODE: 'crash', FAKE_SERVICE_CRASH_AFTER_MS: '300', FAKE_SERVICE_EXIT_CODE: '7' }),
    },
  });

  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(record.outcome, 'fail');
  const svc = env.stepOf(record, 'service');
  assert.equal(svc.status, 'fail');
  assert.equal(svc.exit_code, 7);
  assert.equal(svc.ready_ms, null);
  assert.equal(svc.timed_out, false, '进程自己退了，不是我们等超时');
  assert.equal(svc.stopped, true);
  assert.match(svc.tail, /就绪前崩溃/);
  assert.equal(env.statusMap(record).unit, 'not_run');
  assert.match(record.summary, /service fail: 进程退出 7/);
  assert.match(env.serviceLog(1), /就绪前崩溃/);
});

test('清理打的是整个进程组：服务派生的子进程一并消失', async (t) => {
  const env = makePrecommitEnv(t);
  const childPidFile = path.join(env.root, 'child.pid');
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { command: probeCmd(env) },
      ready_timeout_ms: 20_000,
      env: serviceEnv(env, { FAKE_SERVICE_CHILD_PID_FILE: childPidFile }),
    },
  });

  assert.equal(record.outcome, 'ok');
  const svc = env.stepOf(record, 'service');
  const childPid = Number(fs.readFileSync(childPidFile, 'utf8').trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.ok(await waitFor(() => !pidAlive(svc.pid)), '服务本体必须没了');
  assert.ok(await waitFor(() => !pidAlive(childPid)), '子进程也必须没了：SIGTERM 打的是进程组');
});

test('服务装死不理 SIGTERM：stop_grace_ms 之后 SIGKILL 兜底', async (t) => {
  const env = makePrecommitEnv(t);
  const record = await runWithService(env, {
    service: {
      start: startCmd,
      ready: { command: probeCmd(env) },
      ready_timeout_ms: 20_000,
      stop_grace_ms: 800,
      env: serviceEnv(env, { FAKE_SERVICE_IGNORE_SIGTERM: '1' }),
    },
  });

  assert.equal(record.outcome, 'ok');
  const svc = env.stepOf(record, 'service');
  assert.equal(svc.stopped, true);
  assert.ok(await waitFor(() => !pidAlive(svc.pid)), 'SIGTERM 无效时必须升级到 SIGKILL');
  assert.match(env.serviceLog(1), /收到 SIGTERM，装死不退/);
});
