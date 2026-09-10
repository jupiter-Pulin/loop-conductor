// lib/version-gate.mjs — 版本规则（Invariant 6）：merge 的唯一依据，三处共用同一份纯函数
// （ROUTING 的动作前置、merge 批准的复算、router 内核事实段）。零 IO。
//
// 记 H = 任务分支当前 HEAD，B = base 分支当前 HEAD：
//   需要 review    ⇔ 不存在 outcome=ok ∧ head_sha=H 的 reviewer 记录
//   需要 precommit ⇔ 不存在 outcome=ok ∧ head_sha=H ∧ base_sha=B 的 precommit 记录
// 人的 notes、human_intervened、包状态、越界文件都不能替代这两条——「我看过了」不是版本。

function matchesOk(rec, role) {
  return rec != null && rec.role === role && rec.outcome === 'ok';
}

/** 当前 H 上是否还缺一次通过的整体 review。H 缺失（还没有任务分支）时恒为 true。 */
export function needReview(records, H) {
  if (!H) return true;
  return !(records ?? []).some((r) => matchesOk(r, 'reviewer') && r.head_sha === H);
}

/** 当前 H/B 组合上是否还缺一次通过的 precommit。H 或 B 缺失时恒为 true。 */
export function needPrecommit(records, H, B) {
  if (!H || !B) return true;
  return !(records ?? []).some((r) => matchesOk(r, 'precommit') && r.head_sha === H && r.base_sha === B);
}

/** 两条都不需要时才允许申请 merge。 */
export function mergeAllowed(records, H, B) {
  return !needReview(records, H) && !needPrecommit(records, H, B);
}

/** reviewer 在当前 H 上声明的最高 tier（precommit 的 tier 下界）；没有则 null。 */
export function reviewerTierAt(records, H) {
  const order = { unit: 1, integration: 2, e2e: 3 };
  let best = null;
  for (const r of records ?? []) {
    if (r?.role !== 'reviewer' || r.head_sha !== H || !r.tier) continue;
    if (best == null || (order[r.tier] ?? 0) > (order[best] ?? 0)) best = r.tier;
  }
  return best;
}
