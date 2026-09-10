// actions/maker.mjs — router 的 `maker` 动作（P2：只有单 maker 路径，无方案）。
//
// 内核做的事：懒创建任务 worktree（分支 `task/<id>` @ base）→ spawn maker → `commitAll`。
// 内核不判成败：maker 的 log 只是记录里的一条，绿不绿由 reviewer 与 precommit 说了算。
// commit 无条件跑（`--allow-empty`）：产出必须固化成 commit，diff 与版本规则才看得见它。

import * as state from '../../lib/state.mjs';
import { commitAll, ensureWorktree } from '../../lib/git.mjs';
import { buildMakerPrompt } from '../../lib/prompts.mjs';
import { logPathFor } from '../../lib/agent-settings.mjs';
import { HARNESS_ARTIFACTS, rateLimitedToBox, worktreePath } from '../shared.mjs';
import {
  checkBudgetAndBox, readBriefText, readFrozenSpec, spawnAgentRound, specGateNotes, taskBranchName,
  taskCfg,
} from '../router-kernel.mjs';

/**
 * 修复轮上下文（`[修复轮]` 段）：最近一条 reviewer 记录的 summary，或最近一条 precommit
 * 记录里失败步骤的 tail。两者都没有（第一轮）时返回空串，段不注入。
 */
export function repairContextOf(records) {
  const latest = (role) => {
    let best = null;
    for (const r of records ?? []) {
      if (r.role !== role || r.product !== 'ok') continue;
      if (best == null || r.round >= best.round) best = r;
    }
    return best;
  };
  const reviewer = latest('reviewer');
  const precommit = latest('precommit');
  if (reviewer != null && (precommit == null || reviewer.round >= precommit.round)) {
    return reviewer.summary ?? '';
  }
  if (precommit == null) return '';
  const failed = (precommit.steps ?? []).find((s) => s?.status === 'fail');
  if (!failed) return precommit.summary ?? '';
  return [`precommit ${failed.step} 失败（${failed.command ?? '-'}）：`, failed.tail ?? ''].join('\n').trim();
}

export default async function makerAction(ts, cfg, { round, records }) {
  const id = ts.id;
  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;

  const repo = taskCfg(ts, cfg).targetRepo;
  const wt = ensureWorktree(repo, worktreePath(cfg, id), taskBranchName(id), HARNESS_ARTIFACTS.patterns, ts.task.baseBranch);
  const hasSpec = ts.runtime.spec_approved === true;
  const prompt = buildMakerPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'maker', round),
    testCommand: ts.task.testCommand,
    hasSpec,
    specText: hasSpec ? readFrozenSpec(cfg, id) : '',
    briefText: hasSpec ? '' : readBriefText(ts),
    humanNotes: specGateNotes(records),
    repairContext: repairContextOf(records),
  });

  const res = await spawnAgentRound(ts, cfg, { role: 'maker', round, prompt, cwd: wt });
  const limited = rateLimitedToBox(ts, cfg, 'maker', res);
  if (limited) return limited;

  commitAll(wt, `task ${id}: maker r${round}`);
  state.appendTimeline(cfg, id, `maker r${round} 产出已提交到 ${taskBranchName(id)}`);
  return { changed: true };
}
