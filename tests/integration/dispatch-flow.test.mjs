// 集成：router 的 dispatch——具体委派真的到达执行者、多 subagent 并行与汇合、证据改变下一步。
//
// 覆盖的验收场景：
//   · 多 subagent 协作：边界明确的并行工作 + 结果汇合；共享资源冲突得到处理；最终仍整体审查
//   · 依赖假设被新证据推翻：router 修改具体委派，接收者实际收到新任务；不修改产品承诺，无关工作继续
//   · 权限按真实副作用分档：read 无执行能力、sandbox 的产物不并入产品、write 由内核提交并集成
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { maxInFlight, promptOf } from '../helpers/env.mjs';
import {
  approvedSpecEnv, assignment, bigSpec, dispatchStep, ledgerReviewerStep, routerStep, workerStep,
} from '../helpers/router-env.mjs';
import { sha256Of } from '../../conductor/lib/spec-version.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const workerCall = (env, key) => env.calls().filter((c) => c.key === `worker-${key}`);
const routerPrompts = (env) => env.calls().filter((c) => /router-r\d+\.log\.json/.test(promptOf(c))).map(promptOf);
const toolsOf = (call) => call.argv[call.argv.indexOf('--tools') + 1].split(',');
const ALL_PASS = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`AC-${String(i + 1).padStart(3, '0')}`, 'pass']));

