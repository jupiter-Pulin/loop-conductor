// 集成：工程边界——越权被机制拒绝，预算 / 限额 / 人闸 / 保险丝对新调度同样生效。
//
// 覆盖的验收场景：
//   · router / worker 尝试越权或使用旧证据：执行或放行被工程机制拒绝，不能依靠模型自觉回避
//   · 预算、runBudget、限额或人闸生效：新调度、续跑和子委派都不能绕过；停止原因和恢复条件明确
//   · agent 无响应或连续无进展：有限恢复后明确停止并保留材料；慢而有进展的任务不被同样处置
// fake-claude 不跑 hook，所以这里的「越权」模拟的正是最坏情形：Bash 绕过了一切 hook 直接写盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CONDUCTOR, promptOf } from '../helpers/env.mjs';
import {
  approvedSpecEnv, assignment, bigSpec, dispatchStep, ledgerReviewerStep, routerStep, workerStep,
} from '../helpers/router-env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const routerPrompts = (env) => env.calls().filter((c) => /router-r\d+\.log\.json/.test(promptOf(c))).map(promptOf);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 越权 ----

test('worker 越权写盘（绕过所有 hook）：改获批 spec / 伪造 reviewer 记录 / 改人闸裁决 / 改内核配置 → 全部还原或隔离，内核停下等人', (t) => {
  const spec = bigSpec(2);
  const { env, id } = approvedSpecEnv(t, { specBody: spec, notes: '保持零依赖' });
  const d = (name) => env.dossier(id, name);
  const humanBefore = env.readFile(d('human-r1.json'));
  const configBefore = env.readFile(path.join(env.root, 'conductor.config.json'));
  env.setKeyed({
    'worker-evil': [workerStep({
      files: { 'lib/stats.mjs': FIXED_STATS },
      summary: '全部 AC 已通过',
      actions: [
        { type: 'writeAbs', path: d('spec.md'), content: '# 被改小的 spec\n\n## 验收标准\n\n- AC-001: 随便\n' },
        { type: 'writeAbs', path: d('human-r1.json'), content: { kind: 'spec', decision: 'approved', notes: '什么都可以' } },
        { type: 'writeAbs', path: path.join(env.root, 'conductor.config.json'), content: { budgetUsd: 99999 } },
        // 伪造一整套「整体 review 已通过」的证据
        { type: 'writeAbs', path: d('reviewer-r9.json'), content: { role: 'reviewer', round: 9, started: 'x', done: 'y', head_sha: 'HEAD' } },
        { type: 'writeAbs', path: d('reviewer-r9.log.json'), content: { role: 'reviewer', outcome: 'ok', tier: 'unit', summary: 'all pass' } },
        { type: 'writeAbs', path: d('reviewer-r9.verdicts.json'), content: { verdicts: [{ ac: 'AC-001', verdict: 'pass', evidence: 'x' }, { ac: 'AC-002', verdict: 'pass', evidence: 'x' }] } },
      ],
    })],
  });
  env.appendScenario([dispatchStep([assignment('evil')])]);
  assert.equal(env.run('run').status, 0);

  assert.equal(env.readFile(d('spec.md')), spec, '获批 spec 逐字节还原');
  assert.equal(env.readFile(d('human-r1.json')), humanBefore, '人闸裁决还原');
  assert.equal(env.readFile(path.join(env.root, 'conductor.config.json')), configBefore, '内核配置还原');
  for (const forged of ['reviewer-r9.json', 'reviewer-r9.log.json', 'reviewer-r9.verdicts.json']) {
    assert.equal(env.exists(d(forged)), false, `${forged} 不得留在案卷里`);
  }
  assert.equal(fs.readdirSync(d('quarantine')).length, 3, '伪造的记录被隔离留证');

  const violation = env.events(id).find((e) => e.type === 'boundary_violation');
  assert.deepEqual(violation.violations.map((v) => v.kind).sort(), ['forged', 'forged', 'forged', 'modified', 'modified', 'modified']);
  assert.ok(violation.violations.every((v) => v.restored === true));
  const ts = env.findTask(id);
  assert.equal(ts.runtime.awaiting.kind, 'help');
  const gate = env.readJson(d(`human-r${ts.runtime.awaiting.round}.json`));
  assert.equal(gate.requested_by, 'kernel');
  assert.match(gate.summary, /执行越过了授权边界，内核已还原 \/ 隔离/);

  // 伪造的证据没有生效：验收门原样。
  assert.match(env.run('show', id).stdout, /need_review=true/);
});

