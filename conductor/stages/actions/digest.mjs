// actions/digest.mjs — spec 摘要的生成、校验与有界修复。内核动作，不是 router 的动作。
//
// 触发点（全部走 ensureDigest，幂等）：
//   1. spec 动作写出合格草稿之后、开 spec 人闸之前——人审时就能同时看到摘要与原文；
//   2. ROUTING 每轮开头——当前适用版本的 spec 还没有可用摘要时补齐。覆盖三种情形：
//      人在闸上改过草稿（内容哈希变了，旧摘要自动过期）、升级前已经产出 spec 的存量任务、
//      上一次生成失败但还有重试额度；
//   3. `conductor digest <id> [--force]`——人显式补齐 / 重做。
//
// 内核在这里做的只有机械的事：给原文拍版本快照、把带行号的原文内联进固定 prompt、派出只有 Write
// 的摘要 agent、用 lib/digest-contract.mjs 校验产物、把每次尝试记进 meta。内核不读懂摘要、
// 不改摘要、不替模型补摘要。不合格 → 错误清单原样喂回下一次尝试；尝试用完 → 明确降级：
// router 的 prompt 里写明「摘要不可用」，它直接按路径读这一版原文。任何情况下都不会把过期的、
// 空的或内核猜出来的内容当摘要用，任务也不会因为摘要失败而卡死。

import * as state from '../../lib/state.mjs';
import { numberLines, shortSha } from '../../lib/spec-version.mjs';
import {
  digestMaxAttempts, digestPath, digestPromptSha, digestStateFor, readDigestMeta,
  writeDigestMeta, writeDigestSource,
} from '../../lib/digest-store.mjs';
import { buildDigestPrompt } from '../../lib/prompts.mjs';
import { logPathFor } from '../../lib/agent-settings.mjs';
import { isRateLimited } from '../../lib/claude.mjs';
import { markRunRateLimited } from '../../lib/scheduler.mjs';
import { budgetExceeded, rateLimitedToBox } from '../shared.mjs';
import { allocateRound, checkBudgetAndBox, spawnAgentRound, spawnSkipped } from '../router-kernel.mjs';

/**
 * 确保 `spec` 这一版有可用摘要。最多再尝试一次（每次调用一次 spawn；重试由下一次调用接着做），
 * 这样每次尝试之间都会重新过预算闸 / 限额闸 / 停止闸。
 * 返回 { state: 'valid' | 'missing' | 'invalid' | 'exhausted' | 'none' | 'skipped', result?, spawned }：
 *   result —— 需要调用方原样返回的 handler 结果（限额 / 预算收箱），否则为 null。
 */
export async function ensureDigest(ts, cfg, spec, { boxOnFailure = true } = {}) {
  const id = ts.id;
  if (spec == null || cfg.digestEnabled === false) return { state: 'none', result: null, spawned: false };
  const before = digestStateFor(cfg, id, spec);
  if (before.state === 'valid' || before.state === 'exhausted') return { state: before.state, result: null, spawned: false };

  // boxOnFailure=false（spec 闸前的那次触发）：摘要只是锦上添花，预算 / 限额问题不该拦住人审——
  // 这里不收箱，闸照开；回到 ROUTING 后由每轮开头的触发点按正常规则处理。
  if (boxOnFailure) {
    const boxed = checkBudgetAndBox(ts, cfg);
    if (boxed) return { state: before.state, result: boxed, spawned: false };
  } else if (budgetExceeded(ts, cfg)) {
    return { state: before.state, result: null, spawned: false };
  }

  const round = allocateRound(ts);
  const sourcePath = writeDigestSource(cfg, id, spec);
  const outPath = digestPath(cfg, id, spec.sha256);
  const acIds = state.enumerateAcceptanceCriteria(spec.text).map((a) => a.ac_id);
  const prompt = buildDigestPrompt(cfg, {
    id,
    logPath: logPathFor(cfg, id, 'digest', round),
    digestPath: outPath,
    specSha: spec.sha256,
    acIds,
    numberedSpec: numberLines(spec.text),
    errors: before.state === 'invalid' ? before.errors : [],
  });

  const res = await spawnAgentRound(ts, cfg, {
    role: 'digest',
    round,
    prompt,
    digest: { path: outPath, sourcePath, sha: spec.sha256 },
    extraRecord: { spec_sha: spec.sha256, spec_status: spec.status, prompt_sha256: digestPromptSha(cfg) },
  });
  if (spawnSkipped(res)) return { state: 'skipped', result: null, spawned: false };
  if (isRateLimited(res)) {
    if (boxOnFailure) return { state: before.state, result: rateLimitedToBox(ts, cfg, 'digest', res), spawned: true };
    markRunRateLimited(cfg, typeof res.rate_limit?.resets_at === 'number' ? res.rate_limit.resets_at : null);
    state.appendTimeline(cfg, id, `digest r${round} 命中限额：本次 run 不再发起新 spawn；摘要留待回到 ROUTING 后补齐`);
    return { state: before.state, result: null, spawned: true };
  }

  // 终审：只看盘上的文件，不看 agent 的自评。
  const after = digestStateFor(cfg, id, spec);
  const meta = readDigestMeta(cfg, id, spec.sha256);
  const valid = after.state === 'valid';
  meta.spec_status_at_generation = spec.status;
  meta.prompt_sha256 = digestPromptSha(cfg);
  meta.model = cfg.models?.digest ?? null;
  meta.valid = valid;
  meta.validated_at = new Date().toISOString();
  meta.attempts = [...meta.attempts, {
    round,
    ok: valid,
    errors: valid ? [] : (after.errors.length > 0 ? after.errors : ['摘要文件缺失']),
    cost_usd: res.costUsd ?? 0,
    session_ok: res.ok === true,
    at: new Date().toISOString(),
  }];
  writeDigestMeta(cfg, id, spec.sha256, meta);

  const max = digestMaxAttempts(cfg);
  const final = digestStateFor(cfg, id, spec); // 尝试计数变了，exhausted 要重算
  if (valid) {
    state.appendEventAlways(cfg, id, 'digest_ready', { round, spec_sha: spec.sha256, spec_status: spec.status, stats: after.stats ?? null });
    state.appendTimeline(cfg, id, `digest r${round}：spec ${shortSha(spec.sha256)}（${spec.status}）的摘要通过机械校验`);
  } else {
    state.appendEventAlways(cfg, id, 'digest_invalid', {
      round, spec_sha: spec.sha256, attempt: meta.attempts.length, max_attempts: max, errors: after.errors.slice(0, 10),
    });
    state.appendTimeline(cfg, id, `digest r${round}：摘要未通过机械校验（第 ${meta.attempts.length}/${max} 次）`
      + `${final.state === 'exhausted' ? ' → 尝试用尽，降级：router 直接读原文；`conductor digest ' + id + ' --force` 可重做' : ''}`);
    if (final.state === 'exhausted') {
      state.appendEventAlways(cfg, id, 'digest_failed', { spec_sha: spec.sha256, attempts: meta.attempts.length });
    }
  }
  return { state: final.state, result: null, spawned: true };
}
