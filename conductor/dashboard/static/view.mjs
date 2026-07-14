// dashboard/static/view.mjs — 浏览器安全纯模块：零 node: 导入、不 import model.mjs。
// 可被 node 单测与浏览器 <script type="module"> 同时导入。

/** 本地定义的 lane 顺序常量，值与 model.mjs::LANE_ORDER 深等（靠单测钉住两侧一致）。 */
export const GAUGE_LANES = ['setup', 'feasibility', 'spec', 'maker', 'verify', 'merge'];

/** board → 页头汇总：queue/done/failed 计数、done 总花费。 */
export function summarizeBoard(board) {
  const queue = board.lanes.reduce((sum, lane) => sum + lane.tasks.length, 0);
  const done = board.done.length;
  const failed = board.failed.length;
  const doneSpentUsd = board.done.reduce((sum, entry) => sum + (entry.spentUsd || 0), 0);
  return { queue, done, failed, doneSpentUsd };
}

/** 任务 entry → 长度 6、下标对齐 GAUGE_LANES 的回路刻度段状态数组。 */
export function gaugeSegments(entry) {
  if (entry.box === 'done') return GAUGE_LANES.map(() => 'pass');
  if (entry.box === 'failed') return GAUGE_LANES.map(() => 'fail');
  const idx = GAUGE_LANES.indexOf(entry.lane);
  if (idx === -1) return GAUGE_LANES.map(() => 'future');
  return GAUGE_LANES.map((_, i) => {
    if (i < idx) return 'passed';
    if (i === idx) return entry.needsHuman ? 'attn' : 'live';
    return 'future';
  });
}

// ---- merge/spec 人审面板支撑（P2）：HTML 转义 + 裁决 chip 映射，均为浏览器/node 双端可跑的纯函数 ----

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** patch/reason/summary/evidence 等磁盘或 git 文本进 DOM 前的统一转义通道（AC-004）：五个 HTML 敏感字符转实体。 */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const VERDICT_CHIP = {
  pass: { symbol: '✓', className: 'chip-pass', label: 'pass' },
  fail: { symbol: '✗', className: 'chip-fail', label: 'fail' },
  unknown: { symbol: '?', className: 'chip-unknown', label: 'unknown' },
};

/** 裁决三态 → { symbol, className, label }（AC-006）：颜色之外必带符号与文字标签，含义不只靠颜色传达。 */
export function verdictChip(status) {
  return VERDICT_CHIP[status] ?? { symbol: '?', className: 'chip-unknown', label: String(status ?? 'unknown') };
}

// ---- P3：轮次证据链支撑（纯函数，node/浏览器双端可跑） ----

const ROUND_MARKER_RE = /^maker r(\d+) spawn /;

/**
 * timelineEntries → 按轮次分组的段数组（P3-AC-009）：以 `maker r<N> spawn ` 文本行为轮次边界，
 * 边界前的条目归入 round:null 的前置组；组内条目顺序与原数组一致，渲染逻辑不变。
 */
export function groupTimelineByRound(entries) {
  const groups = [];
  let current = null;
  for (const entry of entries || []) {
    const m = ROUND_MARKER_RE.exec(entry?.text ?? '');
    if (m) {
      current = { round: Number(m[1]), entries: [entry] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { round: null, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/**
 * 轮次聚合 rounds[]（rounds.mjs::buildRoundsView 的 rounds 字段）+ 任务存活性
 * liveness('active'|'done'|'failed') → 回路刻度轮次刻度点数组（P3/P4-AC-010/AC-012）：
 * 每点 { round, state }，state ∈ 'pass'|'fail'|'pending'|'unknown'。
 * 有序决策表（自上而下首个命中生效）：①verifier.overall==='pass' → pass；②verifier.overall==='fail'
 * 或 testGate vacuous → fail；③最后一轮且 liveness==='active'（尚无终局门结果）→ pending；
 * ④最后一轮且 liveness==='failed'（无①②确定打回证据）→ fail；⑤其余一切情形（非末轮门数据缺失、
 * 非失败末轮门数据损坏、done 末轮门数据缺失）→ unknown。
 */
export function roundGaugeTicks(rounds, liveness) {
  return (rounds || []).map((r, i) => {
    const isLast = i === rounds.length - 1;
    const overall = r.verifier?.status === 'ok' ? r.verifier.overall : null;
    const vacuous = r.testGate?.status === 'ok' && r.testGate.verdict === 'vacuous';
    if (overall === 'pass') return { round: r.round, state: 'pass' };
    if (overall === 'fail' || vacuous) return { round: r.round, state: 'fail' };
    if (isLast && liveness === 'active') return { round: r.round, state: 'pending' };
    if (isLast && liveness === 'failed') return { round: r.round, state: 'fail' };
    return { round: r.round, state: 'unknown' };
  });
}

/**
 * closeDrawer 焦点回退决策表（P3-AC-011）：触发元素仍在文档中 → 返回触发元素；已脱离但按 id
 * 查得可见卡片/箱行 → 返回该元素；均无 → 返回容器（调用方须传入恒非 null 的容器）。
 */
export function resolveDrawerFocusTarget(triggerInDocument, triggerEl, cardEl, container) {
  if (triggerInDocument) return triggerEl;
  if (cardEl) return cardEl;
  return container;
}
