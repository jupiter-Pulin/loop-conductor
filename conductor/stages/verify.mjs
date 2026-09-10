// VERIFY（契约 §11）：round=makerRound(miss)。spawn verifier（纯只读，不跑测试）→
// parseStrictJson + validateVerifierVerdict：
//   invalid → 写 verify-r<n>.invalid-a<m>.json、verifierInvalidNext（留 VERIFY 重试 / 收箱），
//             不写 verdict、不写 repair-context、不增 maker_miss_count。
//   valid   → 写 verify-r<n>.verdict.json、verify-r<n>.md（conductor 从 verdict 渲染的人读报告）、
//             重置 verifier_invalid_count；
//             verdictNext：pass→AWAIT_HUMAN_MERGE；fail→writeRepairContext(verifier)+makerMissNext→FIXING/FAILED_BOX。
// 幂等：verify-r<n>.verdict.json 已存在 → 直接按 verdictNext 消费，不重 spawn。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { runClaude, runClaudeWithRetry, isRateLimited } from '../lib/claude.mjs';
import { runCodexExec } from '../lib/codex.mjs';
import { markRunRateLimited } from '../lib/scheduler.mjs';
import { mergeBaseWith, diffNameStatusAgainstBase, parseNameStatusPaths, showFileAtRef, diffNumstatAgainstBase } from '../lib/git.mjs';
import {
  parseStrictJson, validateVerifierVerdict, verdictNext, verifierInvalidNext, makerMissNext, makerRound,
  checkEvidenceAnchors, validateReviewReport, evaluateAutoMerge, parseNumstat,
} from './decisions.mjs';
import {
  worktreePath, buildVerifierPrompt, buildReviewerPrompt, buildRepairContext, writeRepairContext, renderVerifyReport,
  budgetExceeded, failToBox, startSpawnRecord, finishSpawnRecord, VERIFIER_TOOLS, canStartSpawn,
  computeTestChangeGuard, accountSpawnCost, performMerge, rateLimitedToBox,
} from './shared.mjs';

