// 集成：保险丝端到端（AC-024）+ retry 复位。
// 不数步数，数「无进展」：同一 (role, package) 连续 fuseStreak 条记录签名相同即收箱。
// 正经工作每轮改变事实，所以这根保险丝不该误杀——同一组里签名一变就断连击。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

/** 三轮 reviewer 都判同一条 AC 同一原因 fail → 无进展。 */
const SAME_FAIL = 'B-001 fail lib/stats.mjs:8 偶数分支仍取上中位';

test('AC-024：reviewer 连续 3 条同签名记录 → FAILED_BOX(fuse_no_progress)，retry 后连击复位', (t) => {
  const { env, id } = newRouterEnv(t, { config: { fuseStreak: 3 } });
  env.setScenario([
    routerStep('maker'), makerStep({ summary: 'r1 尝试' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('maker'), makerStep({ summary: 'r2 尝试' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('maker'), makerStep({ summary: 'r3 尝试' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
  ]);
  assert.equal(env.run('run').status, 0);

  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.stage, 'FAILED_BOX');
  assert.equal(boxed.runtime.last_failure_type, 'fuse_no_progress');
  const tripped = env.events(id).filter((e) => e.type === 'fuse_tripped');
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0].role, 'reviewer');
  assert.ok(tripped[0].signature.startsWith('reviewer|'));

  // FAILED_BOX 保留一切（AC-045）：worktree 与任务分支还在，人才能接着 retry。
  assert.ok(env.exists(env.worktree(id)), 'FAILED_BOX 不清理 worktree');

  // retry：回 ROUTING，案卷不动，连击从复位轮次重新数——旧的三条同签名记录不再算数。
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const back = env.findTask(id);
  assert.equal(back.box, 'queue');
  assert.equal(back.runtime.stage, 'ROUTING');
  assert.equal(back.runtime.last_failure_type, null);
  assert.ok(env.exists(env.dossier(id, 'reviewer-r4.log.json')), 'retry 不归档任何轮次产物');
  assert.equal(env.readJson(env.dossier(id, 'router-state.json')).fuse_reset_round, back.runtime.current_round + 1);

  // 复位后再来一条同签名 reviewer 记录：只有 1 条在窗口内，不该再收箱。
  env.appendScenario([
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.awaiting.kind, 'help');
  assert.equal(env.events(id).filter((e) => e.type === 'fuse_tripped').length, 1, '复位后不该再触发');
});

test('AC-024：签名变了就断连击（正经工作不被误杀）', (t) => {
  const { env, id } = newRouterEnv(t, { config: { fuseStreak: 3 } });
  env.setScenario([
    routerStep('maker'), makerStep({ summary: 'r1' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('maker'), makerStep({ summary: 'r2' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: 'B-002 fail lib/stats.mjs:9 另一条 AC 不过' }),
    routerStep('maker'), makerStep({ summary: 'r3' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('human', { summary: '让人看一眼' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const ts = env.findTask(id);
  assert.equal(ts.box, 'queue');
  assert.equal(ts.runtime.awaiting.kind, 'help');
  assert.equal(env.events(id).filter((e) => e.type === 'fuse_tripped').length, 0);
});

test('AC-024：fuseStreak=0 关闭保险丝', (t) => {
  const { env, id } = newRouterEnv(t, { config: { fuseStreak: 0 } });
  env.setScenario([
    routerStep('maker'), makerStep({ summary: 'r1' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('maker'), makerStep({ summary: 'r1' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('maker'), makerStep({ summary: 'r1' }),
    routerStep('review'), reviewerStep({ outcome: 'fail', summary: SAME_FAIL }),
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).box, 'queue');
  assert.equal(env.events(id).filter((e) => e.type === 'fuse_tripped').length, 0);
});
