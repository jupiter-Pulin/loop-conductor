// lib/claude.mjs — claude CLI 调用的唯一封装点。
// flag / JSON schema 漂移只改这里；CLAUDE_BIN 环境变量是 fake-claude 测试的挂载点。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const STREAM_PARSE_ERROR =
  'claude stream-json parse failed; ensure Claude CLI supports --output-format stream-json --verbose';

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathHasClaude(env) {
  const pathEnv = env.PATH ?? '';
  return pathEnv.split(path.delimiter).filter(Boolean).some((dir) => isExecutableFile(path.join(dir, 'claude')));
}

/**
 * 桌面 App 托管目录（`<probeRoot>/<版本号>/claude.app/Contents/MacOS/claude`）内
 * 按修改时间探测最新版本的 claude 二进制；探测根目录可注入（单测用）。落空返回 null。
 */
export function probeManagedClaudeBin({ probeRoot, homeDir = os.homedir() } = {}) {
  const root = probeRoot ?? path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude-code');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestMtimeMs = -Infinity;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, 'claude.app', 'Contents', 'MacOS', 'claude');
    if (!isExecutableFile(candidate)) continue;
    const mtimeMs = fs.statSync(candidate).mtimeMs;
    if (mtimeMs > bestMtimeMs) {
      bestMtimeMs = mtimeMs;
      best = candidate;
    }
  }
  return best;
}

/**
 * claude 二进制解析：CLAUDE_BIN 环境变量 > PATH > 桌面 App 托管目录 > 字面回退 'claude'。
 * env/probeRoot 可注入（单测用）；生产调用（runClaudeStream）不传参，用 process.env 与真实 homedir。
 */
export function claudeBin({ env = process.env, probeRoot } = {}) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (pathHasClaude(env)) return 'claude';
  return probeManagedClaudeBin({ probeRoot, homeDir: env.HOME }) ?? 'claude';
}

/**
 * 纯函数：拼装 claude CLI 参数（可单测）。
 * tools = 工具集硬限制（--tools，spec §2/§3.3）；allowedTools = 免审批放行（--allowedTools）。
 * 两者语义不同：--tools 决定 agent 能看见哪些工具，--allowedTools 决定哪些调用免人工审批。
 */
export function buildClaudeArgs({
  resume = null,
  outputFormat = 'stream-json',
  maxTurns = null,
  tools = null,
  allowedTools = null,
  permissionMode = null,
  model = null,
  settings = null,
}) {
  const args = [];
  if (resume) args.push('-r', String(resume));
  args.push('-p', '--output-format', outputFormat); // prompt 正文不进 argv，改由 runClaudeStream 写子进程 stdin（避免超长 diff 撑爆 MAX_ARG_STRLEN）
  if (outputFormat === 'stream-json') args.push('--verbose');
  if (maxTurns != null) args.push('--max-turns', String(maxTurns));
  if (tools && tools.length > 0) args.push('--tools', tools.join(','));
  if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (settings) args.push('--settings', String(settings)); // 逐角色 hook 护栏（conductor 生成，不依赖 target 仓库自带设置）
  return args;
}

/** 解析 `--output-format json` 的 stdout；解析不出返回 null。 */
export function parseClaudeJson(stdout) {
  const t = String(stdout ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 容忍前置噪音：找最后一行 JSON */ }
  const line = t.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try { return JSON.parse(line.trim()); } catch { return null; }
}

/**
 * 异步 stream-json spawn 一次 claude（冷启动或 -r 续会话）。
 * 返回 { ok, exitCode, sessionId, costUsd, result, raw, error?, killed? }。
 * 永不抛错：调用方按 ok 分支（resume 失败要降级冷启动）。
 */
