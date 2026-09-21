// lib/version-gate.mjs — 版本规则（Invariant 6）：merge 的唯一依据，三处共用同一份纯函数
// （ROUTING 的动作前置、merge 批准的复算、router 内核事实段）。零 IO。
//
// 记 H = 任务分支当前 HEAD，B = base 分支当前 HEAD，S = 当前获批 spec 的内容哈希：
//   需要 review    ⇔ 当前 (H, S) 上没有「判全且全 pass」的整体 review
//                     · 有 spec 的任务：按判决台账算（lib/review-ledger.mjs::reviewCoverage，由调用方读盘后传入）
//                       ——全部获批 AC 都判过且全部 pass。reviewer 自述 ok 不算数，判了一半不算数，
//                       对旧 H 或旧 spec 版本的判决不算数。
//                     · 无 spec 的任务（brief 即契约，编号由 reviewer 自编，内核无从枚举）：
//                       存在 outcome=ok ∧ head_sha=H 的 reviewer 记录。
//   需要 precommit ⇔ 不存在 outcome=ok ∧ head_sha=H ∧ base_sha=B、且 tier 不低于 reviewer 在 H 上
//                     声明的最高层级的 precommit 记录
// 人的 notes、human_intervened、子任务完成、局部检查、router 的满意判断都不能替代这两条——
// 「我看过了」不是版本，「这个子任务做完了」也不是整体验收。

const TIER_ORDER = { unit: 1, integration: 2, e2e: 3 };

function matchesOk(rec, role) {
  return rec != null && rec.role === role && rec.outcome === 'ok';
}

/**
 * 当前 H 上是否还缺一次通过的整体 review。H 缺失（还没有任务分支）时恒为 true。
 * opts.coverage 给了（有 spec 的任务）就只认台账；没给走无 spec 的旧口径。
 */
export function needReview(records, H, { coverage = undefined } = {}) {
  if (!H) return true;
  if (coverage !== undefined) return !(coverage != null && coverage.complete === true && coverage.allPass === true);
  return !(records ?? []).some((r) => matchesOk(r, 'reviewer') && r.head_sha === H);
}

/** reviewer 在当前 H 上声明的最高 tier（precommit 的 tier 下界）；没有则 null。 */
export function reviewerTierAt(records, H) {
  let best = null;
  for (const r of records ?? []) {
    if (r?.role !== 'reviewer' || r.head_sha !== H || !r.tier) continue;
    if (best == null || (TIER_ORDER[r.tier] ?? 0) > (TIER_ORDER[best] ?? 0)) best = r.tier;
  }
  return best;
}

/**
 * 当前 H/B 组合上是否还缺一次通过的 precommit。H 或 B 缺失时恒为 true。
 * precommit 现在也可以在 review 之前当「集成检查」跑（router 选层级）；所以层级下界必须在这里
 * 再卡一次：review 之后才声明的更高 tier，会让之前那次较低层级的 precommit 不再够格。
 */
export function needPrecommit(records, H, B) {
  if (!H || !B) return true;
  const floor = TIER_ORDER[reviewerTierAt(records, H)] ?? 0;
  return !(records ?? []).some((r) => matchesOk(r, 'precommit') && r.head_sha === H && r.base_sha === B
    && (TIER_ORDER[r.tier] ?? 0) >= floor);
}

/** 两条都不需要时才允许申请 merge。 */
export function mergeAllowed(records, H, B, opts = {}) {
  return !needReview(records, H, opts) && !needPrecommit(records, H, B);
}
