// AWAIT_SPEC_APPROVAL（契约 §11）：人类闸门，纯读 runtime.approval，天然幂等。
// approved → 冻结 specs/<id>.md → dossier/<id>/spec.md → 草稿归档（specs/archive/，
//   冻结稿是唯一契约，消除双份平行 spec）→ READY；
// rejected → 归档旧草稿（specs/archive/，避免 NEEDS_SPEC 的「草稿已存在」误判）→ NEEDS_SPEC；
// null → 先问 auto-approve-spec 机器放行（默认关，谓词全绿才代章），否则 { changed:false }（闸门未动）。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { validateSpecDoc } from '../lib/spec-contract.mjs';
import { approvalNext, evaluateAutoApproveSpec } from './decisions.mjs';
import { archiveSpecDraft } from './shared.mjs';

export default async function awaitSpecApprovalHandler(ts, cfg) {
  const id = ts.id;
  let next = approvalNext(ts.runtime.approval ?? null);
  let autoApproved = false;
  if (next === null) {
    autoApproved = maybeAutoApproveSpec(ts, cfg);
    if (!autoApproved) return { changed: false }; // 闸门未动，drain 自然停住
    next = 'READY';
  }

  if (next === 'READY') {
    const draft = path.join(cfg.specsDir, `${id}.md`);
    const frozen = state.dossierPath(cfg, id, 'spec.md');
    if (fs.existsSync(draft)) {
      state.writeFileEnsured(frozen, fs.readFileSync(draft, 'utf8')); // 冻结副本，审批后只认 dossier
      state.appendTimeline(cfg, id, 'spec approved，冻结副本 → dossier/spec.md');
      // 先产物后状态：冻结完成后归档草稿，specs/ 下不留双份平行 spec（下游只认冻结稿）。
      const archived = archiveSpecDraft(cfg, id, 'approved');
      if (archived) {
        state.appendTimeline(cfg, id, `已批准草稿归档 → specs/archive/${path.basename(archived)}`);
      }
    } else {
      console.error(`[${id}] 警告：specs/${id}.md 缺失，READY 阶段将回退兜底生成 spec`);
    }
    state.transitionState(
      ts, cfg, 'READY',
      autoApproved ? 'spec auto-approved' : 'spec approved',
      autoApproved ? { approval: 'approved', approval_source: 'auto' } : {},
    );
  } else {
    // 先产物后状态：归档旧草稿，再转移。
    const draft = path.join(cfg.specsDir, `${id}.md`);
    if (fs.existsSync(draft)) {
      const archived = path.join(cfg.specsDir, 'archive', `${id}-rejected-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      fs.renameSync(draft, archived);
      state.appendTimeline(cfg, id, `spec rejected，旧草稿归档 → specs/archive/${path.basename(archived)}`);
    }
    state.appendTimeline(cfg, id, 'spec rejected，退回 spec-agent');
    state.transitionState(ts, cfg, 'NEEDS_SPEC', 'spec rejected', {
      spec_miss_count: 0,
      spec_verifier_invalid_count: 0,
      current_spec_round: 0,
    });
  }
  return { changed: true };
}

/**
 * spec 审批门机器放行（task.autoApproveSpec 显式值 > config.autoApproveSpecEnabled，默认关=零行为差异）。
 * 谓词是 decisions.evaluateAutoApproveSpec（纯函数唯一裁判）；本函数只收集输入、
 * 落 `spec-verify-r<n>.autoapprove-decision.json` + timeline + `autoapprove_decision` 事件。
 * 每 spec 轮至多评估一次：decision 已存在时直接复用（不放行则沉默留人审，放行则幂等重入）。
 * 评估路径任何异常全吞（任务保持人审闸门，fail-open to human）。
 */
function maybeAutoApproveSpec(ts, cfg) {
  const enabled = (ts.task.autoApproveSpec ?? cfg.autoApproveSpecEnabled) === true;
  if (!enabled) return false;
  const id = ts.id;
  const round = ts.runtime.current_spec_round ?? 0;
  const decisionPath = state.dossierPath(cfg, id, `spec-verify-r${round}.autoapprove-decision.json`);
  try {
    const existing = state.readJsonIf(decisionPath);
    if (existing) return existing.eligible === true; // 幂等重入：同轮不重复评估/重复留痕
    const draftPath = path.join(cfg.specsDir, `${id}.md`);
    const draftCheck = fs.existsSync(draftPath)
      ? validateSpecDoc(fs.readFileSync(draftPath, 'utf8'))
      : null;
    const decision = evaluateAutoApproveSpec({
      kind: ts.task.kind,
      draftCheck,
      maxAcs: cfg.autoApproveSpecMaxAcs,
      specVerdict: state.readJsonIf(state.dossierPath(cfg, id, `spec-verify-r${round}.verdict.json`)),
    });
    state.writeJson(decisionPath, { schema_version: 1, round, ...decision });
    state.appendTimeline(
      cfg, id,
      decision.eligible
        ? `auto-approve-spec r${round}：谓词全绿，机器代章进 READY（reject 通道与 merge 闸门不动）`
        : `auto-approve-spec r${round}：不放行（${decision.reasons.join('；')}）——留人审`,
    );
    state.appendEvent(cfg, id, 'autoapprove_decision', { round, eligible: decision.eligible, reasons: decision.reasons });
    return decision.eligible;
  } catch (err) {
    state.appendTimeline(cfg, id, `auto-approve-spec 评估异常（任务保持人审闸门）：${err?.message ?? err}`);
    return false;
  }
}
