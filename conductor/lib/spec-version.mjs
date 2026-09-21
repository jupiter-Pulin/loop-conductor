// lib/spec-version.mjs — spec 的版本身份：内容哈希，不是路径。
//
// 「当前适用版本」只有一个判据：正文的 sha256。草稿在 `specs/<id>.md`，批准时冻结到
// `dossier/<id>/spec.md`、草稿移进 `specs/archive/`——路径变了三次，内容没变，哈希就没变。
// 摘要、reviewer 判决、委派都按这个哈希绑定版本：文件搬家不会让引用失效，人改一个字则全部过期。
//
// 批准时把哈希记进 `runtime.spec_sha256`。之后每次使用冻结稿前复核一次（verifyApprovedSpec）：
// 盘上的冻结稿与批准时的哈希对不上 = 有人（或某个 worker）在批准之后动过它，内核拒绝继续用，
// 这是「router / worker 不得替换获批 spec」的工程执法点，不依赖任何 agent 的自觉。
//
// 零副作用：本模块只读盘，不写盘。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Of(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 展示 / 文件名用的短哈希（12 位足够在单任务内唯一）。 */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : null;
}

/** 行数口径：与「带行号渲染」一致——末尾换行不多算一行。 */
export function splitLines(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 给正文加行号（摘要 agent 与 router 引用的坐标系）：`   12| 内容`。 */
export function numberLines(text) {
  const lines = splitLines(text);
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}| ${l}`).join('\n');
}

export function specDraftFile(cfg, id) {
  return path.join(cfg.specsDir, `${id}.md`);
}

export function frozenSpecFile(cfg, id) {
  return path.join(cfg.dossierDir, id, 'spec.md');
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * 当前适用的 spec：已批准 → 冻结稿；否则 → 草稿（在人闸上、或刚写完）；都没有 → null。
 * 返回 { status: 'approved' | 'draft', path, text, sha256, lines }。
 */
export function currentSpec(cfg, ts) {
  const id = ts.id;
  if (ts.runtime?.spec_approved === true) {
    const p = frozenSpecFile(cfg, id);
    const text = readIf(p);
    if (text != null && text.trim() !== '') {
      return { status: 'approved', path: p, text, sha256: sha256Of(text), lines: splitLines(text).length };
    }
    return null;
  }
  const p = specDraftFile(cfg, id);
  const text = readIf(p);
  if (text == null || text.trim() === '') return null;
  return { status: 'draft', path: p, text, sha256: sha256Of(text), lines: splitLines(text).length };
}

/**
 * 冻结稿完整性复核。返回：
 *   { ok: true, sha256, backfill? }            —— 一致；backfill=true 表示升级前批准的任务还没记过哈希
 *   { ok: false, reason, expected, actual }    —— 不一致或冻结稿丢失
 * 无 spec（brief 即契约）的任务恒 ok。
 */
export function verifyApprovedSpec(cfg, ts) {
  if (ts.runtime?.spec_approved !== true) return { ok: true, sha256: null };
  const text = readIf(frozenSpecFile(cfg, ts.id));
  if (text == null || text.trim() === '') {
    return { ok: false, reason: 'frozen_spec_missing', expected: ts.runtime.spec_sha256 ?? null, actual: null };
  }
  const actual = sha256Of(text);
  const expected = ts.runtime.spec_sha256 ?? null;
  if (expected == null) return { ok: true, sha256: actual, backfill: true };
  if (expected !== actual) return { ok: false, reason: 'frozen_spec_changed', expected, actual };
  return { ok: true, sha256: actual };
}
