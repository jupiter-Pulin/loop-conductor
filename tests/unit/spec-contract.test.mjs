// 单元：spec-doc/v1 契约（validateSpecDoc）、AC 枚举拆分（enumerate 无兜底 / extract 有兜底）、
// specContractInvalidNext 阶梯。契约门与 Stop hook 共用同一份裁判代码，这里锁行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecDoc, SPEC_DOC_CONTRACT } from '../../conductor/lib/spec-contract.mjs';
import { enumerateAcceptanceCriteria, extractAcceptanceCriteria } from '../../conductor/lib/state.mjs';
import { specContractInvalidNext } from '../../conductor/stages/decisions.mjs';

const GOOD = [
  '# 功能 spec',
  '',
  '## 背景',
  '',
  '一些背景。',
  '',
  '## 验收标准',
  '',
  '- AC-1 median 偶数长度取平均',
  '- `node --test` 全绿',
  '',
].join('\n');

test('validateSpecDoc：合法文档 ok，AC 归一编号（标签归一 + 位置编号）', () => {
  const r = validateSpecDoc(GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.acs.map((a) => a.ac_id), ['AC-001', 'AC-002']);
});

test('validateSpecDoc：缺失/空文档 → fail', () => {
  for (const doc of [null, undefined, '', '   \n']) {
    const r = validateSpecDoc(doc);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(';'), /缺失或为空/);
    assert.deepEqual(r.acs, []);
  }
});

test('validateSpecDoc：同义标题不认（Acceptance Criteria）→ 缺段错误', () => {
  const doc = '# spec\n\n## Acceptance Criteria\n\n- AC-001: whatever\n';
  const r = validateSpecDoc(doc);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /缺少「## 验收标准」段/);
  assert.match(r.errors.join(';'), /逐字/);
});

test('validateSpecDoc：AC 段存在但无列表项 → fail', () => {
  const doc = '# spec\n\n## 验收标准\n\n还没想好。\n';
  const r = validateSpecDoc(doc);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /没有可枚举的条目/);
});

test('validateSpecDoc：AC 编号重复（标签撞标签 / 标签撞位置号）→ fail', () => {
  const tagDup = '# s\n\n## 验收标准\n\n- AC-001 甲\n- AC-1 乙\n';
  const r1 = validateSpecDoc(tagDup);
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join(';'), /AC 编号重复：AC-001/);

  // 首条带 AC-002 标签，第二条未标号按位置得 AC-002 → 冲突
  const posDup = '# s\n\n## 验收标准\n\n- AC-002 甲\n- 乙\n';
  const r2 = validateSpecDoc(posDup);
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join(';'), /AC 编号重复：AC-002/);
});

test('契约常量：标题与 state.mjs 抽取口径一致', () => {
  assert.equal(SPEC_DOC_CONTRACT.id, 'spec-doc/v1');
  assert.equal(SPEC_DOC_CONTRACT.acSectionTitle, '验收标准');
});

test('enumerateAcceptanceCriteria 无兜底返回 []；extractAcceptanceCriteria 保留兜底单条', () => {
  const noAc = '# spec\n\n只有正文。\n';
  assert.deepEqual(enumerateAcceptanceCriteria(noAc), []);
  const fallback = extractAcceptanceCriteria(noAc);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].ac_id, 'AC-001');
  assert.match(fallback[0].text, /testCommand 全绿/);
});

test('specContractInvalidNext：max=2 → 0→1 留、1→2 留、2→3 耗尽收箱', () => {
  assert.deepEqual(specContractInvalidNext(0, 2), { exhausted: false, invalidCount: 1, failureType: null });
  assert.deepEqual(specContractInvalidNext(1, 2), { exhausted: false, invalidCount: 2, failureType: null });
  assert.deepEqual(
    specContractInvalidNext(2, 2),
    { exhausted: true, invalidCount: 3, failureType: 'spec_contract_exhausted' },
  );
});
