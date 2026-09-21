import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs, parseClaudeJson, claudeBin, probeManagedClaudeBin, runClaudeStream,
  isTransientFailure, runClaudeWithRetry, setSleepFn, parseRateLimitEvent, isRateLimited,
  activeChildPids, killAllActive,
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

/**
 * 打开 fake-claude 的调用日志（makeFakeClaudeDir 默认把它关掉）并返回读取函数。
 * 「没有重试」这类否定命题只能靠真实 spawn 次数坐实——光看 attempts 数组是自证。
 * 环境变量由 makeFakeClaudeDir 的 t.after 统一还原，这里不另加钩子。
 */
function captureCalls(dir) {
  const logPath = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = logPath;
  return () => (fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
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

// ---- 停止控制：`conductor stop` / SIGINT 收割在飞 agent，绝不当故障重试 ----

test('停止: isTransientFailure — killed=stopped 判非瞬态（人要求停下不是网络抖动）', () => {
  assert.equal(isTransientFailure({ killed: 'stopped' }), false);
  // 真实停止形态：被杀没有退出码（exitCode=null）、也来不及有 result 事件（raw=null）。
  // 这恰好命中「不透明退出失败」的形状（raw==null 且 exitCode!==0），必须被 stopped 分支先截住——
  // 否则 killAllActive 收割完，重试逻辑会把每个 agent 原地再拉起来一次，停止等于没停。
  assert.equal(isTransientFailure({ ok: false, killed: 'stopped', raw: null, exitCode: null, costUnknown: true }), false);
  // 对照：同样是被杀，但原因是卡死/超时 → 仍是瞬态，该重试
  assert.equal(isTransientFailure({ ok: false, killed: 'inactivity', raw: null, exitCode: null }), true);
  assert.equal(isTransientFailure({ ok: false, killed: 'wall_clock', raw: null, exitCode: null }), true);
});

test('停止: activeChildPids 登记在飞子进程，killAllActive 收割并在 close 后注销（不泄漏）', async (t) => {
  const dir = makeFakeClaudeDir(t, [{ hang: true }]); // 只读 stdin 然后永远挂住：模拟正在干活的 agent
  assert.deepEqual(activeChildPids(), [], '本用例开始前登记表必须是空的（前面的用例都已收干净）');

  let spawnedPid = null;
  // killGraceMs 调小：detached 子进程 setsid 与父进程发信号之间有微小竞态窗口，
  // 万一首发 SIGTERM 撞上空进程组，宽限期后的 SIGKILL 兜底，不拖慢用例。
  const pending = runClaudeStream({
    prompt: 'x', cwd: dir, maxTurns: 5, killGraceMs: 150,
    onSpawn: ({ pid }) => { spawnedPid = pid; },
  });
  t.after(() => { // 兜底：收割逻辑若失灵，绝不把 fake-claude 留在机器上
    if (!Number.isInteger(spawnedPid)) return;
    try { process.kill(-spawnedPid, 'SIGKILL'); } catch { /* 已退出 */ }
    try { process.kill(spawnedPid, 'SIGKILL'); } catch { /* 已退出 */ }
  });

  assert.equal(Number.isInteger(spawnedPid), true, 'onSpawn 同步交出 pid（崩溃恢复靠它找回残留进程组）');
  const inflight = activeChildPids();
  assert.deepEqual(inflight, [spawnedPid], '在飞进程必须登记，否则 stop 收割不到它，它会活过 runner');

  assert.equal(killAllActive('stopped'), inflight.length, 'killAllActive 返回收割的进程数');

  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.killed, 'stopped', '被收割的子进程以 killed=stopped 正常返回，内核照常留档');
  assert.equal(res.exitCode, null, '被杀没有退出码');
  assert.equal(res.costUnknown, true, '没有 result 事件 → 花费未知，不得按 0 入账');
  assert.equal(isTransientFailure(res), false, '端到端：收割结果不得被重试');
  assert.deepEqual(activeChildPids(), [], 'close 之后必须从登记表注销，否则下一次 stop 会对死 pid 发信号');
  assert.equal(killAllActive('stopped'), 0, '空表收割返回 0 且不抛错');
});

// ---- resume 失效：死 session 重试 N 次只会白烧预算，必须一次就交回调用方降级冷启动 ----

test('resume: 调用方续会话首次失败且 num_turns<=1 → resumeFailed 且零重试（真实 spawn 次数为证）', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    // 死 session 的真实形态：CLI 直接非零退出，连一条 result 事件都没有（raw=null → num_turns 读作 0）
    { exitCode: 1, stderr: 'No conversation found with session ID: dead-session' },
    { session_id: 's-never', cost: 0.01, result: '不应被调用到' }, // 误重试会消费到这一步
  ]);
  const calls = captureCalls(dir);
  const retryLog = [];
  setSleepFn(() => { throw new Error('resume 失效不得触发退避 sleep'); });
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5, resume: 'dead-session' }, {
    retries: 6,
    backoffMs: [0],
    onRetry: (info) => retryLog.push(info),
  });

  assert.equal(res.ok, false);
  assert.equal(res.resumeFailed, true, '交回调用方降级冷启动，而不是原地重试同一个死 session');
  assert.equal(res.retriesExhausted, undefined, 'resume 失效不是瞬态耗尽，不该按耗尽收箱');
  assert.equal(res.rate_limited, undefined);
  assert.match(String(res.error), /No conversation found/, 'CLI 的原因要保留到 error，人才看得懂为什么降级');
  assert.deepEqual(res.attempts, [{
    attempt: 1, transient: false, api_error_status: null, session_id: null,
    cost_usd: 0, killed: null, cost_unknown: true, resume_failed: true,
  }], '只记一次尝试，且明确标 resume_failed（dossier-stats 按它统计 cold-degraded）');
  assert.equal(retryLog.length, 0, '不得触发 onRetry');

  // 「没有重试」由真实 spawn 次数坐实：retries=6 的预算一次都不许花在死 session 上
  const log = calls();
  assert.equal(log.length, 1, '死 session 只许 spawn 一次');
  assert.deepEqual(log[0].argv.slice(0, 2), ['-r', 'dead-session']);
});

