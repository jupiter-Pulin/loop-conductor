// NEEDS_SPEC（feature 专用）：spawn spec-agent（只读探索 + 受限写，cwd=targetRepo，
// hook 护栏经 --settings 注入）→ agent 直写 specs/<id>.md → conductor 契约门终审
// （spec-doc/v1）→ SPEC_VERIFY。
// 契约门 fail：留在 NEEDS_SPEC 原地重试（草稿归档、错误进下轮 prompt），超额收箱。
// 幂等：specs/<id>.md 已存在且未被打回且过契约门 → 跳过 spawn；未过（崩溃残留半成品）→
// 归档重产，绝不带病进 SPEC_VERIFY。预算超 → FAILED_BOX。
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import { validateSpecDoc } from '../lib/spec-contract.mjs';
import { needsSpecAction, specContractInvalidNext } from './decisions.mjs';
import {
  addCost, archiveSpecDraft, budgetExceeded, buildSpecAgentPrompt, failToBox,
  nextRoleRound, runSpecContractGate, SPEC_AGENT_TOOLS, specDraftPath,
  startSpawnRecord, finishSpawnRecord, writeSpecAgentSettings,
} from './shared.mjs';

export default function needsSpecHandler(ts, cfg) {
  const id = ts.id;
  const specPath = specDraftPath(cfg, id);
  let action = needsSpecAction(fs.existsSync(specPath), ts.runtime.approval ?? null);

  if (action === 'skip-spawn') {
    // 直写模式下现存草稿可能是崩溃残留的半成品：契约不过就归档重产，绝不带病进 SPEC_VERIFY。
    let md = null;
    try { md = fs.readFileSync(specPath, 'utf8'); } catch { /* 视为缺失 */ }
    const leftover = validateSpecDoc(md);
    if (!leftover.ok) {
      const archived = archiveSpecDraft(cfg, id, 'contract-invalid-leftover');
      state.appendTimeline(
        cfg, id,
        `现存 spec 草稿未过契约门（${leftover.errors.join('; ')}），归档重产` +
        `${archived ? ` → ${path.relative(cfg.root, archived)}` : ''}`,
      );
      action = 'spawn';
    }
  }

  if (action === 'spawn') {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}`, 'budget_exceeded');
    }
    const round = nextRoleRound(cfg, id, 'spec-agent');
    const settings = writeSpecAgentSettings(ts, cfg, round);
    const rec = startSpawnRecord(cfg, id, 'spec-agent', round, { mode: 'draft' });
    const res = runClaude({
      cwd: cfg.targetRepo,
      prompt: buildSpecAgentPrompt(ts, cfg, round, { mode: 'draft' }),
      maxTurns: cfg.maxTurns,
      model: cfg.models?.spec ?? null,
      tools: SPEC_AGENT_TOOLS,
      allowedTools: SPEC_AGENT_TOOLS,
      settings,
    });
    finishSpawnRecord(rec, res);
    addCost(ts, res.costUsd);
    if (!res.ok) {
      state.saveRuntime(ts);
      state.appendTimeline(cfg, id, `spec-agent spawn failed: ${res.error ?? 'unknown'}`);
      console.error(`[${id}] spec-agent 失败（${res.error ?? 'unknown'}），任务停留在 NEEDS_SPEC，下次 run 重试`);
      return { changed: false };
    }
    if (res.sessionId) ts.runtime.spec_agent_session_id = res.sessionId;

    // conductor 契约门（权威终审）：hook 是快反馈层，是否真跑过一律不采信，这里重新裁。
    const check = runSpecContractGate(ts, cfg, round);
    if (!check.ok) {
      const next = specContractInvalidNext(ts.runtime.spec_contract_invalid_count ?? 0, cfg.maxSpecContractRetries);
      state.appendTimeline(cfg, id, `spec-agent r${round} 交付未过契约门（第 ${next.invalidCount} 次）：${check.errors.join('; ')}`);
      if (next.exhausted) {
        return failToBox(
          ts, cfg,
          `spec 契约门失败超过上限（${cfg.maxSpecContractRetries}），收箱`,
          next.failureType, // 'spec_contract_exhausted'
          { spec_contract_invalid_count: next.invalidCount },
        );
      }
      archiveSpecDraft(cfg, id, `contract-invalid-r${round}`); // 废稿归档，下一轮干净起步
      ts.runtime.spec_contract_invalid_count = next.invalidCount;
      state.saveRuntime(ts);
      return { changed: true }; // 留在 NEEDS_SPEC，drain 再入本 handler 重 spawn（prompt 带契约错误）
    }
    // 先产物后状态：草稿已过门，清 approval / 复位计数，最后才转移。
    ts.runtime.spec_contract_invalid_count = 0;
    ts.runtime.approval = null;
    ts.runtime.current_spec_round = round;
    ts.runtime.spec_verifier_invalid_count = 0;
    state.saveRuntime(ts);
    state.appendTimeline(cfg, id, `spec-agent r${round} 直写 spec 草稿过契约门 (cost=$${res.costUsd}, AC×${check.acs.length}) → specs/${id}.md`);
  }

  if (action === 'skip-spawn' && !ts.runtime.current_spec_round) {
    ts.runtime.current_spec_round = nextRoleRound(cfg, id, 'spec-agent') - 1 || 1;
  }
  state.transitionState(ts, cfg, 'SPEC_VERIFY', action === 'skip-spawn' ? 'spec 草稿已存在' : 'spec 草稿就绪');
  console.log(`[${id}] spec 草稿进入 spec-verifier：specs/${id}.md`);
  return { changed: true };
}
