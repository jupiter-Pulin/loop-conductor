// actions/review.mjs — router 的 `review` 动作：整体冷审。
//
// reviewer 永远审整份代码与全部 AC（AC-039）：不带包段、不接受 packages、记录无 scope。
// spawn 记录盖 `head_sha` = 派出时的任务分支 HEAD——版本规则（Invariant 6）就靠这个字段
// 判断「这次 review 对的是哪一版」，人的 notes 改不了它。
// 无 spec 的任务把 brief 当契约，reviewer 自编 B-001… 编号（prompt 的 base 段已写死此约定）。

import * as state from '../../lib/state.mjs';
import { diffAgainstBase, diffNameStatusAgainstBase, ensureWorktree } from '../../lib/git.mjs';
import { buildReviewerPrompt } from '../../lib/prompts.mjs';
import { logPathFor } from '../../lib/agent-settings.mjs';
import { HARNESS_ARTIFACTS, rateLimitedToBox, worktreePath } from '../shared.mjs';
import {
  checkBudgetAndBox, readBriefText, readFrozenSpec, revParseOrNull, spawnAgentRound,
  specGateNotes, taskBranchName, taskCfg,
} from '../router-kernel.mjs';

/** AC 清单：有 spec 用枚举结果逐条渲染；无 spec 把 brief 原样交出去当验收线索。 */
function acListFor(cfg, id, hasSpec, briefText) {
  if (!hasSpec) return briefText;
  return state.enumerateAcceptanceCriteria(readFrozenSpec(cfg, id))
    .map((a) => `- ${a.ac_id}: ${a.text}`)
    .join('\n');
}

/** diff 段：超 `verifierDiffMaxBytes` 时降级为 name-status 清单（沿用既有上限口径）。 */
function diffSection(wt, base, cfg) {
  const diff = diffAgainstBase(wt, base);
  const cap = Number.isFinite(cfg.verifierDiffMaxBytes) ? cfg.verifierDiffMaxBytes : 200000;
  if (Buffer.byteLength(diff, 'utf8') <= cap) return diff;
  return [
    `（diff 超过 ${cap} 字节上限，降级为改动清单；需要细看时用 git diff ${base}...HEAD）`,
    diffNameStatusAgainstBase(wt, base),
  ].join('\n');
}

export default async function reviewAction(ts, cfg, { round, records }) {
  const id = ts.id;
  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;

  const repo = taskCfg(ts, cfg).targetRepo;
  const wt = ensureWorktree(repo, worktreePath(cfg, id), taskBranchName(id), HARNESS_ARTIFACTS.patterns, ts.task.baseBranch);
  const head = revParseOrNull(repo, taskBranchName(id));
  const hasSpec = ts.runtime.spec_approved === true;
  const prompt = buildReviewerPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'reviewer', round),
    acList: acListFor(cfg, id, hasSpec, readBriefText(ts)),
    hasSpec,
    humanNotes: specGateNotes(records),
    diff: diffSection(wt, ts.task.baseBranch, cfg),
  });

  const res = await spawnAgentRound(ts, cfg, {
    role: 'reviewer', round, prompt, cwd: wt, extraRecord: { head_sha: head },
  });
  const limited = rateLimitedToBox(ts, cfg, 'reviewer', res);
  if (limited) return limited;
  state.appendTimeline(cfg, id, `reviewer r${round} 结束（head=${head ? head.slice(0, 6) : '?'}）`);
  return { changed: true };
}
