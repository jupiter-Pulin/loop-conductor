// stages/shared.mjs — 内核的 spawn 留档、成本入账、限额与收箱。
//
// 这里只放「每个动作都要用、又都不该各写一份」的副作用助手：spawn 的双标记留档、
// 成本累计（含 killed spawn 的历史均价估计）、限额收口、FAILED_BOX 收箱。
// 判断一律不在这里：去向由 router 决定（stages/routing.mjs），内核事实由 lib/records.mjs 合成。
//
// TaskState（ts）形态：{ box, dir, id, task /*task.json*/, runtime /*runtime.json*/ }。
import fs from 'node:fs';
import path from 'node:path';
import { isDeterministicSpawnFailure, isRateLimited } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import { addRunCost, canStartSpawn, markRunRateLimited } from '../lib/scheduler.mjs';
import { overBudget } from './decisions.mjs';

/** 任务 worktree 的路径（唯一构造点）。 */
export function worktreePath(cfg, id) {
  return path.join(cfg.worktreesDir, id);
}

/** worktree harness 排除（契约 §8）。exclude patterns 与 tracked 检测名分开。 */
export const HARNESS_ARTIFACTS = {
  // 写进 worktree-local .git/info/exclude 的 gitignore pattern。
  // node_modules：testCommand 常 `ln -s` 出一个 node_modules symlink，若不排除会被
  // commitAll 的 `git add -A` 提交进 task 分支，merge 时与目标 working tree 的 node_modules 冲突而中止。
  patterns: ['/.claude_review_state.json', '/.will-workflow/', '/.agent/', '/node_modules'],
  // ls-files 检测「是否已被目标仓库追踪」用的名字（目录名直接传）。
  tracked: ['.claude_review_state.json', '.will-workflow', '.agent', 'node_modules'],
};

export { canStartSpawn };

// ---- <base>-r<n>.json 案卷：每次 spawn 统一留档（契约「记录」一节）。
// started 标记先落盘（崩溃可识别），done 收尾时附原始 CLI JSON（session_id、cost 等）。

/**
 * 写 started 标记。返回 { path, record } 供 finishSpawnRecord 收尾。
 * 同轮重 spawn 不覆盖丢失上一次留档：旧记录（剥离其自身 superseded 字段，避免嵌套）
 * 追加进新记录的 superseded 数组。
 */
export function startSpawnRecord(cfg, id, role, round, extra = {}) {
  const p = state.dossierPath(cfg, id, `${role}-r${round}.json`);
  const record = { role, round, started: new Date().toISOString(), ...extra };
  const prev = state.readJsonIf(p);
  if (prev) {
    const { superseded: prevChain, ...prevRest } = prev;
    record.superseded = [...(prevChain ?? []), prevRest];
  }
  state.writeJson(p, record);
  return { path: p, record };
}

/** 写 done 标记 + 原始 CLI JSON（raw）。 */
export function finishSpawnRecord(rec, res) {
  rec.record.done = new Date().toISOString();
  rec.record.ok = res.ok;
  rec.record.session_id = res.sessionId;
  rec.record.cost_usd = res.costUsd;
  rec.record.raw = res.raw ?? null; // 原始 CLI JSON 留档，不经转述
  if (res.killed !== undefined) rec.record.killed = res.killed ?? null;
  if (res.costUnknown) rec.record.cost_unknown = true;
  if (res.attempts) rec.record.attempts = res.attempts; // 瞬态重试逐次留痕
  if (!res.ok) rec.record.error = res.error ?? 'unknown';
  state.writeJson(rec.path, rec.record);
  return rec.record;
}

// ---- 成本 ----

/** 成本累计写进 ts.runtime.spent_usd（不落盘，交给 saveRuntime/transitionState）。 */
export function addCost(ts, costUsd, cfg = null) {
  const next = (ts.runtime.spent_usd ?? 0) + (costUsd ?? 0);
  ts.runtime.spent_usd = Math.round(next * 1e6) / 1e6;
  if (cfg) addRunCost(cfg, costUsd);
}

/**
 * 某角色的 dossier 历史均价（killed spawn 成本估计的样本源）。
 * 扫 dossier/<id>/<role>-r<n>.json，只取 cost_unknown!==true 且 cost_usd>0 的样本。
 * 无样本返回 { avg: 0, samples: 0 }。
 */
export function estimateRoleCost(cfg, role) {
  let ids = [];
  try { ids = fs.readdirSync(cfg.dossierDir); } catch { return { avg: 0, samples: 0 }; }
  const re = new RegExp(`^${role}-r\\d+\\.json$`);
  const costs = [];
  for (const id of ids) {
    let names = [];
    try { names = fs.readdirSync(path.join(cfg.dossierDir, id)); } catch { continue; }
    for (const n of names) {
      if (!re.test(n)) continue;
      const rec = state.readJsonIf(path.join(cfg.dossierDir, id, n));
      if (rec && rec.cost_unknown !== true && typeof rec.cost_usd === 'number' && rec.cost_usd > 0) {
        costs.push(rec.cost_usd);
      }
    }
  }
  if (costs.length === 0) return { avg: 0, samples: 0 };
  const avg = Math.round((costs.reduce((s, c) => s + c, 0) / costs.length) * 1e6) / 1e6;
  return { avg, samples: costs.length };
}

