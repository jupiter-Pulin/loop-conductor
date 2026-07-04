// commit message 裁判单测（decisions.mjs::validateCommitMessage，零 IO）。
// committer 提案制的唯一裁判：type 白名单 + 描述 ≤72 + 单行无首尾空白 + 禁 WIP +
// body 非空且行宽 ≤100；任何非法输入返回 { ok:false, errors }，绝不抛错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMIT_MESSAGE_CONTRACT, validateCommitMessage } from '../../conductor/stages/decisions.mjs';

const GOOD_BODY = '为什么：merge commit 缺叙事，归因只能读全量 diff。\n\n验证：npm test 全绿。\n索引：README case 表。';

test('validateCommitMessage：合法提案（带/不带 scope）→ ok', () => {
  for (const subject of [
    'feat(conductor): merge 提交文案由 committer 提案',
    'fix: median 偶数长度取中间两数平均',
    'refactor(state): 抽取原子写工具',
    'perf(scheduler): 并发扫描任务目录',
    'test: 补 per-AC 探针混合场景',
    'docs: README case 表增行',
    'chore: 升级 node 版本要求',
  ]) {
    const r = validateCommitMessage({ subject, body: GOOD_BODY });
    assert.equal(r.ok, true, `${subject}: ${r.errors?.join('; ')}`);
    assert.equal(r.subject, subject);
    assert.equal(r.body, GOOD_BODY);
  }
});

test('validateCommitMessage：type 白名单即 skill 决策表（无 optimize 等自造 type）', () => {
  assert.deepEqual(
    [...COMMIT_MESSAGE_CONTRACT.types],
    ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore'],
  );
  const r = validateCommitMessage({ subject: 'optimize: 提升性能', body: GOOD_BODY });
  assert.equal(r.ok, false);
});

test('validateCommitMessage：全部非法分支 → ok:false + errors，绝不抛错', () => {
  const cases = [
    ['非对象：null', null],
    ['非对象：数组', []],
    ['subject 缺失', { body: GOOD_BODY }],
    ['subject 非字符串', { subject: 3, body: GOOD_BODY }],
    ['无 type 前缀', { subject: '修复 median', body: GOOD_BODY }],
    ['type 非白名单', { subject: 'feature: 新增探针', body: GOOD_BODY }],
    ['缺冒号空格', { subject: 'feat:无空格', body: GOOD_BODY }],
    ['描述超 72 字符', { subject: `feat: ${'长'.repeat(73)}`, body: GOOD_BODY }],
    ['subject 多行', { subject: 'feat: 第一行\n第二行', body: GOOD_BODY }],
    ['subject 首尾空白', { subject: ' feat: 有前导空格', body: GOOD_BODY }],
    ['subject 含 WIP', { subject: 'feat: WIP 先提一版', body: GOOD_BODY }],
    ['body 缺失', { subject: 'feat: 合法主题' }],
    ['body 空白串', { subject: 'feat: 合法主题', body: '  \n ' }],
    ['body 行宽超 100', { subject: 'feat: 合法主题', body: `第一行\n${'宽'.repeat(101)}` }],
  ];
  for (const [label, parsed] of cases) {
    let r;
    assert.doesNotThrow(() => { r = validateCommitMessage(parsed); }, label);
    assert.equal(r.ok, false, label);
    assert.ok(Array.isArray(r.errors) && r.errors.length >= 1, `${label}：errors 至少 1 条`);
  }
});

test('validateCommitMessage：描述恰 72 字符 / body 行恰 100 字符是合法边界', () => {
  const r = validateCommitMessage({
    subject: `feat: ${'长'.repeat(72)}`,
    body: `${'宽'.repeat(100)}\n验证：npm test 全绿。`,
  });
  assert.equal(r.ok, true, r.errors?.join('; '));
});
