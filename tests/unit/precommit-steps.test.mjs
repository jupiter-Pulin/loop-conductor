// 单元：precommit 三步的步骤语义（AC-011 / 018 / 048 / 049 / 051）。
// 用假执行器 + 假时钟钉死顺序与状态机：build → service → 分层测试，第一个适用且失败的步骤
// 决定 outcome，其后 not_run，没配置的 skipped。真子进程与真 git 的部分在集成测试里。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runPrecommitSteps, stepPlan, blankSteps, summarizeSteps, composePrecommitRecord,
  parseTestCounts, firstFailureLine, TIER_ORDER,
} from '../../conductor/lib/precommit.mjs';
import { readPrecommitProfile } from '../../conductor/lib/profile.mjs';
import { validateLog } from '../../conductor/lib/log-contract.mjs';

const FULL_PROFILE = {
  build: 'make build',
  service: { start: 'make serve', ready: { url: 'http://127.0.0.1:1/health' }, ready_timeout_ms: 5000 },
  unit: 'make unit',
  integration: 'make it',
  e2e: 'make e2e',
};

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms); },
    advance: (ms) => { t += ms; },
  };
}

/**
 * 假执行器：按命令查结果，默认 exit 0；每次调用把命令记进 events（顺序断言用）。
 * 每条命令消耗 100ms 假时钟，duration_ms 因此可断言。
 */
function harness({ profile = FULL_PROFILE, tier = 'unit', results = {}, service = {} } = {}) {
  const clock = fakeClock();
  const events = [];
  const started = [];
  let stopCalls = 0;

  const runCommand = async (command, cwd, opts) => {
    events.push(`run:${command}`);
    clock.advance(100);
    const r = results[command] ?? {};
    return {
      exitCode: r.exitCode ?? 0,
      timedOut: r.timedOut ?? false,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      cwd,
      opts,
    };
  };

  const { readyAt = 0, exitAt = null, exitCode = 0, pid = 4242 } = service;
  const startService = (args) => {
    started.push(args);
    events.push(`start:${args.command}`);
    return {
      pid,
      get exited() { return exitAt != null && clock.now() >= exitAt; },
      get exitCode() { return this.exited ? exitCode : null; },
      tail: () => 'service stdout tail',
      stop: async () => { stopCalls += 1; events.push('stop:service'); return true; },
    };
  };

  const probeReady = async () => readyAt != null && clock.now() >= readyAt;

  return {
    clock,
    events,
    started,
    get stopCalls() { return stopCalls; },
    run: () => runPrecommitSteps({
      profile, tier, cwd: '/candidate', timeoutMs: 60_000, tailBytes: 12_000,
      serviceLogPath: '/dossier/precommit-r1.service.log',
      runCommand, startService, probeReady, sleep: clock.sleep, now: clock.now,
    }),
  };
}

const statusOf = (res) => Object.fromEntries(res.steps.map((s) => [s.step, s.status]));

// ---- 顺序与骨架 ----

test('顺序固定 build → service → 测试；服务在测试步期间保持运行，最后才停', async () => {
  const h = harness({ tier: 'e2e' });
  const res = await h.run();

  assert.deepEqual(res.steps.map((s) => s.step), ['build', 'service', 'unit', 'integration', 'e2e']);
  assert.deepEqual(h.events, [
    'run:make build',
    'start:make serve',
    'run:make unit',
    'run:make it',
    'run:make e2e',
    'stop:service', // 停在最后：集成 / E2E 测试可以依赖这个服务
  ]);
  assert.equal(res.outcome, 'ok');
  assert.equal(h.stopCalls, 1);
});

