// lib/scheduler.mjs — queue 任务并发 chain 调度；不含 stage 业务逻辑。
import path from 'node:path';
import * as state from './state.mjs';
import { withTaskLock } from './task-lock.mjs';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readQueueTask(cfg, id) {
  const dir = state.taskDir(cfg.queueDir, id);
  try {
    return state.readTaskState(dir, 'queue');
  } catch {
    return null;
  }
}

async function runTaskChain(cfg, id, handlers, { maxStepsPerTask, taskLockRetries, taskLockRetryDelayMs }) {
  let changedInChain = false;
  for (let step = 0; step < maxStepsPerTask; step++) {
    const result = await withTaskLock(
      cfg,
      id,
      async () => {
        const ts = readQueueTask(cfg, id);
        if (!ts) return { stop: true, changed: false };
        if (ts.error) {
          console.error(`[${id}] 任务目录损坏，跳过 ${ts.dir}: ${ts.error}`);
          return { stop: true, changed: false };
        }
        const handler = handlers[ts.runtime.stage];
        if (!handler) {
          console.error(`[${id}] 未知 stage "${ts.runtime.stage}"，跳过`);
          return { stop: true, changed: false };
        }
        try {
          const r = await handler(ts, cfg) ?? {};
          return { stop: !r.changed, changed: Boolean(r.changed) };
        } catch (err) {
          console.error(`[${id}] handler(${ts.runtime.stage}) 异常：${err.message}`);
          return { stop: true, changed: false };
        }
      },
      { retries: taskLockRetries, retryDelayMs: taskLockRetryDelayMs },
    );
    if (result.changed) changedInChain = true;
    if (result.stop) return { id, changed: changedInChain, capped: false };
  }
  console.error(
    `[${id}] maxStepsPerTask=${maxStepsPerTask} 耗尽，状态已落盘；下次 conductor run 将从当前 stage 续推。`,
  );
  return { id, changed: changedInChain, capped: true };
}

export async function runScheduler(cfg, handlers) {
  const maxConcurrentTasks = positiveInt(cfg.maxConcurrentTasks, 1);
  const maxStepsPerTask = positiveInt(cfg.maxStepsPerTask, 20);
  const taskIds = state.listTaskStates(cfg.queueDir, 'queue')
    .filter((ts) => !ts.error)
    .map((ts) => ts.id);
  const results = [];
  let next = 0;

  async function worker() {
    while (next < taskIds.length) {
      const id = taskIds[next++];
      results.push(await runTaskChain(cfg, id, handlers, {
        maxStepsPerTask,
        taskLockRetries: cfg.schedulerTaskLockRetries ?? 50,
        taskLockRetryDelayMs: cfg.schedulerTaskLockRetryDelayMs ?? 100,
      }));
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrentTasks, taskIds.length) }, () => worker());
  await Promise.all(workers);
  return {
    taskCount: taskIds.length,
    changed: results.some((r) => r.changed),
    capped: results.filter((r) => r.capped).map((r) => r.id),
    results,
  };
}

export function initRunBudget(cfg) {
  cfg.__runBudget = {
    spent: 0,
    announced: false,
    limit: typeof cfg.runBudgetUsd === 'number' ? cfg.runBudgetUsd : null,
  };
}

export function addRunCost(cfg, costUsd) {
  if (!cfg.__runBudget) return;
  const cost = Number(costUsd) || 0;
  cfg.__runBudget.spent = Math.round((cfg.__runBudget.spent + cost) * 1e6) / 1e6;
}

export function canStartSpawn(ts, cfg, role) {
  const budget = cfg.__runBudget;
  if (!budget || budget.limit == null) return true;
  if (budget.spent < budget.limit) return true;
  if (!budget.announced) {
    console.error(
      `[${ts.id}] runBudgetUsd=$${budget.limit} 已达到（本 run 已知成本下界 $${budget.spent}），停止发起新 spawn。`,
    );
    budget.announced = true;
  }
  state.appendTimeline(cfg, ts.id, `${role} spawn skipped: runBudgetUsd reached ($${budget.spent} >= $${budget.limit})`);
  return false;
}

export function describeRelative(cfg, p) {
  return path.relative(cfg.root, p);
}
