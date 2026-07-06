// READY（契约 §11）：round=1。ensureWorktree(+excludes) → checkTrackedHarness →
// spawn maker（cold）→ conductor 亲跑 green gate → writeGreenGateResult。
// pass → test gate 探针（vacuous → 同 miss 阶梯 FIXING/FAILED_BOX）→ VERIFY；
// fail → 先判失败签名连续性：同签名连败 2 轮且环境类 → 短路收箱（env_failure_repeated，不
//        spawn 下一轮 maker）；否则 writeRepairContext(green_gate)（同签名非环境类附
//        same_signature_streak 提示）+ makerMissNext → FIXING / FAILED_BOX。
// 幂等：maker-r1.json 有 started 无 done → 上次崩溃，转 FAILED_BOX（crashed），retry 可恢复；
//       有 done → 跳过 spawn，仅复跑 green gate 完成转移（env_failure_repeated 窄恢复复用此路径）。
import * as state from '../lib/state.mjs';
import { ensureWorktree, checkTrackedHarness } from '../lib/git.mjs';
import { taskCfg } from '../lib/task-cfg.mjs';
import { markerStatus, greenGatePassed, makerMissNext, makerRound, sameSignatureStreak } from './decisions.mjs';
import { isEnvFailureSignature } from '../lib/failure-signature.mjs';
import {
  worktreePath, runGreenGate, writeGreenGateResult, runTestGateProbe,
  buildRepairContext, writeRepairContext, readGreenGateSignatures,
  runMakerRound, buildMakerColdPrompt, ensureDossierSpec, budgetExceeded, failToBox,
  HARNESS_ARTIFACTS, canStartSpawn,
} from './shared.mjs';

export default async function readyHandler(ts, cfg) {
  const id = ts.id;
  const tRepo = taskCfg(ts, cfg).targetRepo;
  const round = makerRound(ts.runtime.maker_miss_count); // READY 时 miss 恒为 0 → r1
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
    if (!canStartSpawn(ts, cfg, 'maker')) return { changed: false };
    ensureDossierSpec(ts, cfg); // bugfix 档在此从 state/queue/<id>/spec.md 冻结进 dossier
    const wt = ensureWorktree(tRepo, worktreePath(cfg, id), `task/${id}`, HARNESS_ARTIFACTS.patterns);
    const conflicts = checkTrackedHarness(wt, HARNESS_ARTIFACTS.tracked);
    if (conflicts.length > 0) {
      return failToBox(
        ts, cfg,
        `已知 harness artifact 已被目标仓库追踪（${conflicts.join(', ')}），不静默删除`,
        'tracked_harness_artifact_conflict',
      );
    }
    ts.runtime.verifier_invalid_count = 0; // 新 maker 轮：重置 verifier 协议失败计数
    const prompt = buildMakerColdPrompt(ts, cfg, round);
    const res = await runMakerRound(ts, cfg, round, { mode: 'cold', prompt, wt });
    if (res?.retriesExhausted) {
      // maker spawn 瞬态重试耗尽（基础设施失败，非 maker 可行动失败）：
      // 保留旧行为，直接收箱，不跑 green gate、不进 miss 阶梯（契约 §15）。
      return failToBox(ts, cfg, `maker spawn 瞬态重试耗尽 (r${round})`, 'spawn_transient_exhausted');
    }
    // maker 非瞬态硬失败（ok=false，如 max-turns 打断）不在此分支：worktree 状态未知，
    // 必须继续跑 green gate 实测（绿门是唯一事实源），红了照常计一次 maker miss。
    // 基础设施失败可能因此被计入 miss 阶梯——接受此取舍；timeline 已记 ok=false 供人工归因。
  } else {
    // done 标记已在：跳过 spawn，仅确保环境后复跑 green gate
    ensureWorktree(tRepo, worktreePath(cfg, id), `task/${id}`, HARNESS_ARTIFACTS.patterns);
    ensureDossierSpec(ts, cfg);
  }

  const wt = worktreePath(cfg, id);
  const startedAt = new Date().toISOString();
  const gate = await runGreenGate(ts.task.testCommand, wt, { timeoutMs: cfg.greenGateTimeoutMs });
  const finishedAt = new Date().toISOString();
  const gateRecord = writeGreenGateResult(cfg, id, round, {
    command: ts.task.testCommand,
    exitCode: gate.exitCode,
    timedOut: gate.timedOut,
    stdout: gate.stdout,
    stderr: gate.stderr,
    startedAt,
    finishedAt,
  });
  state.appendTimeline(cfg, id, `green gate r${round}: ${gate.timedOut ? 'timed out' : `exit ${gate.exitCode}`}`);

  if (greenGatePassed(gate.exitCode)) {
    // 第二道闸：test gate（基线空转测试探针）。仅 vacuous block，走同一 miss 阶梯；
    // falsifies / error / disabled(null) 照常进 VERIFY（单侧闸门，见 shared.mjs::runTestGateProbe）。
    const probe = await runTestGateProbe(ts, cfg, round);
    if (probe?.verdict === 'vacuous') {
      const tgCtx = buildRepairContext({ source: 'test_gate', round, probe });
      writeRepairContext(cfg, id, round, tgCtx);
      const tgNext = makerMissNext(ts.runtime.maker_miss_count ?? 0, cfg.maxMakerMisses);
      if (tgNext.stage === 'FAILED_BOX') {
        return failToBox(
          ts, cfg,
          `test gate vacuous at r${round}（测试在基线上仍全绿），miss ${tgNext.missCount} 阶梯耗尽`,
          'maker_misses_exhausted',
          { maker_miss_count: tgNext.missCount },
        );
      }
      state.transitionState(ts, cfg, 'FIXING', `test gate vacuous r${round}, miss=${tgNext.missCount}`, {
        maker_miss_count: tgNext.missCount,
        current_round: round,
      });
      return { changed: true };
    }
    state.transitionState(ts, cfg, 'VERIFY', `green gate pass r${round}`, { current_round: round });
    return { changed: true };
  }

  // green gate 失败：先判本攻坚周期的失败签名连续性（同签名连败短路环境类，见 failure-signature.mjs）。
  const streak = sameSignatureStreak(readGreenGateSignatures(cfg, id, round));
  if (streak >= 2 && isEnvFailureSignature(gateRecord.signature)) {
    const missCount = (ts.runtime.maker_miss_count ?? 0) + 1;
    return failToBox(
      ts, cfg,
      `green gate 连续 ${streak} 轮同签名失败，判定环境类（token: ${gateRecord.signature.errorTokens.join(', ')}；` +
      `失败测试：${gateRecord.signature.failingTests.join(', ')}），短路 miss 阶梯，不再 spawn 下一轮 maker`,
      'env_failure_repeated',
      { maker_miss_count: missCount },
    );
  }

  // 写 repair-context(green_gate)，按 miss 阶梯路由（不直接收箱，除非阶梯耗尽）。
  const ctx = buildRepairContext({
    source: 'green_gate', round,
    sameSignatureStreak: streak >= 2 ? streak : undefined,
    failingTests: streak >= 2 ? gateRecord.signature?.failingTests : undefined,
  });
  writeRepairContext(cfg, id, round, ctx);
  const next = makerMissNext(ts.runtime.maker_miss_count ?? 0, cfg.maxMakerMisses);
  if (next.stage === 'FAILED_BOX') {
    return failToBox(
      ts, cfg,
      `green gate failed (${gate.timedOut ? 'timeout' : `exit ${gate.exitCode}`}) at r${round}，miss ${next.missCount} 阶梯耗尽`,
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
