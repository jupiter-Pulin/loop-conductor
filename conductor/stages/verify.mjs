// VERIFY（契约 §11）：round=maker_miss_count+1。spawn verifier（纯只读，不跑测试）→
// parseStrictJson + validateVerifierVerdict：
//   invalid → 写 verify-r<n>.invalid-a<m>.json、verifierInvalidNext（留 VERIFY 重试 / 收箱），
//             不写 verdict、不写 repair-context、不增 maker_miss_count。
//   valid   → 写 verify-r<n>.verdict.json、verify-r<n>.md（叙事）、重置 verifier_invalid_count；
//             verdictNext：pass→AWAIT_HUMAN_MERGE；fail→writeRepairContext(verifier)+makerMissNext→FIXING/FAILED_BOX。
// 幂等：verify-r<n>.verdict.json 已存在 → 直接按 verdictNext 消费，不重 spawn。
import fs from 'node:fs';
import * as state from '../lib/state.mjs';
import { runClaude } from '../lib/claude.mjs';
import {
  parseStrictJson, validateVerifierVerdict, verdictNext, verifierInvalidNext, makerMissNext,
} from './decisions.mjs';
import {
  worktreePath, buildVerifierPrompt, buildRepairContext, writeRepairContext,
  addCost, budgetExceeded, failToBox, startSpawnRecord, finishSpawnRecord, VERIFIER_TOOLS,
} from './shared.mjs';

export default function verifyHandler(ts, cfg) {
  const id = ts.id;
  const round = (ts.runtime.maker_miss_count ?? 0) + 1; // 轮次与刚产出 diff 的 maker round 对齐
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

  // conductor 枚举 spec 的 AC（既喂 prompt 又作校验 expectedAcIds）。
  const specMd = readDossierSpecRaw(ts, cfg);
  const acList = state.extractAcceptanceCriteria(specMd);
  const expectedAcIds = acList.map((a) => a.ac_id);

  const prompt = buildVerifierPrompt(ts, cfg, round, acList);
  const rec = startSpawnRecord(cfg, id, 'verifier', round);
  const res = runClaude({
    cwd: worktreePath(cfg, id),
    prompt,
    maxTurns: cfg.maxTurns,
    model: cfg.models?.verifier ?? null,
    tools: VERIFIER_TOOLS,        // 工具集硬限制
    allowedTools: VERIFIER_TOOLS, // 免审批放行同一集合
  });
  finishSpawnRecord(rec, res);
  addCost(ts, res.costUsd);
  state.saveRuntime(ts); // 成本先落盘

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

  // ---- valid verdict：落盘 verdict + 叙事，重置 verifier_invalid_count ----
  state.writeJson(verdictPath, check.verdict);
  state.writeFileEnsured(
    state.dossierPath(cfg, id, `verify-r${round}.md`),
    res.result ?? '',
  );
  ts.runtime.verifier_invalid_count = 0;
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `verifier r${round} verdict: ${check.verdict.overall} (cost=$${res.costUsd})`);
  return consumeValidVerdict(ts, cfg, round, check.verdict);
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