test('dispatch：委派逐字进执行上下文；四个 subagent 并行、按权限档隔离、结果汇合进任务分支；最终仍整体 review + precommit + 人闸', (t) => {
  const spec = bigSpec(3);
  const { env, id } = approvedSpecEnv(t, { specBody: spec, notes: '保持零依赖' });
  const api = assignment('api', 'write', {
    title: 'percentile 实现', paths: ['lib/pct/**', 'lib/stats.mjs'],
    purpose: '实现 percentile(p) 并让它能被 stats 入口导出', scope: '只动 lib/pct/ 下的文件；不改 lib/stats.mjs 的既有导出',
    deliverables: 'lib/pct/percentile.mjs 与它的测试', done_when: 'node --test 全绿且新测试在旧代码上会失败', acs: ['AC-002'],
  });
  const web = assignment('web', 'write', { title: '格式化输出', paths: ['lib/fmt/**'] });
  const probe = assignment('probe', 'sandbox', {
    title: '验证零依赖构建', purpose: '确认在没有 node_modules 的环境里测试命令能跑',
    deliverables: '报告：命令、输出、结论', done_when: '给出可行 / 不可行的确定结论',
  });
  const look = assignment('look', 'read', { title: '盘点既有导出', intent: 'investigate' });

  env.setKeyed({
    // 目标仓夹具自带一条红测试（median 偶数分支），api 顺手修掉它，precommit 才会绿。
    'worker-api': [workerStep({ files: { 'lib/pct/percentile.mjs': 'export const percentile = () => 1;\n', 'lib/stats.mjs': FIXED_STATS }, delayMs: 400, done: ['percentile 实现'] })],
    'worker-web': [workerStep({ files: { 'lib/fmt/format.mjs': 'export const fmt = String;\n' }, delayMs: 400 })],
    'worker-probe': [workerStep({ files: { 'scratch/installed.txt': '实验目录里的产物\n' }, report: '## 结论\n可行：node --test 零依赖可跑。\n', delayMs: 400 })],
    'worker-look': [workerStep({ report: '既有导出：mean, median。\n', summary: '盘点完成，见报告', delayMs: 400 })],
  });
  env.appendScenario([
    dispatchStep([api, web, probe, look], { summary: '四件事互不依赖，并行' }),
    routerStep('review'),
    ledgerReviewerStep(ALL_PASS(3)),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '整体 review 与 precommit 均对当前 H/B' }),
  ]);
  const inflight = path.join(env.root, 'inflight.log');
  const run = env.runWithEnv({ FAKE_CLAUDE_INFLIGHT_LOG: inflight }, 'run');
  assert.equal(run.status, 0, run.stderr);

  // ---- 并行是真的 ----
  assert.ok(maxInFlight(inflight) >= 3, `四个委派应并行（maxParallelAssignments=3），实际峰值 ${maxInFlight(inflight)}`);

  // ---- router 的指导逐字到达接收者 ----
  const apiPrompt = promptOf(workerCall(env, 'api')[0]);
  for (const text of [api.purpose, api.scope, api.deliverables, api.done_when, 'spec:L1-3']) {
    assert.ok(apiPrompt.includes(text), `api 的 prompt 应逐字含：${text}`);
  }
  assert.match(apiPrompt, /\[委派 api\]「percentile 实现」（implement）/);
  assert.match(apiPrompt, /\[声明的写入范围\] lib\/pct\/\*\*，lib\/stats\.mjs/);
  assert.match(apiPrompt, /\[人审补充约束（逐字，优先于你的判断）\] 保持零依赖/);
  assert.ok(apiPrompt.includes(env.dossier(id, 'spec.md')), '契约以路径 + 版本给出');
  assert.ok(apiPrompt.includes(sha256Of(spec).slice(0, 12)));
  assert.match(apiPrompt, /\[并行\] 同一轮还有这些委派在同时进行：web「格式化输出」/);
  assert.match(apiPrompt, /完成条件只是这个子任务的退出条件，不等于任何 AC 通过/);

  // ---- 权限按真实副作用分档 ----
  assert.equal(toolsOf(workerCall(env, 'look')[0]).includes('Bash'), false, 'read：没有任何命令执行能力');
  assert.match(promptOf(workerCall(env, 'look')[0]), /\[权限：静态只读\]/);
  for (const key of ['api', 'web', 'probe']) {
    const tools = toolsOf(workerCall(env, key)[0]);
    assert.ok(tools.includes('Bash'));
    for (const bypass of ['Task', 'Agent', 'CronCreate', 'RemoteTrigger', 'SendMessage']) assert.equal(tools.includes(bypass), false, `${key} 不得有 ${bypass}`);
  }
  assert.match(promptOf(workerCall(env, 'probe')[0]), /这里的一切改动在你结束后丢弃，不会进入产品/);
  assert.equal(workerCall(env, 'api')[0].cwd.endsWith(`/worktrees/${id}`), true, '第一个 write 直接用任务 worktree');
  assert.equal(workerCall(env, 'web')[0].cwd.endsWith(`/worktrees/${id}--web`), true, '并行的第二个 write 在自己的分支 / worktree');
  assert.equal(workerCall(env, 'probe')[0].cwd.endsWith(`/worktrees/${id}.x-probe`), true, 'sandbox 在一次性实验目录');
  assert.equal(workerCall(env, 'look')[0].cwd.endsWith(`/worktrees/${id}.r-look`), true, 'read 在派出时刻的只读快照');
  const lookGuard = env.readJson(env.dossier(id, 'worker-look-r2.settings.json')).hooks.PreToolUse;
  assert.ok(lookGuard.some((h) => h.matcher === 'Read|Grep|Glob'), 'read 的读范围由 read-guard 收口');
  assert.ok(lookGuard.some((h) => /write-guard/.test(h.hooks[0].command)), 'read 的写入由 write-guard 白名单收口');

  // ---- 汇合：两个 write 的改动都在任务分支；实验产物不在；临时目录已清 ----
  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.ok(tree.includes('lib/pct/percentile.mjs') && tree.includes('lib/fmt/format.mjs'), '两个并行 write 都集成进了任务分支');
  assert.equal(tree.some((f) => f.startsWith('scratch/')), false, '实验目录里的产物不并入产品');
  for (const suffix of ['--web', '.x-probe', '.r-look']) assert.equal(env.exists(path.join(env.root, 'worktrees', `${id}${suffix}`)), false);
  assert.ok(env.exists(env.dossier(id, 'worker-probe-r2.report.md')), '实验结论以报告留在案卷');

  const ledger = env.readJson(env.dossier(id, 'dispatch-r2.json'));
  assert.equal(ledger.closed, true);
  assert.deepEqual(Object.fromEntries(ledger.assignments.map((a) => [a.key, a.state])), { api: 'integrated', web: 'integrated', probe: 'done', look: 'done' });
  assert.equal(ledger.spec_sha, sha256Of(spec), '委派绑定派出时的 spec 版本');
  assert.deepEqual(ledger.assignments.find((a) => a.key === 'web').changed_files, ['lib/fmt/format.mjs']);

  // ---- 子任务全 ok ≠ 验收：merge 闸只因整体 review（判全且全 pass）+ precommit 才开 ----
  const final = env.findTask(id);
  assert.equal(final.runtime.stage, 'AWAIT_HUMAN');
  assert.equal(final.runtime.awaiting.kind, 'merge');
  assert.equal(env.run('approve', id).status, 0);
  assert.equal(env.findTask(id).box, 'done');
  assert.ok(env.readRuntime(id).spent_usd >= 0.4, '四个 worker 的花费都计入同一任务成本');
});

