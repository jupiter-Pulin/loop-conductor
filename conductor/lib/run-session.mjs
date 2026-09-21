// lib/run-session.mjs — 一次「运行」的持久账本 + 停止请求。
//
// runBudgetUsd 是人给**一次运行**的授权额度。持续运行（`run --continuous` / `run --watch`）会跨很多个
// 调度批次，runner 也可能中途崩溃再被拉起来——这些都不是新的授权，花掉的钱不能因为「新的一批」
// 或「新的进程」而归零。所以运行账本落在 `state/.run-session.json`：
//   - 同一进程内跨批次：同一份账本，spent 一直累加；
//   - 上一次运行没有正常收尾（崩溃 / 被 SIGKILL）：新进程**接管**那份账本，从已花金额接着算；
//   - 上一次运行正常收尾（跑到空闲、额度用尽、人要求停止）之后，人再次手动 `conductor run` 才是一次
//     新授权，开新账本。
// 任务级预算（budgetUsd）本来就落在各任务的 runtime.spent_usd 里，不受批次与进程影响。
//
// 停止请求：`conductor stop` 写 `state/.stop`；runner 在每次 spawn 之前、每个调度步之间检查它，
// 命中后不再发起任何新 spawn（`--now` 另外收割在飞的 agent）。SIGINT / SIGTERM 走同一条路。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './state.mjs';
import { selfIdentity } from './proc.mjs';

export function runSessionFile(cfg) {
  return path.join(cfg.stateDir, '.run-session.json');
}

export function stopFile(cfg) {
  return path.join(cfg.stateDir, '.stop');
}

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function readRunSession(cfg) {
  return readJsonIf(runSessionFile(cfg));
}

function persist(cfg) {
  if (!cfg.__runSession) return;
  try { writeJsonAtomic(runSessionFile(cfg), cfg.__runSession); } catch { /* 账本写不进去不该拖垮 run；下次写再试 */ }
}

/**
 * 开始（或接管）一次运行，并初始化内存里的 run 预算（与 scheduler.canStartSpawn 共用 cfg.__runBudget）。
 * 返回 { session, adopted }。
 */
export function openRunSession(cfg, { mode = 'once' } = {}) {
  const prev = readRunSession(cfg);
  const limit = typeof cfg.runBudgetUsd === 'number' ? cfg.runBudgetUsd : null;
  const adopted = prev != null && prev.ended_at == null;
  const session = adopted
    ? {
      ...prev,
      ...selfIdentity(),
      mode,
      limit_usd: limit,
      adopted_count: (prev.adopted_count ?? 0) + 1,
      adopted_at: new Date().toISOString(),
    }
    : {
      schema_version: 1,
      session_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      ...selfIdentity(),
      mode,
      limit_usd: limit,
      spent_usd: 0,
      batches: 0,
      adopted_count: 0,
      ended_at: null,
      end_reason: null,
    };
  // 账本上的已花金额读不出来（文件被改坏）：不能当成 0——那等于一次静默的额度重置。
  // 有额度上限就按「已用尽」处理（fail closed），并留标记让 run 明说；人确认后删掉账本文件即重新授权。
  const spentRaw = Number(session.spent_usd);
  const spentOk = Number.isFinite(spentRaw) && spentRaw >= 0;
  if (!spentOk) {
    session.ledger_corrupt = true;
    session.spent_usd = limit ?? 0;
  }
  cfg.__runSession = session;
  cfg.__runBudget = { spent: spentOk ? spentRaw : (limit ?? 0), announced: false, limit };
  persist(cfg);
  return { session, adopted };
}

/** scheduler.addRunCost 每入一笔账就同步到账本（崩溃时已花金额不丢）。 */
export function syncRunSessionCost(cfg) {
  if (!cfg.__runSession || !cfg.__runBudget) return;
  cfg.__runSession.spent_usd = cfg.__runBudget.spent;
  persist(cfg);
}

export function noteBatch(cfg) {
  if (!cfg.__runSession) return;
  cfg.__runSession.batches = (cfg.__runSession.batches ?? 0) + 1;
  cfg.__runSession.last_batch_at = new Date().toISOString();
  persist(cfg);
}

export function closeRunSession(cfg, reason) {
  if (!cfg.__runSession) return;
  cfg.__runSession.ended_at = new Date().toISOString();
  cfg.__runSession.end_reason = reason ?? 'finished';
  persist(cfg);
}

// ---- 停止请求 ----

export function requestStop(cfg, { reason = 'conductor stop', now = false } = {}) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(stopFile(cfg), `${JSON.stringify({ requested_at: new Date().toISOString(), reason, now, by_pid: process.pid })}\n`);
}

export function readStopRequest(cfg) {
  return readJsonIf(stopFile(cfg));
}

/** 本进程是否应当停止发起新 spawn：内存标记（信号）或盘上的停止请求。 */
export function stopRequested(cfg) {
  if (cfg?.__stop) return true;
  if (!cfg?.stateDir) return false;
  if (fs.existsSync(stopFile(cfg))) {
    cfg.__stop = readStopRequest(cfg) ?? { reason: 'stop file' };
    return true;
  }
  return false;
}

/** run 启动时清掉上一次遗留的停止请求（它针对的是当时那个 runner，不是这一个）。 */
export function clearStopRequest(cfg) {
  fs.rmSync(stopFile(cfg), { force: true });
  delete cfg.__stop;
}
