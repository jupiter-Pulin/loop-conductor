// 集成：长任务跨多轮完成——撞会话上限后续推、reviewer 分轮续审、持续运行跨调度批次。
//
// 覆盖的验收场景：
//   · maker / worker 中途达到上限：已有有效工作保留，下轮从可确认进度续推；不默认从头做、不假称完成
//   · reviewer 未判完全部 AC：剩余清单可见且可续审；版本变化时不误用旧判决；不能提前打开 merge 资格
//   · 持续运行超过一个调度批次：不靠用户反复手动 run，仍在原授权额度内推进；批次边界不重置成本
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { promptOf } from '../helpers/env.mjs';
import {
  approvedSpecEnv, assignment, bigSpec, commitInTaskWorktree, dispatchStep, ledgerReviewerStep, makerStep,
  newRouterEnv, routerStep, workerStep,
} from '../helpers/router-env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const workerCalls = (env, key) => env.calls().filter((c) => c.key === `worker-${key}`);
const routerPrompts = (env) => env.calls().filter((c) => /router-r\d+\.log\.json/.test(promptOf(c))).map(promptOf);
const resumeArg = (call) => (call.argv.includes('-r') ? call.argv[call.argv.indexOf('-r') + 1] : null);

// ---- 撞会话上限 ----

test('worker 撞会话上限且有进展：已落盘的工作保留，内核在额度内自动续会话（-r），从剩余项接着做；轮次号不复用', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { maxAutoContinues: 2 } });
  env.setKeyed({
    'worker-api': [
      workerStep({
        outcome: 'partial', summary: '路由骨架完成，两条路由与测试未做', done: ['路由骨架'], remaining: ['/v1/pools 两条路由', '路由测试'],
        files: { 'lib/api/app.mjs': 'export const app = 1;\n' }, session_id: 'sess-api-1', actions: [{ type: 'truncateAfterWrite' }],
      }),
      workerStep({ outcome: 'ok', summary: '剩余两项完成', done: ['路由骨架', '/v1/pools 两条路由', '路由测试'], files: { 'lib/api/pools.mjs': 'export const pools = [];\n' } }),
    ],
  });
  env.appendScenario([dispatchStep([assignment('api')]), stop()]);
  assert.equal(env.run('run').status, 0);

  const calls = workerCalls(env, 'api');
  assert.equal(calls.length, 2, '截断后自动续接一次，没有回到 router 再花一轮');
  assert.equal(resumeArg(calls[0]), null);
  assert.equal(resumeArg(calls[1]), 'sess-api-1', '续的是同一个会话，不是从头冷启动');
  assert.match(promptOf(calls[1]), /\[续做\] 这是对 r2 的续接/);
  assert.match(promptOf(calls[1]), /remaining: \/v1\/pools 两条路由；路由测试/, '上一次的未完成项原样带给续接的会话');

  // 两次会话各有自己的轮次号与案卷，互不覆盖。
  assert.ok(env.exists(env.dossier(id, 'worker-api-r2.log.json')) && env.exists(env.dossier(id, 'worker-api-r3.log.json')));
  assert.equal(env.readJson(env.dossier(id, 'worker-api-r2.json')).raw.subtype, 'error_max_turns');
  assert.equal(env.readJson(env.dossier(id, 'worker-api-r3.json')).resume_of, 2);

  const ledger = env.readJson(env.dossier(id, 'dispatch-r2.json'));
  assert.deepEqual(ledger.assignments[0].spawns.map((s) => [s.round, s.outcome, s.truncated]), [[2, 'partial', true], [3, 'ok', false]]);
  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.ok(tree.includes('lib/api/app.mjs') && tree.includes('lib/api/pools.mjs'), '两段工作都在任务分支上');
  assert.equal(env.readRuntime(id).spent_usd >= 0.2, true, '续接的花费同样入账');
});

