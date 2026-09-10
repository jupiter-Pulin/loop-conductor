// 集成：merge 闸批准前的两道 git 护栏——target 仓库当前分支必须等于 task.baseBranch；
// 真正 merge 失败（冲突）时现场必须还原（无 MERGE_HEAD、无冲突标记、工作区干净）。
// 两条路径上任务都保持原状（仍在 merge 闸），失败必须留痕 timeline。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

function driveToMergeGate(t) {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');
  return { env, id };
}

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

test('target 仓库当前分支 ≠ task.baseBranch → approve 拒绝，任务与仓库状态不动', (t) => {
  const { env, id } = driveToMergeGate(t);

  // 人类在 target 仓库切到了另一个分支（不是任务快照里的 baseBranch: 'main'）
  g(env.targetDir, 'checkout', '-b', 'other-branch');
  const headBefore = g(env.targetDir, 'rev-parse', 'HEAD');

  const approve = env.run('approve', id);
  assert.notEqual(approve.status, 0, 'approve 应以非零 exitCode 结束');
  assert.match(approve.stderr, /other-branch/, '错误信息应含当前分支名');
  assert.match(approve.stderr, /main/, '错误信息应含 baseBranch 名');

  // target 仓库未产生新的 merge commit，仍停在 other-branch
  assert.equal(g(env.targetDir, 'rev-parse', 'HEAD'), headBefore, 'target 仓库不应产生新的 merge commit');
  assert.equal(g(env.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other-branch', 'target 仓库当前分支不应被改动');

  // 任务仍在 queue 的 merge 闸上，worktree 与任务分支都还在
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.awaiting.kind, 'merge');
  assert.ok(env.exists(env.worktree(id)), '任务 worktree 不应被清理');
  assert.match(g(env.targetDir, 'branch', '--list', `task/${id}`), new RegExp(`task/${id}`), '任务分支不应被删除');

  // 失败必须留痕
  assert.match(env.readFile(env.dossier(id, 'timeline.md')), /merge 拒绝/);
});

// 注意：base 往前走会先被版本规则（Invariant 6）拦下——那条路径在 version-gate.test.mjs。
// 这里要的是「git merge 本身失败」：target 仓库工作区脏，git 拒绝合并。
test('git merge 失败 → approve 失败但现场必须还原：无 MERGE_HEAD、无冲突标记、任务原地（E28/F15）', (t) => {
  const { env, id } = driveToMergeGate(t);

  // 人在 target 仓库留了未提交的本地改动，且改的正是任务分支要动的文件
  const statsPath = path.join(env.targetDir, 'lib', 'stats.mjs');
  fs.writeFileSync(statsPath, `// uncommitted local edit\n${fs.readFileSync(statsPath, 'utf8')}`);
  const headBefore = g(env.targetDir, 'rev-parse', 'HEAD');

  const approve = env.run('approve', id);
  assert.notEqual(approve.status, 0, 'approve 应以非零 exitCode 结束');
  assert.match(approve.stderr, /merge 失败/, '错误信息应含 merge 失败归因');

  // F15 核心断言：半合并状态必须被 abort 还原
  assert.ok(!fs.existsSync(path.join(env.targetDir, '.git', 'MERGE_HEAD')), '不得残留 MERGE_HEAD');
  assert.ok(!fs.readFileSync(statsPath, 'utf8').includes('<<<<<<<'), '工作区不得残留冲突标记');
  assert.equal(g(env.targetDir, 'rev-parse', 'HEAD'), headBefore, '不应产生 merge commit');

  // 任务原地：queue + merge 闸，分支与 worktree 保留
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.awaiting.kind, 'merge');
  assert.ok(env.exists(env.worktree(id)));
  assert.match(env.readFile(env.dossier(id, 'timeline.md')), /merge 失败：/);
});

test('target 仓库当前分支 == task.baseBranch → approve 照常本地合并并归档', (t) => {
  const { env, id } = driveToMergeGate(t);

  const approve = env.run('approve', id);
  assert.equal(approve.status, 0, approve.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');
  assert.ok(!env.exists(env.worktree(id)), 'worktree 应被清理');
  assert.equal(g(env.targetDir, 'remote'), '', '本地合并，全程无远端');
});
