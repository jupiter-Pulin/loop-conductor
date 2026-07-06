// 集成：conductor 状态机受全局 cfg.targetRepo 约束的修复——READY/FIXING 的 worktree、
// test-gate 探针、五个 agent-spawn stage 的 cwd/prompt、cmdMerge、多仓共存、旧任务兼容回退，
// 全部应改用任务级 targetRepo（task.json 快照 ?? cfg.targetRepo），而不是全局 cfg.targetRepo。
// AC 编号对应 dossier/task-20260706-003/spec.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, promptOf, verifierStep, specVerifierStep } from '../helpers/env.mjs';
import { FIXED_STATS, initSecondTargetRepo } from '../helpers/target-fixture.mjs';

const SETUP_PROFILE = '# Setup Profile\n\n- Use `node --test`.\n';

const GOOD_SPEC = [
  '# 功能 spec', '', '## 背景', '', '一些背景。', '',
  '## 验收标准', '', '- AC-001: `node --test` 全绿', '',
].join('\n');
const GOOD_SPEC_V2 = GOOD_SPEC.replace('# 功能 spec', '# 功能 spec v2');

const FEASIBILITY_DOC = [
  '# Feasibility Study', '', '## 背景', '', '现状。', '',
  '## 选项对比', '',
  '| 选项 | 描述 | 收益 | 代价 | 结论 |',
  '| --- | --- | --- | --- | --- |',
  '| O-A: 方案 A | 描述 A | 收益 A | 代价 A | consider |',
  '| O-B: 方案 B | 描述 B | 收益 B | 代价 B | recommend |',
  '',
  '## 推荐', '', '推荐 O-B。', '',
  '## 开放问题', '',
  '| 问题 | Safe default | 影响 |',
  '| --- | --- | --- |',
  '| 无 | 无 | 无 |',
  '',
].join('\n');