test('自动续接额度为 0：截断的委派回到 router，台账标出「可续接」；router 用 continue_from 续上；乱填的 continue_from 被拒', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { maxAutoContinues: 0 } });
  env.setKeyed({
    'worker-api': [
      workerStep({
        outcome: 'partial', summary: '做了一半', done: ['A'], remaining: ['B'],
        files: { 'lib/api/a.mjs': 'export const a = 1;\n' }, session_id: 'sess-api-9', actions: [{ type: 'truncateAfterWrite' }],
      }),
      workerStep({ outcome: 'ok', summary: 'B 完成', files: { 'lib/api/b.mjs': 'export const b = 2;\n' } }),
    ],
  });
  env.appendScenario([
    dispatchStep([assignment('api')]),
    dispatchStep([assignment('api', 'write', { continue_from: 7 })], { summary: '瞎填一个轮次' }),
    dispatchStep([assignment('api', 'write', { continue_from: 2, purpose: '完成 remaining 里的 B' })], { summary: 'api 撞上限，续接原会话做 B' }),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);

  const second = routerPrompts(env)[2];
  assert.match(second, /api .*state=integrated .*outcome=partial  truncated=yes  可续接=continue_from:2/, '部分工作已集成，且可续接是内核事实');
  assert.match(second, /remaining: B/);
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /continue_from=7 不是一个可续接的会话（台账里可续接的是：r2）/);

  const calls = workerCalls(env, 'api');
  assert.equal(calls.length, 2);
  assert.equal(resumeArg(calls[1]), 'sess-api-9');
  assert.ok(promptOf(calls[1]).includes('完成 remaining 里的 B'), '续接时 router 的新指导同样逐字到达');
  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.ok(tree.includes('lib/api/a.mjs') && tree.includes('lib/api/b.mjs'));
});

test('来不及写 log 就撞上限：工作照样保留；内核只陈述观察到的事实与未知，outcome 为空——不伪造完成', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { maxAutoContinues: 0 } });
  env.setKeyed({
    'worker-api': [workerStep({ log: false, files: { 'lib/api/half.mjs': 'export const half = 0.5;\n' }, session_id: 'sess-x', actions: [{ type: 'truncateAfterWrite' }] })],
  });
  env.appendScenario([dispatchStep([assignment('api')]), stop()]);
  assert.equal(env.run('run').status, 0);

  assert.ok(git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/api/half.mjs'), '已有工作已提交并集成');
  const salvage = env.readJson(env.dossier(id, 'worker-api-r2.salvage.json'));
  assert.equal(salvage.reason, 'truncated');
  assert.equal(salvage.written_by, 'kernel');
  assert.equal(salvage.known.worktree_dirty, true);
  assert.equal(Object.hasOwn(salvage, 'outcome'), false, 'salvage 里没有 outcome：内核不替 agent 下结论');
  assert.ok(salvage.unknown.some((u) => /outcome 未知，不得视为完成/.test(u)));

  const next = routerPrompts(env).at(-1);
  assert.match(next, /r2 worker api .*outcome=-  .*truncated=yes .*product=missing/);
  assert.match(next, /api .*outcome=未知\(无合格 log\)  truncated=yes  可续接=continue_from:2/);
  assert.match(next, /↳ 完整产物：worker-api-r2\.salvage\.json/);
});

test('单 maker 路径同样续得上：增量 log（partial + remaining）在截断后仍是合格交付，修复轮看得到它', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker', { guidance: '先修 median 的偶数分支，再补 percentile；一轮做不完就把进度写进 log' }),
    makerStep({ outcome: 'partial', summary: 'median 已修；percentile 未做', actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }] }),
    stop(),
  ]);
  // 给 maker 的 log 补上 done / remaining，并在写完后撞上限。
  const scenario = JSON.parse(fs.readFileSync(env.scenarioPath, 'utf8'));
  scenario[1].actions.at(-1).content.done = ['median 偶数分支'];
  scenario[1].actions.at(-1).content.remaining = ['percentile'];
  scenario[1].actions.push({ type: 'truncateAfterWrite' });
  fs.writeFileSync(env.scenarioPath, JSON.stringify(scenario));
  assert.equal(env.run('run').status, 0);

  const makerPrompt = promptOf(env.calls()[1]);
  assert.match(makerPrompt, /\[负责人指导（逐字）\] 先修 median 的偶数分支，再补 percentile/, 'router 的指导真的进了 maker 的执行上下文');
  const next = routerPrompts(env).at(-1);
  assert.match(next, /r1 maker .*outcome=partial .*truncated=yes .*product=ok/, '截断不等于交付作废');
  assert.match(next, /remaining: percentile/);
  assert.ok(git(env.targetDir, 'log', '--oneline', `task/${id}`).includes('maker r1'), '已有工作固化为提交');
});

