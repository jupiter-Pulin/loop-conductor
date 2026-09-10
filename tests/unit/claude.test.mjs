import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs, parseClaudeJson, claudeBin, probeManagedClaudeBin, runClaudeStream,
  isTransientFailure, runClaudeWithRetry, setSleepFn, parseRateLimitEvent, isRateLimited,
} from '../../conductor/lib/claude.mjs';
import { loadCfg } from '../../conductor/conductor.mjs';
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
  // env/probeRoot 显式传入，不依赖真实机器的 PATH 或桌面 App 托管目录状态（AC-001/AC-002 的探测根目录可注入）。
  assert.equal(claudeBin({ env: { PATH: '' }, probeRoot: '/nonexistent-probe-root' }), 'claude');
  assert.equal(claudeBin({ env: { CLAUDE_BIN: '/tmp/fake-claude.mjs', PATH: '' } }), '/tmp/fake-claude.mjs');
});

/** 在临时目录下建一个可执行的 `<root>/<version>/claude.app/Contents/MacOS/claude`，返回其路径。 */
function makeManagedClaudeBin(root, version, { mtimeMs } = {}) {
  const binPath = path.join(root, version, 'claude.app', 'Contents', 'MacOS', 'claude');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  if (mtimeMs != null) {
    const t = mtimeMs / 1000;
    fs.utimesSync(binPath, t, t);
  }
  return binPath;
}

test('AC-001: probeManagedClaudeBin — 多版本按修改时间取最新可执行文件', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeManagedClaudeBin(root, '1.0.0', { mtimeMs: 1000 });
  const newer = makeManagedClaudeBin(root, '2.1.209', { mtimeMs: 2000 });
  assert.equal(probeManagedClaudeBin({ probeRoot: root }), newer);
});

test('AC-001: probeManagedClaudeBin — 探测根目录不存在或无可执行文件时返回 null', (t) => {
  assert.equal(probeManagedClaudeBin({ probeRoot: '/nonexistent-probe-root' }), null);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-empty-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  assert.equal(probeManagedClaudeBin({ probeRoot: emptyRoot }), null);
});

test('AC-001: claudeBin — 未设 CLAUDE_BIN 且 PATH 无 claude 时探测托管目录，命中返回绝对路径；全部落空回退字面 claude', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const newest = makeManagedClaudeBin(root, '2.0.0', { mtimeMs: 5000 });
  assert.equal(claudeBin({ env: { PATH: '' }, probeRoot: root }), newest);
  // 全部落空（无 CLAUDE_BIN、PATH 无 claude、托管目录不存在）→ 字面回退
  assert.equal(claudeBin({ env: { PATH: '' }, probeRoot: '/nonexistent-probe-root' }), 'claude');
});

test('AC-001: claudeBin — PATH 命中 claude 时优先于托管目录探测，直接回退字面 claude 交给 PATH 解析', (t) => {
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pathbin-'));
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-unused-'));
  t.after(() => {
    fs.rmSync(pathDir, { recursive: true, force: true });
    fs.rmSync(probeRoot, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(pathDir, 'claude'), '#!/bin/sh\necho fake\n', { mode: 0o755 });
  makeManagedClaudeBin(probeRoot, '9.9.9', { mtimeMs: 9000 }); // 即便托管目录也有更“新”的候选，也不应被探测到
  assert.equal(claudeBin({ env: { PATH: pathDir }, probeRoot }), 'claude');
});

test('AC-002: claudeBin — 显式 CLAUDE_BIN 优先级最高，不做任何探测（回归守卫）', () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-shadowed-'));
  try {
    makeManagedClaudeBin(probeRoot, '3.3.3', { mtimeMs: 3000 });
    assert.equal(
      claudeBin({ env: { CLAUDE_BIN: '/opt/fake/claude', PATH: '/some/dir' }, probeRoot }),
      '/opt/fake/claude',
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
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

test('H11: isTransientFailure — spawn 确定性 errno（EACCES/ENOENT/EPERM/ENOTDIR）判非瞬态，其余 spawn 错误仍瞬态', () => {
  // 确定性：二进制层面的死错误，重试必然同样失败
  assert.equal(isTransientFailure({ spawnError: true, error: 'Error: spawn EACCES', raw: null, exitCode: -1 }), false);
  assert.equal(isTransientFailure({ spawnError: true, error: 'Error: spawn /opt/x/claude ENOENT', raw: null, exitCode: -1 }), false);
  assert.equal(isTransientFailure({ spawnError: true, error: 'Error: spawn EPERM', raw: null, exitCode: -1 }), false);
  assert.equal(isTransientFailure({ spawnError: true, error: 'Error: spawn ENOTDIR', raw: null, exitCode: -1 }), false);
  // 非确定性 spawn 错误（EAGAIN/EMFILE 资源枯竭类、无错误文案）保持瞬态（回归守卫：line 134 旧断言不变）
  assert.equal(isTransientFailure({ spawnError: true, error: 'Error: spawn EAGAIN', raw: null, exitCode: -1 }), true);
  assert.equal(isTransientFailure({ spawnError: true, raw: null, exitCode: -1 }), true);
});

test('H11: 真实 spawn EACCES（二进制无执行位）→ 一次即返回，不吃退避阶梯', async (t) => {
  // 用一个无 +x 的文件当 CLAUDE_BIN：posix_spawn 报 EACCES（task-20260612-001 事故形态）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-eacces-'));
  const binPath = path.join(dir, 'not-executable.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', { mode: 0o644 });
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = binPath;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setSleepFn(() => { throw new Error('确定性 spawn 错误不得触发退避 sleep'); });
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, { retries: 6, backoffMs: [15000] });
  assert.equal(res.ok, false);
  assert.equal(res.spawnError, true);
  assert.match(String(res.error), /EACCES/);
  assert.equal(res.attempts.length, 1, '确定性 spawn 错误一次即返回');
  assert.ok(!res.retriesExhausted, '非瞬态路径不得标记 retriesExhausted');
});

// ---- AC-020：五小时 / 周限额（rejected rate_limit_event）→ 零重试短路 ----

test('AC-020: parseRateLimitEvent — 只认 rejected；camelCase 与 snake_case 都解析', () => {
  const real = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1788068400, rateLimitType: 'five_hour' },
  };
  assert.deepEqual(parseRateLimitEvent(real), { type: 'five_hour', resets_at: 1788068400, status: 'rejected' });
  assert.deepEqual(
    parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resets_at: 42, rate_limit_type: 'weekly' } }),
    { type: 'weekly', resets_at: 42, status: 'rejected' },
  );
  // allowed / 缺 info / 其他事件类型一律 null（allowed 是正常配额播报，绝不能当限额）
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } }), null);
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event' }), null);
  assert.equal(parseRateLimitEvent({ type: 'assistant' }), null);
  assert.equal(parseRateLimitEvent(null), null);
});

