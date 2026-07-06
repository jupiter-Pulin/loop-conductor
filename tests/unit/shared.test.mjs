// stages/shared.mjs 单测：readRejectNotes 的截尾行为——超过 10 条 `- ` 打回意见时
// 只保留最近 10 条并加截断说明；未超限时原样返回（不破坏既有单条 note 行为）。
// 另：buildRepairContext(test_gate) 的 per-ac / suite 两形态（纯函数，零 IO）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRejectNotes, buildRepairContext, writeGreenGateResult, readGreenGateSignatures,
} from '../../conductor/stages/shared.mjs';

/** 造一个含 reject_notes.md 的临时任务目录，返回 { dir } 形态的 ts。 */
function makeTaskDir(t, notesContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (notesContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'reject_notes.md'), notesContent);
  }
  return { dir };
}

/** 造一个只含 dossierDir 的最小 cfg，供 writeGreenGateResult / readGreenGateSignatures 用。 */
function makeGreenGateCfg(t) {
  const dossierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-test-dossier-'));
  t.after(() => fs.rmSync(dossierDir, { recursive: true, force: true }));
  return { dossierDir, greenGateOutputTailBytes: 12000 };
}

const FAILING_STDOUT = [
  '✖ failing tests:', '',
  'test at test/foo.test.mjs:1:1',
  '✖ some test (1.234ms)',
  '  Error: boom',
  '      at Object.<anonymous> (/abs/path/test/foo.test.mjs:2:1)',
  '',
].join('\n');

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

test('buildRepairContext(test_gate)：per-ac 探针的 vacuous 条目精确进 failed_criteria（AC-009）', () => {
  const probe = {
    mode: 'per-ac',
    per_ac: [
      { ac_id: 'AC-001', expect: 'fail_on_baseline', exit_code: 0, timed_out: false, verdict: 'vacuous' },
      { ac_id: 'AC-002', expect: 'pass_on_baseline', exit_code: 0, timed_out: false, verdict: 'guard_holds' },
      { ac_id: 'AC-003', verdict: 'unmapped' },
    ],
  };
  const ctx = buildRepairContext({ source: 'test_gate', round: 1, probe });
  assert.equal(ctx.source, 'test_gate');
  assert.equal(ctx.test_gate_ref, 'test-gate-r1.json');
  assert.deepEqual(ctx.failed_criteria, [
    { ac_id: 'AC-001', status: 'vacuous', reason: '映射的测试命令在基线代码上仍 exit 0，未钉住该 AC 的新行为' },
  ], '只有 vacuous 条目进 failed_criteria，guard_holds/unmapped 不进');
});

test('buildRepairContext(test_gate)：suite 模式（降级）保持 v1 形态 failed_criteria=[]（AC-010）', () => {
  const ctx = buildRepairContext({ source: 'test_gate', round: 2, probe: { mode: 'suite', verdict: 'vacuous' } });
  assert.deepEqual(ctx.failed_criteria, []);
  assert.equal(ctx.test_gate_ref, 'test-gate-r2.json');
  // probe 缺省（旧调用形态）也不抛错
  assert.deepEqual(buildRepairContext({ source: 'test_gate', round: 3 }).failed_criteria, []);
});

test('buildRepairContext(green_gate)：sameSignatureStreak>=2 时注入 same_signature_streak 与人类可读提示（AC-007）', () => {
  const ctx = buildRepairContext({
    source: 'green_gate', round: 3, sameSignatureStreak: 2, failingTests: ['foo.test.mjs :: some test'],
  });
  assert.equal(ctx.same_signature_streak, 2);
  assert.match(ctx.same_signature_hint, /失败签名完全未变/);
  assert.match(ctx.same_signature_hint, /foo\.test\.mjs :: some test/);
});

test('buildRepairContext(green_gate)：streak<2 或缺省时不含 same_signature 字段', () => {
  const ctxNoStreak = buildRepairContext({ source: 'green_gate', round: 1 });
  assert.equal(ctxNoStreak.same_signature_streak, undefined);
  assert.equal(ctxNoStreak.same_signature_hint, undefined);
  const ctxStreak1 = buildRepairContext({ source: 'green_gate', round: 1, sameSignatureStreak: 1 });
  assert.equal(ctxStreak1.same_signature_streak, undefined);
});

test('writeGreenGateResult：绿门失败落盘时新增 signature 字段，READY/FIXING 两路径共用同一函数（AC-003）', (t) => {
  const cfg = makeGreenGateCfg(t);
  const rec = writeGreenGateResult(cfg, 'task-x', 1, {
    command: 'npm test',
    exitCode: 1,
    timedOut: false,
    stdout: FAILING_STDOUT,
    stderr: '',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
  });
  assert.ok(rec.signature, '失败记录返回值应带 signature');
  assert.equal(typeof rec.signature.hash, 'string');
  assert.deepEqual(rec.signature.failingTests, ['foo.test.mjs :: some test']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(cfg.dossierDir, 'task-x', 'green-gate-r1.json'), 'utf8'));
  assert.ok(onDisk.signature, '落盘文件同样含 signature 字段');
  assert.equal(onDisk.signature.hash, rec.signature.hash);
});

test('writeGreenGateResult：绿门通过（exit 0）不写 signature', (t) => {
  const cfg = makeGreenGateCfg(t);
  const rec = writeGreenGateResult(cfg, 'task-x', 1, {
    command: 'npm test', exitCode: 0, timedOut: false, stdout: 'all good', stderr: '',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  });
  assert.equal(rec.signature, undefined);
  const onDisk = JSON.parse(fs.readFileSync(path.join(cfg.dossierDir, 'task-x', 'green-gate-r1.json'), 'utf8'));
  assert.equal(onDisk.signature, undefined);
});

test('readGreenGateSignatures：无 signature 字段的旧记录/缺失记录读取不报错，记为 undefined（AC-003）', (t) => {
  const cfg = makeGreenGateCfg(t);
  const dir = path.join(cfg.dossierDir, 'task-y');
  fs.mkdirSync(dir, { recursive: true });
  // round1：旧记录形态（迁移前落盘，无 signature 字段）
  fs.writeFileSync(path.join(dir, 'green-gate-r1.json'), JSON.stringify({ schema_version: 1, round: 1, exit_code: 1 }));
  // round2：新代码路径写入，含 signature
  writeGreenGateResult(cfg, 'task-y', 2, {
    command: 'npm test', exitCode: 1, timedOut: false, stdout: FAILING_STDOUT, stderr: '',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  });
  // round3：文件不存在
  const sigs = readGreenGateSignatures(cfg, 'task-y', 3);
  assert.equal(sigs.length, 3);
  assert.equal(sigs[0], undefined, '旧记录无 signature 字段 → undefined，不参与 streak');
  assert.equal(typeof sigs[1], 'string');
  assert.equal(sigs[2], undefined, '记录缺失 → undefined');
});