/**
 * spawn 成本入账统一入口：cost 已知 → 原样入账；costUnknown（killed / 无 result 事件）
 * → 默认只留 lower-bound timeline（记 0）；config `unknownSpawnCostEstimateEnabled=true`
 * 且该角色有历史样本 → 按均价估计入账，runtime.estimated_cost_usd 独立累计（透明可审），
 * timeline 标 estimated —— 预算闸不再被 killed spawn 系统性放水。无样本时退回 lower-bound
 * （绝不凭空造数）。
 * 例外：spawn 报确定性系统错误（ENOENT/EACCES/ENOTDIR 类，与 isTransientFailure 同源判定）
 * 时进程从未起来、零 API 消费，不落入估计分支（task-20260718-001：曾被虚增 $1.9 成本）。
 */
export function accountSpawnCost(ts, cfg, role, round, res) {
  if (!res.costUnknown) {
    addCost(ts, res.costUsd, cfg);
    return;
  }
  addCost(ts, res.costUsd, cfg); // unknown 时 costUsd 恒 0：保持字面等价（no-op）
  if (isDeterministicSpawnFailure(res)) {
    state.appendTimeline(cfg, ts.id, `${role} r${round} spawn 确定性失败（${res.error ?? 'unknown'}），不做历史均价估计入账`);
    return;
  }
  if (cfg.unknownSpawnCostEstimateEnabled === true) {
    const est = estimateRoleCost(cfg, role);
    if (est.samples > 0) {
      addCost(ts, est.avg, cfg);
      ts.runtime.estimated_cost_usd = Math.round(((ts.runtime.estimated_cost_usd ?? 0) + est.avg) * 1e6) / 1e6;
      state.appendTimeline(cfg, ts.id, `${role} r${round} cost unknown → 按历史均价 $${est.avg} 估计入账（n=${est.samples}，estimated）`);
      return;
    }
    state.appendTimeline(cfg, ts.id, `${role} r${round} cost unknown → 无历史样本可估计，spent_usd uses lower-bound accounting`);
    return;
  }
  state.appendTimeline(cfg, ts.id, `${role} r${round} cost unknown; spent_usd uses lower-bound accounting`);
}

export function budgetExceeded(ts, cfg) {
  return overBudget(ts.runtime.spent_usd ?? 0, cfg.budgetUsd);
}

// ---- 五小时 / 周限额：进箱，人手动恢复，永不自动续跑 ----

/** rate_limit 的 ISO 文案（resets_at 缺失时给 'unknown'，绝不造时刻）。 */
export function rateLimitResetIso(resetsAt) {
  return typeof resetsAt === 'number' && Number.isFinite(resetsAt)
    ? new Date(resetsAt * 1000).toISOString()
    : 'unknown';
}

/**
 * 全部 spawn 点共用的限额收口：命中 → 本次 run 内不再发起任何新 spawn（markRunRateLimited），
 * 该任务 FAILED_BOX(rate_limited) 并记 `runtime.rate_limit = {type, resets_at, hit_at, resume_stage}`；
 * resume_stage 取命中时所在 stage，`retry` 据此原地回位（不归档轮次产物、不重置任何计数）。
 * 未命中返回 null，调用方继续走原路径。
 */
export function rateLimitedToBox(ts, cfg, role, res) {
  if (!isRateLimited(res)) return null;
  const rl = res.rate_limit ?? {};
  const resetsAt = typeof rl.resets_at === 'number' ? rl.resets_at : null;
  const type = rl.type ?? null;
  const iso = rateLimitResetIso(resetsAt);
  const resumeStage = ts.runtime.stage;
  markRunRateLimited(cfg, resetsAt);
  state.appendTimeline(cfg, ts.id, `${role} spawn 命中限额（${type ?? 'unknown'}），重置于 ${iso}`);
  // 字段名不能叫 `type`：appendEvent 以 `{ts, type, ...fields}` 展开，会把事件类型顶掉。
  state.appendEvent(cfg, ts.id, 'rate_limited', {
    role, limit_type: type, resets_at: resetsAt, resume_stage: resumeStage,
  });
  return failToBox(ts, cfg, `rate limited (${type ?? 'unknown'})，重置于 ${iso}`, 'rate_limited', {
    rate_limit: {
      type,
      resets_at: resetsAt,
      hit_at: Math.floor(Date.now() / 1000),
      resume_stage: resumeStage,
    },
  });
}

/**
 * 收箱：transitionState→FAILED_BOX，设 last_failure_type，console.error。
 * extra 合并进 runtime，与 stage 一同落盘（否则 timeline 与 runtime 会各说一套）。
 */
export function failToBox(ts, cfg, reason, failureType = null, extra = {}) {
  console.error(`[${ts.id}] → FAILED_BOX: ${reason}`);
  state.transitionState(ts, cfg, 'FAILED_BOX', reason, { last_failure_type: failureType, ...extra });
  return { changed: true };
}