// ---- reviewer 分轮续审 ----

test('reviewer 一轮判不完：剩余清单可见、merge 资格不提前打开；同版本续审只判剩余；HEAD 变了旧判决全部作废', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(6) });
  env.setKeyed({ 'worker-a': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })] });
  env.appendScenario([
    dispatchStep([assignment('a')]),
    routerStep('review'),
    ledgerReviewerStep({ 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass', 'AC-004': 'pass' }, { outcome: 'ok', summary: '判了 4 条就撞上限（自称 ok）', truncate: true }),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: 'reviewer 说 ok 了' }),
    routerStep('review', { summary: '继续判剩余' }),
    ledgerReviewerStep({ 'AC-005': 'pass', 'AC-006': 'pass' }, { summary: '剩余 2 条判完' }),
    routerStep('merge', { summary: '6/6 且全 pass' }),
  ]);
  assert.equal(env.run('run').status, 0);

  // reviewer 自称 ok、precommit 也绿，但台账只覆盖 4/6 → merge 被拒。
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /need_review=true need_precommit=false（review：已判 4\/6；fail 0；未判 2：AC-005, AC-006/);

  // 续审：prompt 只要求判剩余两条，并带上已沿用的判决。
  const second = env.calls().filter((c) => /reviewer-r\d+\.log\.json/.test(promptOf(c)))[1];
  assert.match(promptOf(second), /本轮要判：AC-005, AC-006/);
  assert.match(promptOf(second), /同一版本（HEAD 与 spec 都没变）上已有判决，本轮沿用、不必重判.*AC-001 pass；AC-002 pass/);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge', '判全且全 pass 之后 merge 闸才开');

  // 人在 merge 闸期间动了任务分支：HEAD 变了 → 旧判决一条都不算，approve 被拒并回 ROUTING。
  commitInTaskWorktree(env, id, { 'lib/extra.mjs': 'export const extra = 1;\n' });
  const approve = env.run('approve', id);
  assert.notEqual(approve.status, 0);
  assert.match(approve.stderr, /没有判全且全 pass 的整体 review（need_review=true；已判 0\/6/);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');
  env.appendScenario([stop()]);
  assert.equal(env.run('run').status, 0);
  assert.match(routerPrompts(env).at(-1), /整体 review（对当前 H 与 spec [0-9a-f]{12}，共 6 条 AC）：已判 0\/6/, '旧 HEAD 上的判决只留作记录，不计入当前版本');
});

test('reviewer 判出 fail：哪几条 fail 是内核事实；修复后 HEAD 变化，必须整体重审', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(3) });
  env.setKeyed({
    'worker-a': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })],
    'worker-fix': [workerStep({ files: { 'lib/fix.mjs': 'export const fixed = true;\n' } })],
  });
  env.appendScenario([
    dispatchStep([assignment('a')]),
    routerStep('review'),
    ledgerReviewerStep({ 'AC-001': 'pass', 'AC-002': { verdict: 'fail', evidence: 'lib/stats.mjs:7 percentile 未导出' }, 'AC-003': 'pass' }, { outcome: 'fail' }),
    dispatchStep([assignment('fix', 'write', { intent: 'fix', purpose: '只修 AC-002：导出 percentile', inputs: ['reviewer-r3.verdicts.json'] })]),
    routerStep('merge', { summary: '修好了直接合' }),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.match(routerPrompts(env)[3], /已判 3\/3；fail 1（AC-002）/);
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.match(rejected[0].reason, /need_review=true/, '修复产生了新 HEAD：没有整体重审就不能 merge');
});

