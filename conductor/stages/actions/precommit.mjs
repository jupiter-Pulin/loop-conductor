// actions/precommit.mjs — router 的 `precommit` 动作：在合并候选上跑三步（build → service → 分层测试）。
//
// 没有 agent：内核跑完自己合成一条同构记录（lib/precommit.mjs::runPrecommit 已负责候选 worktree、
// 全局串行锁、进程组清理与记录落盘，并把 base_sha=B / head_sha=H 盖进记录）。
// 这里只做三件事：调它、记事件、把结果交回 ROUTING。runPrecommit 永不抛错——任何失败都只是
// 记录里的一条 `outcome: fail`，router 照常决策。

import * as state from '../../lib/state.mjs';
import { runPrecommit } from '../../lib/precommit.mjs';
import { taskBranchName } from '../router-kernel.mjs';

export default async function precommitAction(ts, cfg, { round, decision }) {
  const id = ts.id;
  const record = await runPrecommit({
    cfg,
    id,
    task: ts.task,
    round,
    tier: decision.tier,
    taskBranch: taskBranchName(id),
  });
  state.appendEventAlways(cfg, id, 'precommit_result', {
    round,
    tier: record?.tier ?? decision.tier,
    outcome: record?.outcome ?? 'fail',
    summary: record?.summary ?? null,
  });
  state.appendTimeline(cfg, id, `precommit r${round}（tier=${record?.tier ?? decision.tier}）：${record?.outcome ?? 'fail'} — ${record?.summary ?? ''}`);
  return { changed: true };
}
