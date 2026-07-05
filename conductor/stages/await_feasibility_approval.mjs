// AWAIT_FEASIBILITY_APPROVAL：option 人类闸门，纯读 runtime.feasibility_approval，天然幂等。
// 这是全链路唯一裁「方向」的门：下游所有机器门（spec 契约门 / green gate / test gate /
// verifier）都只对照 spec 验证实现，选错 option 的 spec 会满分通过全部机器门——所以
// approve 必须显式 --option 点名，不提供静默通过。
// approved → 冻结草稿 → dossier/<id>/feasibility-study.md + feasibility-decision.json
//   → 草稿归档（feasibility-archive/，冻结稿是唯一事实源）→ NEEDS_SPEC；
// rejected → 归档旧草稿 → NEEDS_FEASIBILITY 重产（notes 经 feasibility_reject_notes.md 进下轮 prompt）；
// null → { changed:false }（闸门未动）。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { feasibilityApprovalNext } from './decisions.mjs';
import { archiveFeasibilityDraft, feasibilityDraftPath } from './shared.mjs';

export default async function awaitFeasibilityApprovalHandler(ts, cfg) {
  const id = ts.id;
  const next = feasibilityApprovalNext(ts.runtime.feasibility_approval ?? null);
  if (next === null) return { changed: false }; // 闸门未动，drain 自然停住

  if (next === 'NEEDS_SPEC') {
    const draft = feasibilityDraftPath(ts);
    if (fs.existsSync(draft)) {
      const frozen = state.dossierPath(cfg, id, 'feasibility-study.md');
      state.writeFileEnsured(frozen, fs.readFileSync(draft, 'utf8')); // 冻结副本，下游只认 dossier
      state.appendTimeline(cfg, id, 'feasibility approved，冻结副本 → dossier/feasibility-study.md');
    } else {
      console.error(`[${id}] 警告：feasibility 草稿缺失（${path.relative(cfg.root, draft)}），仅落 decision 记录`);
    }
    // 人审裁决记录：chosen_option 由 approve-feasibility CLI 校验（必须存在于草稿枚举）后写入 runtime。
    state.writeJson(state.dossierPath(cfg, id, 'feasibility-decision.json'), {
      schema_version: 1,
      chosen_option: ts.runtime.chosen_option ?? null,
      notes: ts.runtime.feasibility_decision_notes ?? null,
      decided_at: new Date().toISOString(),
    });
    state.appendTimeline(cfg, id, `feasibility decision 落盘：chosen_option=${ts.runtime.chosen_option ?? '(none)'}`);
    // 先产物后状态：冻结 + decision 落盘后归档草稿，任务目录不留双份平行文档。
    const archived = archiveFeasibilityDraft(ts, 'approved');
    if (archived) {
      state.appendTimeline(cfg, id, `已批准草稿归档 → ${path.relative(cfg.root, archived)}`);
    }
    state.transitionState(ts, cfg, 'NEEDS_SPEC', `feasibility approved (option=${ts.runtime.chosen_option ?? '?'})`);
  } else {
    // 先产物后状态：归档旧草稿，再转移（避免 NEEDS_FEASIBILITY 的「草稿已存在」误判）。
    const archived = archiveFeasibilityDraft(ts, 'rejected');
    if (archived) {
      state.appendTimeline(cfg, id, `feasibility rejected，旧草稿归档 → ${path.relative(cfg.root, archived)}`);
    }
    state.appendTimeline(cfg, id, 'feasibility rejected，退回 feasibility-agent');
    state.transitionState(ts, cfg, 'NEEDS_FEASIBILITY', 'feasibility rejected', {
      feasibility_contract_invalid_count: 0,
      current_feasibility_round: 0,
    });
  }
  return { changed: true };
}