function gitOut(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

test('READY 失败→FIXING 修复：worktree 与 test-gate 探针都作用于任务级 targetRepo，不是 cfg.targetRepo（AC-002）', (t) => {
  const env = makeEnv(t); // cfg.targetRepo 指向 env.targetDir，两个任务都不该碰它
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  const id = 'task-20260706-201';
  env.writeTask(id, { targetRepo: repoB });
  env.setScenario([
    { session_id: 'sess-m1', cost: 0.05, result: 'r1：什么都没做' }, // green gate 应仍红
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.08, result: 'r2：真修复' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const wt = env.worktree(id);
  const listB = gitOut(repoB, 'worktree', 'list');
  assert.ok(listB.includes(wt), 'worktree 应注册在任务的 targetRepo(repoB)');
  const listA = gitOut(env.targetDir, 'worktree', 'list');
  assert.ok(!listA.includes(wt), 'worktree 不应注册在 cfg.targetRepo(repoA)');

  // test-gate 探针在 r2 green gate 通过后触发；若探针误用了 cfg.targetRepo(repoA)，
  // repoB 独有的 baseCommit 在 repoA 里不存在 → git worktree add 失败 → verdict='error'。
  const tg2 = env.readJson(env.dossier(id, 'test-gate-r2.json'));
  assert.notEqual(tg2.verdict, 'error', `test-gate 探针应成功作用于 repoB：${tg2.error ?? ''}`);
});

test('cmdMerge 全程落在任务级 targetRepo；cfg.targetRepo 指向的仓库全程不受影响（AC-004）', (t) => {
  const env = makeEnv(t);
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  const id = 'task-20260706-202';
  env.writeTask(id, { targetRepo: repoB });
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const repoAHeadBefore = gitOut(env.targetDir, 'rev-parse', 'HEAD').trim();
  const repoBHeadBefore = gitOut(repoB, 'rev-parse', 'HEAD').trim();

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');

  // repoB（task.targetRepo）：merge 真的落地，任务分支与 worktree 均已清理
  const repoBHeadAfter = gitOut(repoB, 'rev-parse', 'HEAD').trim();
  assert.notEqual(repoBHeadAfter, repoBHeadBefore, 'repoB 应产生新的 merge commit');
  const bBranches = gitOut(repoB, 'branch', '--list', `task/${id}`).trim();
  assert.equal(bBranches, '', 'repoB 任务分支应被删除');
  const bWorktrees = gitOut(repoB, 'worktree', 'list');
  assert.ok(!bWorktrees.includes(env.worktree(id)), 'repoB worktree 应被清理');

  // repoA（cfg.targetRepo）：全程未被触碰
  const repoAHeadAfter = gitOut(env.targetDir, 'rev-parse', 'HEAD').trim();
  assert.equal(repoAHeadAfter, repoAHeadBefore, 'cfg.targetRepo 指向的仓库不应产生任何新提交');
  const aBranches = gitOut(env.targetDir, 'branch', '--list', `task/${id}`).trim();
  assert.equal(aBranches, '', 'cfg.targetRepo 里不应出现任务分支');
});

test('多仓共存：一次 drain 中两个任务各自在自己的仓库完成 worktree 创建与 green gate，互不误触对方或 cfg 仓库（AC-006）', (t) => {
  const env = makeEnv(t); // cfg.targetRepo（env.targetDir）两个任务都不用，充当第三方哨兵仓库
  const repoA2 = initSecondTargetRepo(path.join(env.root, 'target-a2'));
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  const idA = 'task-20260706-203';
  const idB = 'task-20260706-204';
  env.writeTask(idA, { targetRepo: repoA2 });
  env.writeTask(idB, { targetRepo: repoB });
  // 两个 maker 步骤与两个 verifier 步骤两两等价（都是"写同一修复"/"全 pass"），
  // 无论调度器按什么顺序把 4 个槽位分给两个任务，结果都一致，不依赖具体交错顺序。
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-x1', cost: 0.1, result: 'fixed' },
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-x2', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(idA).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.findTask(idB).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const wtA = env.worktree(idA);
  const wtB = env.worktree(idB);
  const listRepoA2 = gitOut(repoA2, 'worktree', 'list');
  const listRepoB = gitOut(repoB, 'worktree', 'list');
  const listCfgRepo = gitOut(env.targetDir, 'worktree', 'list');

  assert.ok(listRepoA2.includes(wtA), '任务 A 的 worktree 应在自己的仓库');
  assert.ok(!listRepoA2.includes(wtB), '任务 A 的仓库不该出现任务 B 的 worktree');
  assert.ok(listRepoB.includes(wtB), '任务 B 的 worktree 应在自己的仓库');
  assert.ok(!listRepoB.includes(wtA), '任务 B 的仓库不该出现任务 A 的 worktree');
  assert.ok(!listCfgRepo.includes(wtA) && !listCfgRepo.includes(wtB), 'cfg.targetRepo 不该被任何一个任务碰到');
});

test('task.json 缺 targetRepo 字段（旧任务）：整个生命周期回退 cfg.targetRepo，行为与现状一致，不报错（AC-007）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260706-205';
  env.writeTask(id);
  const taskPath = path.join(env.root, 'state', 'queue', id, 'task.json');
  const task = env.readJson(taskPath);
  delete task.targetRepo;
  fs.writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);

  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');
});

test('new --repo 覆盖快照 targetRepo（含该仓库 baseBranch 解析）；setup-agent 的 cwd/prompt 落在该仓库（AC-010，AC-003 needs_target_setup）', (t) => {
  const env = makeEnv(t, { config: { baseBranch: null } }); // 不给 cfg.baseBranch，逼 cmdNew 去解析仓库的 currentBranch
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  execFileSync('git', ['-C', repoB, 'checkout', '-b', 'develop'], { encoding: 'utf8' });

  const created = env.run('new', '--kind', 'bugfix', '--title', 'x', '--repo', repoB);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);

  const task = env.readTaskJson(id);
  assert.equal(task.targetRepo, repoB);
  assert.equal(task.baseBranch, 'develop', '--repo 覆盖后 baseBranch 应解析该仓库的 currentBranch');
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_TARGET_SETUP', 'repoB 尚未审批 setup profile → 走 setup 闸门');

  env.setScenario([{ session_id: 'sess-setup-1', cost: 0.02, result: SETUP_PROFILE }]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SETUP_APPROVAL');
  const setupCall = env.calls()[0];
  assert.equal(setupCall.cwd, repoB, 'setup-agent cwd 应是任务的 targetRepo(repoB)，不是 cfg.targetRepo');
  assert.ok(promptOf(setupCall).includes(repoB), 'prompt 的 Target repo 行应含 repoB 路径');
  assert.ok(!promptOf(setupCall).includes(env.targetDir), 'prompt 不应含 cfg.targetRepo(默认 target) 路径');
});

test('feature 任务 feasibility gate：feasibility-agent 的 cwd 与 prompt 均为任务级 targetRepo（AC-003）', (t) => {
  const env = makeEnv(t, { config: { feasibilityEnabled: true } });
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  const id = 'task-20260706-206';
  env.writeTask(id, { kind: 'feature', stage: 'NEEDS_FEASIBILITY', targetRepo: repoB });
  const draftAbs = path.join(env.root, 'state', 'queue', id, 'feasibility-study.md');

  env.setScenario([
    { actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC }], session_id: 'sess-f1', cost: 0.02, result: 'memo written' },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_FEASIBILITY_APPROVAL');
  const call = env.calls()[0];
  assert.equal(call.cwd, repoB, 'feasibility-agent cwd 应是任务级 targetRepo');
  assert.ok(promptOf(call).includes(repoB), 'prompt 应含任务级 targetRepo 路径');
  assert.ok(!promptOf(call).includes(env.targetDir), 'prompt 不应含 cfg.targetRepo(默认 target) 路径');
});

test('feature 任务的 spec 链路（needs_spec → spec_verify(fail) → spec_fixing → spec_verify(pass)）全程作用于任务级 targetRepo（AC-003）', (t) => {
  const env = makeEnv(t);
  const repoB = initSecondTargetRepo(path.join(env.root, 'target-b'));
  env.writeApprovedSetupProfile(SETUP_PROFILE, { targetRepo: repoB });
  const created = env.run('new', '--kind', 'feature', '--title', 'spec 链路', '--repo', repoB);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_SPEC', 'repoB 已审批 setup + 无 feasibility gate → 直接 NEEDS_SPEC');

  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC }], session_id: 'sess-spec-1', cost: 0.03, result: 'v1' },
    specVerifierStep(1, 'fail'),
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC_V2 }], session_id: 'sess-spec-2', cost: 0.03, result: 'v2' },
    specVerifierStep(2, 'pass'),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');

  const calls = env.calls();
  assert.equal(calls.length, 4, 'spec-agent r1 + spec-verifier r1 + spec-agent r2(修复) + spec-verifier r2');
  const labels = ['needs_spec', 'spec_verify r1', 'spec_fixing', 'spec_verify r2'];
  calls.forEach((call, i) => {
    assert.equal(call.cwd, repoB, `${labels[i]} 的 cwd 应是任务级 targetRepo`);
    assert.ok(promptOf(call).includes(repoB), `${labels[i]} 的 prompt 应含任务级 targetRepo 路径`);
  });
});