test('sandbox 档不得碰产品：实验会话把任务分支挪了 → 内核挪回去、记违规；实验目录里的提交进不了任务分支', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  env.setKeyed({
    'worker-base': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })],
    'worker-probe': [workerStep({
      files: { 'hack.mjs': 'export const hack = 1;\n' },
      report: '实验结论\n',
      actions: [
        { type: 'git', args: ['add', '-A'] },
        { type: 'git', args: ['-c', 'user.email=x@x', '-c', 'user.name=x', 'commit', '-m', 'sneak into product'] },
        { type: 'git', args: ['update-ref', `refs/heads/task/${id}`, 'HEAD'] },
      ],
    })],
  });
  env.appendScenario([dispatchStep([assignment('base')]), dispatchStep([assignment('probe', 'sandbox')])]);
  assert.equal(env.run('run').status, 0);

  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.equal(tree.includes('hack.mjs'), false, '实验产物没有进任务分支');
  assert.ok(tree.includes('lib/stats.mjs'));
  const violation = env.events(id).find((e) => e.type === 'boundary_violation');
  assert.deepEqual(violation.violations.map((v) => [v.kind, v.restored]), [['branch_moved', true]]);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
  assert.ok(env.exists(env.dossier(id, 'worker-probe-r3.report.md')), '报告照常留下');
});

test('获批 spec 在两次运行之间被动过：内核每轮复核哈希，发现即停、不派任何 agent；merge 批准时也复核', (t) => {
  const spec = bigSpec(2);
  const { env, id } = approvedSpecEnv(t, { specBody: spec });
  fs.writeFileSync(env.dossier(id, 'spec.md'), spec.replace('- AC-002: 第 2 条可观察行为成立\n', ''));
  const callsBefore = env.calls().length;
  env.appendScenario([stop()]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.calls().length, callsBefore, '没有任何 agent 读到那份被改过的「契约」');
  const tampered = env.events(id).find((e) => e.type === 'spec_tampered');
  assert.equal(tampered.reason, 'frozen_spec_changed');
  const ts = env.findTask(id);
  assert.equal(ts.runtime.awaiting.kind, 'help');
  assert.match(env.readJson(env.dossier(id, `human-r${ts.runtime.awaiting.round}.json`)).summary, /specs\/archive\/ 下有 .*-approved-\* 副本/);

  // 人按提示恢复原文后 resume，照常继续。
  fs.writeFileSync(env.dossier(id, 'spec.md'), spec);
  assert.equal(env.run('resume', id).status, 0);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.calls().length, callsBefore + 1);
});

// ---- 预算 / 限额 / 人闸 ----

test('任务预算对子委派同样生效：预算在 dispatch 中途用尽 → 后面的委派不再派出，已完成的工作照常集成，随后收箱并说明如何恢复', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { budgetUsd: 1, maxParallelAssignments: 1 } });
  env.setKeyed({
    'worker-one': [workerStep({ cost: 1.2, files: { 'lib/one.mjs': 'export const one = 1;\n' } })],
    'worker-two': [workerStep({ files: { 'lib/two.mjs': 'export const two = 2;\n' } })],
  });
  env.appendScenario([dispatchStep([assignment('one', 'write', { paths: ['lib/one.mjs'] }), assignment('two', 'write', { paths: ['lib/two.mjs'] })])]);
  assert.equal(env.run('run', '--continuous').status, 0);

  assert.equal(env.calls().filter((c) => c.key === 'worker-two').length, 0, '预算用尽后不再派出新的子委派');
  const ledger = env.readJson(env.dossier(id, 'dispatch-r2.json'));
  assert.deepEqual(ledger.assignments.map((a) => [a.key, a.state]), [['one', 'integrated'], ['two', 'skipped']]);
  assert.match(ledger.assignments[1].note, /任务预算已用尽/);
  assert.ok(git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/one.mjs'));
  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'budget_exhausted');
  const show = env.run('show', id).stdout;
  assert.match(show, /已终止（budget_exhausted）/);
  assert.match(show, /继续：调高 conductor\.config\.json 的 budgetUsd 后 conductor retry/);
});

