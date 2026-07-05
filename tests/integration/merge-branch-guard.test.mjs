// 集成：conductor merge 前校验 target 仓库当前分支 == task.baseBranch（AC-001/AC-002/AC-003）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

function driveToAwaitMerge(env, id) {
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: '已修复' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
}

test('target 仓库当前分支 ≠ task.baseBranch → merge 拒绝，任务与仓库状态不动', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-801';
  driveToAwaitMerge(env, id);

  // 人类在 target 仓库切到了另一个分支（不是任务快照里的 baseBranch: 'main'）
  execFileSync('git', ['-C', env.targetDir, 'checkout', '-b', 'other-branch'], { encoding: 'utf8' });
  const headBefore = execFileSync('git', ['-C', env.targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const merge = env.run('merge', id);
  assert.notEqual(merge.status, 0, 'merge 应以非零 exitCode 结束');
  assert.match(merge.stderr, /other-branch/, '错误信息应含当前分支名');
  assert.match(merge.stderr, /main/, '错误信息应含 baseBranch 名');

  // target 仓库未产生新的 merge commit，仍停在 other-branch
  const headAfter = execFileSync('git', ['-C', env.targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(headAfter, headBefore, 'target 仓库不应产生新的 merge commit');
  const curBranch = execFileSync('git', ['-C', env.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(curBranch, 'other-branch', 'target 仓库当前分支不应被改动');

  // 任务仍在 queue，stage 仍是 AWAIT_HUMAN_MERGE
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');

  // worktree 与任务分支都还在
  assert.ok(env.exists(env.worktree(id)), '任务 worktree 不应被清理');
  const branches = execFileSync('git', ['-C', env.targetDir, 'branch', '--list', `task/${id}`], { encoding: 'utf8' });
  assert.match(branches, new RegExp(`task/${id}`), '任务分支不应被删除');
});

test('target 仓库当前分支 == task.baseBranch → merge 照常成功归档', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-802';
  driveToAwaitMerge(env, id);

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');
  assert.ok(!env.exists(env.worktree(id)), 'worktree 应被清理');
});
