// 单元：spec 的版本身份（内容哈希）与冻结稿完整性复核。
// 两条规则全靠这里：① 行号坐标系——摘要里每条引用都是按 splitLines/numberLines 的行号写的，
// 少算或多算一行，整份摘要的引用就集体指错地方，而机械校验还会判它「通过」；
// ② 冻结稿哈希复核——它是「批准之后没人能换掉 spec」的唯一工程执法点，不依赖任何 agent 的自觉，
// 一旦 verifyApprovedSpec 对改动过的冻结稿返回 ok，router / worker 就能悄悄换掉人批准过的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sha256Of, shortSha, splitLines, numberLines, specDraftFile, frozenSpecFile,
  currentSpec, verifyApprovedSpec,
} from '../../conductor/lib/spec-version.mjs';

const ID = 'task-20260918-004';

function makeCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { root, specsDir: path.join(root, 'specs'), dossierDir: path.join(root, 'dossier') };
  fs.mkdirSync(cfg.specsDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.dossierDir, ID), { recursive: true });
  return cfg;
}

/** 最小 TaskState：currentSpec / verifyApprovedSpec 只看 id 与 runtime。 */
const ts = (runtime = {}) => ({ id: ID, runtime });

const writeDraft = (cfg, text) => fs.writeFileSync(specDraftFile(cfg, ID), text);
const writeFrozen = (cfg, text) => fs.writeFileSync(frozenSpecFile(cfg, ID), text);

/** 目录快照（路径 → 内容），用来证明这个模块真的零副作用。 */
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile()) out[p] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

const DRAFT = '# 草稿\n\n把 median 的偶数分支改成取中间两数平均。\n';
const FROZEN = '# 冻结稿\n\n把 median 的偶数分支改成取中间两数平均。\n\n## 验收标准\n\n- AC-001: 偶数长度取中间两数平均。\n';

test('sha256Of：内容即身份——同文同哈希、差一个字符即不同、空/null/undefined 同源', () => {
  assert.equal(sha256Of('abc'), crypto.createHash('sha256').update('abc', 'utf8').digest('hex'));
  assert.match(sha256Of('abc'), /^[0-9a-f]{64}$/);
  assert.equal(sha256Of(DRAFT), sha256Of(DRAFT));
  // 差一个字符就必须是另一个版本：否则人在闸上微调 spec，旧摘要 / 旧委派会被当成仍然有效。
  assert.notEqual(sha256Of(DRAFT), sha256Of(`${DRAFT} `));
  assert.equal(sha256Of(''), sha256Of(null));
  assert.equal(sha256Of(undefined), sha256Of(''));
});

test('shortSha：12 位十六进制前缀；非字符串 → null（它要当文件名用，不能混进路径分隔符）', () => {
  const sha = sha256Of(DRAFT);
  assert.equal(shortSha(sha).length, 12);
  assert.equal(shortSha(sha), sha.slice(0, 12));
  assert.match(shortSha(sha), /^[0-9a-f]{12}$/);
  assert.equal(/[/\\.]/.test(shortSha(sha)), false, '短哈希直接拼进文件名，出现 / 或 . 就会写到别处');
  for (const bad of [null, undefined, 42, {}, ['a']]) assert.equal(shortSha(bad), null);
});

test('splitLines 行数口径：末尾那一个换行不多算一行（引用行号的坐标系起点）', () => {
  // 天真的 split('\n') 会把 'a\nb\n' 数成 3 行——摘要里所有 Lx-y 就会整体偏移。
  assert.equal('a\nb\n'.split('\n').length, 3);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n'), ['a']);
  // 只弹末尾那一个空串：文末真有一行空行（'a\n\n'）时它是第 2 行，必须留着。
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('\n'), ['']);
  assert.deepEqual(splitLines(null), ['']);
  assert.equal(splitLines(DRAFT).length, 3);
});

