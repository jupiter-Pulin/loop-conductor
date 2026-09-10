// 集成：产物清理（AC-045）。
// DONE 与 abandon 清干净（任务/包 worktree、只读 worktree、候选 worktree、任务与包分支）；
// FAILED_BOX 的其他去向一律保留一切——人还要 retry，清掉就等于让他从零开始。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

function branches(env) {
  return execFileSync('git', ['-C', env.targetDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

function worktreeDirs(env) {
  return fs.readdirSync(path.join(env.root, 'worktrees')).sort();
}

/** 造几个「上一轮崩溃残留」的目录，验证清理不是只删它自己知道的那一个。 */
function seedResidue(env, id) {
  for (const name of [`${id}--P-001`, `${id}.plan-ro`, `${id}.precommit`]) {
    fs.mkdirSync(path.join(env.root, 'worktrees', name), { recursive: true });
    fs.writeFileSync(path.join(env.root, 'worktrees', name, 'residue.txt'), 'left over\n');
  }
  execFileSync('git', ['-C', env.targetDir, 'branch', `task/${id}--P-001`, 'main'], { stdio: 'pipe' });
}

test('AC-045：merge → DONE 时清掉任务与包分支、全部残留 worktree', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  assert.equal(env.run('run').status, 0);
  seedResidue(env, id);
  assert.ok(branches(env).includes(`task/${id}--P-001`));

  assert.equal(env.run('approve', id).status, 0);

  assert.equal(env.findTask(id).box, 'done');
  assert.deepEqual(worktreeDirs(env), [], '全部 worktree 清空');
  assert.deepEqual(branches(env), ['main'], '任务分支与包分支都删掉');
});

test('AC-045：abandon → FAILED_BOX(abandoned) 同样清干净；retry 回 ROUTING', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([routerStep('maker'), makerStep(), routerStep('human', { summary: '先停一下' })]);
  assert.equal(env.run('run').status, 0);
  seedResidue(env, id);

  const abandon = env.run('abandon', id);
  assert.equal(abandon.status, 0, abandon.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'abandoned');
  assert.deepEqual(worktreeDirs(env), []);
  assert.deepEqual(branches(env), ['main'], '未合并的任务分支也要强删');

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');
  assert.ok(env.exists(env.dossier(id, 'maker-r1.log.json')), '案卷不随清理消失');
});

test('AC-045：FAILED_BOX（非 abandon）保留一切以便 retry', (t) => {
  const { env, id } = newRouterEnv(t, { config: { budgetUsd: 0.15 } });
  env.setScenario([
    routerStep('maker', { cost: 0.05 }), makerStep({ cost: 0.2 }),
    routerStep('review'),
  ]);
  assert.equal(env.run('run').status, 0);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.last_failure_type, 'budget_exhausted');
  assert.ok(worktreeDirs(env).includes(id), '任务 worktree 必须留着');
  assert.ok(branches(env).includes(`task/${id}`), '任务分支必须留着');
});

test('AC-045：router 选 abandon 时也清干净', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('abandon', { summary: 'brief 的前提已经不成立了' }),
  ]);
  assert.equal(env.run('run').status, 0);
  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'abandoned');
  assert.deepEqual(worktreeDirs(env), []);
  assert.deepEqual(branches(env), ['main']);
});

test('AC-045：删不掉的分支不算已清理，timeline 如实记 branch delete failed', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([routerStep('maker'), makerStep(), routerStep('human', { summary: '先停一下' })]);
  assert.equal(env.run('run').status, 0);

  // 造一个删不掉的包分支：在 worktrees/ 之外把它 checkout 出去（清理不会碰那个目录），
  // `git branch -D` 于是必然失败。
  const pinned = path.join(env.root, 'pinned-worktree');
  execFileSync('git', ['-C', env.targetDir, 'branch', `task/${id}--P-009`, 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'worktree', 'add', pinned, `task/${id}--P-009`], { stdio: 'pipe' });

  assert.equal(env.run('abandon', id).status, 0);

  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.match(timeline, new RegExp(`branch delete failed: task/${id}--P-009`));
  const listed = /清理：worktree .*；分支 (.*)/.exec(timeline)?.[1] ?? '';
  assert.equal(listed.includes('--P-009'), false, '删不掉的分支不得出现在「已清理」清单里');
  assert.ok(listed.includes(`task/${id}`), '真删掉的任务分支照常列出');
  assert.ok(branches(env).includes(`task/${id}--P-009`), '它确实还在仓库里');
});
