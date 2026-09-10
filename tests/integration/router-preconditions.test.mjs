// 集成：动作前置与 router 失效连击（AC-003、AC-004）。
// 每种被拒前置一例，加上「连续 2 次失效 → 内核开 help 闸」与「成功决策清零」。
// 被拒必须**零副作用**：不建 worktree、不 spawn 下游 agent、不动 stage。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promptOf } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, reviewerStep, routerStep, specStep } from '../helpers/router-env.mjs';

function rejections(env, id) {
  return env.events(id).filter((e) => e.type === 'action_rejected');
}

test('AC-003：review 在任务分支无 diff 时被拒，零副作用', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('review', { summary: '想审，但还没有任何改动' }),
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = rejections(env, id);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].action, 'review');
  assert.match(rejected[0].reason, /没有 diff/);
  assert.ok(!env.exists(env.worktree(id)), '被拒不得建任务 worktree');
  assert.ok(!env.exists(env.dossier(id, 'reviewer-r1.json')), '被拒不得 spawn reviewer');

  // 下一轮事实段带上被拒原因（AC-003 末句）。
  const nextRouterPrompt = promptOf(env.calls()[1]);
  assert.match(nextRouterPrompt, /最近一次 action_rejected：r1 review：/);
});

test('AC-003：merge 在版本规则未满足时被拒', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'),
    makerStep(),
    routerStep('merge', { summary: '直接申请合并' }),
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = rejections(env, id);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].action, 'merge');
  assert.match(rejected[0].reason, /need_review=true/);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help', '被拒后是 router 自己再求助，不是 merge 闸');
});

test('AC-003：precommit 在当前 HEAD 无 reviewer 记录 / tier 低于声明时被拒', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'),
    makerStep(),
    routerStep('precommit', { tier: 'unit', summary: '还没 review 就想跑 precommit' }),
    routerStep('review'),
    reviewerStep({ tier: 'integration', summary: 'B-001 pass' }),
    routerStep('precommit', { tier: 'unit', summary: 'tier 比 reviewer 声明的低' }),
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = rejections(env, id);
  assert.deepEqual(rejected.map((r) => r.action), ['precommit', 'precommit']);
  assert.match(rejected[0].reason, /没有 reviewer 记录/);
  assert.match(rejected[1].reason, /低于 reviewer 在当前 HEAD 声明的 integration/);
  assert.ok(!env.exists(env.dossier(id, 'precommit-r3.json')), '被拒不得留下 precommit 记录');
  assert.ok(!env.exists(env.dossier(id, 'precommit-r6.json')));
});

test('AC-003：曾产出 spec 但未批准时，maker 被拒；plan 在阶段闸关时被拒', (t) => {
  const { env, id } = newRouterEnv(t);
  const specBody = '# t\n\n## 验收标准\n\n- AC-001: median([1,2,3,4]) 返回 2.5\n';
  env.setScenario([
    routerStep('spec'),
    specStep(specBody, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'spec');

  const reject = env.run('reject', id, '--notes', 'AC 写得太笼统，重写');
  assert.equal(reject.status, 0, reject.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');

  env.appendScenario([
    routerStep('maker', { summary: '不管 spec 闸，直接实现' }),
    routerStep('plan', { summary: '想拆包' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = rejections(env, id);
  assert.deepEqual(rejected.map((r) => r.action), ['maker', 'plan']);
  assert.match(rejected[0].reason, /曾产出 spec/);
  assert.match(rejected[1].reason, /packagesEnabled=false/);
  assert.ok(!env.exists(env.worktree(id)), 'maker 被拒不得建 worktree');
});

test('AC-004：router 记录 product≠ok 与被拒各计一次失效，连续 2 次开 help 闸；成功决策清零', (t) => {
  const { env, id } = newRouterEnv(t);
  // r1：router 写了一份非法 log（action 不在闭集）→ product invalid，第一次失效。
  // r2：动作被前置拒 → 第二次失效 → 内核开 help 闸。
  env.setScenario([
    { cost: 0.01, result: 'ok', actions: [{ type: 'writeLog', content: { role: 'router', outcome: 'ok', action: 'teleport', summary: '瞎选一个' } }] },
    routerStep('review', { summary: '无 diff 还要 review' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'AWAIT_HUMAN');
  assert.equal(ts.runtime.awaiting.kind, 'help');
  const gate = env.readJson(env.dossier(id, 'human-r2.json'));
  assert.equal(gate.requested_by, 'kernel');
  assert.match(gate.summary, /product=invalid/);
  assert.match(gate.summary, /action_rejected\(review\)/);
  assert.match(gate.summary, /r1:/);
  assert.match(gate.summary, /r2:/);

  // resume 回 ROUTING 后：一次成功决策把连击清零，随后再来一次失效不会立刻再开闸。
  assert.equal(env.run('resume', id, '--notes', '继续吧').status, 0);
  env.appendScenario([
    routerStep('maker'), makerStep(),
    routerStep('merge', { summary: '还没 review 就要合' }),
    routerStep('human', { summary: '第三次失效之后的求助' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.awaiting.kind, 'help');
  const helpGate = env.readJson(env.dossier(id, `human-r${after.runtime.awaiting.round}.json`));
  assert.equal(helpGate.requested_by, 'router', '成功的 maker 清零后，只有 1 次失效，不该由内核开闸');
});