test('stepPlan：tier 决定测试步范围，缺省层进 skipped_tiers', () => {
  assert.deepEqual(stepPlan(FULL_PROFILE, 'unit').steps.map((s) => s.step), ['build', 'service', 'unit']);
  assert.deepEqual(
    stepPlan(FULL_PROFILE, 'integration').steps.map((s) => s.step),
    ['build', 'service', 'unit', 'integration'],
  );
  assert.deepEqual(stepPlan(FULL_PROFILE, 'e2e').tiers, TIER_ORDER);
  assert.deepEqual(stepPlan({ unit: 'x' }, 'e2e').skipped_tiers, ['integration', 'e2e']);
  assert.deepEqual(stepPlan(FULL_PROFILE, 'e2e').skipped_tiers, []);
  // tier 非法时回落 unit（记录里的 tier 必须是合法值，否则记录本身会被判 invalid）
  assert.equal(stepPlan(FULL_PROFILE, 'nonsense').tier, 'unit');
});

// ---- 层级累加 ----

test('tier 累加：unit 只跑 unit；integration 跑 unit+integration；e2e 跑三层', async () => {
  for (const [tier, expected] of [
    ['unit', ['run:make unit']],
    ['integration', ['run:make unit', 'run:make it']],
    ['e2e', ['run:make unit', 'run:make it', 'run:make e2e']],
  ]) {
    const h = harness({ profile: { unit: 'make unit', integration: 'make it', e2e: 'make e2e' }, tier });
    const res = await h.run();
    assert.deepEqual(h.events, expected, `tier=${tier}`);
    assert.equal(res.outcome, 'ok');
    assert.deepEqual(res.skipped_tiers, []);
  }
});

test('只有 unit 的仓库声明 e2e：跑 unit，缺省两层记 skipped_tiers 且不影响裁决', async () => {
  const h = harness({ profile: { unit: 'make unit' }, tier: 'e2e' });
  const res = await h.run();
  assert.equal(res.outcome, 'ok');
  assert.deepEqual(res.skipped_tiers, ['integration', 'e2e']);
  assert.deepEqual(statusOf(res), {
    build: 'skipped', service: 'skipped', unit: 'ok', integration: 'skipped', e2e: 'skipped',
  });
  assert.match(res.summary, /integration skipped/);
  assert.match(res.summary, /e2e skipped/);
});

test('unit 缺省回落 task.testCommand（profile 读取面与步骤面接得上）', async () => {
  const profile = readPrecommitProfile({ precommit: { build: 'make build' } }, { testCommand: 'node --test' });
  const h = harness({ profile, tier: 'unit' });
  const res = await h.run();
  assert.deepEqual(h.events, ['run:make build', 'run:node --test']);
  assert.equal(res.steps.find((s) => s.step === 'unit').command, 'node --test');
  assert.deepEqual(res.skipped_tiers, []);
});

// ---- 未配置 = skipped ----

test('没配 build / service：两步 skipped，不影响裁决，等价于跑一次 unit 命令', async () => {
  const h = harness({ profile: { unit: 'make unit' }, tier: 'unit' });
  const res = await h.run();
  assert.deepEqual(h.events, ['run:make unit']);
  assert.deepEqual(statusOf(res), { build: 'skipped', service: 'skipped', unit: 'ok' });
  assert.equal(res.outcome, 'ok');
  // skipped 步的字段一律齐全（契约要求），只是没有内容
  const build = res.steps[0];
  assert.deepEqual(
    { command: build.command, exit_code: build.exit_code, timed_out: build.timed_out, tail: build.tail },
    { command: null, exit_code: null, timed_out: false, tail: '' },
  );
  const service = res.steps[1];
  assert.deepEqual(
    { ready_ms: service.ready_ms, pid: service.pid, stopped: service.stopped },
    { ready_ms: null, pid: null, stopped: false },
  );
});

// ---- 失败与 not_run ----

test('build 失败：service 与全部测试步 not_run，outcome=fail', async () => {
  const h = harness({
    tier: 'e2e',
    results: { 'make build': { exitCode: 2, stderr: 'error: cannot find module x' } },
  });
  const res = await h.run();
  assert.equal(res.outcome, 'fail');
  assert.deepEqual(h.events, ['run:make build'], '红了就不该再起服务、再跑测试');
  assert.deepEqual(statusOf(res), {
    build: 'fail', service: 'not_run', unit: 'not_run', integration: 'not_run', e2e: 'not_run',
  });
  assert.equal(res.steps[0].exit_code, 2);
  assert.match(res.summary, /^build fail: error: cannot find module x；service not_run；unit not_run/);
});