test('AC-020: runClaudeStream 从 stream 取出 rate_limit（type/resets_at/status）；无事件为 null', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { actions: [{ type: 'rateLimit', resets_at: 1788068400, rate_limit_type: 'five_hour' }] },
    { session_id: 's-ok', cost: 0.01, result: 'ok' },
  ]);

  const limited = await runClaudeStream({ prompt: 'x', cwd: dir, maxTurns: 5 });
  assert.equal(limited.ok, false);
  assert.deepEqual(limited.rate_limit, { type: 'five_hour', resets_at: 1788068400, status: 'rejected' });

  const normal = await runClaudeStream({ prompt: 'x', cwd: dir, maxTurns: 5 });
  assert.equal(normal.ok, true, normal.error);
  assert.equal(normal.rate_limit, null, '无 rate_limit_event 时字段为 null');
});

test('AC-020: runClaudeWithRetry 遇 rejected rate_limit → 零重试、rate_limited:true、不吃退避', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { actions: [{ type: 'rateLimit', resets_at: 1788068400, rate_limit_type: 'five_hour' }] },
    { session_id: 's-ok', cost: 0.01, result: '不应被调用到' },
  ]);
  const retryLog = [];
  setSleepFn(() => { throw new Error('限额不得触发退避 sleep'); });
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, {
    retries: 6,
    backoffMs: [0],
    onRetry: (info) => retryLog.push(info),
  });

  assert.equal(res.ok, false);
  assert.equal(res.rate_limited, true);
  assert.equal(res.retriesExhausted, undefined, '限额不是瞬态耗尽');
  assert.deepEqual(res.rate_limit, { type: 'five_hour', resets_at: 1788068400, status: 'rejected' });
  assert.equal(res.attempts.length, 1, '限额一次即返回');
  assert.equal(res.attempts[0].transient, false, '限额不得被记成瞬态');
  assert.equal(res.attempts[0].rate_limited, true);
  assert.equal(retryLog.length, 0, '不得触发 onRetry');
});

test('AC-020: isRateLimited 覆盖 rate_limited 标记与裸 rate_limit 两种形态', () => {
  assert.equal(isRateLimited({ rate_limited: true }), true);
  assert.equal(isRateLimited({ rate_limit: { status: 'rejected', resets_at: 1, type: 'five_hour' } }), true);
  assert.equal(isRateLimited({ rate_limit: null }), false);
  assert.equal(isRateLimited({ rate_limit: { status: 'allowed' } }), false);
  assert.equal(isRateLimited({ ok: true }), false);
  assert.equal(isRateLimited(null), false);
});

test('AC-020: 其余瞬态退避阶梯为 15s / 30s / 60s 三档（末档重复，不再有 2min/5min/10min 长尾）', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    { exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 },
  ]);
  const slept = [];
  setSleepFn((ms) => { slept.push(ms); });
  t.after(() => setSleepFn(null));

  // 不传 backoffMs → 走 DEFAULT_BACKOFF_MS
  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5 }, { retries: 4 });
  assert.equal(res.retriesExhausted, true);
  assert.deepEqual(slept, [15000, 30000, 60000, 60000], '三档阶梯，超出后停在末档');
});

test('AC-020: loadCfg 默认 spawnBackoffMs 为三档 15/30/60', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadCfg(root).spawnBackoffMs, [15000, 30000, 60000]);
});
