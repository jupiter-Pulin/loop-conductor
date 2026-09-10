// lib/model-probe.mjs — 模型可用性探测（AC-052）。
//
// `run` 启动时对配置里每个尚未验证过的模型 id 做一次最小探测（`--max-turns 1`、无工具、
// 提示词「reply ok」）：模型 id 打错、没权限、被下线时，代价是 run 启动即停并列出 id，
// 而不是四个角色各自 spawn 失败、各烧一遍退避阶梯、把任务推进错误的分支。
//
// 缓存键 = 模型 id + claude 二进制版本：换了 CLI 版本要重探（可用模型集合随 CLI 变），
// 同一版本内一次探测终身有效。缓存落 `state/.model-probe.json`。
//
// 只缓存成功：失败的探测本来就会终止本次 run，把它写进缓存只会造成「模型恢复了但缓存
// 说它不可用」的死角，唯一出路是人手删文件。
//
// 探测器（runner）、claude 版本、时钟均可注入；生产默认走 lib/claude.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeBin, isRateLimited, runClaudeWithRetry } from './claude.mjs';
import { writeJsonAtomic } from './state.mjs';

export const PROBE_PROMPT = 'reply ok';
export const CACHE_SCHEMA_VERSION = 1;

/** 缓存文件位置：state/.model-probe.json（与 precommit 锁同属 state 下的内核私有物）。 */
export function modelProbeCacheFile(cfg) {
  return path.join(cfg?.stateDir ?? path.join(cfg?.root ?? '.', 'state'), '.model-probe.json');
}

/** claude 二进制版本（缓存键的一半）。探不到返回 'unknown'——照常探测，只是缓存粒度粗一点。 */
export function detectClaudeVersion({ bin = null, run = spawnSync } = {}) {
  try {
    const r = run(bin ?? claudeBin(), ['--version'], { encoding: 'utf8', timeout: 30_000 });
    const out = String(r?.stdout ?? '').trim();
    return out === '' ? 'unknown' : out.split('\n')[0].trim();
  } catch {
    return 'unknown';
  }
}

/** cfg.models（对象）或裸数组 → 去重后的模型 id 列表；null / 空串视为「用默认模型」，不探测。 */
export function collectModelIds(models) {
  const raw = Array.isArray(models) ? models : Object.values(models ?? {});
  const seen = new Set();
  for (const m of raw) {
    if (typeof m === 'string' && m.trim() !== '') seen.add(m.trim());
  }
  return [...seen];
}

export function cacheKeyOf(model, version) {
  return `${model}@${version}`;
}

function readCache(cacheFile) {
  try {
    const obj = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return obj && typeof obj.entries === 'object' && obj.entries !== null ? obj.entries : {};
  } catch {
    return {}; // 缺失或损坏都当空缓存：探测本身是幂等的，重探一次的代价是一次 max-turns 1
  }
}

function errorTextOf(res) {
  const fromResult = res?.raw?.is_error === true && typeof res?.raw?.result === 'string' ? res.raw.result : null;
  const text = fromResult ?? res?.error ?? `claude exited ${res?.exitCode ?? 'unknown'} with no result event`;
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * 一次探测结果 → { kind: 'ok' | 'rate_limited' | 'unavailable', ... }。纯函数，可单测。
 * 限额与「模型不可用」必须分开：前者是等一等还能跑，后者是配置写错了，两者的人类动作完全不同。
 * 其余任何非 ok（含瞬态重试耗尽、spawn 失败）一律归「不可用」——探测已经替我们退避过了，
 * 到这一步仍不通就该让人看见，而不是让四个角色轮流再撞一遍。
 */
export function classifyProbeResult(res) {
  if (isRateLimited(res)) {
    return { kind: 'rate_limited', rate_limit: res?.rate_limit ?? { type: null, resets_at: null, status: 'rejected' } };
  }
  if (res?.ok === true) return { kind: 'ok' };
  return { kind: 'unavailable', error: errorTextOf(res) };
}

function defaultRunner(cfg) {
  return ({ model }) => runClaudeWithRetry({
    prompt: PROBE_PROMPT,
    maxTurns: 1,
    tools: [], // 无工具：探的是「这个 id 能不能起会话」，不是它能干什么
    model,
    cwd: cfg?.root ?? process.cwd(),
    inactivityTimeoutMs: 120_000,
    wallClockMs: 300_000,
  }, { retries: 1, backoffMs: cfg?.spawnBackoffMs ?? [15000] });
}

/**
 * 探测全部未缓存的模型 id。返回：
 *   { ok, unavailable: [{ model, error }], rateLimited: { type, resets_at } | null,
 *     probed: [...], cached: [...], version, cacheFile }
 * ok=false 时调用方（`cmdRun`）应在处理任何任务前终止本次 run，且不改任何任务状态。
 * 命中限额立即停止后续探测（再探也是同一堵墙）。
 */
export async function probeModels({
  cfg = {},
  models = cfg?.models,
  cacheFile = null,
  runner = null,
  claudeVersion = null,
  now = () => new Date(),
} = {}) {
  const file = cacheFile ?? modelProbeCacheFile(cfg);
  const version = claudeVersion ?? detectClaudeVersion();
  const ids = collectModelIds(models);
  const entries = readCache(file);
  const run = runner ?? defaultRunner(cfg);

  const unavailable = [];
  const probed = [];
  const cached = [];
  let rateLimited = null;
  let dirty = false;

  for (const model of ids) {
    const key = cacheKeyOf(model, version);
    if (entries[key]?.ok === true) {
      cached.push(model);
      continue;
    }
    const res = await run({ model, prompt: PROBE_PROMPT, maxTurns: 1, cfg });
    probed.push(model);
    const verdict = classifyProbeResult(res);
    if (verdict.kind === 'rate_limited') {
      rateLimited = { type: verdict.rate_limit?.type ?? null, resets_at: verdict.rate_limit?.resets_at ?? null };
      break; // 再探也是同一堵墙
    }
    if (verdict.kind === 'unavailable') {
      unavailable.push({ model, error: verdict.error });
      continue;
    }
    entries[key] = { ok: true, model, claude_version: version, checked_at: now().toISOString() };
    dirty = true;
  }

  if (dirty) {
    try {
      writeJsonAtomic(file, { schema_version: CACHE_SCHEMA_VERSION, entries });
    } catch { /* 缓存写不进去不该拖垮 run：下次重探一遍即可 */ }
  }

  return {
    ok: unavailable.length === 0 && rateLimited == null,
    unavailable,
    rateLimited,
    probed,
    cached,
    version,
    cacheFile: file,
  };
}
