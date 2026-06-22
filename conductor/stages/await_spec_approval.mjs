// AWAIT_SPEC_APPROVAL（契约 §11）：人类闸门，纯读 runtime.approval，天然幂等。
// approved → 冻结 specs/<id>.md → dossier/<id>/spec.md → READY；
// rejected → 归档旧草稿（specs/archive/，避免 NEEDS_SPEC 的「草稿已存在」误判）→ NEEDS_SPEC；
// null → { changed:false }（闸门未动）。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { approvalNext } from './decisions.mjs';

export default function awaitSpecApprovalHandler(ts, cfg) {
  const id = ts.id;
  const next = approvalNext(ts.runtime.approval ?? null);
  if (next === null) return { changed: false }; // 闸门未动，drain 自然停住

  if (next === 'READY') {
    const draft = path.join(cfg.specsDir, `${id}.md`);
    const frozen = state.dossierPath(cfg, id, 'spec.md');
    if (fs.existsSync(draft)) {
      state.writeFileEnsured(frozen, fs.readFileSync(draft, 'utf8')); // 冻结副本，审批后只认 dossier
      state.appendTimeline(cfg, id, 'spec approved，冻结副本 → dossier/spec.md');
    } else {
      console.error(`[${id}] 警告：specs/${id}.md 缺失，READY 阶段将回退兜底生成 spec`);
    }
    state.transitionState(ts, cfg, 'READY', 'spec approved');
  } else {
    // 先产物后状态：归档旧草稿，再转移。
    const draft = path.join(cfg.specsDir, `${id}.md`);
    if (fs.existsSync(draft)) {
      const archived = path.join(cfg.specsDir, 'archive', `${id}-rejected-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      fs.renameSync(draft, archived);
      state.appendTimeline(cfg, id, `spec rejected，旧草稿归档 → specs/archive/${path.basename(archived)}`);
    }
    state.appendTimeline(cfg, id, 'spec rejected，退回 plan-agent');
    state.transitionState(ts, cfg, 'NEEDS_SPEC', 'spec rejected');
  }
  return { changed: true };
}
