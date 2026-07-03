// NEEDS_TARGET_SETUP：repo 级 setup profile 缺失时，spawn setup-agent 只读探索 target repo。
// 产出 target-profiles/<repo>/setup-profile.draft.md 后停在 AWAIT_SETUP_APPROVAL。
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import { hasApprovedSetupProfile, setupProfilePaths } from '../lib/profile.mjs';
import * as state from '../lib/state.mjs';
import {
  addCost, budgetExceeded, buildSetupPrompt, entryStageAfterSetup, failToBox,
  finishSpawnRecord, nextRoleRound, READONLY_TOOLS, startSpawnRecord,
} from './shared.mjs';

export default function needsTargetSetupHandler(ts, cfg) {
  const id = ts.id;
  if (hasApprovedSetupProfile(cfg)) {
    state.transitionState(ts, cfg, entryStageAfterSetup(ts), 'approved setup profile already exists');
    return { changed: true };
  }

  const paths = setupProfilePaths(cfg);
  if (!fs.existsSync(paths.draft)) {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}`, 'budget_exceeded');
    }
    const round = nextRoleRound(cfg, id, 'setup');
    const rec = startSpawnRecord(cfg, id, 'setup', round);
    const res = runClaude({
      cwd: cfg.targetRepo,
      prompt: buildSetupPrompt(ts, cfg),
      maxTurns: cfg.maxTurns,
      model: cfg.models?.setup ?? null,
      tools: READONLY_TOOLS,
      allowedTools: READONLY_TOOLS,
    });
    finishSpawnRecord(rec, res);
    addCost(ts, res.costUsd);
    state.saveRuntime(ts);
    if (!res.ok || !res.result?.trim()) {
      state.appendTimeline(cfg, id, `setup-agent failed: ${res.error ?? 'empty result'}`);
      console.error(`[${id}] setup-agent 失败（${res.error ?? 'empty result'}），任务停留在 NEEDS_TARGET_SETUP`);
      return { changed: false };
    }
    fs.mkdirSync(path.dirname(paths.draft), { recursive: true });
    fs.writeFileSync(paths.draft, res.result);
    state.appendTimeline(cfg, id, `setup-agent 产出 setup profile 草稿 (cost=$${res.costUsd}) → ${path.relative(cfg.root, paths.draft)}`);
  }

  ts.runtime.setup_approval = null;
  state.transitionState(ts, cfg, 'AWAIT_SETUP_APPROVAL', 'setup profile draft ready');
  console.log(`[${id}] setup profile 待审批：${path.relative(cfg.root, paths.draft)} → conductor approve-setup ${id}`);
  return { changed: true };
}