test('dispatch：子任务都说 ok 也不能跳过整体验收——直接 merge 被版本规则拒绝', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  env.setKeyed({ 'worker-a': [workerStep({ files: { 'lib/a.mjs': 'export default 1;\n' }, summary: 'AC-001、AC-002 全部完成并通过' })] });
  env.appendScenario([
    dispatchStep([assignment('a')]),
    routerStep('merge', { summary: 'worker 说都做完了' }),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /need_review=true need_precommit=true/);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help', '没有开 merge 闸');
});

test('共享写入：同轮两个 write 不声明 paths / 声明重叠 → 动作被拒零副作用；真实冲突 → 先到先集成，后者记 conflict、分支保留、其余继续', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  // 两个都改同一个文件（声明的 paths 不相交，实际越界撞车）。
  env.setKeyed({
    'worker-one': [workerStep({ files: { 'lib/one/a.mjs': 'export const a = 1;\n', 'lib/stats.mjs': '// one 改的\n' } })],
    'worker-two': [workerStep({ files: { 'lib/two/b.mjs': 'export const b = 2;\n', 'lib/stats.mjs': '// two 改的\n' } })],
    'worker-three': [workerStep({ files: { 'lib/three/c.mjs': 'export const c = 3;\n' } })],
  });
  env.appendScenario([
    dispatchStep([assignment('one'), assignment('two')], { summary: '没声明 paths 就想并行写' }),
    dispatchStep([assignment('one', 'write', { paths: ['lib/**'] }), assignment('two', 'write', { paths: ['lib/two/**'] })], { summary: '声明重叠' }),
  ]);
  assert.equal(env.run('run').status, 0);
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /没有声明 paths/);
  assert.match(rejected[1].reason, /写入范围可能重叠/);
  assert.equal(workerCall(env, 'one').length, 0, '被拒的 dispatch 不派出任何 worker');
  assert.equal(env.exists(env.worktree(id)), false, '也不建任何 worktree');

  // 被拒两次 → 内核 help 闸；人 resume 后 router 改成声明不相交的并行。
  assert.equal(env.run('resume', id).status, 0);
  env.appendScenario([
    dispatchStep([
      assignment('one', 'write', { paths: ['lib/one/**'] }),
      assignment('two', 'write', { paths: ['lib/two/**'] }),
      assignment('three', 'write', { paths: ['lib/three/**'] }),
    ]),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);

  const round = env.events(id).filter((e) => e.type === 'dispatch_result').at(-1).round;
  const ledger = env.readJson(env.dossier(id, `dispatch-r${round}.json`));
  const by = Object.fromEntries(ledger.assignments.map((a) => [a.key, a]));
  assert.equal(by.one.state, 'integrated');
  assert.equal(by.two.state, 'conflict');
  assert.deepEqual(by.two.conflict_files, ['lib/stats.mjs']);
  assert.equal(by.three.state, 'integrated', '冲突只影响撞车的那一个，无关的照常集成');
  assert.deepEqual(by.one.out_of_scope_files, ['lib/stats.mjs'], '声明范围之外的改动被如实报告（不判失败）');

  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.ok(tree.includes('lib/one/a.mjs') && tree.includes('lib/three/c.mjs'));
  assert.equal(tree.includes('lib/two/b.mjs'), false, '冲突的委派没有半合并进任务分支');
  assert.equal(git(env.worktree(id), 'status', '--porcelain'), '', '任务 worktree 不留半合并现场');
  assert.ok(git(env.targetDir, 'branch', '--list', `task/${id}--two`).includes(`task/${id}--two`), '冲突分支保留供参考');

  const next = routerPrompts(env).at(-1);
  assert.match(next, /two .*state=conflict .*conflict_files=lib\/stats\.mjs/, '冲突作为内核事实回到 router');
});

