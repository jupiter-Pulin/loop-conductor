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
import { runClaudeWithRetry } from '../lib/claude.mjs';
import { runCodexExec } from '../lib/codex.mjs';
import {
  parseStrictJson, validateVerifierVerdict, verdictNext, verifierInvalidNext, makerMissNext, makerRound,
} from './decisions.mjs';
import {
  worktreePath, buildVerifierPrompt, buildRepairContext, writeRepairContext, renderVerifyReport,
  addCost, budgetExceeded, failToBox, startSpawnRecord, finishSpawnRecord, VERIFIER_TOOLS, canStartSpawn,
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

  const prompt = buildVerifierPrompt(ts, cfg, round, acList);
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
  addCost(ts, res.costUsd, cfg);
  if (res.costUnknown) state.appendTimeline(cfg, id, `verifier r${round} cost unknown; spent_usd uses lower-bound accounting`);
  state.saveRuntime(ts); // 成本先落盘

  if (!res.ok) {
    // 基建失败（spawn 错误 / killed / 非零退出 / 无 result 事件，瞬态重试已耗尽）：
    // 不是 verifier 的协议失败，不计 invalid、不动 verifier_invalid_count，留在 VERIFY 下次 run 重 spawn。
    state.appendTimeline(cfg, id, `verifier r${round} 基建失败（${res.error ?? 'unknown'}），任务留在 VERIFY，下次 run 重试`);
    return { changed: false };
  }

  // 严格解析 + schema 校验：绝不在叙事里打捞 JSON。
  const parsed = parseStrictJson(res.result);
  const check = validateVerifierVerdict(parsed, expectedAcIds);

  if (!check.ok) {
    // ---- invalid verifier 输出：不是 maker 失败 ----
    const m = (ts.runtime.verifier_invalid_count ?? 0) + 1;
    state.writeJson(state.dossierPath(cfg, id, `verify-r${round}.invalid-a${m}.json`), {
      schema_version: 1,
      round,
      attempt: m,
      errors: check.errors,
      raw_result: res.result ?? null,
    });
    const next = verifierInvalidNext(ts.runtime.verifier_invalid_count ?? 0, cfg.maxVerifierInvalidRetries);
    state.appendTimeline(cfg, id, `verifier r${round} invalid 第 ${m} 次：${check.errors.join('; ')}`);
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
  return consumeValidVerdict(ts, cfg, round, check.verdict);
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
function consumeValidVerdict(ts, cfg, round, verdict) {
  const id = ts.id;
  const overall = verdict.overall;
  if (overall === 'pass') {
    state.transitionState(ts, cfg, 'AWAIT_HUMAN_MERGE', `verdict pass r${round}`, { current_round: round });
    console.log(`[${id}] verdict pass → AWAIT_HUMAN_MERGE。人工看 diff：worktrees/${id}，然后 conductor merge ${id}`);
    return { changed: true };
  }

  // fail（或含 unknown 的 fail）：写最小 repair-context（verifier 源），按 miss 阶梯路由。
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
