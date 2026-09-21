// actions/dispatch.mjs — router 的 `dispatch` 动作：把 1..N 个有边界的委派交给 worker 执行。
//
// 内核在这里做的事，全部是机械的：
//   绑定版本（任务分支 HEAD、获批 spec 的哈希）→ 预写委派台账 → 按 profile 准备隔离的工作目录
//   → 并行派出（受 maxParallelAssignments 与全局 spawn 槽位限制，每一次 spawn 都过预算 / 限额 / 停止闸）
//   → 撞会话上限且有进展的，在额度内自动续会话 → 核对完整性（lib/integrity.mjs）
//   → 逐个提交、顺序集成进任务分支 → 收尾记账。
// 每过一个边界就重写一次台账，runner 在任何一步崩溃，lib/recovery.mjs 都能从台账 + spawn 记录 +
// git 的实际状态接着收尾，不重复派出、不重复集成。
//
// 内核不判断委派写得对不对、worker 做得好不好：outcome 只是记录里的一条，绿不绿由整体 review 与
// precommit 说了算。三个结论在这里严格分开——
//   子任务退出（worker 的 log）≠ 集成成功（本文件的 merge 结果）≠ 产品验收（version-gate）。
//
// 工作目录按真实副作用分配（placement）：
//   write   第一个 → `inplace`：直接用任务 worktree（依赖缓存是热的）；同轮其余 → `isolated`：
//           各自的分支 `task/<id>--<key>` + worktree，结束后由内核合进任务分支，冲突则保留分支、记 conflict。
//   read    → `snapshot`：派出时刻任务 HEAD 的一次性 detached 副本——并行的 write 改到一半的文件它看不到。
//   sandbox → `scratch`：同样的一次性副本，可以随便装依赖跑命令；结束即弃，**任何产物都不并入产品**，
//           只有报告留在案卷里。结束后任务分支 ref 必须原样，被动过就还原并记违规。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as state from '../../lib/state.mjs';
import {
  changedFilesBetween, commitIfDirty, deleteBranch, ensureWorktree, git, headOf, isAncestor, isDirty,
  mergeInto, prepareBranchWorktree, recreateDetachedWorktree, removeWorktree, treeOf,
} from '../../lib/git.mjs';
import { buildWorkerPrompt } from '../../lib/prompts.mjs';
import { artifactPath, logPathFor, reportPathFor, workerWorktreePath } from '../../lib/agent-settings.mjs';
import { filesOutsideDeclared, writePathConflicts } from '../../lib/assignment-contract.mjs';
import {
  latestAssignments, listLedgers, newLedger, resumableSpawn, writeLedger,
} from '../../lib/dispatch-ledger.mjs';
import { snapshotProtected, verifyProtected } from '../../lib/integrity.mjs';
import { currentSpec } from '../../lib/spec-version.mjs';
import { digestStateFor } from '../../lib/digest-store.mjs';
import { validateLog } from '../../lib/log-contract.mjs';
import { writeSalvage } from '../../lib/salvage.mjs';
import { isRateLimited } from '../../lib/claude.mjs';
import { markRunRateLimited } from '../../lib/scheduler.mjs';
import { stopRequested } from '../../lib/run-session.mjs';
import { HARNESS_ARTIFACTS, budgetExceeded, rateLimitedToBox, worktreePath } from '../shared.mjs';
import {
  allocateRound, checkBudgetAndBox, everProducedSpec, openHumanGate, readBriefText, relRef,
  spawnAgentRound, spawnSkipped, specGateNotes, taskBranchName, taskCfg,
} from '../router-kernel.mjs';

