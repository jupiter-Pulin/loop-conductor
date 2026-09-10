// SPEC_VERIFY：spawn spec-verifier 审查 specs/<id>.md。
// pass → AWAIT_SPEC_APPROVAL；fail → SPEC_FIXING，第三次 fail 冷启动新 spec-agent；
// fail + 规模闸触发且人未豁免 → AWAIT_SCOPE_DECISION（升闸交人裁拆分，本次 fail 挂起）。
import fs from 'node:fs';
import path from 'node:path';
import { runClaudeWithRetry } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import {
  parseStrictJson, specFailRoute, specMissNext, specScaleGateViolation, specVerifierInvalidNext,
  validateSpecVerifierVerdict,
  legacyMaxTurns,
} from './decisions.mjs';
import {
  accountSpawnCost, archiveSpecDraft, budgetExceeded, buildSpecVerifierPrompt, failToBox,
  finishSpawnRecord, renderSpecVerifyReport, SPEC_TOOLS, startSpawnRecord, writeSpecRepairContext, canStartSpawn,
  acquireSpecChainCwd, rateLimitedToBox,
} from './shared.mjs';

export default async function specVerifyHandler(ts, cfg) {
  const id = ts.id;
  const round = ts.runtime.current_spec_round ?? 0;
  if (round < 1) {
    return failToBox(ts, cfg, 'SPEC_VERIFY 缺 current_spec_round', 'spec_state_invalid');
  }
  const specPath = path.join(cfg.specsDir, `${id}.md`);
  if (!fs.existsSync(specPath)) {
    return failToBox(ts, cfg, `SPEC_VERIFY 缺 spec 草稿：specs/${id}.md`, 'spec_missing');
  }

  // 规模闸的计算上提到幂等分支之前：消费 fail verdict 的路由（specFailRoute）也要用它，
  // 重入时同样得拿到规模信息。SPEC_VERIFY 期间没有任何角色写 spec 文件，计算是确定性的。
  const scaleGate = computeScaleGate(cfg, specPath);

  const verdictPath = state.dossierPath(cfg, id, `spec-verify-r${round}.verdict.json`);
  const existing = state.readJsonIf(verdictPath);
  if (existing) {
    state.appendTimeline(cfg, id, `spec-verifier r${round} verdict 已存在，直接消费（幂等重入）`);
    return consumeSpecVerdict(ts, cfg, round, existing, scaleGate);
  }

  if (budgetExceeded(ts, cfg)) {
    return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}，拒绝 spawn spec-verifier`, 'budget_exceeded');
  }
  if (!canStartSpawn(ts, cfg, 'spec-verifier')) return { changed: false };

  // 「已要求拆分建议」只在 spawn 分支记账：幂等重入不重复写 timeline/事件。
  if (scaleGate) {
    state.appendTimeline(cfg, id, `spec 规模闸（软档）：AC×${scaleGate.acCount} > 阈值 ${scaleGate.max}，已要求 spec-verifier 附拆分建议（不 block）`);
    state.appendEvent(cfg, id, 'spec_scale_gate', { round, ac_count: scaleGate.acCount, max: scaleGate.max });
  }

  const streamFile = state.dossierPath(cfg, id, `spec-verifier-r${round}.stream.jsonl`);
  const rec = startSpawnRecord(cfg, id, 'spec-verifier', round, {
    stream_file: path.relative(cfg.root, streamFile),
  });
  const iso = acquireSpecChainCwd(ts, cfg, 'spec-verifier');
  let res;
  try {
    res = await runClaudeWithRetry({
      cwd: iso.cwd,
      prompt: buildSpecVerifierPrompt(ts, cfg, round, scaleGate),
      maxTurns: legacyMaxTurns(cfg),
      model: cfg.models?.specVerifier ?? null,
      tools: SPEC_TOOLS,
      allowedTools: SPEC_TOOLS,
      streamFile,
      inactivityTimeoutMs: cfg.inactivityTimeoutMs,
      wallClockMs: cfg.spawnWallClockMs,
    }, {
      retries: cfg.spawnRetries,
      backoffMs: cfg.spawnBackoffMs,
      onRetry: ({ attempt, status }) =>
        state.appendTimeline(cfg, id, `spec-verifier r${round} transient retry attempt ${attempt} (status=${status ?? 'spawn-error'})`),
    });
  } finally {
    iso.cleanup();
  }
  finishSpawnRecord(rec, res);
  accountSpawnCost(ts, cfg, 'spec-verifier', round, res);
  state.saveRuntime(ts);

  const limited = rateLimitedToBox(ts, cfg, 'spec-verifier', res);
  if (limited) return limited; // 限额：进箱等人在 resets_at 后 retry
  if (!res.ok) {
    // 基建失败：不是 spec-verifier 的协议失败，不计 invalid、不动 spec_verifier_invalid_count，
    // 留在 SPEC_VERIFY 下次 run 重 spawn。
    state.appendTimeline(cfg, id, `spec-verifier r${round} 基建失败（${res.error ?? 'unknown'}），任务留在 SPEC_VERIFY，下次 run 重试`);
    return { changed: false };
  }

  const parsed = parseStrictJson(res.result);
  let check = validateSpecVerifierVerdict(parsed);
  if (check.ok) {
    // H18 双向核验（机械执法，幂等重入的历史 verdict 不追溯）：闸触发 ⇔ advisory 在场。
    const violation = specScaleGateViolation(scaleGate, check.verdict);
    if (violation) check = { ok: false, errors: [violation] };
  }
  if (!check.ok) {
    const m = (ts.runtime.spec_verifier_invalid_count ?? 0) + 1;
    state.writeJson(state.dossierPath(cfg, id, `spec-verify-r${round}.invalid-a${m}.json`), {
      schema_version: 1,
      round,
      attempt: m,
      errors: check.errors,
      raw_result: res.result ?? null,
    });
    const next = specVerifierInvalidNext(ts.runtime.spec_verifier_invalid_count ?? 0, cfg.maxSpecVerifierInvalidRetries);
    state.appendTimeline(cfg, id, `spec-verifier r${round} invalid 第 ${m} 次：${check.errors.join('; ')}`);
    if (next.stage === 'FAILED_BOX') {
      return failToBox(
        ts, cfg,
        `spec-verifier 协议失败超过上限（${cfg.maxSpecVerifierInvalidRetries}），收箱`,
        next.failureType,
        { spec_verifier_invalid_count: next.invalidCount },
      );
    }
    ts.runtime.spec_verifier_invalid_count = next.invalidCount;
    state.saveRuntime(ts);
    return { changed: true };
  }

  state.writeJson(verdictPath, check.verdict);
  state.writeFileEnsured(state.dossierPath(cfg, id, `spec-verify-r${round}.md`), renderSpecVerifyReport(check.verdict));
  ts.runtime.spec_verifier_invalid_count = 0;
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `spec-verifier r${round} verdict: ${check.verdict.overall} (cost=$${res.costUsd})`);
  return consumeSpecVerdict(ts, cfg, round, check.verdict, scaleGate);
}

/**
 * H18 规模闸（config specMaxAcs，null=关）：机械数 AC，超限返回 { acCount, max }，否则 null。
 * 触发的两个后果：注入 spec-verifier prompt 的拆分建议要求（软档，不改 pass 路由），
 * 以及 fail 时把路由升格为人闸（specFailRoute）。
 */
function computeScaleGate(cfg, specPath) {
  if (!Number.isFinite(cfg.specMaxAcs)) return null;
  let draftMd = '';
  try { draftMd = fs.readFileSync(specPath, 'utf8'); } catch { /* 调用方已验存在性 */ }
  const acCount = state.extractAcceptanceCriteria(draftMd).length;
  return acCount > cfg.specMaxAcs ? { acCount, max: cfg.specMaxAcs } : null;
}

function consumeSpecVerdict(ts, cfg, round, verdict, scaleGate) {
  const id = ts.id;
  if (verdict.overall === 'pass') {
    state.transitionState(ts, cfg, 'AWAIT_SPEC_APPROVAL', `spec-verifier pass r${round}`, { current_spec_round: round });
    console.log(`[${id}] spec-verifier pass → AWAIT_SPEC_APPROVAL。人工看 specs/${id}.md 后 approve|reject`);
    return { changed: true };
  }

  // 修复上下文照常落盘：人裁「接受规模」后 SPEC_FIXING 直接拿它开工，无需重跑 spec-verifier。
  writeSpecRepairContext(cfg, id, round, verdict);
  if (specFailRoute(scaleGate, ts.runtime.scope_decision) === 'escalate') {
    state.appendTimeline(
      cfg, id,
      `spec 规模升闸：AC×${scaleGate.acCount} > 阈值 ${scaleGate.max} 且 spec-verifier r${round} fail，` +
      '本次 fail 挂起（miss 不计），等人裁决：' +
      `approve-scope ${id}（接受规模，继续修复循环）| reject-scope ${id} --notes "…"（选择拆分，任务收箱）`,
    );
    state.appendEvent(cfg, id, 'scope_escalation', { round, ac_count: scaleGate.acCount, max: scaleGate.max });
    state.transitionState(ts, cfg, 'AWAIT_SCOPE_DECISION', `spec-verifier fail r${round} + 规模闸触发`, {
      current_spec_round: round,
    });
    console.log(
      `[${id}] spec 规模升闸 → AWAIT_SCOPE_DECISION（AC×${scaleGate.acCount} > ${scaleGate.max}）。` +
      `conductor approve-scope ${id} 接受规模继续修复；conductor reject-scope ${id} --notes "…" 选择拆分`,
    );
    return { changed: true };
  }
  return applySpecFail(ts, cfg, round);
}

/**
 * spec-verifier fail 的 miss 阶梯入账（挂起的 fail 经 approve-scope 人裁后也走这里）：
 * 前两次回 SPEC_FIXING，第三次冷启动新 spec-agent（epoch+1），epoch 耗尽收箱。
 * 调用方负责 repair 上下文——本函数只管计数与去向。
 */
export function applySpecFail(ts, cfg, round) {
  const id = ts.id;
  const next = specMissNext(ts.runtime.spec_miss_count ?? 0, cfg.maxSpecMisses);
  if (next.stage === 'NEEDS_SPEC') {
    const nextEpoch = (ts.runtime.spec_epoch ?? 1) + 1;
    if (nextEpoch > cfg.maxSpecEpochs) {
      return failToBox(
        ts, cfg,
        `spec-verifier fail r${round}，spec epoch ${nextEpoch - 1} 已达上限`,
        'spec_misses_exhausted',
        { spec_miss_count: next.missCount, spec_epoch: nextEpoch - 1 },
      );
    }
    const archived = archiveSpecDraft(cfg, id, `spec-fail-r${round}`);
    if (archived) state.appendTimeline(cfg, id, `spec draft archived → ${path.relative(cfg.root, archived)}`);
    state.transitionState(ts, cfg, 'NEEDS_SPEC', `spec-verifier fail r${round}, cold restart spec-agent`, {
      spec_miss_count: 0,
      spec_epoch: nextEpoch,
      current_spec_round: 0,
    });
    return { changed: true };
  }
  state.transitionState(ts, cfg, 'SPEC_FIXING', `spec-verifier fail r${round}, miss=${next.missCount}`, {
    spec_miss_count: next.missCount,
    current_spec_round: round,
  });
  return { changed: true };
}