export default async function verifyHandler(ts, cfg) {
  const id = ts.id;
  const round = makerRound(ts.runtime.maker_miss_count); // 轮次与刚产出 diff 的 maker round 对齐
  const verdictPath = state.dossierPath(cfg, id, `verify-r${round}.verdict.json`);

  // 幂等分支：verdict 文件已存在 → 直接消费（不重 spawn）。
  const existing = state.readJsonIf(verdictPath);
  if (existing) {
    state.appendTimeline(cfg, id, `verifier r${round} verdict 已存在，直接消费（幂等重入）`);
    return consumeValidVerdict(ts, cfg, round, existing);
  }

  if (budgetExceeded(ts, cfg)) {
    return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}，拒绝 spawn verifier`, 'budget_exceeded');
  }
  if (!canStartSpawn(ts, cfg, 'verifier')) return { changed: false };

  // conductor 枚举 spec 的 AC（既喂 prompt 又作校验 expectedAcIds）。
  const specMd = readDossierSpecRaw(ts, cfg);
  const acList = state.extractAcceptanceCriteria(specMd);
  const expectedAcIds = acList.map((a) => a.ac_id);

  // H16 测试改动守卫（观测型）：非空时注入 prompt 段 + timeline，绝不影响路由。
  // H32/E27：命中同步落机械产物 verify-r<n>.test-change-guard.json——周报/签名台账的聚合源
  // （此前只有 timeline/prompt/merge stdout 三面人读出证，机器无从消费）。
  const testChanges = computeTestChangeGuard(ts, cfg);
  if (testChanges) {
    state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.test-change-guard.json`), {
      schema_version: 1, round, ...testChanges,
    });
    state.appendTimeline(cfg, id, `verifier r${round} test-change guard：modified ${testChanges.modified.length} / deleted ${testChanges.deleted.length} / renamed ${testChanges.renamed.length}（已注入 prompt，观测不 block）`);
  }
  const prompt = buildVerifierPrompt(ts, cfg, round, acList, testChanges);
  const streamFile = state.dossierPath(cfg, id, `verifier-r${round}.stream.jsonl`);
  const rec = startSpawnRecord(cfg, id, 'verifier', round, {
    stream_file: path.relative(cfg.root, streamFile),
  });
  const res = await runClaudeWithRetry({
    cwd: worktreePath(cfg, id),
    prompt,
    maxTurns: cfg.maxTurns,
    model: cfg.models?.verifier ?? null,
    tools: VERIFIER_TOOLS,        // 工具集硬限制
    allowedTools: VERIFIER_TOOLS, // 免审批放行同一集合
    streamFile,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    wallClockMs: cfg.spawnWallClockMs,
  }, {
    retries: cfg.spawnRetries,
    backoffMs: cfg.spawnBackoffMs,
    onRetry: ({ attempt, status }) =>
      state.appendTimeline(cfg, id, `verifier r${round} transient retry attempt ${attempt} (status=${status ?? 'spawn-error'})`),
  });
  finishSpawnRecord(rec, res);
  accountSpawnCost(ts, cfg, 'verifier', round, res);
  state.saveRuntime(ts); // 成本先落盘

  const limited = rateLimitedToBox(ts, cfg, 'verifier', res);
  if (limited) return limited; // 限额：进箱等人在 resets_at 后 retry，不计 invalid、不重 spawn
  if (!res.ok) {
    // 基建失败（spawn 错误 / killed / 非零退出 / 无 result 事件，瞬态重试已耗尽）：
    // 不是 verifier 的协议失败，不计 invalid、不动 verifier_invalid_count，留在 VERIFY 下次 run 重 spawn。
    state.appendTimeline(cfg, id, `verifier r${round} 基建失败（${res.error ?? 'unknown'}），任务留在 VERIFY，下次 run 重试`);
    return { changed: false };
  }

  // 严格解析 + schema 校验：绝不在叙事里打捞 JSON。
  const parsed = parseStrictJson(res.result);
  const check = validateVerifierVerdict(parsed, expectedAcIds);

  // ---- H15 evidence 机械锚定核验（config 开关，默认 off = 旧行为）----
  // observe：只落对照产物 + timeline，不影响任何路由；
  // enforce：hard 错误（文件不存在 / 行号越界，客观幻觉）走协议 invalid 阶梯；
  //          soft（引用 diff 外文件）任何模式都只记录——verifier 有全树只读权，合法。
  let invalidErrors = check.ok ? null : check.errors;
  let anchors = null;
  const anchorsMode = cfg.verifierEvidenceAnchorsMode ?? 'off';
  if (check.ok && (anchorsMode === 'observe' || anchorsMode === 'enforce')) {
    anchors = computeEvidenceAnchors(ts, cfg, check.verdict);
    if (anchorsMode === 'enforce' && anchors.hard.length > 0) {
      invalidErrors = anchors.hard.map((h) => (h.reason === 'line_out_of_range'
        ? `evidence 行号越界：${h.ac_id} ${h.file}:${h.start_line}-${h.end_line}（文件共 ${h.file_lines} 行）`
        : `evidence 文件不存在（worktree 与 base 均无）：${h.ac_id} ${h.file}`));
    } else {
      state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.evidence-anchors.json`), {
        schema_version: 1,
        round,
        mode: anchorsMode,
        hard_count: anchors.hard.length,
        soft_count: anchors.soft.length,
        hard: anchors.hard,
        soft: anchors.soft,
      });
      state.appendTimeline(cfg, id, `verifier r${round} evidence anchors ${anchorsMode}：hard ${anchors.hard.length} / soft ${anchors.soft.length}`);
    }
  }

  if (invalidErrors) {
    // ---- invalid verifier 输出（协议失败或 enforce 锚定硬错误）：不是 maker 失败 ----
    const m = (ts.runtime.verifier_invalid_count ?? 0) + 1;
    state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.invalid-a${m}.json`), {
      schema_version: 1,
      round,
      attempt: m,
      errors: invalidErrors,
      // enforce 锚定拒收时附全量锚定明细（含 soft），供分析误杀率
      ...(check.ok && anchors ? { anchor_mismatches: anchors } : {}),
      raw_result: res.result ?? null,
    });
    const next = verifierInvalidNext(ts.runtime.verifier_invalid_count ?? 0, cfg.maxVerifierInvalidRetries);
    state.appendTimeline(cfg, id, `verifier r${round} invalid 第 ${m} 次：${invalidErrors.join('; ')}`);
    state.appendEvent(cfg, id, 'verifier_invalid', { round, attempt: m, errors_count: invalidErrors.length, anchors_enforced: Boolean(check.ok && anchors) });
    if (next.stage === 'FAILED_BOX') {
      return failToBox(
        ts, cfg,
        `verifier 协议失败超过上限（${cfg.maxVerifierInvalidRetries}），收箱`,
        next.failureType, // 'verifier_protocol_exhausted'
        { verifier_invalid_count: next.invalidCount }, // 递增后的计数一并落盘，与 invalid-a<m> 产物/timeline 对齐
      );
    }
    // 留在 VERIFY 重试：仅更新 verifier_invalid_count，stage 不变；返回 changed:true 让 drain 再进 VERIFY 重 spawn。
    ts.runtime.verifier_invalid_count = next.invalidCount;
    state.saveRuntime(ts);
    return { changed: true };
  }

  // ---- valid verdict：落盘 verdict + 渲染人读报告，重置 verifier_invalid_count ----
  // 报告由 conductor 从 verdict 渲染（合法 verifier 输出被强制为纯 JSON，原文没有叙事可留）。
  state.writeJson(verdictPath, check.verdict);
  state.writeFileEnsured(
    state.dossierPath(cfg, id, `verify-r${round}.md`),
    renderVerifyReport(check.verdict, round),
  );
  ts.runtime.verifier_invalid_count = 0;
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `verifier r${round} verdict: ${check.verdict.overall} (cost=$${res.costUsd})`);
  state.appendEvent(cfg, id, 'verifier_verdict', { round, overall: check.verdict.overall, cost_usd: res.costUsd ?? null });

  // ---- verifier shadow（opt-in 观测实验，契约：默认关闭；开启也绝不影响状态机）----
  // 主 verdict 已落盘后才跑；shadow 的任何失败（spawn/协议/异常）只留 shadow 证据与 timeline，
  // 不写 verifier_invalid_count、不改 stage、不产生 repair-context。幂等：compare 已存在不重跑。
  if (cfg.verifierShadowEnabled === true) {
    try {
      await runVerifierShadow(ts, cfg, round, check.verdict, { prompt, expectedAcIds, mainCostUsd: res.costUsd });
    } catch (err) {
      state.appendTimeline(cfg, id, `verifier shadow 异常（已忽略，不影响主链）：${String(err)}`);
    }
  }

  // ---- H21 Reviewer shadow（config reviewStage='shadow'，默认 off）----
  // 只在主 verdict pass 后跑（false-pass 猎手）；best-effort：任何失败只留证据与 timeline，
  // 不影响 stage、不计 verifier_invalid_count、不产生 repair-context。幂等：compare 已存在不重跑。
  if (cfg.reviewStage === 'shadow' && check.verdict.overall === 'pass') {
    try {
      await runReviewerShadow(ts, cfg, round, check.verdict, { acList, expectedAcIds });
    } catch (err) {
      state.appendTimeline(cfg, id, `reviewer shadow 异常（已忽略，不影响主链）：${String(err)}`);
    }
  }
  return consumeValidVerdict(ts, cfg, round, check.verdict);
}

