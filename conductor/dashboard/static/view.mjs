// dashboard/static/view.mjs — 浏览器安全纯模块：零 node: 导入、不 import model.mjs。
// 可被 node 单测与浏览器 <script type="module"> 同时导入。

/** 本地定义的 lane 顺序常量，值与 model.mjs::LANE_ORDER 深等（靠单测钉住两侧一致）。 */
export const GAUGE_LANES = ['setup', 'feasibility', 'spec', 'maker', 'verify', 'merge'];

/** 新看板的四列常量，值与 model.mjs::COLUMN_ORDER 深等（靠单测钉住两侧一致）。 */
export const BOARD_COLUMNS = ['ROUTING', 'AWAIT_HUMAN', 'FAILED_BOX', 'DONE'];

/** AWAIT_HUMAN 的闸别 → 卡片徽标文案（Invariant 5：三种，封闭）。 */
const AWAITING_LABELS = { spec: 'spec 闸', merge: 'merge 闸', help: 'help 闸' };

export function awaitingLabel(kind) {
  return AWAITING_LABELS[kind] ?? '人闸';
}

/**
 * board → 页头汇总：queue/done/failed 计数、done 总花费。
 * queue 口径 = 还活着的任务：新状态机的 ROUTING + AWAIT_HUMAN 两列，加上仍按旧泳道显示的
 * 遗留任务（board.legacy）。旧载荷（只有 lanes）回落为泳道之和。
 */
export function summarizeBoard(board) {
  const queue = board.columns
    ? board.columns
      .filter((c) => c.column === 'ROUTING' || c.column === 'AWAIT_HUMAN')
      .reduce((sum, c) => sum + c.tasks.length, 0) + (board.legacy?.length ?? 0)
    : board.lanes.reduce((sum, lane) => sum + lane.tasks.length, 0);
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

/**
 * hash 路由解析（P6 全屏审查页）：`#/task/<id>` → { view:'task', id }、`#/metrics` →
 * { view:'metrics' }、其余一切（含 ''、'#'、'#/'、畸形 id）→ { view:'board' }。
 * id 字符集与 model.mjs::isValidTaskId 同宽（字母数字/-/_），最终合法性仍由 server 端裁决。
 */
export function parseRouteHash(hash) {
  const m = /^#\/task\/([A-Za-z0-9_-]+)$/.exec(hash ?? '');
  if (m) return { view: 'task', id: m[1] };
  if (hash === '#/metrics') return { view: 'metrics' };
  return { view: 'board' };
}

/**
 * 限额收箱卡片（AC-023）：runtime.rate_limit → { type, resetsAtMs, resetText, canResume }。
 * `canResume` 是「恢复」按钮的唯一开关，与 CLI `retry` 同一条规则——必须到达重置时刻之后；
 * `resets_at` 缺失（CLI 没给时刻）时不把人锁死，允许恢复。传 null 返回 null（非限额失败）。
 */
export function rateLimitPanel(rateLimit, nowMs = Date.now()) {
  if (!rateLimit) return null;
  const resetsAt = typeof rateLimit.resets_at === 'number' && Number.isFinite(rateLimit.resets_at)
    ? rateLimit.resets_at
    : null;
  const resetsAtMs = resetsAt == null ? null : resetsAt * 1000;
  const resetText = resetsAtMs == null ? '未知' : new Date(resetsAtMs).toLocaleString();
  return {
    type: rateLimit.type || 'unknown',
    resetsAtMs,
    resetText,
    canResume: resetsAtMs == null || nowMs >= resetsAtMs,
    label: `限额 ${rateLimit.type || 'unknown'}，重置于 ${resetText}`,
  };
}