test('service 起不来（就绪前退出）：测试步 not_run，记退出码与 tail，照样 stop', async () => {
  const h = harness({ tier: 'integration', service: { readyAt: null, exitAt: 200, exitCode: 3 } });
  const res = await h.run();
  assert.equal(res.outcome, 'fail');
  assert.deepEqual(statusOf(res), { build: 'ok', service: 'fail', unit: 'not_run', integration: 'not_run' });
  const svc = res.steps[1];
  assert.equal(svc.exit_code, 3);
  assert.equal(svc.ready_ms, null);
  assert.equal(svc.timed_out, false);
  assert.equal(svc.pid, 4242);
  assert.equal(svc.stopped, true, '进程组清理无论如何都要跑并记 stopped');
  assert.match(svc.tail, /service stdout tail/);
  assert.match(res.summary, /service fail: 进程退出 3/);
});

test('service 永不就绪：ready_timeout_ms 内没起来即 fail，timed_out=true、ready_ms=null', async () => {
  const h = harness({ tier: 'unit', service: { readyAt: null } });
  const res = await h.run();
  const svc = res.steps[1];
  assert.equal(svc.status, 'fail');
  assert.equal(svc.timed_out, true);
  assert.equal(svc.ready_ms, null);
  assert.equal(svc.duration_ms, 5000, '轮询到 ready_timeout_ms 为止');
  assert.equal(svc.stopped, true);
  assert.equal(statusOf(res).unit, 'not_run');
  assert.match(res.summary, /service fail: 就绪超时 5.0s/);
});

test('service 就绪：记 ready_ms 与 pid，测试步照常跑', async () => {
  const h = harness({ tier: 'unit', service: { readyAt: 3000 } });
  const res = await h.run();
  const svc = res.steps[1];
  assert.equal(svc.status, 'ok');
  assert.equal(svc.ready_ms, 3000, '每 1s 轮询一次，第 4 次命中');
  assert.equal(svc.pid, 4242);
  assert.equal(svc.stopped, true);
  assert.equal(res.outcome, 'ok');
  assert.match(res.summary, /service ready 3.0s/);
});

test('tier 内某层红：同层后续命令 not_run，前面的 ok 保留', async () => {
  const h = harness({
    tier: 'e2e',
    results: { 'make it': { exitCode: 1, stdout: '# pass 3\n# fail 2\nnot ok 4 - 空板块不抛错' } },
  });
  const res = await h.run();
  assert.equal(res.outcome, 'fail');
  assert.deepEqual(statusOf(res), {
    build: 'ok', service: 'ok', unit: 'ok', integration: 'fail', e2e: 'not_run',
  });
  assert.match(res.summary, /integration 2 fail: not ok 4 - 空板块不抛错/);
});

test('超时的命令算 fail 并记 timed_out', async () => {
  const h = harness({ tier: 'unit', results: { 'make unit': { exitCode: null, timedOut: true } } });
  const res = await h.run();
  assert.equal(res.outcome, 'fail');
  const unit = res.steps.find((s) => s.step === 'unit');
  assert.equal(unit.status, 'fail');
  assert.equal(unit.timed_out, true);
  assert.match(res.summary, /unit fail: 超时/);
});

// ---- summary ----

test('summary 形如 `build ok 42s；service ready 3.1s；unit 41/41 ok；integration 2 fail: <首行>`', () => {
  const steps = [
    { step: 'build', command: 'make', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 42_000, tail: '' },
    { step: 'service', command: 'serve', status: 'ok', exit_code: null, timed_out: false, duration_ms: 3100, tail: '', ready_ms: 3100, pid: 9, stopped: true },
    { step: 'unit', command: 'u', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 1000, tail: '# pass 41\n# fail 0' },
    { step: 'integration', command: 'i', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 2000, tail: '# pass 8\n# fail 2\nnot ok 3 - sweep 未扣手续费' },
  ];
  assert.equal(
    summarizeSteps(steps),
    'build ok 42s；service ready 3.1s；unit 41/41 ok；integration 2 fail: not ok 3 - sweep 未扣手续费',
  );
});

