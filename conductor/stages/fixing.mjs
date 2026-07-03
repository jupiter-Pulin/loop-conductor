// FIXING（契约 §11）：round=makerRound(miss)。fixingMode 决定 resume/cold。
// buildMakerRepairPrompt（resume）/ buildMakerColdPrompt(fullDossier)（cold）。
// ensureWorktree(+excludes) → checkTrackedHarness → spawn maker → green gate → 同 READY 的 pass/fail 路由。
// 幂等：maker-r<round>.json 双标记；崩溃残留（started 无 done）转 FAILED_BOX（crashed），retry 恢复。
import * as state from '../lib/state.mjs';
import { ensureWorktree, checkTrackedHarness } from '../lib/git.mjs';
import { markerStatus, greenGatePassed, makerMissNext, fixingMode, makerRound } from './decisions.mjs';
import {
  worktreePath, runGreenGate, writeGreenGateResult, buildRepairContext, writeRepairContext,
  runMakerRound, buildMakerColdPrompt, buildMakerRepairPrompt,
  budgetExceeded, failToBox, HARNESS_ARTIFACTS,
} from './shared.mjs';

export default function fixingHandler(ts, cfg) {
  const id = ts.id;
  const miss = ts.runtime.maker_miss_count ?? 0;
  const round = makerRound(miss); // miss==1 → r2，miss==2 → r3
  const marker = state.readJsonIf(state.dossierPath(cfg, id, `maker-r${round}.json`));
  const status = markerStatus(marker);

  if (status === 'in-progress') {
    // 有 started 无 done = 上次 run 在 spawn 中途崩溃。不滞留：收箱待人工 retry 恢复。
    return failToBox(
      ts, cfg,
      `crashed: maker-r${round} 有 started 无 done（上次 conductor 中断）。\`conductor retry ${id}\` 可恢复`,
      'crashed',
    );
  }

  if (status === 'none') {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}，拒绝 spawn`, 'budget_exceeded');
    }
    const wt = ensureWorktree(cfg.targetRepo, worktreePath(cfg, id), `task/${id}`, HARNESS_ARTIFACTS.patterns);
    const conflicts = checkTrackedHarness(wt, HARNESS_ARTIFACTS.tracked);
    if (conflicts.length > 0) {
      return failToBox(
        ts, cfg,
        `已知 harness artifact 已被目标仓库追踪（${conflicts.join(', ')}），不静默删除`,
        'tracked_harness_artifact_conflict',
      );
    }
    ts.runtime.verifier_invalid_count = 0; // 新 maker 轮：重置 verifier 协议失败计数
    const mode = fixingMode(miss, ts.runtime.maker_session_id);
    const coldPrompt = buildMakerColdPrompt(ts, cfg, round, { fullDossier: true });
    const prompt = mode === 'resume' ? buildMakerRepairPrompt(ts, cfg, round) : coldPrompt;
    const res = runMakerRound(ts, cfg, round, { mode, prompt, coldPrompt, wt });
    if (res?.retriesExhausted) {
      // maker spawn 瞬态重试耗尽（基础设施失败）：直接收箱，不跑 green gate、不进 miss 阶梯（契约 §15）。
      return failToBox(ts, cfg, `maker spawn 瞬态重试耗尽 (r${round})`, 'spawn_transient_exhausted');
    }
    // maker 非瞬态硬失败（ok=false，如 max-turns 打断）不在此分支：worktree 状态未知，
    // 必须继续跑 green gate 实测（绿门是唯一事实源），红了照常计一次 maker miss。
    // 基础设施失败可能因此被计入 miss 阶梯——接受此取舍；timeline 已记 ok=false 供人工归因。
  } else {
    ensureWorktree(cfg.targetRepo, worktreePath(cfg, id), `task/${id}`, HARNESS_ARTIFACTS.patterns);
  }

  const wt = worktreePath(cfg, id);
  const startedAt = new Date().toISOString();
  const gate = runGreenGate(ts.task.testCommand, wt);
  const finishedAt = new Date().toISOString();
  writeGreenGateResult(cfg, id, round, {
    command: ts.task.testCommand,
    exitCode: gate.exitCode,
    stdout: gate.stdout,
    stderr: gate.stderr,
    startedAt,
    finishedAt,
  });
  state.appendTimeline(cfg, id, `green gate r${round}: exit ${gate.exitCode}`);

  if (greenGatePassed(gate.exitCode)) {
    state.transitionState(ts, cfg, 'VERIFY', `green gate pass r${round}`, { current_round: round });
    return { changed: true };
  }

  const ctx = buildRepairContext({ source: 'green_gate', round });
  writeRepairContext(cfg, id, round, ctx);
  const next = makerMissNext(ts.runtime.maker_miss_count ?? 0, cfg.maxMakerMisses);
  if (next.stage === 'FAILED_BOX') {
    return failToBox(
      ts, cfg,
      `green gate failed (exit ${gate.exitCode}) at r${round}，miss ${next.missCount} 阶梯耗尽`,
      'maker_misses_exhausted',
      { maker_miss_count: next.missCount }, // 递增后的 miss 一并落盘
    );
  }
  state.transitionState(ts, cfg, 'FIXING', `green gate fail r${round}, miss=${next.missCount}`, {
    maker_miss_count: next.missCount,
    current_round: round,
  });
  return { changed: true };
}
