// 集成：版本规则是 merge 的唯一依据（AC-014、AC-015）。
//   1) 人在 help 闸期间自己改了任务分支 → H 变 → merge 被拒，必须重新 review + precommit；
//      人的 notes（「我看过了」）不改变 need_review / need_precommit。
//   2) 进了 merge 闸之后 base 往前走一步 → approve 时重算，precommit 基线过期 → 拒并回 ROUTING。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitInTaskWorktree, commitOnBase, makerStep, newRouterEnv, reviewerStep, routerStep, sha,
} from '../helpers/router-env.mjs';

const MORE = '// human touched this during the help gate\n';

test('AC-015：help 闸期间人改了任务分支，resume 后 merge 被拒，直到重新 review + precommit @H', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('human', { summary: '合并前想让人确认一下命名' }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');

  // 人自己在 worktree 里改了一版并提交 —— H 变了。
  const before = sha(env, `task/${id}`);
  const afterHuman = commitInTaskWorktree(env, id, { 'NOTES.md': MORE });
  assert.notEqual(before, afterHuman);

  assert.equal(env.run('resume', id, '--notes', '已验证，我自己跑过 unit 了').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');

  env.appendScenario([
    routerStep('merge', { summary: '人说已验证，直接合' }),   // 被拒：need_review=true
    routerStep('review'),
    reviewerStep({ summary: 'B-001 pass（人改过之后重审）' }),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '重审 + 重跑 precommit 都对当前 H/B' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1, '只有那一次「人说看过了」的 merge 被拒');
  assert.match(rejected[0].reason, /need_review=true/);

  const ts = env.findTask(id);
  assert.equal(ts.runtime.awaiting.kind, 'merge');
  const round = ts.runtime.awaiting.round;
  const gate = env.readJson(env.dossier(id, `human-r${round}.json`));
  assert.equal(gate.kind, 'merge');

  // resume 不创建也不修改任何 reviewer / precommit 记录：人改动之前的那两份原样在盘上。
  assert.equal(env.readJson(env.dossier(id, 'reviewer-r2.json')).head_sha, before);
  assert.equal(env.readJson(env.dossier(id, 'precommit-r3.json')).head_sha, before);
  assert.equal(env.readJson(env.dossier(id, 'precommit-r3.json')).outcome, 'ok');
});

test('AC-014：进了 merge 闸之后 base 前进，approve 按当时的 H/B 重算并拒绝，回 ROUTING', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');

  const baseBefore = sha(env, 'main');
  const baseAfter = commitOnBase(env, { 'CHANGELOG.md': '# moved\n' });
  assert.notEqual(baseBefore, baseAfter);

  const approve = env.run('approve', id);
  assert.notEqual(approve.status, 0, 'base 前进后 approve 必须失败');
  assert.match(approve.stderr, /precommit 基线已过期/);

  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'ROUTING');
  assert.equal(ts.runtime.awaiting, null);
  assert.equal(ts.box, 'queue');
  assert.ok(env.events(id).some((e) => e.type === 'main_moved'));
  assert.equal(sha(env, 'main'), baseAfter, 'base 分支未被合入任何东西');

  // 重跑 precommit（review 仍对当前 H 有效）之后才允许再申请 merge。
  env.appendScenario([
    routerStep('merge', { summary: '再试一次' }),
    routerStep('precommit', { tier: 'unit', summary: 'precommit 基线过期，重跑' }),
    routerStep('merge', { summary: 'H/B 都对上了' }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');

  const ok = env.run('approve', id);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(env.findTask(id).box, 'done');
});