test('numberLines 与 splitLines 同一坐标系：第 n 行的行号就是 n，行数一致', () => {
  assert.equal(numberLines('a\nb\nc\n'), '1| a\n2| b\n3| c');
  for (const text of ['a\nb\n', 'a\n\n', '', DRAFT, FROZEN]) {
    const lines = splitLines(text);
    const numbered = numberLines(text).split('\n');
    assert.equal(numbered.length, lines.length, `行数必须一致：${JSON.stringify(text)}`);
    numbered.forEach((row, i) => {
      assert.equal(row, `${String(i + 1).padStart(String(lines.length).length, ' ')}| ${lines[i]}`);
    });
  }
  // 位宽按总行数右对齐：10 行时个位数要补一个空格，否则模型抄行号时容易错位。
  const ten = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const rows = numberLines(ten).split('\n');
  assert.equal(rows[0], ' 1| 第 1 行');
  assert.equal(rows[9], '10| 第 10 行');
});

test('currentSpec：未批准 → specs/ 下的草稿，status=draft，sha/lines 与正文一致', (t) => {
  const cfg = makeCfg(t);
  writeDraft(cfg, DRAFT);
  const spec = currentSpec(cfg, ts({ spec_approved: false }));
  assert.equal(spec.status, 'draft');
  assert.equal(spec.path, specDraftFile(cfg, ID));
  assert.equal(spec.text, DRAFT);
  assert.equal(spec.sha256, sha256Of(DRAFT));
  assert.equal(spec.lines, 3);
  // runtime 里连 spec_approved 字段都没有的老任务，一样走草稿分支。
  assert.equal(currentSpec(cfg, ts({})).status, 'draft');
});

test('currentSpec：已批准 → dossier 冻结稿；草稿还在盘上也绝不回头看草稿', (t) => {
  const cfg = makeCfg(t);
  writeDraft(cfg, DRAFT);
  writeFrozen(cfg, FROZEN);
  const spec = currentSpec(cfg, ts({ spec_approved: true }));
  assert.equal(spec.status, 'approved');
  assert.equal(spec.path, frozenSpecFile(cfg, ID));
  assert.equal(spec.text, FROZEN);
  assert.equal(spec.sha256, sha256Of(FROZEN));
  assert.notEqual(spec.sha256, sha256Of(DRAFT), '批准后草稿再改也不是当前版本');
  // spec_approved 必须是严格的 true：字符串 'true' 不算批准，否则一个脏 runtime 就能提前读冻结稿。
  assert.equal(currentSpec(cfg, ts({ spec_approved: 'true' })).status, 'draft');
});

test('currentSpec：文件缺失 / 空 / 纯空白都算「没有 spec」，已批准时也不回退到草稿', (t) => {
  const cfg = makeCfg(t);
  assert.equal(currentSpec(cfg, ts({ spec_approved: false })), null, '草稿文件不存在');
  writeDraft(cfg, '');
  assert.equal(currentSpec(cfg, ts({ spec_approved: false })), null, '空草稿不算 spec');
  writeDraft(cfg, '  \n\t\n');
  assert.equal(currentSpec(cfg, ts({ spec_approved: false })), null, '纯空白草稿不算 spec');

  // 已批准但冻结稿没了：必须返回 null（降级为「没有 spec」），绝不能悄悄拿草稿顶包——
  // 草稿是人没批准过的那一版，顶包等于用未批准内容当契约。
  writeDraft(cfg, DRAFT);
  assert.equal(currentSpec(cfg, ts({ spec_approved: true })), null);
  writeFrozen(cfg, '   \n');
  assert.equal(currentSpec(cfg, ts({ spec_approved: true })), null);
});

test('verifyApprovedSpec：没有获批 spec（brief 即契约）的任务恒 ok，且不看盘', (t) => {
  const cfg = makeCfg(t);
  for (const runtime of [{}, { spec_approved: false }, { spec_approved: null }, { spec_approved: 'true' }]) {
    assert.deepEqual(verifyApprovedSpec(cfg, ts(runtime)), { ok: true, sha256: null });
  }
  assert.deepEqual(verifyApprovedSpec(cfg, { id: ID }), { ok: true, sha256: null }, 'runtime 缺失也不抛错');
});