test('resume 边界: 首次失败但 num_turns>1（会话已有实质进展）→ 不是 resumeFailed，照常瞬态重试续会话', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    // 有进展的失败：result 事件带 num_turns=5 + 可重试状态码 503
    { session_id: 'sess-live', cost: 0.01, extra: { is_error: true, api_error_status: 503, num_turns: 5 } },
    { session_id: 'sess-live', cost: 0.02, result: 'done' },
  ]);
  const calls = captureCalls(dir);
  setSleepFn(() => {});
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5, resume: 'sess-orig' }, {
    retries: 3, backoffMs: [0],
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.resumeFailed, undefined, '有进展 ≠ session 失效：降级冷启动会白扔掉这 5 轮工作');
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0].transient, true);
  assert.equal(res.attempts[0].api_error_status, 503);
  assert.equal(res.costUsd, 0.03, '两次尝试的花费都要累计入账');

  const log = calls();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].argv.slice(0, 2), ['-r', 'sess-orig'], '第一次续调用方给的 session');
  assert.deepEqual(log[1].argv.slice(0, 2), ['-r', 'sess-live'], '重试续最近一次失败的 session');
  assert.match(log[1].prompt, /从中断处继续/, '续接提示词换成「从中断处继续」，不重发原 prompt');
});

test('resume 边界: 首次撞限额（num_turns=1）→ 记 rate_limited 而非 resumeFailed', async (t) => {
  const dir = makeFakeClaudeDir(t, [
    // 限额的 result 事件 num_turns=1，形状与死 session 极像：若少了 rate_limit 判定就会被误标成
    // resume 失效 → 调用方降级冷启动 → 冷启动再撞同一堵墙，白烧一整轮上下文。
    { actions: [{ type: 'rateLimit', resets_at: 1788068400, rate_limit_type: 'five_hour' }] },
    { session_id: 's-never', cost: 0.01, result: '不应被调用到' },
  ]);
  const calls = captureCalls(dir);
  setSleepFn(() => { throw new Error('限额不得触发退避 sleep'); });
  t.after(() => setSleepFn(null));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: dir, maxTurns: 5, resume: 'sess-limited' }, {
    retries: 6, backoffMs: [0],
  });

  assert.equal(res.ok, false);
  assert.equal(res.rate_limited, true);
  assert.equal(res.resumeFailed, undefined, '限额不是 session 失效，session 本身还好好的');
  assert.deepEqual(res.rate_limit, { type: 'five_hour', resets_at: 1788068400, status: 'rejected' });
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0].rate_limited, true);
  assert.equal(res.attempts[0].resume_failed, undefined);
  assert.equal(calls().length, 1, '限额同样一次即返回');
});
