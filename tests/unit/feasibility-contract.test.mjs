// feasibility-doc/v1 契约（lib/feasibility-contract.mjs）：机器锚点的唯一裁判。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEASIBILITY_DOC_CONTRACT, enumerateOptions, validateFeasibilityDoc,
} from '../../conductor/lib/feasibility-contract.mjs';

const VALID_TABLE_DOC = [
  '# Feasibility Study: 示例',
  '',
  '## 选项对比',
  '',
  '| 选项 | 描述 | 取舍 | 结论 |',
  '| --- | --- | --- | --- |',
  '| O-A: 就地修 | 改现有函数 | 快但埋雷 | consider |',
  '| O-B: 抽新模块 | 独立模块 | 慢但干净 | recommend |',
  '',
  '## 推荐',
  '',
  '推荐 O-B：独立模块可测试性更好。',
  '',
  '## 开放问题',
  '',
  '| 问题 | Safe default | 影响 |',
  '| --- | --- | --- |',
  '| 缓存 TTL 取多少 | 60s | 命中率波动 |',
  '',
].join('\n');

const VALID_LIST_DOC = [
  '# Feasibility Study: 列表形态',
  '',
  '## 选项对比',
  '',
  '- O-A: 就地修——快但埋雷',
  '- O-B: 抽新模块——慢但干净',
  '- O-C: 不做——保持现状',
  '',
  '## 推荐',
  '',
  '推荐 O-C，当前收益不抵成本。',
  '',
  '## 开放问题',
  '',
  '（无）',
  '',
].join('\n');

test('validateFeasibilityDoc：表格形态合法文档 → ok，option 按序枚举', () => {
  const check = validateFeasibilityDoc(VALID_TABLE_DOC);
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.deepEqual(check.options.map((o) => o.option_id), ['O-A', 'O-B']);
});

test('validateFeasibilityDoc：列表形态同样合法（两种承载形态都认）', () => {
  const check = validateFeasibilityDoc(VALID_LIST_DOC);
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.deepEqual(check.options.map((o) => o.option_id), ['O-A', 'O-B', 'O-C']);
});

test('validateFeasibilityDoc：缺失/空文档 → ok:false，绝不抛错', () => {
  for (const bad of [null, undefined, '', '   \n  ']) {
    const check = validateFeasibilityDoc(bad);
    assert.equal(check.ok, false);
    assert.equal(check.options.length, 0);
    assert.match(check.errors[0], /缺失或为空/);
  }
});

test('validateFeasibilityDoc：缺「## 选项对比」段 → 明确报缺段（不认同义标题）', () => {
  const doc = VALID_TABLE_DOC.replace('## 选项对比', '## Option Comparison');
  const check = validateFeasibilityDoc(doc);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('选项对比')), check.errors.join('; '));
});

test(`validateFeasibilityDoc：option 少于 ${FEASIBILITY_DOC_CONTRACT.minOptions} 个 → fail`, () => {
  const doc = VALID_LIST_DOC.replace('- O-B: 抽新模块——慢但干净\n', '').replace('- O-C: 不做——保持现状\n', '')
    .replace('推荐 O-C，当前收益不抵成本。', '推荐 O-A。');
  const check = validateFeasibilityDoc(doc);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('不足')), check.errors.join('; '));
});

test('validateFeasibilityDoc：option ID 重复 → fail', () => {
  const doc = VALID_LIST_DOC.replace('- O-C: 不做——保持现状', '- O-A: 重复编号')
    .replace('推荐 O-C，当前收益不抵成本。', '推荐 O-B。');
  const check = validateFeasibilityDoc(doc);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('重复')), check.errors.join('; '));
});

test('validateFeasibilityDoc：缺「## 推荐」段 / 推荐未点名 option / 推荐引用不存在 option → fail', () => {
  const noSection = VALID_TABLE_DOC.replace('## 推荐', '## 结论');
  assert.equal(validateFeasibilityDoc(noSection).ok, false);

  const noMention = VALID_TABLE_DOC.replace('推荐 O-B：独立模块可测试性更好。', '两个都行。');
  const c2 = validateFeasibilityDoc(noMention);
  assert.equal(c2.ok, false);
  assert.ok(c2.errors.some((e) => e.includes('未引用任何 option')), c2.errors.join('; '));

  const ghost = VALID_TABLE_DOC.replace('推荐 O-B：独立模块可测试性更好。', '推荐 O-Z。');
  const c3 = validateFeasibilityDoc(ghost);
  assert.equal(c3.ok, false);
  assert.ok(c3.errors.some((e) => e.includes('不存在的 option：O-Z')), c3.errors.join('; '));
});

test('validateFeasibilityDoc：缺「## 开放问题」段 → fail（safe default 纪律的机器锚点）', () => {
  const doc = VALID_TABLE_DOC.replace('## 开放问题', '## FAQ');
  const check = validateFeasibilityDoc(doc);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('开放问题')), check.errors.join('; '));
});

test('enumerateOptions：O-Auth 之类前缀相似词不被误吞；段外的 O-X 不计入', () => {
  const doc = [
    '## 选项对比',
    '',
    '- O-A: 用 O-Auth2 登录',   // 行首 O-A 是 option；行内 O-Auth2 不是
    '- O-B: 本地 session',
    '',
    '## 推荐',
    '',
    '推荐 O-A。',
    '',
    '## 开放问题',
    '',
    '- O-C 只是这里顺嘴一提，不在选项对比段，不算 option。',
  ].join('\n');
  assert.deepEqual(enumerateOptions(doc).map((o) => o.option_id), ['O-A', 'O-B']);
  // 开放问题段提到的 O-C 不进枚举 → 推荐引用 O-C 会被判不存在
  const ghost = doc.replace('推荐 O-A。', '推荐 O-C。');
  const check = validateFeasibilityDoc(ghost);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('O-C')));
});