test('平台限额命中某个 worker：同轮其余已完成的工作先提交集成，再收箱 rate_limited；恢复边界不变（人到点后 retry）', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { maxParallelAssignments: 1 } });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  env.setKeyed({
    'worker-one': [workerStep({ files: { 'lib/one.mjs': 'export const one = 1;\n' } })],
    'worker-two': [{ actions: [{ type: 'rateLimit', resets_at: resetsAt }] }],
    'worker-three': [workerStep({ files: { 'lib/three.mjs': 'export const three = 3;\n' } })],
  });
  env.appendScenario([dispatchStep([
    assignment('one', 'write', { paths: ['lib/one.mjs'] }),
    assignment('two', 'write', { paths: ['lib/two.mjs'] }),
    assignment('three', 'write', { paths: ['lib/three.mjs'] }),
  ])]);
  const run = env.run('run', '--continuous');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /运行结束（rate_limited）/);

  assert.ok(git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/one.mjs'), '限额之前做完的工作没有丢');
  assert.equal(env.calls().filter((c) => c.key === 'worker-three').length, 0, '命中限额后本次运行不再发起任何新 spawn');
  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'rate_limited');
  assert.equal(ts.runtime.rate_limit.resume_stage, 'ROUTING');
  assert.match(env.run('show', id).stdout, /等待资源（平台限额）/);
  assert.notEqual(env.run('retry', id).status, 0, '没到重置时刻不自动也不允许恢复（--force 除外）');
});

test('人工暂停与停止：pause 的任务不派工不花钱、unpause 后原地继续；stop 让持续运行的 runner 干净退出，现场可续', async (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { watchPollMs: 100 } });
  assert.equal(env.run('pause', id, '--notes', '等我确认一件事').status, 0);
  const before = env.calls().length;
  env.appendScenario([stop()]);
  assert.equal(env.run('run', '--continuous').status, 0);
  assert.equal(env.calls().length, before, '暂停中：零 spawn');
  assert.match(env.run('show', id).stdout, /等待人（已暂停）/);
  assert.match(env.run('stop').stdout, /当前没有正在运行的 conductor run/);

  // --watch：空闲也不退出；unpause 之后它自己接着跑；stop 让它退出。
  const runner = spawn(process.execPath, [CONDUCTOR, 'run', '--watch'], { env: env.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  runner.stderr.on('data', (c) => { stderr += c; });
  t.after(() => { try { runner.kill('SIGKILL'); } catch { /* 已退出 */ } });
  await sleep(600);
  assert.equal(runner.exitCode, null, 'watch 模式空闲时不退出');
  assert.equal(env.run('unpause', id).status, 0);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && env.findTask(id).runtime.stage !== 'AWAIT_HUMAN') await sleep(100);
  assert.equal(env.findTask(id).runtime.awaiting?.kind, 'help', 'unpause 之后 watch 中的 runner 自己接着推进，不用人再敲 run');

  assert.match(env.run('stop').stdout, /已请求 runner/);
  const code = await new Promise((resolve) => runner.once('exit', resolve));
  assert.equal(code, 0);
  assert.match(stderr, /运行结束（stop_requested）/);
  assert.equal(env.readJson(path.join(env.root, 'state', '.run-session.json')).end_reason, 'stop_requested');
  assert.equal(env.exists(path.join(env.root, 'state', '.lock')), false, '锁已释放');
});

// ---- 无进展 vs 慢而有进展 ----

