// 集成：三道人闸的 CLI 面（AC-012–015）与建单前置（AC-019）。
// 闸的产物形状（human-r<n>.json）与「离开时人的裁决进记录列表」是 dashboard 与 router 的共同契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv } from '../helpers/env.mjs';
import { makerCalls, makerStep, newRouterEnv, reviewerStep, routerStep, specStep } from '../helpers/router-env.mjs';

const SPEC_BODY = '# t\n\n## 验收标准\n\n- AC-001: median([1,2,3,4]) 返回 2.5\n- AC-002: node --test 全绿\n';

test('AC-019：目标仓没有可用 precommit 段时 new 失败，stderr 打印全键样例', (t) => {
  const env = makeEnv(t);
  const briefPath = env.writeBrief();

  const noProfile = env.run('new', '--title', 't', '--brief', briefPath);
  assert.notEqual(noProfile.status, 0);
  assert.match(noProfile.stderr, /precommit/);
  for (const key of ['build', 'service', 'unit', 'integration', 'e2e']) {
    assert.match(noProfile.stderr, new RegExp(`"${key}"`), `样例应含 ${key} 键`);
  }
  assert.match(noProfile.stderr, /可删的键/);
  assert.equal(fs.readdirSync(path.join(env.root, 'state', 'queue')).length, 0, '拒绝时不得留下半个任务');

  // 有 profile 但 precommit 段缺 unit，且任务也没有 testCommand 回落 → 仍拒。
  env.writePrecommitProfile({ build: 'npm run build' });
  env.writeConfig({ testCommand: '' });
  const noUnit = env.run('new', '--title', 't', '--brief', briefPath);
  assert.notEqual(noUnit.status, 0);
  assert.match(noUnit.stderr, /precommit\.unit 与任务的 testCommand 皆缺/);

  // 配齐即可建单。
  env.writeConfig({ testCommand: 'node --test' });
  const ok = env.run('new', '--title', 't', '--brief', briefPath);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /stage=ROUTING/);
});

test('AC-019：--brief 缺失或文件不存在时 new 拒绝', (t) => {
  const env = makeEnv(t);
  env.writePrecommitProfile();
  assert.notEqual(env.run('new', '--title', 't').status, 0);
  const missing = env.run('new', '--title', 't', '--brief', path.join(env.root, 'nope.md'));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /文件不存在/);
});

test('AC-012/013：spec 闸 reject → ROUTING，notes 进记录并回喂 spec-agent；--no-packages 在阶段闸关时被忽略', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('spec'),
    specStep(SPEC_BODY, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  assert.equal(env.run('run').status, 0);

  const noNotes = env.run('reject', id);
  assert.notEqual(noNotes.status, 0, 'reject 必须带 --notes');
  assert.match(noNotes.stderr, /--notes/);

  const rejected = env.run('reject', id, '--notes', 'AC-002 是套话，换成可观察行为');
  assert.equal(rejected.status, 0, rejected.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'ROUTING');
  assert.equal(ts.runtime.awaiting, null);
  assert.equal(ts.runtime.spec_approved, false);
  const record = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.equal(record.decision, 'rejected');
  assert.equal(record.notes, 'AC-002 是套话，换成可观察行为');
  assert.ok(env.events(id).some((e) => e.type === 'human_decision' && e.decision === 'rejected'));

  // 下一轮 spec-agent 拿到打回意见。
  env.appendScenario([
    routerStep('spec', { summary: '按 notes 重写' }),
    specStep(SPEC_BODY, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  assert.equal(env.run('run').status, 0);
  const specPrompt = env.calls().at(-1).prompt;
  assert.match(specPrompt, /人审打回意见/);
  assert.match(specPrompt, /AC-002 是套话/);

  // --no-packages 在 packagesEnabled=false 时只是被忽略，不影响批准本身。
  const gateRound = env.findTask(id).runtime.awaiting.round;
  const approve = env.run('approve', id, '--no-packages', '--notes', '就这样，别动 median 之外的东西');
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, /--no-packages 本阶段无意义/);
  assert.equal(env.findTask(id).runtime.spec_approved, true);
  assert.equal(env.readJson(env.dossier(id, `human-r${gateRound}.json`)).no_packages, false);

  // 「人审补充约束」只取批准时的 notes：打回时那句是给 spec-agent 的改写指令，已经通过
  // 「人审打回意见」进过 spec prompt，再灌给 maker 等于让它照着一份作废的意见干活。
  env.appendScenario([
    routerStep('maker'), makerStep(),
    routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' }),
  ]);
  assert.equal(env.run('run').status, 0);
  const makerPrompt = makerCalls(env).at(-1).prompt;
  assert.match(makerPrompt, /\[人审补充约束\] 就这样，别动 median 之外的东西/);
  assert.equal(makerPrompt.includes('AC-002 是套话'), false, '被打回的 notes 不进 maker 的约束段');
});

test('AC-015：resume 只在 help 闸可用，其他 stage 报错退出', (t) => {
  const { env, id } = newRouterEnv(t);
  const early = env.run('resume', id);
  assert.notEqual(early.status, 0, 'ROUTING 上 resume 应报错');
  assert.match(early.stderr, /仅适用于 AWAIT_HUMAN\(help\)/);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING');

  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');

  const wrongGate = env.run('resume', id);
  assert.notEqual(wrongGate.status, 0, 'merge 闸上 resume 应报错');
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge', '报错不得改变闸的状态');

  // 反向：approve 落在 help 闸上时指回 resume。
  assert.equal(env.run('reject', id, '--notes', '先不合').status, 0);
  env.appendScenario([routerStep('human', { summary: '请人裁决命名' })]);
  assert.equal(env.run('run').status, 0);
  const onHelp = env.run('approve', id);
  assert.notEqual(onHelp.status, 0);
  assert.match(onHelp.stderr, /conductor resume/);
});

test('AC-012：merge 闸 reject → ROUTING，base 分支不动', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = env.run('reject', id, '--notes', '命名再改一版');
  assert.equal(rejected.status, 0, rejected.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'ROUTING');
  assert.equal(ts.box, 'queue');
  const record = env.readJson(env.dossier(id, 'human-r4.json'));
  assert.equal(record.kind, 'merge');
  assert.equal(record.decision, 'rejected');
  assert.equal(record.notes, '命名再改一版');
});