test('证据改变下一步：探针推翻假设 → router 改具体委派（接收者收到新文字）并记下为什么；获批 spec 一个字节不变；同轮无关工作照常集成', (t) => {
  const spec = bigSpec(3);
  const { env, id } = approvedSpecEnv(t, { specBody: spec });
  const frozenBefore = env.readFile(env.dossier(id, 'spec.md'));
  env.setKeyed({
    'worker-nodb-probe': [workerStep({ summary: '假设不成立：build 阶段会尝试连库；设 SKIP_DB=1 可跳过（报告 §2）', report: '## 2 结论\nbuild 会连库；SKIP_DB=1 可跳过。\n' })],
    'worker-chains': [workerStep({ files: { 'lib/chains.mjs': 'export const ids = [1];\n' } })],
    'worker-indexer': [workerStep({ files: { 'lib/indexer.mjs': 'export const skipDb = true;\n' } })],
  });
  const notes = {
    schema: 'router-notes/v1',
    objective: '先验证无库构建假设，再排索引器',
    facts: [{ text: 'build 阶段会连库，SKIP_DB=1 可跳过', source: 'worker-nodb-probe-r2.report.md §2' }],
    hypotheses: [],
    questions: [],
    plan: [{ key: 'indexer', title: '索引器骨架', status: 'active', depends_on: ['nodb-probe'] }],
    changelog: [{ round: 3, why: '探针结论改变索引器委派：带上 SKIP_DB 并加断言' }],
  };
  env.appendScenario([
    dispatchStep([
      assignment('nodb-probe', 'sandbox', { title: '无库构建探针', purpose: '验证 build 不需要数据库这个假设' }),
      assignment('chains', 'write', { title: '链配置' }),
    ], { summary: '探针与无关的链配置同轮进行' }),
    dispatchStep([
      assignment('indexer', 'write', {
        title: '索引器骨架（按探针结论）', purpose: '按探针结论：build 脚本带 SKIP_DB=1，并加一条「未设 DATABASE_URL 也能 build」的断言',
        inputs: ['worker-nodb-probe-r2.report.md §2', 'spec:L13-15'],
      }),
    ], { summary: '探针推翻了「build 天然不连库」：改索引器委派，AC 不变', notes }),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);

  // 第二轮 router 读到了探针的自述 + 完整产物的指路；它的新委派逐字到达接收者。
  const second = routerPrompts(env)[2];
  assert.match(second, /假设不成立：build 阶段会尝试连库/);
  assert.match(second, /↳ 完整产物：worker-nodb-probe-r2\.report\.md/);
  const indexerPrompt = promptOf(workerCall(env, 'indexer')[0]);
  assert.ok(indexerPrompt.includes('build 脚本带 SKIP_DB=1，并加一条「未设 DATABASE_URL 也能 build」的断言'));
  assert.ok(indexerPrompt.includes('worker-nodb-probe-r2.report.md §2'));

  // 无关工作没有因为探针而停：chains 在第一轮就集成了。
  const tree = git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).split('\n');
  assert.ok(tree.includes('lib/chains.mjs') && tree.includes('lib/indexer.mjs'));

  // 调整的是计划，不是产品承诺：冻结 spec 逐字节未变；router 的工作记忆留了快照与理由。
  assert.equal(env.readFile(env.dossier(id, 'spec.md')), frozenBefore);
  assert.equal(env.readRuntime(id).spec_sha256, sha256Of(spec));
  const saved = env.readJson(env.dossier(id, 'router-notes', 'r3.json'));
  assert.equal(saved.changelog[0].why, '探针结论改变索引器委派：带上 SKIP_DB 并加断言');
  const third = routerPrompts(env)[3];
  assert.match(third, /你的工作记忆（上一轮你自己写的；其中的内容未经内核验证）/);
  assert.match(third, /"source": "worker-nodb-probe-r2\.report\.md §2"/, '工作记忆原样交还给下一轮');
  assert.match(env.run('show', id).stdout, /最近一次调整计划（r3）：探针结论改变索引器委派/);
});

test('工作记忆写坏了：还原上一份合格快照并告诉 router；没有出处的「事实」进不了 facts', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  const good = { schema: 'router-notes/v1', objective: 'o', facts: [{ text: 'f', source: 'kernel' }] };
  const bad = { schema: 'router-notes/v1', facts: [{ text: '我觉得 build 不连库' }] };
  env.setKeyed({ 'worker-a': [workerStep({ report: 'r1\n' }), workerStep({ report: 'r2\n' })] });
  env.appendScenario([
    dispatchStep([assignment('a', 'read')], { notes: good }),
    dispatchStep([assignment('a', 'read')], { notes: bad }),
    stop(),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.deepEqual(env.readJson(env.dossier(id, 'router-notes.json')), good, '不合格的那一版被还原');
  assert.ok(env.exists(env.dossier(id, 'router-notes', 'r3.invalid.json')), '坏的那份留档');
  assert.match(routerPrompts(env).at(-1), /上一轮的工作记忆不合格，已还原为上一份：.*facts 必须带出处/);
  assert.equal(env.events(id).filter((e) => e.type === 'dispatch_result').length, 2, '记忆写坏不算 router 失效，决策照常执行');
});
