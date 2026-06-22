// lib/claude.mjs — claude CLI 调用的唯一封装点。
// flag / JSON schema 漂移只改这里；CLAUDE_BIN 环境变量是 fake-claude 测试的挂载点。
import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024;

export function claudeBin() {
  return process.env.CLAUDE_BIN || 'claude';
}

/**
 * 纯函数：拼装 claude CLI 参数（可单测）。
 * tools = 工具集硬限制（--tools，spec §2/§3.3）；allowedTools = 免审批放行（--allowedTools）。
 * 两者语义不同：--tools 决定 agent 能看见哪些工具，--allowedTools 决定哪些调用免人工审批。
 */
export function buildClaudeArgs({
  prompt,
  resume = null,
  outputFormat = 'json',
  maxTurns = null,
  tools = null,
  allowedTools = null,
  permissionMode = null,
  model = null,
}) {
  const args = [];
  if (resume) args.push('-r', String(resume));
  args.push('-p', prompt, '--output-format', outputFormat);
  if (maxTurns != null) args.push('--max-turns', String(maxTurns));
  if (tools && tools.length > 0) args.push('--tools', tools.join(','));
  if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
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
 * 同步 spawn 一次 claude（冷启动或 -r 续会话）。
 * 返回 { ok, exitCode, sessionId, costUsd, result, raw, error? }。
 * 永不抛错：调用方按 ok 分支（resume 失败要降级冷启动）。
 */
export function runClaude(opts) {
  const args = buildClaudeArgs(opts);
  const res = spawnSync(claudeBin(), args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  if (res.error) {
    return { ok: false, exitCode: -1, sessionId: null, costUsd: 0, result: null, raw: null, error: String(res.error), spawnError: true };
  }
  const raw = parseClaudeJson(res.stdout);
  const sessionId = raw?.session_id ?? null;
  const costUsd = typeof raw?.total_cost_usd === 'number' ? raw.total_cost_usd : 0;
  const result = typeof raw?.result === 'string' ? raw.result : null;
  if (res.status !== 0 || raw === null) {
    const error = (res.stderr ?? '').trim() || `claude exited ${res.status} with unparsable output`;
    return { ok: false, exitCode: res.status ?? -1, sessionId, costUsd, result, raw, error };
  }
  return { ok: true, exitCode: 0, sessionId, costUsd, result: result ?? '', raw };
}

// ---- 瞬态故障重试（API 不稳定：403/408/429/5xx 或 spawn 本身失败时退避重试，能续会话就续）。

const DEFAULT_RETRIES = 4;
const DEFAULT_BACKOFF_MS = [15000, 30000, 60000, 120000];
const TRANSIENT_STATUSES = new Set([403, 408, 429, 500, 502, 503, 529]);
const RESUME_PROMPT = '上一条请求被瞬态错误打断，请从中断处继续完成原任务';

/** 同步 sleep（默认 Atomics.wait 忙等；测试经 setSleepFn 注入空函数）。 */
function defaultSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let sleepFn = defaultSleep;

export function setSleepFn(fn) {
  sleepFn = fn ?? defaultSleep;
}

/** 瞬态判定：API 错误状态码命中名单，或 spawnSync 自身报错。 */
export function isTransientFailure(res) {
  if (res?.spawnError) return true;
  return res?.raw?.is_error === true && TRANSIENT_STATUSES.has(res.raw?.api_error_status);
}

/**
 * runClaude 外包一层瞬态重试。非瞬态或成功 → 原样返回；瞬态 → 退避后重试。
 * 续接优先：上次失败带 session_id 且 num_turns>1 时改为 -r 续会话（保留原 maxTurns / output-format）；
 * num_turns<=1 原样重发。resume 再瞬态失败可继续 resume（始终以最近一次失败的 session 为准）。
 * 返回值附加 attempts: [{attempt, transient, api_error_status, session_id, cost_usd}]，
 * costUsd 为所有尝试累计。耗尽时 ok 强制 false 并带 retriesExhausted 标记。
 */
export function runClaudeWithRetry(callOpts, {
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  onRetry = null,
} = {}) {
  const attempts = [];
  let totalCost = 0;
  let current = { ...callOpts };
  let res;
  for (let attempt = 1; ; attempt++) {
    res = runClaude(current);
    totalCost += res.costUsd ?? 0;
    const transient = isTransientFailure(res);
    const status = res.raw?.api_error_status ?? null;
    attempts.push({
      attempt,
      transient,
      api_error_status: status,
      session_id: res.raw?.session_id ?? res.sessionId ?? null,
      cost_usd: res.costUsd ?? 0,
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
    if (onRetry) onRetry({ attempt: attempt + 1, status, sessionId: res.raw?.session_id ?? null });
    sleepFn(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0);
    if (res.raw?.session_id && (res.raw?.num_turns ?? 0) > 1) {
      // 已有实质进展：改 resume 续会话，提示从中断处继续（其余 flag 不变）
      current = { ...current, resume: res.raw.session_id, prompt: RESUME_PROMPT };
    }
    // 否则原样重发 current（可能本身已是上一轮的 resume 调用）
  }
  return { ...res, costUsd: Math.round(totalCost * 1e6) / 1e6, attempts };
}