/**
 * H21：独立 Reviewer 影子轮。同 worktree 冷读 diff（不喂 verifier verdict / maker 叙述），
 * 契约 review-diff/v1（validateReviewReport 唯一裁判）。产物（dossier/<id>/）：
 *   review-r<n>.json          —— 合法 report（含机械推导 metrics/blockers）
 *   review-r<n>.invalid.json  —— 基建/协议失败证据（不计主 invalid）
 *   reviewer-r<n>.json/.stream.jsonl —— spawn 双标记与事件流
 *   review-r<n>.compare.json  —— 与主 verdict 的分歧对照（H22 升 gate 的数据源）
 * disagreement = review gate ≠ ready（verifier pass 前提下）；high_risk = gate = blocked。
 */
async function runReviewerShadow(ts, cfg, round, mainVerdict, { acList, expectedAcIds }) {
  const id = ts.id;
  const comparePath = state.dossierPath(cfg, id, `review-r${round}.compare.json`);
  if (state.readJsonIf(comparePath)) return; // 幂等重入不重跑
  if (budgetExceeded(ts, cfg)) {
    state.appendTimeline(cfg, id, `reviewer shadow r${round} 跳过（budget exceeded），不影响主链`);
    return;
  }
  state.appendTimeline(cfg, id, `reviewer shadow r${round} spawn (model=${cfg.models?.reviewer ?? 'default'})`);
  const streamFile = state.dossierPath(cfg, id, `reviewer-r${round}.stream.jsonl`);
  const rec = startSpawnRecord(cfg, id, 'reviewer', round, {
    stream_file: path.relative(cfg.root, streamFile),
  });
  // best-effort 单次 spawn（无瞬态重试阶梯——shadow 不值得吃退避；失败即记 infra）
  const res = await runClaude({
    cwd: worktreePath(cfg, id),
    prompt: buildReviewerPrompt(ts, cfg, round, acList),
    maxTurns: cfg.maxTurns,
    model: cfg.models?.reviewer ?? null,
    tools: VERIFIER_TOOLS,
    allowedTools: VERIFIER_TOOLS,
    streamFile,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    wallClockMs: cfg.spawnWallClockMs,
  });
  finishSpawnRecord(rec, res);
  accountSpawnCost(ts, cfg, 'reviewer', round, res);
  state.saveRuntime(ts);

  let review = { valid: false, gate: null, metrics: null, invalid_kind: null };
  // shadow 命中限额：只把本次 run 标记为「不再发起新 spawn」，绝不把主链任务收箱
  // （shadow 是观测面，永不影响状态机）。
  if (isRateLimited(res)) markRunRateLimited(cfg, res.rate_limit?.resets_at ?? null);
  if (!res.ok) {
    review.invalid_kind = 'infra';
    state.writeJson(state.dossierPath(cfg, id, `review-r${round}.invalid.json`), {
      schema_version: 1, round, kind: 'infra', error: res.error ?? 'unknown',
    });
    state.appendTimeline(cfg, id, `reviewer shadow r${round} 基建失败（不影响主链）：${res.error ?? 'unknown'}`);
  } else {
    const check = validateReviewReport(parseStrictJson(res.result), expectedAcIds);
    if (!check.ok) {
      review.invalid_kind = 'protocol';
      state.writeJson(state.dossierPath(cfg, id, `review-r${round}.invalid.json`), {
        schema_version: 1, round, kind: 'protocol', errors: check.errors, raw_result: res.result ?? null,
      });
      state.appendTimeline(cfg, id, `reviewer shadow r${round} 协议失败（不计主 invalid）：${check.errors.join('; ')}`);
    } else {
      review = { valid: true, gate: check.report.gate, metrics: check.report.metrics, invalid_kind: null };
      state.writeJson(state.dossierPath(cfg, id, `review-r${round}.json`), check.report);
    }
  }

  const disagreement = review.valid ? review.gate !== 'ready' : null;
  const highRisk = review.valid ? review.gate === 'blocked' : null;
  state.writeJson(comparePath, {
    schema_version: 1,
    round,
    main: { overall: mainVerdict.overall },
    review: { ...review, cost_usd: res.costUsd ?? null },
    disagreement,
    high_risk: highRisk,
  });
  state.appendEvent(cfg, id, 'review_shadow', {
    round, valid: review.valid, gate: review.gate, disagreement, high_risk: highRisk, invalid_kind: review.invalid_kind,
  });
  state.appendTimeline(
    cfg, id,
    review.valid
      ? `reviewer shadow r${round} 对照落盘：main=pass / review gate=${review.gate}（P0×${review.metrics.p0} P1×${review.metrics.p1} P2×${review.metrics.p2}）${highRisk ? ' ⚠ HIGH-RISK（false-pass 候选）' : ''}`
      : `reviewer shadow r${round} 无有效 report（${review.invalid_kind}），compare 记录 review 无效`,
  );
}