test('summary：解析不出计数就退化成用时，绝不编造数字', () => {
  const steps = [{ step: 'unit', command: 'forge test', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 12_000, tail: 'Suite result: ok' }];
  assert.equal(summarizeSteps(steps), 'unit ok 12s');
});

test('parseTestCounts / firstFailureLine 的口径', () => {
  assert.deepEqual(parseTestCounts('ℹ pass 41\nℹ fail 0'), { pass: 41, fail: 0, total: 41 });
  assert.deepEqual(parseTestCounts('# pass 8\n# fail 2'), { pass: 8, fail: 2, total: 10 });
  assert.equal(parseTestCounts('随便什么输出'), null);
  assert.equal(firstFailureLine('一切正常\nnot ok 1 - median\n更多噪音'), 'not ok 1 - median');
  assert.equal(firstFailureLine('只有一行没有标记'), '只有一行没有标记');
  assert.equal(firstFailureLine(''), '(无输出)');
});

// ---- 记录 ----

test('合成记录过 validateLog(record, "precommit")：ok / fail / 冲突三种形态', async () => {
  const okRes = await harness({ tier: 'e2e' }).run();
  const okRecord = composePrecommitRecord({
    tier: okRes.tier, outcome: okRes.outcome, summary: okRes.summary,
    steps: okRes.steps, skippedTiers: okRes.skipped_tiers,
    baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), candidateSha: 'c'.repeat(40),
  });
  assert.deepEqual(validateLog(okRecord, 'precommit'), { ok: true, errors: [] });
  assert.equal(okRecord.cost_usd, 0);
  assert.equal(okRecord.role, 'precommit');

  const failRes = await harness({ tier: 'unit', results: { 'make unit': { exitCode: 1 } } }).run();
  const failRecord = composePrecommitRecord({
    tier: failRes.tier, outcome: failRes.outcome, summary: failRes.summary,
    steps: failRes.steps, skippedTiers: failRes.skipped_tiers,
  });
  assert.deepEqual(validateLog(failRecord, 'precommit'), { ok: true, errors: [] });

  // 候选冲突：三步全部 not_run，conflict_files 非空
  const plan = stepPlan(FULL_PROFILE, 'integration');
  const conflictSteps = blankSteps(plan, 'not_run');
  const conflictRecord = composePrecommitRecord({
    tier: plan.tier,
    outcome: 'fail',
    summary: summarizeSteps(conflictSteps, { prefix: '合并候选与 base 冲突：src/index.mjs' }),
    steps: conflictSteps,
    conflictFiles: ['src/index.mjs'],
  });
  assert.deepEqual(validateLog(conflictRecord, 'precommit'), { ok: true, errors: [] });
  assert.deepEqual(conflictSteps.map((s) => s.status), ['not_run', 'not_run', 'not_run', 'not_run']);
  assert.match(conflictRecord.summary, /^合并候选与 base 冲突：src\/index\.mjs；build not_run/);
});

test('tail 受 tailBytes 约束', async () => {
  const clock = fakeClock();
  const long = 'x'.repeat(5000);
  const res = await runPrecommitSteps({
    profile: { unit: 'noisy' },
    tier: 'unit',
    cwd: '/candidate',
    tailBytes: 100,
    runCommand: async () => ({ exitCode: 1, timedOut: false, stdout: long, stderr: '' }),
    sleep: clock.sleep,
    now: clock.now,
  });
  const unit = res.steps.find((s) => s.step === 'unit');
  assert.equal(Buffer.from(unit.tail, 'utf8').length, 100);
});
