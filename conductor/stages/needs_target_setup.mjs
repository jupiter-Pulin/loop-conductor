// NEEDS_TARGET_SETUP：repo 级 setup profile 缺失时，spawn setup-agent 只读探索 target repo。
// 产出 target-profiles/<repo>/setup-profile.draft.md 后停在 AWAIT_SETUP_APPROVAL。
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import { hasApprovedSetupProfile, setupProfilePaths } from '../lib/profile.mjs';
import { taskCfg } from '../lib/task-cfg.mjs';
import * as state from '../lib/state.mjs';
import {
  accountSpawnCost, budgetExceeded, buildSetupPrompt, entryStageAfterSetup, failToBox,
  finishSpawnRecord, nextRoleRound, READONLY_TOOLS, startSpawnRecord, canStartSpawn, rateLimitedToBox,
} from './shared.mjs';

const setupLocks = new Map();

async function withSetupKey(key, fn) {
  const prior = setupLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = prior.then(() => current, () => current);
  setupLocks.set(key, chained);
  await prior.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (setupLocks.get(key) === chained) setupLocks.delete(key);
  }
}

export default async function needsTargetSetupHandler(ts, cfg) {
  const id = ts.id;
  const tcfg = taskCfg(ts, cfg);
  if (hasApprovedSetupProfile(tcfg)) {
    state.transitionState(ts, cfg, entryStageAfterSetup(ts), 'approved setup profile already exists');
    return { changed: true };
  }

  const paths = setupProfilePaths(tcfg);
  return withSetupKey(paths.key, async () => {
  if (hasApprovedSetupProfile(tcfg)) {
    state.transitionState(ts, cfg, entryStageAfterSetup(ts), 'approved setup profile already exists');
    return { changed: true };
  }
  if (!fs.existsSync(paths.draft)) {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}`, 'budget_exceeded');
    }
    if (!canStartSpawn(ts, cfg, 'setup')) return { changed: false };
    const round = nextRoleRound(cfg, id, 'setup');
    const streamFile = state.dossierPath(cfg, id, `setup-r${round}.stream.jsonl`);
    const rec = startSpawnRecord(cfg, id, 'setup', round, { stream_file: path.relative(cfg.root, streamFile) });
    const res = await runClaude({
      cwd: tcfg.targetRepo,
      prompt: buildSetupPrompt(ts, cfg),
      maxTurns: cfg.maxTurns,
      model: cfg.models?.setup ?? null,
      tools: READONLY_TOOLS,
      allowedTools: READONLY_TOOLS,
      streamFile,
      inactivityTimeoutMs: cfg.inactivityTimeoutMs,
      wallClockMs: cfg.spawnWallClockMs,
    });
    finishSpawnRecord(rec, res);
    accountSpawnCost(ts, cfg, 'setup', round, res);
    state.saveRuntime(ts);
    const limited = rateLimitedToBox(ts, cfg, 'setup', res);
    if (limited) return limited; // 限额：进箱等人在 resets_at 后 retry
    if (!res.ok || !res.result?.trim()) {
      state.appendTimeline(cfg, id, `setup-agent failed: ${res.error ?? 'empty result'}`);
      console.error(`[${id}] setup-agent 失败（${res.error ?? 'empty result'}），任务停留在 NEEDS_TARGET_SETUP`);
      return { changed: false };
    }
    fs.mkdirSync(path.dirname(paths.draft), { recursive: true });
    state.writeFileEnsured(paths.draft, res.result);
    state.appendTimeline(cfg, id, `setup-agent 产出 setup profile 草稿 (cost=$${res.costUsd}) → ${path.relative(cfg.root, paths.draft)}`);
  }

  ts.runtime.setup_approval = null;
  state.transitionState(ts, cfg, 'AWAIT_SETUP_APPROVAL', 'setup profile draft ready');
  console.log(`[${id}] setup profile 待审批：${path.relative(cfg.root, paths.draft)} → conductor approve-setup ${id}`);
  return { changed: true };
  });
}
