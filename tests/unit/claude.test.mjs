import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs, parseClaudeJson, claudeBin, runClaudeStream,
  isTransientFailure, runClaudeWithRetry, setSleepFn,
} from '../../conductor/lib/claude.mjs';
import { FAKE_CLAUDE } from '../helpers/env.mjs';

/** 起一个临时目录 + fake-claude 剧本，注入 CLAUDE_BIN，返回 { dir, scenarioPath }；t.after 自动还原环境与清理。 */
function makeFakeClaudeDir(t, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-unit-'));
  const scenarioPath = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify(steps));
  const prevEnv = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_SCRIPT: process.env.FAKE_CLAUDE_SCRIPT,
    FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  };
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_SCRIPT = scenarioPath;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

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

test('AC-001: isTransientFailure — 不透明退出失败（非零退出/被杀 + raw==null + 无 api_error_status）判定为瞬态', () => {
  // 非零退出 + 无 result 事件（raw==null）→ 疑似瞬态
  assert.equal(isTransientFailure({ ok: false, exitCode: 1, raw: null, killed: null }), true);
  assert.equal(isTransientFailure({ ok: false, exitCode: -1, raw: null, killed: null }), true);
  // 边界：exit 0 且 raw==null 不属于 AC-001 定义的「非零退出或被杀」范围，不应命中新分支
  assert.equal(isTransientFailure({ ok: true, exitCode: 0, raw: null, killed: null }), false);
  // 既有分类不变：spawnError / killed / 瞬态状态码
  assert.equal(isTransientFailure({ spawnError: true, raw: null, exitCode: -1 }), true);
  assert.equal(isTransientFailure({ killed: 'inactivity', raw: null, exitCode: null }), true);
  assert.equal(isTransientFailure({ ok: true, exitCode: 0, raw: { is_error: true, api_error_status: 429 } }), true);
  assert.equal(isTransientFailure({ ok: true, exitCode: 0, raw: { is_error: true, api_error_status: 503 } }), true);
});

test('AC-003: isTransientFailure — 非瞬态可读硬错误（400/404）仍返回 false（回归守卫）', () => {
  assert.equal(isTransientFailure({ ok: true, exitCode: 0, raw: { is_error: true, api_error_status: 400 } }), false);
  assert.equal(isTransientFailure({ ok: true, exitCode: 0, raw: { is_error: true, api_error_status: 404 } }), false);
});

test('AC-002: runClaudeWithRetry 对不透明退出失败按 retries 上限重试；中途成功即停止', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { exitCode: 1 }, // attempt1：不透明失败
    { exitCode: 1 }, // attempt2：不透明失败（重试）
    { session_id: 's-ok', cost: 0.02, result: 'done' }, // attempt3：成功
  ]);
  const retryLog = [];
  setSleepFn(() => {}); // 跳过真实退避
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, {
    retries: 4,
    backoffMs: [0],
    onRetry: (info) => retryLog.push(info),
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.sessionId, 's-ok');
  assert.equal(res.attempts.length, 3, '2 次不透明失败 + 1 次成功');
  assert.equal(res.attempts[0].transient, true);
  assert.equal(res.attempts[1].transient, true);
  assert.equal(res.attempts[2].transient, false);
  assert.equal(retryLog.length, 2, 'onRetry 应恰好调用 2 次（每次失败后触发一次）');
});

test('AC-002: 连续不透明退出失败达 retries 上限 → retriesExhausted:true', async (t) => {
  const dir = makeFakeClaudeDir(t, [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }]);
  setSleepFn(() => {});
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, { retries: 2, backoffMs: [0] });
  assert.equal(res.ok, false);
  assert.equal(res.retriesExhausted, true);
  assert.equal(res.attempts.length, 3, 'retries=2 → 共 3 次尝试后耗尽');
  assert.ok(res.attempts.every((a) => a.transient === true));
});

test('AC-003: 非瞬态硬错误（api_error_status=400）不被重试 —— 一次即返回、无退避（回归守卫）', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { cost: 0.01, extra: { is_error: true, api_error_status: 400, num_turns: 1 } },
    { cost: 0.01, result: '不应被调用到' }, // 若误重试会消费到这一步，断言会因 attempts.length 不符而失败
  ]);
  const retryLog = [];
  setSleepFn(() => { throw new Error('不应发生退避 sleep'); });
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, {
    retries: 4,
    backoffMs: [0],
    onRetry: (info) => retryLog.push(info),
  });

  assert.equal(res.attempts.length, 1, '非瞬态硬错误一次即返回，不重试');
  assert.equal(res.attempts[0].transient, false);
  assert.equal(retryLog.length, 0, '不得触发 onRetry');
});

test('AC-006: runClaudeStream 失败时 stderr/error 捞到 CLI 实际 stderr；无 stderr 时退回默认文案', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { exitCode: 1, stderr: 'boom: real stderr content' },
    { exitCode: 1, stderr: '' }, // 无 stderr（fake-claude 缺省会自己写一句诊断，显式传空串抑制）
  ]);

  const withStderr = await runClaudeStream({ prompt: 'x', cwd: dir, maxTurns: 5 });
  assert.ok(withStderr.stderr.includes('boom: real stderr content'), 'res.stderr 应捞到 CLI 实际 stderr');
  assert.ok(withStderr.error.includes('boom: real stderr content'), 'res.error 应捞到 CLI 实际 stderr');

  const noStderr = await runClaudeStream({ prompt: 'x', cwd: dir, maxTurns: 5 });
  assert.match(noStderr.error, /exited \d+ with no result event/, '无 stderr 时退回默认文案');
});