// ---- 持续运行 ----

test('run --continuous：一个调度批次耗尽后自动接下一批，直到没有可执行的工作；运行账本跨批次累计', (t) => {
  const { env, id } = newRouterEnv(t, { config: { maxStepsPerTask: 1, runBudgetUsd: 50 } });
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), { cost: 0.05, actions: [{ type: 'writeLog', content: { role: 'reviewer', outcome: 'ok', tier: 'unit', summary: 'B-001 pass' } }], result: 'ok' },
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '可以合并' }),
  ]);

  const once = env.run('run');
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stderr, /maxStepsPerTask=1 耗尽/);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING', '单批模式：一批 1 步用完就让出，任务还在 ROUTING');
  const afterOnce = env.readJson(`${env.root}/state/.run-session.json`);
  assert.equal(afterOnce.end_reason, 'batch_done');

  const cont = env.run('run', '--continuous');
  assert.equal(cont.status, 0, cont.stderr);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge', '不用人反复敲 run，一直推进到人闸');
  assert.match(cont.stderr, /运行结束（idle）：没有可执行的工作了/);
  const session = env.readJson(`${env.root}/state/.run-session.json`);
  assert.ok(session.batches >= 3, `review / precommit / merge 各占一批（实际 ${session.batches}）`);
  assert.equal(session.end_reason, 'idle');
  assert.ok(session.spent_usd > 0.03, '批次之间运行账本持续累计，不清零');
  assert.equal(session.limit_usd, 50);
});

test('runBudget 跨批次、跨重启都不清零：额度在批次中途用尽即停并说明原因；崩溃后的新进程接管旧账本', (t) => {
  const { env, id } = newRouterEnv(t, { config: { maxStepsPerTask: 1, runBudgetUsd: 0.25 } });
  env.setScenario([
    routerStep('maker', { cost: 0.1 }), makerStep({ cost: 0.1 }),
    routerStep('review', { cost: 0.1 }),
    { cost: 0.05, actions: [{ type: 'writeLog', content: { role: 'reviewer', outcome: 'ok', tier: 'unit', summary: 'B-001 pass' } }], result: 'ok' },
    stop(),
  ]);
  const run = env.run('run', '--continuous');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /runBudgetUsd=\$0\.25 已达到/);
  assert.match(run.stderr, /运行结束（run_budget_exhausted）/);
  const ts = env.findTask(id);
  assert.equal(ts.box, 'queue');
  assert.equal(ts.runtime.stage, 'ROUTING', '任务状态原样保留，不因运行额度用尽而收箱');
  assert.equal(env.calls().length, 3, '第 2 批的 reviewer 没有被派出：新批次没有绕过额度');
  assert.match(env.run('show', id).stdout, /等待资源（运行额度）/);

  // 模拟「上一次运行崩溃」：账本没有收尾。新进程必须接着已花金额算，而不是从 0 开始。
  const file = `${env.root}/state/.run-session.json`;
  const crashed = { ...env.readJson(file), ended_at: null, end_reason: null };
  fs.writeFileSync(file, JSON.stringify(crashed));
  const again = env.run('run', '--continuous');
  assert.match(again.stderr, /上一次运行没有正常收尾，接管它的运行账本：已花 \$0\.300/);
  assert.match(again.stderr, /运行结束（run_budget_exhausted）/);
  assert.equal(env.calls().length, 3, '接管后额度仍然是用尽的：一个新 spawn 都没有');

  // 正常收尾之后人再次手动 run = 新授权。
  env.writeConfig({ runBudgetUsd: 5 });
  assert.equal(env.run('run', '--continuous').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
});
