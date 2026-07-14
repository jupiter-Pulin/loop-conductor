// dashboard/static/metrics-view.mjs 单测（P5 AC-008）：条宽映射、明细表排序 comparator、
// KPI 数字格式化、空态判定四类纯函数，node 直接 import 断言（浏览器安全模块，零 node: 导入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barWidths, sortTableRows, formatUsd, formatPercent, formatDurationSeconds, isMetricsEmpty,
} from '../../conductor/dashboard/static/metrics-view.mjs';

test('barWidths：条宽映射 value→[0,100]%，分母取该组最大值，最大值为 0（含空组）时全 0（AC-008）', () => {
  assert.deepEqual(barWidths([10, 5, 20]), [50, 25, 100]);
  assert.deepEqual(barWidths([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(barWidths([]), []);
  assert.deepEqual(barWidths([3]), [100]);
});

test('sortTableRows：对 id/kind/rounds/spentUsd/box/primaryRejectDoor 稳定排序，升降序可选（AC-008）', () => {
  const rows = [
    { id: 'task-c', kind: 'bugfix', rounds: 2, spentUsd: 3, box: 'done', primaryRejectDoor: null },
    { id: 'task-a', kind: 'feature', rounds: 1, spentUsd: 5, box: 'failed', primaryRejectDoor: 'verifier' },
    { id: 'task-b', kind: 'bugfix', rounds: 1, spentUsd: 1, box: 'done', primaryRejectDoor: null },
  ];
  assert.deepEqual(sortTableRows(rows, 'id', 'asc').map((r) => r.id), ['task-a', 'task-b', 'task-c']);
  assert.deepEqual(sortTableRows(rows, 'id', 'desc').map((r) => r.id), ['task-c', 'task-b', 'task-a']);
  assert.deepEqual(sortTableRows(rows, 'spentUsd', 'asc').map((r) => r.spentUsd), [1, 3, 5]);
  // rounds 相等时（task-a、task-b 均为 1）稳定排序保留原数组相对顺序（a 在 b 之前）。
  assert.deepEqual(sortTableRows(rows, 'rounds', 'asc').map((r) => r.id), ['task-a', 'task-b', 'task-c']);
  // 排序不改动入参数组。
  assert.deepEqual(rows.map((r) => r.id), ['task-c', 'task-a', 'task-b']);
});

test('sortTableRows：primaryRejectDoor 为 null 的行恒排在末尾（AC-008）', () => {
  const rows = [
    { id: 'x', primaryRejectDoor: 'verifier' },
    { id: 'y', primaryRejectDoor: null },
    { id: 'z', primaryRejectDoor: 'maker' },
  ];
  assert.deepEqual(sortTableRows(rows, 'primaryRejectDoor', 'asc').map((r) => r.id), ['z', 'x', 'y']);
  assert.deepEqual(sortTableRows(rows, 'primaryRejectDoor', 'desc').map((r) => r.id), ['x', 'z', 'y']);
});

test('formatUsd：花费格式化为 $x.xx，null 显示占位符（AC-008）', () => {
  assert.equal(formatUsd(2), '$2.00');
  assert.equal(formatUsd(12.5), '$12.50');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(null), '—');
});

test('formatPercent：比率格式化为整数百分比，null 显示占位符（AC-008）', () => {
  assert.equal(formatPercent(0.5), '50%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(1 / 3), '33%');
  assert.equal(formatPercent(null), '—');
});

test('formatDurationSeconds：60 秒内显示整数秒，以上显示一位小数分钟，null 显示占位符（AC-008）', () => {
  assert.equal(formatDurationSeconds(45), '45s');
  assert.equal(formatDurationSeconds(59), '59s');
  assert.equal(formatDurationSeconds(60), '1.0min');
  assert.equal(formatDurationSeconds(90), '1.5min');
  assert.equal(formatDurationSeconds(null), '—');
});

test('isMetricsEmpty：依据 metrics.isEmpty 判定，缺失/非法输入视为非空态（AC-008）', () => {
  assert.equal(isMetricsEmpty({ isEmpty: true }), true);
  assert.equal(isMetricsEmpty({ isEmpty: false }), false);
  assert.equal(isMetricsEmpty(null), false);
  assert.equal(isMetricsEmpty(undefined), false);
});
