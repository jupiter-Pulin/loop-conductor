// 集成：spec 闸 approve 时的 spec-doc/v1 终审守门（R4-E9）。
// 真实案例：task-20260706-002 人审期间被人工重写，标题改成英文「## Acceptance Criteria」——
// 契约门只在 spec-agent 交付时跑过一次，冻结路径不再校验，结果冻结稿静默兜底成 1 条笼统 AC，
// 24 条 AC 的验收面整体退化。行为：approve 对草稿终审，不合格拒绝冻结，任务留在 spec 闸上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newRouterEnv, routerStep, specStep } from '../helpers/router-env.mjs';

const GOOD_SPEC = [
  '# Tech Spec: x', '', '## 验收标准', '',
  '- AC-001: constant 增加 hyperliquid。',
  '- AC-002: id 生成函数纯函数化。',
  '',
].join('\n');
const BAD_SPEC = GOOD_SPEC.replace('## 验收标准', '## Acceptance Criteria');

test('approve：草稿被人工改成不合格 → 拒绝冻结，任务留在 spec 闸；修正后放行', (t) => {
  const { env, id } = newRouterEnv(t);
  const draft = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([routerStep('spec'), specStep(GOOD_SPEC, { specPath: draft })]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'spec');

  // 人审期间把草稿改坏（合法动作：草稿是人可以动的）
  fs.writeFileSync(draft, BAD_SPEC);

  const refused = env.run('approve', id);
  assert.notEqual(refused.status, 0, '不合格草稿必须拒绝');
  assert.ok(refused.stderr.includes('spec-doc/v1'), '报错点名契约');
  assert.ok(refused.stderr.includes('验收标准'), '报错给出可行动修复方向');
  const after = env.findTask(id);
  assert.equal(after.runtime.spec_approved, false, '不得冻结');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN', 'stage 不动');
  assert.equal(after.runtime.awaiting.kind, 'spec');
  assert.ok(!env.exists(env.dossier(id, 'spec.md')), '不得写出冻结稿');
  assert.ok(fs.existsSync(draft), '草稿不得被归档');

  fs.writeFileSync(draft, GOOD_SPEC);
  const ok = env.run('approve', id);
  assert.equal(ok.status, 0, ok.stderr);
  const approved = env.findTask(id);
  assert.equal(approved.runtime.spec_approved, true);
  assert.equal(approved.runtime.stage, 'ROUTING');
  assert.equal(env.readFile(env.dossier(id, 'spec.md')), GOOD_SPEC, '冻结稿逐字等于当时的草稿');
});

test('approve：草稿被移走 → 拒绝并说明原因，任务保持原状', (t) => {
  const { env, id } = newRouterEnv(t);
  const draft = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([routerStep('spec'), specStep(GOOD_SPEC, { specPath: draft })]);
  assert.equal(env.run('run').status, 0);

  fs.rmSync(draft);
  const refused = env.run('approve', id);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`specs/${id}\\.md 不存在`));
  assert.equal(env.findTask(id).runtime.spec_approved, false);
});
