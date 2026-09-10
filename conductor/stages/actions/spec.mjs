// actions/spec.mjs — router 的 `spec` 动作：在一次性只读 worktree 里让 spec-agent 写 spec，
// 结束后由内核（不是 agent 的 outcome）判定能否送人审。
//
// 边界：
//   - cwd 是 base 分支的一次性 detached worktree（沿用 spec 链隔离）：任何越轨写都落在随后即弃
//     的目录里，物理到不了用户 checkout。交付面走编排侧绝对路径（specs/<id>.md、log），不受影响。
//   - 送不送人审只看 `validateSpecDoc(specs/<id>.md)`，与 spec log 的 outcome 无关（AC-013）：
//     agent 说 ok 但文件不合格照样留在 ROUTING；agent 说 needs_human 但文件合格照样开闸——
//     人在闸上看得到那句 summary。
//   - packagesEnabled=false（P2 阶段闸）：prompt 不含工作包段、白名单不放行 packages 路径、
//     validatePackages 不被调用。

import fs from 'node:fs';
import path from 'node:path';
import * as state from '../../lib/state.mjs';
import { addDetachedWorktree, removeWorktree } from '../../lib/git.mjs';
import { taskCfg } from '../../lib/task-cfg.mjs';
import { validateSpecDoc } from '../../lib/spec-contract.mjs';
import { buildSpecPrompt } from '../../lib/prompts.mjs';
import { logPathFor } from '../../lib/agent-settings.mjs';
import { rateLimitedToBox } from '../shared.mjs';
import {
  checkBudgetAndBox, openHumanGate, packagesDraftPath, readBriefText, relRef,
  spawnAgentRound, specDraftPath, specRejectNotes,
} from '../router-kernel.mjs';

/**
 * spec 链隔离的一次性只读 worktree @ base。建不起来时 fail-open 回退真仓库 cwd
 * （隔离是加固，不是可用性闸门），并记一行 timeline。返回 { cwd, cleanup }。
 */
function acquireSpecCwd(ts, cfg) {
  const repo = taskCfg(ts, cfg).targetRepo;
  const wtPath = path.join(cfg.worktreesDir, `${ts.id}.spec-ro`);
  removeWorktree(repo, wtPath); // 清崩溃残留；无残留时是无害 no-op
  fs.rmSync(wtPath, { recursive: true, force: true });
  const added = addDetachedWorktree(repo, wtPath, ts.task.baseBranch);
  if (!added.ok) {
    state.appendTimeline(cfg, ts.id, `spec 只读 worktree 建立失败（${added.error}），本轮回退真仓库 cwd`);
    return { cwd: repo, cleanup: () => {} };
  }
  return {
    cwd: wtPath,
    cleanup: () => {
      try { removeWorktree(repo, wtPath); fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* 清理失败不影响主链 */ }
    },
  };
}

export default async function specAction(ts, cfg, { round, records }) {
  const id = ts.id;
  const boxed = checkBudgetAndBox(ts, cfg);
  if (boxed) return boxed;

  const packagesEnabled = cfg.packagesEnabled === true;
  const specPath = specDraftPath(cfg, id);
  const held = acquireSpecCwd(ts, cfg);
  let res;
  try {
    const prompt = buildSpecPrompt(cfg, {
      id,
      mode: 'draft',
      specPath,
      packagesPath: packagesDraftPath(cfg, id),
      logPath: logPathFor(cfg, id, 'spec', round),
      brief: readBriefText(ts),
      rejectNotes: specRejectNotes(records),
      packagesEnabled,
    });
    res = await spawnAgentRound(ts, cfg, {
      role: 'spec', round, prompt, cwd: held.cwd, packagesEnabled,
    });
  } finally {
    held.cleanup();
  }

  const limited = rateLimitedToBox(ts, cfg, 'spec', res);
  if (limited) return limited;

  const check = validateSpecDoc(fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null);
  if (!check.ok) {
    state.appendEventAlways(cfg, id, 'spec_invalid', { round, errors: check.errors });
    state.appendTimeline(cfg, id, `spec r${round} 交付不合格（${check.errors.join('; ')}），留在 ROUTING`);
    return { changed: true };
  }
  return openHumanGate(ts, cfg, {
    kind: 'spec',
    requestedBy: 'kernel',
    summary: `spec 待审：AC×${check.acs.length}（${relRef(cfg, specPath)}）`,
    refs: [relRef(cfg, specPath)],
    round,
  });
}