export function runClaudeStream(opts) {
  const args = buildClaudeArgs(opts);
  const inactivityTimeoutMs = Number(opts.inactivityTimeoutMs) || 600_000;
  const wallClockMs = Number(opts.wallClockMs) || 14_400_000;
  const killGraceMs = Number(opts.killGraceMs) || 10_000;
  if (opts.streamFile) fs.mkdirSync(path.dirname(opts.streamFile), { recursive: true });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin(), args, {
        cwd: opts.cwd,
        env: process.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false, exitCode: -1, sessionId: null, costUsd: 0, result: null, raw: null,
        error: String(err), spawnError: true, killed: null, costUnknown: true,
      });
      return;
    }
    child.stdin.on('error', () => { /* 子进程未消费即退出（如启动失败）时忽略 EPIPE */ });
    child.stdin.write(String(opts.prompt ?? ''));
    child.stdin.end();

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBuffered = '';
    let parsedAny = false;
    let resultEvent = null;
    let lastEvent = null;
    let parseError = null;
    let killed = null;
    let closed = false;
    let forceTimer = null;

    const appendStreamLine = (line) => {
      if (!opts.streamFile) return;
      fs.appendFileSync(opts.streamFile, `${line}\n`);
    };

    const killGroup = (reason) => {
      if (closed || killed) return;
      killed = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process may already have exited */ }
      forceTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      forceTimer.unref?.();
    };

    let inactivityTimer = null;
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => killGroup('inactivity'), inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };
    resetInactivity();
    const wallTimer = setTimeout(() => killGroup('wall_clock'), wallClockMs);
    wallTimer.unref?.();

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      appendStreamLine(trimmed);
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parseError = STREAM_PARSE_ERROR;
        if (!parsedAny) killGroup('stream_parse_error');
        return;
      }
      parsedAny = true;
      lastEvent = parsed;
      if (parsed.type === 'result' || parsed.subtype === 'success' || typeof parsed.result === 'string') {
        resultEvent = parsed;
      }
    };

    child.stdout.on('data', (chunk) => {
      resetInactivity();
      if (Buffer.concat(stdoutChunks).length < MAX_BUFFER) stdoutChunks.push(Buffer.from(chunk));
      stdoutBuffered += chunk.toString('utf8');
      const lines = stdoutBuffered.split(/\r?\n/);
      stdoutBuffered = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });

    child.stderr.on('data', (chunk) => {
      resetInactivity();
      if (Buffer.concat(stderrChunks).length < MAX_BUFFER) stderrChunks.push(Buffer.from(chunk));
    });

    child.on('error', (err) => {
      closed = true;
      clearTimeout(inactivityTimer);
      clearTimeout(wallTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        ok: false, exitCode: -1, sessionId: null, costUsd: 0, result: null, raw: null,
        error: String(err), spawnError: true, killed: null, costUnknown: true,
      });
    });

    child.on('close', (code) => {
      closed = true;
      clearTimeout(inactivityTimer);
      clearTimeout(wallTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (stdoutBuffered.trim()) consumeLine(stdoutBuffered);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const raw = resultEvent ?? lastEvent;
      const sessionId = raw?.session_id ?? lastEvent?.session_id ?? null;
      const costUnknown = Boolean(killed) || resultEvent == null;
      const costUsd = !costUnknown && typeof raw?.total_cost_usd === 'number' ? raw.total_cost_usd : 0;
      const result = typeof raw?.result === 'string' ? raw.result : null;
      const exitCode = killed ? null : code ?? -1;
      if (killed && killed === 'stream_parse_error') killed = null;
      if (code !== 0 || raw === null || parseError || costUnknown) {
        const baseError = parseError ?? (stderr.trim() || `claude exited ${exitCode ?? 'killed'} with no result event`);
        resolve({
          ok: false,
          exitCode,
          sessionId,
          costUsd,
          result,
          raw,
          error: baseError,
          killed,
          costUnknown,
          stdout,
          stderr,
        });
        return;
      }
      resolve({ ok: true, exitCode: 0, sessionId, costUsd, result: result ?? '', raw, killed: null, costUnknown: false });
    });
  });
}

export const runClaude = runClaudeStream;

// ---- 瞬态故障重试（API 不稳定：403/408/429/5xx 或 spawn 本身失败时退避重试，能续会话就续）。

// 尾部 300s/600s：dossier 证据（task-20260706-001）显示 4 连 429 在 3.75min 阶梯内穿不过
// 限流窗口，收箱后人工 retry 一次即过——长尾退避把这类失败变成自愈。
const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000, 600000];
const TRANSIENT_STATUSES = new Set([403, 408, 429, 500, 502, 503, 529]);
// spawn 层确定性 errno：二进制不可执行/不存在/权限问题，重试必然同样失败——
// 退避阶梯加长后误判为瞬态的代价升至 ~18.75min（task-20260612-001 EACCES 即此类）。
const DETERMINISTIC_SPAWN_ERRNO = /\b(EACCES|ENOENT|EPERM|ENOTDIR)\b/;
const RESUME_PROMPT = '上一条请求被瞬态错误打断，请从中断处继续完成原任务';

