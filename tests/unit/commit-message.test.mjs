// commit message 裁判单测（decisions.mjs::validateCommitMessage，零 IO）。
// committer 提案制的唯一裁判：type 白名单 + 描述 ≤72 + 单行无首尾空白 + 禁 WIP +
// body 非空且行宽 ≤100 + commitLanguage 语言门（缺省 en 拒非 ASCII，非 en 逃生口回退旧行为）；
// 任何非法输入返回 { ok:false, errors }，绝不抛错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMIT_MESSAGE_CONTRACT, validateCommitMessage } from '../../conductor/stages/decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const GOOD_BODY = '为什么：merge commit 缺叙事，归因只能读全量 diff。\n\n验证：npm test 全绿。\n索引：README case 表。';

// 下面这组 fixture 本是纯形状测试，内容用中文只是历史遗留；commitLanguage 缺省 en 后
// 中文会被语言门拦，与本组测试要盯的形状逻辑无关，故显式传 'zh' 关闭语言门、只测形状。
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
    const r = validateCommitMessage({ subject, body: GOOD_BODY }, 'zh');
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
  }, 'zh');
  assert.equal(r.ok, true, r.errors?.join('; '));
});

// ---- commitLanguage 语言门（AC-1/AC-2：拒中文/放行英文，非 en 逃生口钉死旧行为） ----

test('validateCommitMessage：commitLanguage 缺省 en，非 ASCII 提案 → ok:false + 语言原因（AC-1）', () => {
  const zhSubject = validateCommitMessage({
    subject: 'fix(stats): 修复 median 偶数分支取值错误',
    body: 'Why: legacy bug misreads even-length median.\n\nVerify: npm test all green.\nRef: README case table.',
  });
  assert.equal(zhSubject.ok, false);
  assert.ok(zhSubject.errors.some((e) => e.includes('commit 必须为英文')), zhSubject.errors.join('; '));

  const zhBody = validateCommitMessage({
    subject: 'fix(stats): median even-length branch misreads value',
    body: 'Why: 历史遗留 bug 导致偶数长度取值错误。\n\nVerify: npm test all green.\nRef: README case table.',
  });
  assert.equal(zhBody.ok, false);
  assert.ok(zhBody.errors.some((e) => e.includes('commit 必须为英文')), zhBody.errors.join('; '));

  // 纯 ASCII/英文的合法形状提案在 en 模式下仍 ok:true（语言门不得误伤）
  const asciiOnly = validateCommitMessage({
    subject: 'fix(stats): median even-length branch misreads value',
    body: 'Why: legacy bug misreads even-length median.\n\nVerify: npm test all green.\nRef: README case table.',
  });
  assert.equal(asciiOnly.ok, true, asciiOnly.errors?.join('; '));
});

test('validateCommitMessage：commitLanguage 非 en（如 zh）→ 语言门关闭，逐字节回退旧行为（AC-2）', () => {
  const parsed = { subject: 'fix: median 偶数长度取中间两数平均', body: GOOD_BODY };
  const escaped = validateCommitMessage(parsed, 'zh');
  assert.deepEqual(escaped, { ok: true, errors: [], subject: parsed.subject, body: parsed.body });
});

test('agents/committer-agent.md：commit 语言反转为英文，body 四要素改英文固定标签（AC-5）', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'committer-agent.md'), 'utf8');
  assert.match(md, /commit 一律英文/, '必须反转为 commit 一律英文');
  assert.ok(!md.includes('语言跟随 target 仓库既有 commit 风格'), '不得保留旧的“跟随仓库风格”表述');
  for (const label of ['Why', 'Contract', 'Verify', 'Ref']) {
    assert.ok(md.includes(`\`${label}\``), `body 四要素必须含英文标签 ${label}`);
  }
});