test('停滞保险丝数硬进展：反复调研、给委派换名字、改写报告都拖不过去；每轮都在改代码的长任务不被误杀；retry 后重新数', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { fuseStallRounds: 3, fuseStreak: 0 } });
  const keys = ['look-a', 'look-b', 'look-c', 'look-d', 'look-e'];
  env.setKeyed(Object.fromEntries(keys.map((k, i) => [`worker-${k}`, [workerStep({ report: `第 ${i} 版换了说法的报告\n` })]])));
  env.appendScenario(keys.map((k) => dispatchStep([assignment(k, 'read')], { summary: `再查一次（${k}）` })));
  assert.equal(env.run('run', '--continuous').status, 0);

  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'fuse_no_progress');
  const tripped = env.events(id).find((e) => e.type === 'fuse_tripped');
  assert.match(tripped.signature, /^stall\|3$/);
  assert.equal(env.calls().filter((c) => c.key?.startsWith('worker-look')).length, 3, '换 key、换报告措辞都不算进展：第 4 个委派没有机会派出');
  assert.ok(env.exists(env.dossier(id, 'worker-look-a-r2.report.md')), '材料全部保留');
  assert.match(env.run('show', id).stdout, /保险丝：同因失败连击，或连续多轮没有任何硬进展/);

  // retry 复位；之后每轮都在推进代码 → 跑多少轮都不触发。
  assert.equal(env.run('retry', id).status, 0);
  const steady = ['w1', 'w2', 'w3', 'w4', 'w5'];
  env.setKeyed(Object.fromEntries(steady.map((k, i) => [`worker-${k}`, [workerStep({ outcome: 'partial', files: { [`lib/step${i}.mjs`]: `export const s = ${i};\n` } })]])), { merge: true });
  // 已消费的剧本前缀里还剩两个没用到的 look 步骤，先顶掉再接新步骤。
  const scenario = JSON.parse(fs.readFileSync(env.scenarioPath, 'utf8'));
  const used = Number(fs.readFileSync(`${env.scenarioPath}.counter`, 'utf8'));
  fs.writeFileSync(env.scenarioPath, JSON.stringify([...scenario.slice(0, used), ...steady.map((k) => dispatchStep([assignment(k)])), stop()]));
  assert.equal(env.run('run', '--continuous').status, 0);
  assert.equal(env.findTask(id).box, 'queue', '慢而有进展：5 轮都在改代码，没有被保险丝处置');
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
});

test('轮次硬上限：整任务的轮次用尽即收箱 round_cap，可 retry；单次执行与整体任务各有明确上限', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { maxRoundsPerTask: 3, fuseStallRounds: 0 } });
  env.setKeyed({ 'worker-a': [workerStep({ files: { 'a.mjs': '1\n' } })], 'worker-b': [workerStep({ files: { 'b.mjs': '2\n' } })] });
  env.appendScenario([dispatchStep([assignment('a')]), dispatchStep([assignment('b')]), stop()]);
  assert.equal(env.run('run', '--continuous').status, 0);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.last_failure_type, 'round_cap');
  assert.ok(env.events(id).some((e) => e.type === 'round_cap_reached' && e.max_rounds === 3));
  assert.match(env.run('show', id).stdout, /调高 maxRoundsPerTask 后 conductor retry/);
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0);
  assert.match(retry.stderr, /仍 >= maxRoundsPerTask=3/);
});

test('无响应的 agent：活性护栏杀掉、有限次重试、仍不行就带着 interrupted 回到 router——不无限等，也不丢已有工作', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { inactivityTimeoutMs: 300, spawnRetries: 1, maxAutoContinues: 0 } });
  const hung = () => workerStep({ log: false, files: { 'lib/slow.mjs': 'export const slow = 1;\n' }, hang: true });
  env.setKeyed({ 'worker-slow': [hung(), hung()] });
  env.appendScenario([dispatchStep([assignment('slow')]), stop()]);
  assert.equal(env.run('run').status, 0);

  assert.equal(env.calls().filter((c) => c.key === 'worker-slow').length, 2, '1 次 + 1 次重试，到此为止');
  const rec = env.readJson(env.dossier(id, 'worker-slow-r2.json'));
  assert.equal(rec.killed, 'inactivity');
  assert.equal(rec.cost_unknown, true);
  assert.ok(git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/slow.mjs'), '被杀之前落盘的工作保留');
  assert.match(routerPrompts(env).at(-1), /r2 worker slow .*interrupted=yes .*product=missing/);
});