/** 异步 sleep；测试经 setSleepFn 注入空函数。 */
async function defaultSleep(ms) {
  if (!(ms > 0)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let sleepFn = defaultSleep;

export function setSleepFn(fn) {
  sleepFn = fn ?? defaultSleep;
}

/**
 * spawn 层确定性系统错误（EACCES/ENOENT/EPERM/ENOTDIR，二进制层面的死错误）：进程从未
 * 启动，零 API 消费。isTransientFailure 与 accountSpawnCost（H20 估价，避免把这类失败
 * 按历史均价虚增成本）共用同一判定，防止两处漂移。
 */
export function isDeterministicSpawnFailure(res) {
  return Boolean(res?.spawnError) && DETERMINISTIC_SPAWN_ERRNO.test(String(res?.error ?? ''));
}

/**
 * 瞬态判定：API 错误状态码命中名单、spawn 自身报错、被杀，或「不透明退出失败」
 * ——CLI 非零退出且无可解析 result 事件（raw==null，从而也读不到 api_error_status）。
 * 拿不到状态码时无法区分真是瞬态还是硬错误，按疑似瞬态给一次重试机会；
 * 带可读 api_error_status 的硬错误（如 400/404）不受影响，仍判非瞬态。
 * 例外：spawn 报确定性 errno（EACCES/ENOENT/EPERM/ENOTDIR，二进制层面的死错误）
 * 判非瞬态——重试必然同样失败，只会白等整条退避阶梯。
 */
export function isTransientFailure(res) {
  if (res?.spawnError) return !isDeterministicSpawnFailure(res);
  if (res?.killed) return true;
  if (res?.raw == null && res?.exitCode !== 0) return true;
  return res?.raw?.is_error === true && TRANSIENT_STATUSES.has(res.raw?.api_error_status);
}

/**
 * runClaude 外包一层瞬态重试。非瞬态或成功 → 原样返回；瞬态 → 退避后重试。
 * 续接优先：上次失败带 session_id 且 num_turns>1 时改为 -r 续会话（保留原 maxTurns / output-format）；
 * num_turns<=1 原样重发。resume 再瞬态失败可继续 resume（始终以最近一次失败的 session 为准）。
 * 返回值附加 attempts: [{attempt, transient, api_error_status, session_id, cost_usd}]，
 * costUsd 为所有尝试累计。耗尽时 ok 强制 false 并带 retriesExhausted 标记。
 */
export async function runClaudeWithRetry(callOpts, {
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  onRetry = null,
} = {}) {
  const attempts = [];
  let totalCost = 0;
  let anyCostUnknown = false;
  let current = { ...callOpts };
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await runClaude(current);
    totalCost += res.costUsd ?? 0;
    if (res.costUnknown) anyCostUnknown = true;
    const transient = isTransientFailure(res);
    const status = res.raw?.api_error_status ?? null;
    attempts.push({
      attempt,
      transient,
      api_error_status: status,
      session_id: res.raw?.session_id ?? res.sessionId ?? null,
      cost_usd: res.costUsd ?? 0,
      killed: res.killed ?? null,
      cost_unknown: res.costUnknown === true,
    });
    if (!transient) break; // 成功或非瞬态失败 → 原样返回
    if (attempt > retries) {
      res = {
        ...res,
        ok: false,
        retriesExhausted: true,
        error: res.error ?? `transient failure (api_error_status=${status ?? 'spawn error'}), retries exhausted after ${attempt} attempts`,
      };
      break;
    }
    if (onRetry) onRetry({ attempt: attempt + 1, status, sessionId: res.raw?.session_id ?? null, killed: res.killed ?? null });
    await sleepFn(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
    if (res.raw?.session_id && (res.raw?.num_turns ?? 0) > 1) {
      // 已有实质进展：改 resume 续会话，提示从中断处继续（其余 flag 不变）
      current = { ...current, resume: res.raw.session_id, prompt: RESUME_PROMPT };
    }
    // 否则原样重发 current（可能本身已是上一轮的 resume 调用）
  }
  return { ...res, costUsd: Math.round(totalCost * 1e6) / 1e6, costUnknown: anyCostUnknown || res.costUnknown === true, attempts };
}
