// stages/shared.mjs 单测：readRejectNotes 的截尾行为——超过 10 条 `- ` 打回意见时
// 只保留最近 10 条并加截断说明；未超限时原样返回（不破坏既有单条 note 行为）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRejectNotes } from '../../conductor/stages/shared.mjs';

/** 造一个含 reject_notes.md 的临时任务目录，返回 { dir } 形态的 ts。 */
function makeTaskDir(t, notesContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (notesContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'reject_notes.md'), notesContent);
  }
  return { dir };
}

test('readRejectNotes：15 条 note 只保留最近 10 条 + 截断说明行', (t) => {
  const notes = Array.from({ length: 15 }, (_, i) => `- 2026-06-${String(i + 1).padStart(2, '0')}: 打回意见 ${i + 1}`);
  const ts = makeTaskDir(t, `${notes.join('\n')}\n`);
  const out = readRejectNotes(ts);
  const lines = out.split('\n');
  assert.equal(lines[0], '（仅保留最近 10 条打回意见，完整历史见任务目录 reject_notes.md）');
  assert.deepEqual(lines.slice(1), notes.slice(-10), '正文只剩最近 10 条，顺序不变');
  assert.ok(!out.includes('打回意见 5'), '第 5 条（旧）已被截掉');
  assert.ok(out.includes('打回意见 6') && out.includes('打回意见 15'), '第 6–15 条（新）保留');
});

test('readRejectNotes：3 条 note 未超限，原样返回', (t) => {
  const raw = '- 2026-06-01: 意见一\n- 2026-06-02: 意见二\n- 2026-06-03: 意见三\n';
  const ts = makeTaskDir(t, raw);
  assert.equal(readRejectNotes(ts), raw, '未截断时逐字节原样返回');
});

test('readRejectNotes：文件缺失返回空串', (t) => {
  const ts = makeTaskDir(t);
  assert.equal(readRejectNotes(ts), '');
});