test('verifyApprovedSpec：盘上冻结稿与批准时记下的哈希一致 → ok', (t) => {
  const cfg = makeCfg(t);
  writeFrozen(cfg, FROZEN);
  const r = verifyApprovedSpec(cfg, ts({ spec_approved: true, spec_sha256: sha256Of(FROZEN) }));
  assert.deepEqual(r, { ok: true, sha256: sha256Of(FROZEN) });
  assert.equal(r.backfill, undefined, '一致时不应标 backfill');
});

test('verifyApprovedSpec：runtime 还没记过哈希（升级前批准的任务）→ ok + backfill，而不是判失败', (t) => {
  const cfg = makeCfg(t);
  writeFrozen(cfg, FROZEN);
  for (const runtime of [{ spec_approved: true }, { spec_approved: true, spec_sha256: null }]) {
    const r = verifyApprovedSpec(cfg, ts(runtime));
    // 存量任务不该因为「历史上没记哈希」被判成篡改而卡死；调用方据 backfill 把哈希补记进 runtime。
    assert.deepEqual(r, { ok: true, sha256: sha256Of(FROZEN), backfill: true });
  }
});

test('verifyApprovedSpec：冻结稿被改过 → frozen_spec_changed，并报出 expected / actual', (t) => {
  const cfg = makeCfg(t);
  writeFrozen(cfg, FROZEN);
  const approvedSha = sha256Of(FROZEN);
  const tampered = `${FROZEN}- AC-002: 偷偷加的一条。\n`;
  writeFrozen(cfg, tampered);

  const r = verifyApprovedSpec(cfg, ts({ spec_approved: true, spec_sha256: approvedSha }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'frozen_spec_changed');
  assert.equal(r.expected, approvedSha);
  assert.equal(r.actual, sha256Of(tampered));
  assert.notEqual(r.expected, r.actual);
  // 连「只多一个空格」也必须判变更：范围蠕变往往就是一两个字。
  writeFrozen(cfg, `${FROZEN} `);
  assert.equal(verifyApprovedSpec(cfg, ts({ spec_approved: true, spec_sha256: approvedSha })).reason, 'frozen_spec_changed');
});

test('verifyApprovedSpec：冻结稿丢失 / 被清空 → frozen_spec_missing（不是 ok，也不是 changed）', (t) => {
  const cfg = makeCfg(t);
  const approvedSha = sha256Of(FROZEN);
  const runtime = { spec_approved: true, spec_sha256: approvedSha };

  const gone = verifyApprovedSpec(cfg, ts(runtime));
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'frozen_spec_missing');
  assert.equal(gone.expected, approvedSha);
  assert.equal(gone.actual, null);

  writeFrozen(cfg, '   \n\n');
  const blank = verifyApprovedSpec(cfg, ts(runtime));
  assert.equal(blank.reason, 'frozen_spec_missing', '清空文件不能被当成「内容变了」以外的合法状态');

  // 没记哈希 + 冻结稿也没了：仍然判 missing，不能因为 expected 为 null 就放行。
  const noSha = verifyApprovedSpec(cfg, ts({ spec_approved: true }));
  assert.equal(noSha.ok, false);
  assert.equal(noSha.reason, 'frozen_spec_missing');
  assert.equal(noSha.expected, null);
});

test('零副作用：currentSpec / verifyApprovedSpec 只读盘，不新建也不改任何文件', (t) => {
  const cfg = makeCfg(t);
  writeDraft(cfg, DRAFT);
  writeFrozen(cfg, FROZEN);
  const before = snapshot(cfg.root);

  currentSpec(cfg, ts({ spec_approved: false }));
  currentSpec(cfg, ts({ spec_approved: true }));
  currentSpec(cfg, { id: 'task-不存在', runtime: { spec_approved: true } });
  verifyApprovedSpec(cfg, ts({ spec_approved: true, spec_sha256: sha256Of(FROZEN) }));
  verifyApprovedSpec(cfg, ts({ spec_approved: true, spec_sha256: 'deadbeef' }));

  // 校验本身绝不能「顺手修好」冻结稿或补写哈希文件：那会让篡改在下一次复核时自动变成新基线。
  assert.deepEqual(snapshot(cfg.root), before);
});
