// 集成：approve 时的 spec-doc/v1 终审守门（R4-E9）。
// 真实案例：task-20260706-002 人审期间被人工重写，标题改成英文「## Acceptance Criteria」——
// 契约门只在 spec-agent 交付时跑，approve/冻结路径不再校验，冻结会静默兜底成 1 条笼统 AC，
// 24 条 AC 的 per-AC 验证链整体退化。新行为：cmdApprove 对草稿终审，不合格拒绝写入 approval。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv } from '../helpers/env.mjs';

const BAD_SPEC = `# Tech Spec: x

## Acceptance Criteria

- [ ] AC-001: constant 增加 'hyperliquid'。
- [ ] AC-002: id 生成函数纯函数化。
`;

const GOOD_SPEC = BAD_SPEC.replace('## Acceptance Criteria', '## 验收标准');

test('approve：草稿标题不符合 spec-doc/v1 → 拒绝写入 approval，任务保持原状；修正后放行', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-940';
  env.writeTask(id, { kind: 'feature', stage: 'AWAIT_SPEC_APPROVAL' });
  const draft = path.join(env.root, 'specs', `${id}.md`);
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, BAD_SPEC);

  const refused = env.run('approve', id);
  assert.notEqual(refused.status, 0, '不合格草稿必须拒绝');
  assert.ok(refused.stderr.includes('spec-doc/v1'), '报错点名契约');
  assert.ok(refused.stderr.includes('验收标准'), '报错给出可行动修复方向');
  const after = env.findTask(id);
  assert.equal(after.runtime.approval, null, 'approval 不得写入');
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL', 'stage 不动');

  fs.writeFileSync(draft, GOOD_SPEC);
  const ok = env.run('approve', id);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(env.findTask(id).runtime.approval, 'approved', '合格草稿照常放行');
});

test('approve：草稿缺失（bugfix/历史路径）保持旧行为——仅警告不拦截', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-941';
  env.writeTask(id, { kind: 'bugfix', stage: 'AWAIT_SPEC_APPROVAL' });

  const r = env.run('approve', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(env.findTask(id).runtime.approval, 'approved', '无 specs/ 草稿时不引入新拦截');
});
