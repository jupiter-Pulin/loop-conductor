// dashboard/static/metrics-view.mjs — 浏览器安全纯模块：零 node: 导入，供「指标」视图消费的
// 纯计算函数（条宽映射/明细表排序/KPI 数字格式化/空态判定）。可被 node 单测与浏览器同时导入。

/** 一组数值 → 各自占该组最大值的百分比宽度 [0,100]；最大值 ≤0（含空组）时全 0。 */
export function barWidths(values) {
  const max = (values || []).reduce((m, v) => Math.max(m, v || 0), 0);
  if (max <= 0) return (values || []).map(() => 0);
  return values.map((v) => ((v || 0) / max) * 100);
}

/** 单字段比较：null 恒排末尾（升降序皆然）；数字按大小，其余按字典序，方向只影响非 null 值。 */
function compareByKey(a, b, key, dir) {
  const av = a?.[key];
  const bv = b?.[key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
  return dir === 'desc' ? -cmp : cmp;
}

/** 明细表行 → 按 key 稳定排序的新数组（不改动入参）；dir 为 'asc'（默认）或 'desc'。 */
export function sortTableRows(rows, key, dir = 'asc') {
  return (rows || []).slice().sort((a, b) => compareByKey(a, b, key, dir));
}

/** 花费 → `$x.xx`；null 显示占位符。 */
export function formatUsd(value) {
  return value == null ? '—' : `$${Number(value).toFixed(2)}`;
}

/** 0..1 比率 → 整数百分比；null 显示占位符。 */
export function formatPercent(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

/** 秒数 → 60 秒内显示整数秒，以上显示一位小数分钟；null 显示占位符。 */
export function formatDurationSeconds(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${(seconds / 60).toFixed(1)}min`;
}

/** metrics.isEmpty 的直接判定（缺失/非 metrics 输入视为非空态，交由调用方按缺失另行处理）。 */
export function isMetricsEmpty(metrics) {
  return metrics?.isEmpty === true;
}
