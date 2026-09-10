// 集成：spec-agent 直写交付 + spec-doc/v1 契约门（router 纪元）。
// ① 直写过门：--settings 注入写白名单 + Stop 双 hook（check-log + check-spec）、受限工具集，
//    文件合格即开 spec 闸；
// ② 契约门 fail：事件 spec_invalid、不开闸、留在 ROUTING，去向由 router 下一轮决定
//    （内核不自动重派，也不收箱）；
// ③ 送不送人审只看文件，不看 agent 自评：log 说 needs_human 但文件合格照样开闸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newRouterEnv, routerStep, specStep } from '../helpers/router-env.mjs';

const GOOD_SPEC = [
  '# 功能 spec',
  '',
  '## 背景',
  '',
  '一些背景。',
  '',
  '## 验收标准',
  '',
  '- AC-001: `node --test` 全绿',
  '',
].join('\n');
// 同义标题：契约门必须拒绝（标题不逐字）。
const BAD_SPEC_TITLE = '# spec\n\n## Acceptance Criteria\n\n- AC-001: whatever\n';

const SPEC_TOOLS_ARGV = 'Read,Grep,Glob,Bash(git log:*),Bash(git blame:*),Bash(git show:*),Write,Edit';

test('直写过门：settings/hook/工具形态正确，文件合格即开 spec 闸', (t) => {
  const { env, id } = newRouterEnv(t);
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([routerStep('spec'), specStep(GOOD_SPEC, { specPath: specAbs })]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN');
  assert.equal(after.runtime.awaiting.kind, 'spec');
  assert.equal(fs.readFileSync(specAbs, 'utf8'), GOOD_SPEC, '交付文件就是 agent 直写的内容，conductor 不改写');

  const specCall = env.calls()[1];
  assert.equal(specCall.argv[specCall.argv.indexOf('--tools') + 1], SPEC_TOOLS_ARGV, 'spec-agent 工具集受限');
  const settings = env.readJson(env.dossier(id, 'spec-r1.settings.json'));
  const allow = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(allow, /write-guard\.mjs/);
  assert.ok(allow.includes(specAbs), '写白名单放行 spec 草稿路径');
  assert.ok(allow.includes(env.dossier(id, 'spec-r1.log.json')), '写白名单放行 log 路径');
  assert.ok(!allow.includes('.packages.json'), 'packagesEnabled=false 时连 packages 路径都不放行');
  const stop = settings.hooks.Stop[0].hooks.map((h) => h.command);
  assert.equal(stop.length, 2, 'spec 起草轮挂 check-log + check-spec 两道 Stop hook');
  assert.match(stop[0], /check-log\.mjs/);
  assert.match(stop[1], /check-spec\.mjs/);
});

test('契约门 fail：事件 spec_invalid、不开闸、留在 ROUTING 交 router 处置', (t) => {
  const { env, id } = newRouterEnv(t);
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([
    routerStep('spec'),
    specStep(BAD_SPEC_TITLE, { specPath: specAbs }),
    routerStep('spec', { summary: '上轮 spec 交付不合格，重写' }),
    specStep(GOOD_SPEC, { specPath: specAbs }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const invalid = env.events(id).filter((e) => e.type === 'spec_invalid');
  assert.equal(invalid.length, 1, '不合格的那一轮记一条 spec_invalid');
  assert.equal(invalid[0].round, 1);
  assert.ok(invalid[0].errors.length > 0, '事件带结构化错误');
  assert.match(env.readFile(env.dossier(id, 'timeline.md')), /spec r1 交付不合格/);

  // 第二轮合格 → 才开闸；两轮之间没有任何 stage 转移
  const after = env.findTask(id);
  assert.equal(after.runtime.awaiting.kind, 'spec');
  assert.equal(after.runtime.awaiting.round, 2);
  assert.equal(after.runtime.spec_approved, false);
});

test('送不送人审只看文件：log 说 needs_human 但文件合格，照样开闸', (t) => {
  const { env, id } = newRouterEnv(t);
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([
    routerStep('spec'),
    specStep(GOOD_SPEC, { specPath: specAbs, outcome: 'needs_human', summary: 'brief 有自相矛盾之处，请裁决' }),
  ]);

  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'spec');
  const gate = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.match(gate.summary, /AC×1/);
  assert.equal(env.readJson(env.dossier(id, 'spec-r1.log.json')).outcome, 'needs_human', 'agent 的自评原样留档');
});
