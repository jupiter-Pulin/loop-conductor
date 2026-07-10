// SPEC_VERIFY：spawn spec-verifier 审查 specs/<id>.md。
// pass → AWAIT_SPEC_APPROVAL；fail → SPEC_FIXING，第三次 fail 冷启动新 spec-agent。
import fs from 'node:fs';
import path from 'node:path';
import { runClaudeWithRetry } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import {
  parseStrictJson, specMissNext, specVerifierInvalidNext, validateSpecVerifierVerdict,
} from './decisions.mjs';
import {
  accountSpawnCost, archiveSpecDraft, budgetExceeded, buildSpecVerifierPrompt, failToBox,
  finishSpawnRecord, renderSpecVerifyReport, SPEC_TOOLS, startSpawnRecord, writeSpecRepairContext, canStartSpawn,
  acquireSpecChainCwd,
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

  const verdictPath = state.dossierPath(cfg, id, `spec-verify-r${round}.verdict.json`);
  const existing = state.readJsonIf(verdictPath);
  if (existing) {
    state.appendTimeline(cfg, id, `spec-verifier r${round} verdict 已存在，直接消费（幂等重入）`);
    return consumeSpecVerdict(ts, cfg, round, existing);
  }

  if (budgetExceeded(ts, cfg)) {
    return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}，拒绝 spawn spec-verifier`, 'budget_exceeded');
  }
  if (!canStartSpawn(ts, cfg, 'spec-verifier')) return { changed: false };

  // H18 规模闸（软档，config specMaxAcs，null=关）：机械数 AC，超限只注入 prompt 段 +
  // 留痕，绝不改路由——拆分决定权在人审闸门。
  let scaleGate = null;
  if (Number.isFinite(cfg.specMaxAcs)) {
    let draftMd = '';
    try { draftMd = fs.readFileSync(specPath, 'utf8'); } catch { /* 上方已验存在性 */ }
    const acCount = state.extractAcceptanceCriteria(draftMd).length;
    if (acCount > cfg.specMaxAcs) {
      scaleGate = { acCount, max: cfg.specMaxAcs };
      state.appendTimeline(cfg, id, `spec 规模闸（软档）：AC×${acCount} > 阈值 ${cfg.specMaxAcs}，已要求 spec-verifier 附拆分建议（不 block）`);
      state.appendEvent(cfg, id, 'spec_scale_gate', { round, ac_count: acCount, max: cfg.specMaxAcs });
    }
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
      maxTurns: cfg.maxTurns,
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

  if (!res.ok) {
    // 基建失败：不是 spec-verifier 的协议失败，不计 invalid、不动 spec_verifier_invalid_count，
    // 留在 SPEC_VERIFY 下次 run 重 spawn。
    state.appendTimeline(cfg, id, `spec-verifier r${round} 基建失败（${res.error ?? 'unknown'}），任务留在 SPEC_VERIFY，下次 run 重试`);
    return { changed: false };
  }

  const parsed = parseStrictJson(res.result);
  const check = validateSpecVerifierVerdict(parsed);
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
  return consumeSpecVerdict(ts, cfg, round, check.verdict);
}

function consumeSpecVerdict(ts, cfg, round, verdict) {
  const id = ts.id;
  if (verdict.overall === 'pass') {
    state.transitionState(ts, cfg, 'AWAIT_SPEC_APPROVAL', `spec-verifier pass r${round}`, { current_spec_round: round });
    console.log(`[${id}] spec-verifier pass → AWAIT_SPEC_APPROVAL。人工看 specs/${id}.md 后 approve|reject`);
    return { changed: true };
  }

  writeSpecRepairContext(cfg, id, round, verdict);
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
