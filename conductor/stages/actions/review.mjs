// actions/review.mjs — router 的 `review` 动作：整体冷审。
//
// reviewer 永远审整份代码与全部 AC（AC-039）：不带包段、不接受 packages、记录无 scope。
// spawn 记录盖 `head_sha` = 派出时的任务分支 HEAD——版本规则（Invariant 6）就靠这个字段
// 判断「这次 review 对的是哪一版」，人的 notes 改不了它。
// 无 spec 的任务把 brief 当契约，reviewer 自编 B-001… 编号（prompt 的 base 段已写死此约定），
// 并先按注入的 `git diff --stat` 分诊（小改动只审测试是否钉住目标）；分诊是 reviewer 的判断，
// 内核只负责把 stat 与 base 分支名作为事实给它。
//
// 有 spec 的任务走**判决台账**（lib/review-ledger.mjs）：reviewer 把逐条判决增量写进
// `reviewer-r<n>.verdicts.json`，一轮判不完（AC 多、diff 大、撞会话上限）下一次 review 接着判剩余的。
// 沿用只在同一版本内发生：spawn 记录盖 `head_sha` 与 `spec_sha`，HEAD 或获批 spec 任何一个变了，
// 旧判决一条都不算数。本轮要判哪些由内核按台账机械算出（未判的；都判过了就整份重判），
// 判得对不对是 reviewer 的独立判断，内核不碰。

import fs from 'node:fs';
import path from 'node:path';
import * as state from '../../lib/state.mjs';
import { diffAgainstBase, diffNameStatusAgainstBase, diffStatAgainstBase, ensureWorktree } from '../../lib/git.mjs';
import { buildReviewerPrompt } from '../../lib/prompts.mjs';
import { logPathFor, verdictsPathFor } from '../../lib/agent-settings.mjs';
import { reviewCoverage } from '../../lib/review-ledger.mjs';
import { currentSpec } from '../../lib/spec-version.mjs';
import { HARNESS_ARTIFACTS, rateLimitedToBox, worktreePath } from '../shared.mjs';
import {
  checkBudgetAndBox, readBriefText, readFrozenSpec, revParseOrNull, spawnAgentRound,
  spawnSkipped, specGateNotes, taskBranchName, taskCfg,
} from '../router-kernel.mjs';

/** AC 清单：有 spec 用枚举结果逐条渲染；无 spec 把 brief 原样交出去当验收线索。 */
function acListFor(cfg, id, hasSpec, briefText) {
  if (!hasSpec) return briefText;
  return state.enumerateAcceptanceCriteria(readFrozenSpec(cfg, id))
    .map((a) => `- ${a.ac_id}: ${a.text}`)
    .join('\n');
}

/**
 * 把整份 diff 物化成案卷里的只读视图（`views/<head12>.patch`）。reviewer 与 router 都没有可靠的
 * 命令执行能力，大 diff 内嵌不下时靠它按需 Read / Grep——证据不因 prompt 的字节上限而丢。
 */
export function materializeDiffView(cfg, id, wt, base, head) {
  const dir = state.dossierPath(cfg, id, 'views');
  const p = path.join(dir, `${String(head ?? 'nohead').slice(0, 12)}.patch`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, diffAgainstBase(wt, base));
    return p;
  } catch { return null; }
}

/** diff 段：超 `verifierDiffMaxBytes` 时降级为 name-status 清单（沿用既有上限口径）。 */
function diffSection(wt, base, cfg, patchPath = null) {
  const diff = diffAgainstBase(wt, base);
  const cap = Number.isFinite(cfg.verifierDiffMaxBytes) ? cfg.verifierDiffMaxBytes : 200000;
  if (Buffer.byteLength(diff, 'utf8') <= cap) return diff;
  return [
    `（diff 超过 ${cap} 字节上限，降级为改动清单；需要细看时用 git diff ${base}...HEAD${patchPath ? `，或直接读完整 patch：${patchPath}` : ''}）`,
    diffNameStatusAgainstBase(wt, base),
  ].join('\n');
}

/** 同一版本上已有的判决 → 注入 prompt 的「沿用」说明。 */
function carriedText(cov) {
  const judged = Object.entries(cov.judged);
  if (judged.length === 0) return '';
  const lines = judged.map(([ac, v]) => `${ac} ${v.verdict}${v.verdict === 'fail' ? `（${v.evidence}）` : ''}`);
  return `同一版本（HEAD 与 spec 都没变）上已有判决，本轮沿用、不必重判，台账里也不用重抄：${lines.join('；')}`;
}

export default async function reviewAction(ts, cfg, { round, records }) {
  const id = ts.id;
  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;

  const repo = taskCfg(ts, cfg).targetRepo;
  const wt = ensureWorktree(repo, worktreePath(cfg, id), taskBranchName(id), HARNESS_ARTIFACTS.patterns, ts.task.baseBranch);
  const head = revParseOrNull(repo, taskBranchName(id));
  const hasSpec = ts.runtime.spec_approved === true;
  const spec = hasSpec ? currentSpec(cfg, ts) : null;
  const patchPath = materializeDiffView(cfg, id, wt, ts.task.baseBranch, head);

  let ledger = null;
  let todo = null;
  if (spec) {
    const acIds = state.enumerateAcceptanceCriteria(spec.text).map((a) => a.ac_id);
    const cov = reviewCoverage({ dossierDir: state.dossierPath(cfg, id), records, head, specSha: spec.sha256, acIds });
    // 还有没判的 → 只判剩余；都判过了（router 要求重审）→ 整份重判，后判覆盖先判。
    const resume = cov.remaining.length > 0 && cov.remaining.length < acIds.length;
    todo = resume ? cov.remaining : acIds;
    ledger = {
      verdictsPath: verdictsPathFor(cfg, id, round),
      todo,
      carried: resume ? carriedText(cov) : '',
      specPath: spec.path,
      patchPath,
    };
  }

  const prompt = buildReviewerPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'reviewer', round),
    acList: acListFor(cfg, id, hasSpec, readBriefText(ts)),
    hasSpec,
    humanNotes: specGateNotes(records),
    base: ts.task.baseBranch,
    diffStat: diffStatAgainstBase(wt, ts.task.baseBranch),
    diff: diffSection(wt, ts.task.baseBranch, cfg, patchPath),
    ledger,
  });

  const res = await spawnAgentRound(ts, cfg, {
    role: 'reviewer', round, prompt, cwd: wt,
    extraRecord: { head_sha: head, spec_sha: spec?.sha256 ?? null, ...(todo ? { todo } : {}) },
  });
  if (spawnSkipped(res)) return { changed: false }; // run 级闸门拦下：本轮无记录、无 timeline
  const limited = rateLimitedToBox(ts, cfg, 'reviewer', res);
  if (limited) return limited;
  state.appendTimeline(cfg, id, `reviewer r${round} 结束（head=${head ? head.slice(0, 6) : '?'}）`);
  return { changed: true };
}