/**
 * Codex shadow verifier：同 prompt、同 worktree、同契约校验（validateVerifierVerdict），
 * 不同引擎（codex exec，read-only 沙箱）。产物（dossier/<id>/）：
 *   verify-r<n>.codex-shadow.verdict.json / .md      —— 合法 shadow verdict + 人读报告
 *   verify-r<n>.codex-shadow.invalid.json            —— 基建失败或协议失败证据（不计主 invalid）
 *   verify-r<n>.codex-shadow.stream.jsonl            —— codex 事件流
 *   verify-r<n>.shadow-compare.json                  —— 逐 AC 对照（切换裁决的数据源）
 */
async function runVerifierShadow(ts, cfg, round, mainVerdict, { prompt, expectedAcIds, mainCostUsd }) {
  const id = ts.id;
  const backend = cfg.verifierShadowBackend ?? 'codex-exec';
  const comparePath = state.dossierPath(cfg, id, `verify-r${round}.shadow-compare.json`);
  if (state.readJsonIf(comparePath)) return; // 幂等重入不重跑 shadow
  if (backend !== 'codex-exec') {
    state.appendTimeline(cfg, id, `verifier shadow 跳过：未知 backend「${backend}」（当前仅支持 codex-exec）`);
    return;
  }
  state.appendTimeline(cfg, id, `verifier shadow r${round} spawn (codex-exec, model=${cfg.verifierShadowModel ?? 'default'})`);
  const res = await runCodexExec({
    prompt,
    cwd: worktreePath(cfg, id),
    model: cfg.verifierShadowModel ?? null,
    sandbox: 'read-only',
    outputLastMessage: state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.last-message.txt`),
    streamFile: state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.stream.jsonl`),
    timeoutMs: cfg.verifierShadowTimeoutMs,
  });

  let shadow = { valid: false, overall: null, by_ac: null, invalid_kind: null };
  if (!res.ok) {
    shadow.invalid_kind = 'infra';
    state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.invalid.json`), {
      schema_version: 1, round, kind: 'infra', error: res.error ?? 'unknown', exit_code: res.exitCode ?? null,
    });
    state.appendTimeline(cfg, id, `verifier shadow r${round} 基建失败（不影响主链）：${res.error ?? 'unknown'}`);
  } else {
    const parsed = parseStrictJson(res.result);
    const check = validateVerifierVerdict(parsed, expectedAcIds);
    if (!check.ok) {
      shadow.invalid_kind = 'protocol';
      state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.invalid.json`), {
        schema_version: 1, round, kind: 'protocol', errors: check.errors, raw_result: res.result ?? null,
      });
      state.appendTimeline(cfg, id, `verifier shadow r${round} 协议失败（不计主 invalid）：${check.errors.join('; ')}`);
    } else {
      shadow = {
        valid: true,
        overall: check.verdict.overall,
        by_ac: Object.fromEntries(check.verdict.criteria_results.map((c) => [c.ac_id, c.status])),
        invalid_kind: null,
      };
      state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.verdict.json`), check.verdict);
      state.writeFileEnsured(
        state.dossierPath(cfg, id, `verify-r${round}.codex-shadow.md`),
        renderVerifyReport(check.verdict, round),
      );
    }
  }

  // 逐 AC 对照：high_risk = 主裁 fail/unknown 而 shadow 裁 pass（false-pass 风险，切换否决项）。
  const mainByAc = Object.fromEntries(mainVerdict.criteria_results.map((c) => [c.ac_id, c.status]));
  const disagreements = [];
  let agreed = 0;
  if (shadow.valid) {
    for (const acId of expectedAcIds) {
      const m = mainByAc[acId] ?? null;
      const s = shadow.by_ac[acId] ?? null;
      if (m === s) agreed++;
      else disagreements.push({ ac_id: acId, main: m, shadow: s, high_risk: s === 'pass' && (m === 'fail' || m === 'unknown') });
    }
  }
  state.writeJson(comparePath, {
    schema_version: 1,
    round,
    backend,
    shadow_model: cfg.verifierShadowModel ?? null,
    main: { overall: mainVerdict.overall, by_ac: mainByAc, cost_usd: mainCostUsd ?? null },
    shadow: { ...shadow, duration_ms: res.durationMs ?? null, usage: res.usage ?? null, error: res.error ?? null },
    agreement: shadow.valid
      ? { total_acs: expectedAcIds.length, agreed, disagreements, high_risk_count: disagreements.filter((d) => d.high_risk).length }
      : null,
  });
  state.appendTimeline(
    cfg, id,
    shadow.valid
      ? `verifier shadow r${round} 对照落盘：overall main=${mainVerdict.overall}/shadow=${shadow.overall}，AC 一致 ${agreed}/${expectedAcIds.length}，high-risk ${disagreements.filter((d) => d.high_risk).length}`
      : `verifier shadow r${round} 无有效 verdict（${shadow.invalid_kind}），compare 记录 shadow 无效`,
  );
}

/** 消费一个「有效」verdict（幂等分支与新产出分支共用）：按 verdictNext 路由。 */
async function consumeValidVerdict(ts, cfg, round, verdict) {
  const id = ts.id;
  const overall = verdict.overall;
  if (overall === 'pass') {
    state.transitionState(ts, cfg, 'AWAIT_HUMAN_MERGE', `verdict pass r${round}`, { current_round: round });
    console.log(`[${id}] verdict pass → AWAIT_HUMAN_MERGE。人工看 diff：worktrees/${id}，然后 conductor merge ${id}`);
    await maybeAutoMerge(ts, cfg, round, verdict);
    return { changed: true };
  }

  // fail（或含 unknown 的 fail）：写最小 repair-context（verifier 源），按 miss 阶梯路由。
  return consumeFailVerdict(ts, cfg, round, verdict);
}

/**
 * H33 机械全绿自动本地合并（config `autoMergeEnabled`，默认关=零行为差异）。
 * 裁决点：pass 转移到 AWAIT_HUMAN_MERGE 之后——不放行/失败都停在人审闸门（fail-open to human）。
 * 谓词是 decisions.evaluateAutoMerge（纯函数唯一裁判，输入全部机械产物）；本函数只收集输入、
 * 落 `verify-r<n>.automerge-decision.json` + timeline + `automerge_decision` 事件，eligible 才 performMerge。
 * 绝不 push：performMerge 只做本地合并（H33 边界）。评估路径任何异常全吞（任务保持人审闸门）。
 */
async function maybeAutoMerge(ts, cfg, round, verdict) {
  if (cfg.autoMergeEnabled !== true) return;
  const id = ts.id;
  try {
    const wt = worktreePath(cfg, id);
    const decision = evaluateAutoMerge({
      kind: ts.task.kind,
      allowedKinds: cfg.autoMergeKinds,
      verdictOverall: verdict.overall,
      acCount: Array.isArray(verdict.criteria_results) ? verdict.criteria_results.length : null,
      maxAcs: cfg.autoMergeMaxAcs,
      testGate: state.readJsonIf(state.dossierPath(cfg, id, `test-gate-r${round}.json`)),
      guardEnabled: cfg.testChangeGuardEnabled === true,
      guardChanges: computeTestChangeGuard(ts, cfg),
      anchorsMode: cfg.verifierEvidenceAnchorsMode,
      anchors: state.readJsonIf(state.dossierPath(cfg, id, `verify-r${round}.evidence-anchors.json`)),
      shadowEnabled: cfg.verifierShadowEnabled === true,
      shadowCompare: state.readJsonIf(state.dossierPath(cfg, id, `verify-r${round}.shadow-compare.json`)),
      reviewCompare: state.readJsonIf(state.dossierPath(cfg, id, `review-r${round}.compare.json`)),
      diff: parseNumstat(diffNumstatAgainstBase(wt, ts.task.baseBranch)),
      maxDiffLines: cfg.autoMergeMaxDiffLines,
      deniedPaths: cfg.autoMergeDeniedPaths,
    });
    state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.automerge-decision.json`), {
      schema_version: 1, round, ...decision,
    });
    state.appendTimeline(
      cfg, id,
      decision.eligible
        ? `auto-merge r${round}：机械全绿谓词通过，执行本地合并（push 仍人工）`
        : `auto-merge r${round}：不放行（${decision.reasons.join('；')}）——留人审`,
    );
    state.appendEvent(cfg, id, 'automerge_decision', { round, eligible: decision.eligible, reasons: decision.reasons });
    if (!decision.eligible) return;

    const res = await performMerge(ts, cfg, { auto: true });
    if (res.ok) {
      console.log(`[${id}] auto-merge 完成（机械全绿，本地合并已归档 done；push 仍人工）`);
    } else {
      state.appendTimeline(cfg, id, `auto-merge 执行失败（任务保持 AWAIT_HUMAN_MERGE）：${res.error}`);
      console.error(`[${id}] auto-merge 失败：${res.error}`);
    }
  } catch (err) {
    state.appendTimeline(cfg, id, `auto-merge 评估异常（任务保持 AWAIT_HUMAN_MERGE）：${err?.message ?? err}`);
  }
}

