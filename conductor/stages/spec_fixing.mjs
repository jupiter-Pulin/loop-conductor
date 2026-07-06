// SPEC_FIXING：基于 spec-repair-context 让 spec-agent 直写下一稿（hook 护栏 + 契约门
// 与 NEEDS_SPEC 相同），过门后回 SPEC_VERIFY。
// 契约门 fail：留在 SPEC_FIXING 原地重试（修复轮保留现有草稿作上下文，不归档），超额收箱。
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import { taskCfg } from '../lib/task-cfg.mjs';
import { specContractInvalidNext } from './decisions.mjs';
import {
  addCost, budgetExceeded, buildSpecAgentPrompt, failToBox,
  finishSpawnRecord, nextRoleRound, runSpecContractGate, SPEC_AGENT_TOOLS,
  startSpawnRecord, writeSpecAgentSettings, canStartSpawn,
} from './shared.mjs';

export default async function specFixingHandler(ts, cfg) {
  const id = ts.id;
  const tRepo = taskCfg(ts, cfg).targetRepo;
  if (budgetExceeded(ts, cfg)) {
    return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}，拒绝 spawn spec-agent`, 'budget_exceeded');
  }
  if (!canStartSpawn(ts, cfg, 'spec-agent')) return { changed: false };
  const round = nextRoleRound(cfg, id, 'spec-agent');
  const settings = writeSpecAgentSettings(ts, cfg, round);
  const streamFile = state.dossierPath(cfg, id, `spec-agent-r${round}.stream.jsonl`);
  const rec = startSpawnRecord(cfg, id, 'spec-agent', round, {
    mode: 'repair',
    stream_file: path.relative(cfg.root, streamFile),
  });
  const res = await runClaude({
    cwd: tRepo,
    prompt: buildSpecAgentPrompt(ts, cfg, round, { mode: 'repair' }),
    maxTurns: cfg.maxTurns,
    model: cfg.models?.spec ?? null,
    tools: SPEC_AGENT_TOOLS,
    allowedTools: SPEC_AGENT_TOOLS,
    settings,
    streamFile,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    wallClockMs: cfg.spawnWallClockMs,
  });
  finishSpawnRecord(rec, res);
  addCost(ts, res.costUsd, cfg);
  if (res.costUnknown) state.appendTimeline(cfg, id, `spec-agent r${round} cost unknown; spent_usd uses lower-bound accounting`);
  if (!res.ok) {
    state.saveRuntime(ts);
    state.appendTimeline(cfg, id, `spec-agent repair failed: ${res.error ?? 'unknown'}`);
    console.error(`[${id}] spec-agent repair 失败（${res.error ?? 'unknown'}），任务停留在 SPEC_FIXING`);
    return { changed: false };
  }
  if (res.sessionId) ts.runtime.spec_agent_session_id = res.sessionId;

  // conductor 契约门（权威终审）：修复稿同样不采信口头汇报。
  const check = runSpecContractGate(ts, cfg, round);
  if (!check.ok) {
    const next = specContractInvalidNext(ts.runtime.spec_contract_invalid_count ?? 0, cfg.maxSpecContractRetries);
    state.appendTimeline(cfg, id, `spec-agent r${round} 修复稿未过契约门（第 ${next.invalidCount} 次）：${check.errors.join('; ')}`);
    if (next.exhausted) {
      return failToBox(
        ts, cfg,
        `spec 契约门失败超过上限（${cfg.maxSpecContractRetries}），收箱`,
        next.failureType, // 'spec_contract_exhausted'
        { spec_contract_invalid_count: next.invalidCount },
      );
    }
    ts.runtime.spec_contract_invalid_count = next.invalidCount;
    state.saveRuntime(ts);
    return { changed: true }; // 留在 SPEC_FIXING，drain 再入本 handler 重 spawn（prompt 带契约错误 + 现有草稿）
  }

  ts.runtime.spec_contract_invalid_count = 0;
  ts.runtime.current_spec_round = round;
  ts.runtime.spec_verifier_invalid_count = 0;
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `spec-agent r${round} repair draft 过契约门 (cost=$${res.costUsd}, AC×${check.acs.length}) → specs/${id}.md`);
  state.transitionState(ts, cfg, 'SPEC_VERIFY', `spec repair draft r${round}`);
  return { changed: true };
}