export const DEFAULT_MAX_PARALLEL_ASSIGNMENTS = 3;
export const DEFAULT_MAX_AUTO_CONTINUES = 2;

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function fileSha(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

function workerBase(key) {
  return `worker-${key}`;
}

/** 内核给自己的 spawn 记录补字段（进度证据、集成结果、违规）。agent 写的 log 从不动。 */
export function patchSpawnRecord(cfg, id, key, round, patch) {
  const p = artifactPath(cfg, id, 'worker', round, 'json', { key });
  const rec = readJsonIf(p);
  if (!rec) return;
  state.writeJson(p, { ...rec, ...patch });
}

// ---- 前置（零副作用，由 routing.checkPrecondition 调用） ----

export function dispatchPrecondition(ts, cfg, decision) {
  const id = ts.id;
  if (readBriefText(ts).trim() === '') return 'brief 不存在或为空';
  if (everProducedSpec(cfg, id) && ts.runtime.spec_approved !== true) {
    return '本任务曾产出 spec，必须先过 spec 人闸才能委派执行';
  }
  const assignments = decision.assignments ?? [];
  const conflicts = writePathConflicts(assignments);
  if (conflicts.length > 0) return `并行写入范围未隔离：${conflicts.join('；')}`;

  const latest = new Map(latestAssignments(listLedgers(cfg, id)).map((a) => [a.key, a]));
  for (const a of assignments) {
    if (a.continue_from == null) continue;
    const prev = latest.get(a.key);
    const resumable = prev ? resumableSpawn(prev) : null;
    if (!resumable || resumable.round !== a.continue_from) {
      return `${a.key} 的 continue_from=${a.continue_from} 不是一个可续接的会话`
        + `（台账里可续接的是：${resumable ? `r${resumable.round}` : '无'}）；去掉 continue_from 重新分派，或换成台账标出的轮次`;
    }
    if (prev.profile !== a.profile) return `${a.key} 续接时 profile 不得改变（原 ${prev.profile}，现 ${a.profile}）：权限档变了就换一个 key 重派`;
  }
  return null;
}

// ---- 工作目录 ----

function placementsFor(assignments) {
  let inplaceTaken = false;
  return assignments.map((a) => {
    if (a.profile === 'read') return 'snapshot';
    if (a.profile === 'sandbox') return 'scratch';
    if (!inplaceTaken) { inplaceTaken = true; return 'inplace'; }
    return 'isolated';
  });
}

function prepareWorkdir(ctx, a) {
  const { cfg, id, repo, mainWt, baseHead, round } = ctx;
  if (a.placement === 'inplace') return mainWt;
  const wt = workerWorktreePath(cfg, id, a.profile, a.key);
  if (a.placement === 'isolated') {
    prepareBranchWorktree(repo, wt, a.branch, baseHead, {
      excludePatterns: HARNESS_ARTIFACTS.patterns, archiveTag: String(round), mergedInto: baseHead,
    });
    return wt;
  }
  // scratch 续做时保留上次的实验目录（装好的依赖还在）；其余一律重建为派出时刻的干净副本。
  if (a.placement === 'scratch' && a.continue_from != null && fs.existsSync(path.join(wt, '.git'))) return wt;
  const added = recreateDetachedWorktree(repo, wt, baseHead);
  if (!added.ok) throw new Error(`工作目录建不起来（${a.key}）：${added.error}`);
  return wt;
}

// ---- 单个委派的执行（含自动续接） ----

function progressTextOf(cfg, id, key, round) {
  const log = readJsonIf(logPathFor(cfg, id, 'worker', round, { key }));
  const lines = [];
  if (typeof log?.summary === 'string') lines.push(`summary: ${log.summary}`);
  if (Array.isArray(log?.done) && log.done.length > 0) lines.push(`done: ${log.done.join('；')}`);
  if (Array.isArray(log?.remaining) && log.remaining.length > 0) lines.push(`remaining: ${log.remaining.join('；')}`);
  const report = reportPathFor(cfg, id, 'worker', round, { key });
  if (fs.existsSync(report)) lines.push(`上一次的报告：${report}`);
  return lines.join('\n');
}

/** 这次会话有没有留下可核实的进展：write 看 worktree / HEAD，read 与 sandbox 看报告内容。 */
function progressEvidence(a, wt, before, reportPath) {
  if (a.profile === 'write') {
    return isDirty(wt) || headOf(wt) !== before.head || (before.dirtySig !== dirtySignature(wt)) ? 'changed' : 'none';
  }
  const sha = fileSha(reportPath);
  return sha != null && sha !== before.reportSha ? 'changed' : 'none';
}

function dirtySignature(wt) {
  const r = git(['status', '--porcelain'], wt);
  return r.status === 0 ? crypto.createHash('sha1').update(r.stdout).digest('hex') : null;
}

async function runAssignment(ctx, a, siblings) {
  const { ts, cfg, id, ledger, hasSpec, spec, digestPath, humanNotes } = ctx;
  const maxAuto = Number.isInteger(cfg.maxAutoContinues) && cfg.maxAutoContinues >= 0 ? cfg.maxAutoContinues : DEFAULT_MAX_AUTO_CONTINUES;
  const save = () => writeLedger(cfg, id, ledger);

  let wt;
  try {
    wt = prepareWorkdir(ctx, a);
  } catch (err) {
    a.state = 'skipped';
    a.note = `工作目录准备失败：${String(err.message).slice(0, 300)}`;
    save();
    return;
  }
  a.worktree = wt;

  // 续接来源：router 点名的那一轮（前置已核对过它确实可续），之后的自动续接接的是本循环里上一次。
  let resumeFrom = null;
  if (a.continue_from != null) {
    const prev = latestAssignments(listLedgers(cfg, id).filter((l) => l.round !== ledger.round)).find((x) => x.key === a.key);
    resumeFrom = prev ? resumableSpawn(prev) : null;
  }
  let autoContinues = 0;
  let first = true;

  for (;;) {
    if (budgetExceeded(ts, cfg)) { a.note = '任务预算已用尽，未（再）派出'; if (first) a.state = 'skipped'; break; }
    if (stopRequested(cfg)) { a.note = '收到停止请求，未（再）派出'; if (first) a.state = 'skipped'; break; }

    const m = first ? ctx.round : allocateRound(ts);
    const logPath = logPathFor(cfg, id, 'worker', m, { key: a.key });
    const reportPath = reportPathFor(cfg, id, 'worker', m, { key: a.key });
    const before = { head: headOf(wt), dirtySig: a.profile === 'write' ? dirtySignature(wt) : null, reportSha: fileSha(reportPath) };
    const prompt = buildWorkerPrompt(cfg, {
      id,
      assignment: a,
      logPath,
      reportPath,
      testCommand: ts.task.testCommand,
      hasSpec,
      specPath: spec?.path ?? '',
      specSha: spec?.sha256 ?? '',
      digestPath,
      briefText: hasSpec ? '' : readBriefText(ts),
      humanNotes,
      siblings,
      continuation: resumeFrom ? { round: resumeFrom.round, progress: progressTextOf(cfg, id, a.key, resumeFrom.round) } : null,
    });

    const spawnEntry = { round: m, resume_of: resumeFrom?.round ?? null, state: 'running', started_at: new Date().toISOString() };
    a.spawns.push(spawnEntry);
    a.state = 'running';
    save(); // 预写：崩溃后恢复流程据此知道「这一轮派出过」

    let res = await spawnAgentRound(ts, cfg, {
      role: 'worker', round: m, key: a.key, profile: a.profile, prompt, cwd: wt,
      resume: resumeFrom?.session_id ?? null,
      readRoots: a.profile === 'read' ? [wt, state.dossierPath(cfg, id)] : [],
      extraRecord: {
        intent: a.intent, title: a.title, dispatch_round: ledger.round, base_head: ledger.base_head,
        spec_sha: ledger.spec_sha, resume_of: resumeFrom?.round ?? null, placement: a.placement,
      },
    });

    if (spawnSkipped(res)) {
      a.spawns.pop();
      a.note = `未派出：${res.error === 'stop_requested' ? '收到停止请求' : '本次运行的限额 / runBudget 闸门已关'}`;
      if (first) a.state = 'skipped';
      save();
      break;
    }

    // 续会话起不来：同一轮次号下降级为带进度上下文的冷启动（两次的花费都已各自入账）。
    if (res.resumeFailed) {
      state.appendTimeline(cfg, id, `${workerBase(a.key)} r${m} 续会话失败（session 已失效），降级为带进度上下文的冷启动`);
      res = await spawnAgentRound(ts, cfg, {
        role: 'worker', round: m, key: a.key, profile: a.profile, prompt, cwd: wt, resume: null,
        readRoots: a.profile === 'read' ? [wt, state.dossierPath(cfg, id)] : [],
        extraRecord: {
          intent: a.intent, title: a.title, dispatch_round: ledger.round, base_head: ledger.base_head,
          spec_sha: ledger.spec_sha, resume_of: resumeFrom?.round ?? null, placement: a.placement, resume_fallback: true,
        },
      });
      if (spawnSkipped(res)) { a.spawns.pop(); if (first) a.state = 'skipped'; save(); break; }
    }

    const log = readJsonIf(logPath);
    const logOk = log != null && validateLog(log, 'worker').ok;
    const truncated = res.raw?.subtype === 'error_max_turns';
    const interrupted = Boolean(res.killed);
    const progress = progressEvidence(a, wt, before, reportPath);
    Object.assign(spawnEntry, {
      state: 'done',
      outcome: logOk ? log.outcome : null,
      truncated,
      interrupted,
      session_id: res.sessionId ?? null,
      progress,
      cost_usd: res.costUsd ?? 0,
      finished_at: new Date().toISOString(),
    });
    patchSpawnRecord(cfg, id, a.key, m, { progress });
    if (!logOk) {
      writeSalvage(artifactPath(cfg, id, 'worker', m, 'salvage.json', { key: a.key }), {
        role: 'worker', key: a.key, round: m,
        reason: interrupted ? 'interrupted' : truncated ? 'truncated' : (log == null ? 'log_missing' : 'log_invalid'),
        streamFile: artifactPath(cfg, id, 'worker', m, 'stream.jsonl', { key: a.key }),
        known: {
          profile: a.profile, worktree_dirty: a.profile === 'write' ? isDirty(wt) : null,
          head_moved: headOf(wt) !== before.head, report_written: fs.existsSync(reportPath), progress,
        },
      });
    }
    a.state = 'finished';
    save();
    first = false;

    if (isRateLimited(res)) {
      // 限额：本次 run 立刻不再发起新 spawn；收箱推迟到本轮已有工作提交、集成之后（不丢已做完的部分）。
      markRunRateLimited(cfg, typeof res.rate_limit?.resets_at === 'number' ? res.rate_limit.resets_at : null);
      ctx.rateLimitedRes ??= res;
      break;
    }

    // 自动续接：只处理「撞会话上限 + 有可核实的进展 + 还有续接额度」这一种机械情形；
    // 没进展、被中断、自述 blocked / needs_human 的，一律交回 router 判断。
    const canAuto = truncated && res.sessionId && progress === 'changed' && autoContinues < maxAuto
      && (!logOk || log.outcome === 'partial');
    if (!canAuto) break;
    autoContinues += 1;
    resumeFrom = { round: m, session_id: res.sessionId };
    state.appendTimeline(cfg, id, `${workerBase(a.key)} r${m} 撞会话上限且有进展，自动续接（${autoContinues}/${maxAuto}）`);
  }
}

// ---- 提交与集成（dispatch 收尾与崩溃恢复共用；全部幂等） ----

/**
 * 把一个委派已落盘的工作固化并集成进任务分支。可重入：每一步先看事实（worktree 脏不脏、
 * 分支是不是已经是任务 HEAD 的祖先），已经发生过的不重做。
 */
export function finalizeAssignment(ctx, a) {
  const { cfg, id, repo, mainWt, ledger, currentSpecSha } = ctx;
  if (['integrated', 'conflict', 'stale', 'skipped', 'done'].includes(a.state)) return;
  const save = () => writeLedger(cfg, id, ledger);
  const lastRound = a.spawns.length > 0 ? a.spawns[a.spawns.length - 1].round : ledger.round;
  const last = a.spawns.length > 0 ? a.spawns[a.spawns.length - 1] : null;
  const wt = a.worktree;

  if (a.profile !== 'write') {
    // 只读 / 实验：没有任何东西进产品。实验目录在可续接时留着，其余清掉。
    const keep = a.profile === 'sandbox' && last && (last.truncated || last.interrupted) && last.session_id;
    if (!keep && wt && wt !== mainWt) {
      try { removeWorktree(repo, wt); fs.rmSync(wt, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
    }
    a.state = 'done';
    save();
    return;
  }

  // 过期：派出时绑定的 spec 版本已经不是当前获批版本 → 结果只留作诊断，不进任务分支。
  if ((ledger.spec_sha ?? null) !== (currentSpecSha ?? null)) {
    a.state = 'stale';
    a.note = `派出时的 spec 版本 ${String(ledger.spec_sha).slice(0, 12)} 已不是当前获批版本，结果未集成（分支 / worktree 保留作诊断）`;
    if (wt && fs.existsSync(wt) && a.placement === 'isolated') commitIfDirty(wt, `task ${id}: worker ${a.key} r${lastRound} (stale, not integrated)`);
    save();
    return;
  }

  if (wt && fs.existsSync(path.join(wt, '.git'))) {
    const sha = commitIfDirty(wt, `task ${id}: worker ${a.key} r${lastRound}`);
    if (sha) a.commit_sha = sha;
    else a.commit_sha ??= headOf(wt);
  }
  a.state = 'committed';
  save();

  if (a.placement === 'inplace') {
    a.integrated_sha = headOf(mainWt);
  } else {
    const tip = headOf(repo, `refs/heads/${a.branch}`);
    const taskHead = headOf(mainWt);
    if (tip == null || tip === ledger.base_head || isAncestor(repo, tip, taskHead)) {
      a.integrated_sha = taskHead; // 没有新提交，或上次崩溃前已经合进去了：不重复集成
    } else {
      const merged = mergeInto(mainWt, a.branch, `task ${id}: integrate ${a.key} (r${lastRound})`);
      if (!merged.ok) {
        a.state = 'conflict';
        a.conflict_files = merged.conflict_files;
        a.note = `集成冲突，分支 ${a.branch} 保留（可 git diff ${taskBranchName(id)}...${a.branch} 参考）`;
        try { removeWorktree(repo, wt); fs.rmSync(wt, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
        save();
        return;
      }
      a.integrated_sha = merged.head;
    }
    try { removeWorktree(repo, wt); fs.rmSync(wt, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
    deleteBranch(repo, a.branch, { force: false });
  }

  a.changed_files = changedFilesBetween(repo, ledger.base_head, a.commit_sha ?? a.integrated_sha).slice(0, 200);
  a.out_of_scope_files = filesOutsideDeclared(a.changed_files, a.paths).slice(0, 50);
  a.state = 'integrated';
  save();
}

/** 收尾一份台账：逐个 finalize → 关账 → 事件与 timeline。dispatch 与恢复流程共用。 */
export function closeLedger(ctx, { recovered = false } = {}) {
  const { cfg, id, ledger } = ctx;
  for (const a of ledger.assignments) finalizeAssignment(ctx, a);
  ledger.closed = true;
  ledger.closed_at = new Date().toISOString();
  if (recovered) ledger.recovered = true;
  writeLedger(cfg, id, ledger);
  for (const a of ledger.assignments) {
    const last = a.spawns.length > 0 ? a.spawns[a.spawns.length - 1] : null;
    if (last) patchSpawnRecord(cfg, id, a.key, last.round, { integration: a.state });
  }
  const brief = ledger.assignments.map((a) => {
    const last = a.spawns.length > 0 ? a.spawns[a.spawns.length - 1] : null;
    return `${a.key}=${a.state}${last ? `(${last.outcome ?? '未知'}${last.truncated ? ',truncated' : ''}${last.interrupted ? ',interrupted' : ''})` : ''}`;
  }).join('  ');
  state.appendEventAlways(cfg, id, 'dispatch_result', {
    round: ledger.round,
    recovered,
    assignments: ledger.assignments.map((a) => ({
      key: a.key, profile: a.profile, state: a.state,
      outcome: a.spawns.length > 0 ? a.spawns[a.spawns.length - 1].outcome ?? null : null,
      spawns: a.spawns.map((s) => s.round), conflict_files: a.conflict_files ?? [],
    })),
  });
  state.appendTimeline(cfg, id, `dispatch r${ledger.round}${recovered ? '（崩溃后恢复收尾）' : ''}：${brief}`);
}

// ---- 动作入口 ----

export default async function dispatchAction(ts, cfg, { round, decision, records }) {
  const id = ts.id;
  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;

  const repo = taskCfg(ts, cfg).targetRepo;
  const mainWt = ensureWorktree(repo, worktreePath(cfg, id), taskBranchName(id), HARNESS_ARTIFACTS.patterns, ts.task.baseBranch);
  const baseHead = headOf(mainWt);
  const hasSpec = ts.runtime.spec_approved === true;
  const spec = hasSpec ? currentSpec(cfg, ts) : null;
  const digest = spec ? digestStateFor(cfg, id, spec) : null;

  const placements = placementsFor(decision.assignments);
  const assignments = decision.assignments.map((a, i) => ({
    ...a,
    placement: placements[i],
    branch: placements[i] === 'isolated' ? `${taskBranchName(id)}--${a.key}` : (placements[i] === 'inplace' ? taskBranchName(id) : null),
    worktree: null,
    state: 'bound',
    spawns: [],
    commit_sha: null,
    integrated_sha: null,
    conflict_files: [],
    changed_files: [],
    out_of_scope_files: [],
    note: null,
  }));
  const ledger = writeLedger(cfg, id, newLedger({ round, baseHead, specSha: spec?.sha256 ?? null, assignments }));
  const snapshot = snapshotProtected(cfg, ts, { round });

  const ctx = {
    ts, cfg, id, repo, mainWt, baseHead, round, ledger, hasSpec, spec,
    digestPath: digest?.state === 'valid' ? digest.path : '',
    humanNotes: specGateNotes(records),
    currentSpecSha: spec?.sha256 ?? null,
    rateLimitedRes: null,
  };

  // 并行派出：同一轮的委派之间没有顺序保证；并发数受配置约束，超出的排队。
  const limit = positiveInt(cfg.maxParallelAssignments, DEFAULT_MAX_PARALLEL_ASSIGNMENTS);
  let next = 0;
  const runner = async () => {
    while (next < assignments.length) {
      const a = assignments[next++];
      const siblings = assignments.filter((x) => x !== a);
      try {
        await runAssignment(ctx, a, siblings);
      } catch (err) {
        a.note = `内核执行异常：${String(err?.message ?? err).slice(0, 300)}`;
        if (a.state === 'bound' || a.state === 'running') a.state = a.spawns.length > 0 ? 'finished' : 'skipped';
        writeLedger(cfg, id, ledger);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, assignments.length) }, runner));

  // 实验 / 只读不得移动任务分支：本轮没有任何 write 委派时，任务分支必须原样。
  const violations = verifyProtected(snapshot, {
    expectedBases: assignments.map((a) => workerBase(a.key)),
  });
  if (!assignments.some((a) => a.profile === 'write') && headOf(mainWt) !== baseHead) {
    git(['reset', '--hard', baseHead], mainWt);
    violations.push({ path: `refs/heads/${taskBranchName(id)}`, kind: 'branch_moved', restored: headOf(mainWt) === baseHead });
  }

  closeLedger(ctx);

  if (violations.length > 0) {
    state.appendEventAlways(cfg, id, 'boundary_violation', {
      round, violations: violations.map((v) => ({ ...v, path: relRef(cfg, v.path) })),
    });
    for (const a of assignments) {
      const last = a.spawns.length > 0 ? a.spawns[a.spawns.length - 1] : null;
      if (last && a.profile !== 'read') patchSpawnRecord(cfg, id, a.key, last.round, { violations: violations.map((v) => `${v.kind}:${relRef(cfg, v.path)}`) });
    }
  }

  if (ctx.rateLimitedRes) {
    const limited = rateLimitedToBox(ts, cfg, 'worker', ctx.rateLimitedRes);
    if (limited) return limited;
  }
  if (violations.length > 0) {
    return openHumanGate(ts, cfg, {
      kind: 'help',
      requestedBy: 'kernel',
      summary: `r${round} 的执行越过了授权边界，内核已还原 / 隔离并停下等你裁决：\n${violations.map((v) => `- ${v.kind}: ${relRef(cfg, v.path)}${v.restored ? '（已还原）' : '（未能还原）'}`).join('\n')}`,
      refs: [relRef(cfg, state.dossierPath(cfg, id, `dispatch-r${round}.json`))],
      round,
    });
  }
  return { changed: true };
}

/** treeOf 供 routing 的停滞保险丝用（任务分支的代码到底变没变）。 */
export { treeOf };