function consumeFailVerdict(ts, cfg, round, verdict) {
  const id = ts.id;
  const ctx = buildRepairContext({ source: 'verifier', round, verdict });
  writeRepairContext(cfg, id, round, ctx);
  const next = makerMissNext(ts.runtime.maker_miss_count ?? 0, cfg.maxMakerMisses);
  if (next.stage === 'FAILED_BOX') {
    return failToBox(
      ts, cfg,
      `verdict fail r${round}，miss ${next.missCount} 阶梯耗尽`,
      'maker_misses_exhausted',
      { maker_miss_count: next.missCount }, // 递增后的 miss 一并落盘
    );
  }
  state.transitionState(ts, cfg, 'FIXING', `verdict fail r${round}, miss=${next.missCount}`, {
    maker_miss_count: next.missCount,
    current_round: round,
  });
  return { changed: true };
}

/** 读 dossier 冻结 spec 原文（AC 枚举的输入）。 */
function readDossierSpecRaw(ts, cfg) {
  const p = state.dossierPath(cfg, ts.id, 'spec.md');
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * H15：为 verdict 引用的每个 evidence 文件建锚定索引并核验（checkEvidenceAnchors 是唯一裁判）。
 * 行数来源：worktree 现文件；不在 worktree（已删除 / rename 旧路径）时回退 merge-base 的
 * base blob——与 verifier 看到的三点 diff（base...HEAD）同基线。绝不解析 worktree 外路径：
 * 绝对路径或含 `..` 段一律记 unsafe_path 硬错误，不碰文件系统。
 */
function computeEvidenceAnchors(ts, cfg, verdict) {
  const wt = worktreePath(cfg, ts.id);
  const baseBranch = ts.task.baseBranch;
  const baseRef = mergeBaseWith(wt, baseBranch) ?? baseBranch;
  const diffFiles = parseNameStatusPaths(diffNameStatusAgainstBase(wt, baseBranch));
  const files = new Set();
  for (const c of verdict.criteria_results) {
    for (const ev of c.evidence ?? []) files.add(ev.file);
  }
  const fileIndex = {};
  for (const f of files) {
    if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) {
      fileIndex[f] = { lines: null, in_diff: false, missing_reason: 'unsafe_path' };
      continue;
    }
    let content = null;
    try { content = fs.readFileSync(path.join(wt, f), 'utf8'); } catch { /* 不在 worktree：回退 base blob */ }
    if (content === null) content = showFileAtRef(wt, baseRef, f);
    fileIndex[f] = { lines: content === null ? null : countLines(content), in_diff: diffFiles.has(f) };
  }
  return checkEvidenceAnchors(verdict, fileIndex);
}

/** 行数口径：尾随换行不多算一行；空文件 0 行。 */
function countLines(content) {
  if (content === '') return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}
