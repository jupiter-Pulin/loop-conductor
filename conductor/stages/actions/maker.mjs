// actions/maker.mjs — router 的 `maker` 动作（P2：只有单 maker 路径，无方案）。
//
// 内核做的事：懒创建任务 worktree（分支 `task/<id>` @ base）→ spawn maker → `commitAll`。
// 内核不判成败：maker 的 log 只是记录里的一条，绿不绿由 reviewer 与 precommit 说了算。
// commit 无条件跑（`--allow-empty`）：产出必须固化成 commit，diff 与版本规则才看得见它。

import fs from 'node:fs';
import * as state from '../../lib/state.mjs';
import { commitAll, ensureWorktree } from '../../lib/git.mjs';
import { snapshotProtected, verifyProtected } from '../../lib/integrity.mjs';
import { validateLog } from '../../lib/log-contract.mjs';
import { writeSalvage } from '../../lib/salvage.mjs';
import { buildMakerPrompt } from '../../lib/prompts.mjs';
import { logPathFor } from '../../lib/agent-settings.mjs';
import { HARNESS_ARTIFACTS, rateLimitedToBox, worktreePath } from '../shared.mjs';
import {
  checkBudgetAndBox, openHumanGate, readBriefText, readFrozenSpec, relRef, spawnAgentRound, spawnSkipped,
  specGateNotes, taskBranchName, taskCfg,
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

export default async function makerAction(ts, cfg, { round, records, decision = null }) {
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
    guidance: decision?.guidance ?? '', // router 的具体指导逐字进执行上下文
  });

  // maker 有 Bash：派出前给不可变的东西拍快照，跑完核对（被动过就还原并记违规）。
  const snapshot = snapshotProtected(cfg, ts, { round });
  const res = await spawnAgentRound(ts, cfg, {
    role: 'maker', round, prompt, cwd: wt,
    extraRecord: { spec_sha: hasSpec ? (ts.runtime.spec_sha256 ?? null) : null },
  });
  // run 级闸门拦下（本次 run 已命中限额 / runBudget）：这一轮什么都没发生，不提交、不留记录。
  if (spawnSkipped(res)) return { changed: false };
  const limited = rateLimitedToBox(ts, cfg, 'maker', res);
  if (limited) return limited;

  commitAll(wt, `task ${id}: maker r${round}`);
  state.appendTimeline(cfg, id, `maker r${round} 产出已提交到 ${taskBranchName(id)}`);

  // 撞上限 / 被杀而没留下合格 log：内核把自己观察到的执行事实落成 salvage，明确列出已知与未知。
  const logPath = logPathFor(cfg, id, 'maker', round);
  let logOk = false;
  try { logOk = validateLog(JSON.parse(fs.readFileSync(logPath, 'utf8')), 'maker').ok; } catch { /* 缺失或非法 */ }
  if (!logOk) {
    writeSalvage(state.dossierPath(cfg, id, `maker-r${round}.salvage.json`), {
      role: 'maker', round,
      reason: res.killed ? 'interrupted' : (res.raw?.subtype === 'error_max_turns' ? 'truncated' : 'log_missing'),
      streamFile: state.dossierPath(cfg, id, `maker-r${round}.stream.jsonl`),
      known: { committed_to: taskBranchName(id), note: 'worktree 里已有的改动已提交到任务分支；完成度未知' },
    });
  }

  const violations = verifyProtected(snapshot, { expectedBases: ['maker'] });
  if (violations.length > 0) {
    state.appendEventAlways(cfg, id, 'boundary_violation', {
      round, violations: violations.map((v) => ({ ...v, path: relRef(cfg, v.path) })),
    });
    return openHumanGate(ts, cfg, {
      kind: 'help',
      requestedBy: 'kernel',
      summary: `maker r${round} 的执行越过了授权边界，内核已还原 / 隔离并停下等你裁决：\n${violations.map((v) => `- ${v.kind}: ${relRef(cfg, v.path)}${v.restored ? '（已还原）' : '（未能还原）'}`).join('\n')}`,
      refs: [relRef(cfg, state.dossierPath(cfg, id, `maker-r${round}.json`))],
      round,
    });
  }
  return { changed: true };
}
