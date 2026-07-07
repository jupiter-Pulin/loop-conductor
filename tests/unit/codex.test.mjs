// 单元：codex.mjs adapter —— 参数拼装不变量 + 真实 spawn 行为（用 fake-codex）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexExecArgs, runCodexExec, codexBin } from '../../conductor/lib/codex.mjs';

const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-codex.mjs');

test('buildCodexExecArgs：恒定 --json/--color never/--skip-git-repo-check/-s + stdin 哨兵结尾', () => {
  const args = buildCodexExecArgs({ cwd: '/wt', model: 'gpt-5.2', outputLastMessage: '/tmp/o.txt' });
  assert.deepEqual(args, ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-s', 'read-only', '-C', '/wt', '-m', 'gpt-5.2', '-o', '/tmp/o.txt', '-']);
  const minimal = buildCodexExecArgs({});
  assert.equal(minimal[minimal.length - 1], '-', 'prompt 恒走 stdin');
  assert.ok(!minimal.includes('-m'), '无 model 不传 -m');
});

test('runCodexExec：读 -o 最终回复 + 捞 usage + 事件流落盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-unit-'));
  const scenario = path.join(dir, 's.json');
  fs.writeFileSync(scenario, JSON.stringify([{ lastMessage: '{"hello":1}' }]));
  const prev = { CODEX_BIN: process.env.CODEX_BIN, FAKE_CODEX_SCRIPT: process.env.FAKE_CODEX_SCRIPT };
  process.env.CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_SCRIPT = scenario;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await runCodexExec({
    prompt: 'x', cwd: dir,
    outputLastMessage: path.join(dir, 'last.txt'),
    streamFile: path.join(dir, 'stream.jsonl'),
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.result, '{"hello":1}');
  assert.equal(res.usage.input_tokens, 1000, 'usage 从 JSONL 事件捞取');
  assert.ok(fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').includes('turn.completed'));
  assert.ok(res.durationMs >= 0);
});

test('runCodexExec：二进制不存在 → spawnError 兜底不抛', async () => {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = '/nonexistent/codex-not-here';
  try {
    const res = await runCodexExec({ prompt: 'x', cwd: os.tmpdir(), outputLastMessage: path.join(os.tmpdir(), 'never.txt') });
    assert.equal(res.ok, false);
    assert.equal(res.spawnError, true);
    assert.match(String(res.error), /ENOENT/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prev;
  }
});

test('codexBin：CODEX_BIN 覆盖，缺省 codex', () => {
  const prev = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_BIN;
    assert.equal(codexBin(), 'codex');
    process.env.CODEX_BIN = '/x/fake';
    assert.equal(codexBin(), '/x/fake');
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prev;
  }
});
