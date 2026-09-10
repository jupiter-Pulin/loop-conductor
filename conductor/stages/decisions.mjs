// stages/decisions.mjs — 状态机的常量与几个零 IO 的纯判据。
//
// router 纪元里「下一步做什么」不再由这里的谓词表决定：动作由 router 选，前置由
// stages/routing.mjs 按闭集校验，版本规则在 lib/version-gate.mjs，保险丝在 lib/fuse.mjs。
// 留在这里的只有跨模块共用、又不属于任何一个模块的小东西。
// 不做任何 IO；handler 只是「读盘 → 调这里 → 落盘」。

/**
 * 全部 stage（AC-001）：ROUTING ⇄ AWAIT_HUMAN → DONE，外加 FAILED_BOX。
 * queue 里出现不在这张表里的名字（P3 之前建的遗留任务）由 scheduler 打印「未知 stage，跳过」。
 */
export const STAGES = Object.freeze(['ROUTING', 'AWAIT_HUMAN', 'FAILED_BOX', 'DONE']);

/** 人闸种类封闭（Invariant 5）。 */
export const HUMAN_GATE_KINDS = Object.freeze(['spec', 'merge', 'help']);

/** 预算闸：达到上限即拒绝 spawn。 */
export function overBudget(spentUsd, budgetUsd) {
  return (spentUsd ?? 0) >= budgetUsd;
}

/**
 * 整段必须是严格 JSON（容忍 ```json 围栏），绝不在叙事里打捞；失败返回 null。
 * trim → 去 ```json 围栏 → JSON.parse → 失败 null。
 */
export function parseStrictJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { return null; }
}

/** 解析 `git diff --numstat` 输出：{ total_lines, files, binary }。二进制行（-\t-）计入 binary。 */
export function parseNumstat(text) {
  let totalLines = 0;
  const files = [];
  let binary = 0;
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const [added, deleted, ...rest] = line.split('\t');
    const p = rest.join('\t').trim();
    if (p === '') continue;
    files.push(p);
    if (added === '-' || deleted === '-') {
      binary++;
      continue;
    }
    totalLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { total_lines: totalLines, files, binary };
}
