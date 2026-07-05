import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs, parseClaudeJson, claudeBin, runClaudeStream } from '../../conductor/lib/claude.mjs';
import { FAKE_CLAUDE } from '../helpers/env.mjs';

test('buildClaudeArgs：冷启动（prompt 不进 argv，走 stdin）', () => {
  const args = buildClaudeArgs({ prompt: 'do it', maxTurns: 30 });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '30']);
});

test('buildClaudeArgs：resume 带 -r 前置', () => {
  const args = buildClaudeArgs({ prompt: 'fix', resume: 'sess-1', maxTurns: 5 });
  assert.deepEqual(args.slice(0, 2), ['-r', 'sess-1']);
  assert.ok(args.includes('-p'));
});

test('buildClaudeArgs：allowedTools / permission-mode / model', () => {
  const args = buildClaudeArgs({
    prompt: 'x',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)'],
    permissionMode: 'acceptEdits',
    model: 'claude-test',
  });
  const at = args[args.indexOf('--allowedTools') + 1];
  assert.equal(at, 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*)');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-test');
});

test('buildClaudeArgs：--tools 硬限制与 --allowedTools 免审批并行', () => {
  const args = buildClaudeArgs({
    prompt: 'x',
    tools: ['Read', 'Grep', 'Glob'],
    allowedTools: ['Read', 'Grep', 'Glob'],
  });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
  // 不传 tools 时不得出现 --tools（maker 全工具集）
  const makerArgs = buildClaudeArgs({ prompt: 'x', permissionMode: 'acceptEdits' });
  assert.equal(makerArgs.includes('--tools'), false);
});

test('parseClaudeJson：标准/带噪音/坏输出', () => {
  assert.deepEqual(parseClaudeJson('{"session_id":"s","total_cost_usd":0.1}'), { session_id: 's', total_cost_usd: 0.1 });
  // 前置噪音行 + 最后一行 JSON
  const noisy = 'warning: something\n{"session_id":"s2","result":"ok"}';
  assert.equal(parseClaudeJson(noisy).session_id, 's2');
  assert.equal(parseClaudeJson(''), null);
  assert.equal(parseClaudeJson('not json'), null);
  assert.equal(parseClaudeJson(null), null);
});

test('runClaudeStream：超长 prompt（≥300KB）经 stdin 传递，argv 不含 prompt 正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stdin-it-'));
  const scenarioPath = path.join(dir, 'scenario.json');
  const logPath = path.join(dir, 'log.jsonl');
  fs.writeFileSync(scenarioPath, JSON.stringify([{ session_id: 'sess-big', cost: 0.01, result: 'ok' }]));
  const bigPrompt = `${'A'.repeat(300 * 1024)}\n末尾标记END`;

  const prevEnv = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_SCRIPT: process.env.FAKE_CLAUDE_SCRIPT,
    FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  };
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_SCRIPT = scenarioPath;
  process.env.FAKE_CLAUDE_LOG = logPath;
  try {
    const res = await runClaudeStream({ prompt: bigPrompt, cwd: dir, maxTurns: 5 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.sessionId, 'sess-big');

    const call = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(call.prompt, bigPrompt, 'fake-claude 收到的 prompt 与发送内容完全一致');
    for (const a of call.argv) {
      assert.equal(a.includes('END'), false, 'argv 不含 prompt 正文');
      assert.ok(a.length < 1024, `argv 元素不应携带大段 prompt 正文：len=${a.length}`);
    }
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeBin：CLAUDE_BIN 环境变量覆盖（fake-claude 挂载点）', () => {
  const prev = process.env.CLAUDE_BIN;
  try {
    delete process.env.CLAUDE_BIN;
    assert.equal(claudeBin(), 'claude');
    process.env.CLAUDE_BIN = '/tmp/fake-claude.mjs';
    assert.equal(claudeBin(), '/tmp/fake-claude.mjs');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
  }
});
