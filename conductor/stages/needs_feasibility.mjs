// NEEDS_FEASIBILITY（feature + feasibility gate 专用）：spawn feasibility-agent（只读探索 +
// 受限写，cwd=targetRepo，hook 护栏经 --settings 注入）→ agent 直写 <taskdir>/feasibility-study.md
// → conductor 契约门终审（feasibility-doc/v1）→ AWAIT_FEASIBILITY_APPROVAL（人按 option ID 点名）。
// 契约门 fail：留在 NEEDS_FEASIBILITY 原地重试（废稿归档、错误进下轮 prompt），超额收箱。
// 幂等：草稿已存在且未被打回且过契约门 → 跳过 spawn；未过（崩溃残留半成品）→
// 归档重产，绝不带病进人审闸门。预算超 → FAILED_BOX。
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import { validateFeasibilityDoc } from '../lib/feasibility-contract.mjs';
import { needsFeasibilityAction, feasibilityContractInvalidNext, legacyMaxTurns } from './decisions.mjs';
import {
  accountSpawnCost, archiveFeasibilityDraft, budgetExceeded, buildFeasibilityPrompt, failToBox,
  feasibilityDraftPath, FEASIBILITY_AGENT_TOOLS, nextRoleRound, runFeasibilityContractGate,
  startSpawnRecord, finishSpawnRecord, writeFeasibilityAgentSettings, canStartSpawn, acquireSpecChainCwd,
  rateLimitedToBox,
} from './shared.mjs';

export default async function needsFeasibilityHandler(ts, cfg) {
  const id = ts.id;
  const draftPath = feasibilityDraftPath(ts);
  let action = needsFeasibilityAction(fs.existsSync(draftPath), ts.runtime.feasibility_approval ?? null);

  if (action === 'skip-spawn') {
    // 直写模式下现存草稿可能是崩溃残留的半成品：契约不过就归档重产，绝不带病进人审闸门。
    let md = null;
    try { md = fs.readFileSync(draftPath, 'utf8'); } catch { /* 视为缺失 */ }
    const leftover = validateFeasibilityDoc(md);
    if (!leftover.ok) {
      const archived = archiveFeasibilityDraft(ts, 'contract-invalid-leftover');
      state.appendTimeline(
        cfg, id,
        `现存 feasibility 草稿未过契约门（${leftover.errors.join('; ')}），归档重产` +
        `${archived ? ` → ${path.relative(cfg.root, archived)}` : ''}`,
      );
      action = 'spawn';
    }
  }

  if (action === 'spawn') {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}`, 'budget_exceeded');
    }
    if (!canStartSpawn(ts, cfg, 'feasibility-agent')) return { changed: false };
    const round = nextRoleRound(cfg, id, 'feasibility-agent');
    const settings = writeFeasibilityAgentSettings(ts, cfg, round);
    const streamFile = state.dossierPath(cfg, id, `feasibility-agent-r${round}.stream.jsonl`);
    const rec = startSpawnRecord(cfg, id, 'feasibility-agent', round, {
      stream_file: path.relative(cfg.root, streamFile),
    });
    const iso = acquireSpecChainCwd(ts, cfg, 'feasibility-agent');
    let res;
    try {
      res = await runClaude({
        cwd: iso.cwd,
        prompt: buildFeasibilityPrompt(ts, cfg, round),
        maxTurns: legacyMaxTurns(cfg),
        model: cfg.models?.feasibility ?? null,
        tools: FEASIBILITY_AGENT_TOOLS,
        allowedTools: FEASIBILITY_AGENT_TOOLS,
        settings,
        streamFile,
        inactivityTimeoutMs: cfg.inactivityTimeoutMs,
        wallClockMs: cfg.spawnWallClockMs,
      });
    } finally {
      iso.cleanup();
    }
    finishSpawnRecord(rec, res);
    accountSpawnCost(ts, cfg, 'feasibility-agent', round, res);
    const limited = rateLimitedToBox(ts, cfg, 'feasibility-agent', res);
    if (limited) return limited; // 限额：进箱等人在 resets_at 后 retry
    if (!res.ok) {
      state.saveRuntime(ts);
      state.appendTimeline(cfg, id, `feasibility-agent spawn failed: ${res.error ?? 'unknown'}`);
      console.error(`[${id}] feasibility-agent 失败（${res.error ?? 'unknown'}），任务停留在 NEEDS_FEASIBILITY，下次 run 重试`);
      return { changed: false };
    }
    if (res.sessionId) ts.runtime.feasibility_agent_session_id = res.sessionId;

    // conductor 契约门（权威终审）：hook 是快反馈层，是否真跑过一律不采信，这里重新裁。
    const check = runFeasibilityContractGate(ts, cfg, round);
    if (!check.ok) {
      const next = feasibilityContractInvalidNext(ts.runtime.feasibility_contract_invalid_count ?? 0, cfg.maxFeasibilityContractRetries);
      state.appendTimeline(cfg, id, `feasibility-agent r${round} 交付未过契约门（第 ${next.invalidCount} 次）：${check.errors.join('; ')}`);
      if (next.exhausted) {
        return failToBox(
          ts, cfg,
          `feasibility 契约门失败超过上限（${cfg.maxFeasibilityContractRetries}），收箱`,
          next.failureType, // 'feasibility_contract_exhausted'
          { feasibility_contract_invalid_count: next.invalidCount },
        );
      }
      archiveFeasibilityDraft(ts, `contract-invalid-r${round}`); // 废稿归档，下一轮干净起步
      ts.runtime.feasibility_contract_invalid_count = next.invalidCount;
      state.saveRuntime(ts);
      return { changed: true }; // 留在 NEEDS_FEASIBILITY，drain 再入本 handler 重 spawn（prompt 带契约错误）
    }
    // 先产物后状态：草稿已过门，清 approval / 复位计数，最后才转移。
    ts.runtime.feasibility_contract_invalid_count = 0;
    ts.runtime.feasibility_approval = null;
    ts.runtime.current_feasibility_round = round;
    state.saveRuntime(ts);
    state.appendTimeline(
      cfg, id,
      `feasibility-agent r${round} 直写草稿过契约门 (cost=$${res.costUsd}, options=${check.options.map((o) => o.option_id).join('/')})`,
    );
  }

  if (action === 'skip-spawn' && !ts.runtime.current_feasibility_round) {
    ts.runtime.current_feasibility_round = nextRoleRound(cfg, id, 'feasibility-agent') - 1 || 1;
  }
  // probe 链（H26）：调查报告即最终交付，人读后 close 归档——不进 option 点名闸门。
  if (ts.task.kind === 'probe') {
    state.transitionState(ts, cfg, 'AWAIT_PROBE_CLOSE', action === 'skip-spawn' ? 'probe 报告已存在' : 'probe 报告就绪');
    console.log(`[${id}] probe 调查报告就绪：${path.relative(cfg.root, draftPath)}（人读后 conductor close ${id} 归档）`);
    return { changed: true };
  }
  state.transitionState(ts, cfg, 'AWAIT_FEASIBILITY_APPROVAL', action === 'skip-spawn' ? 'feasibility 草稿已存在' : 'feasibility 草稿就绪');
  console.log(`[${id}] feasibility memo 进入人审闸门：${path.relative(cfg.root, draftPath)}（approve-feasibility ${id} --option O-X）`);
  return { changed: true };
}
