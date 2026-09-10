// dashboard/static/app.mjs — 看板屏浏览器入口：屏 1 看板增量渲染 / 屏 2 详情（窄抽屉监控态 +
// #/task/<id> 全屏审查页）/ 屏 3 新建任务面板 / 屏 4 指标视图。
// 契约不变：/api/board、/api/task/:id、五个同步动作、/api/new-task；轮询周期恒 1500ms（I-4），
// P4 起以 /api/events SSE 失效通知驱动增量刷新，SSE 不可用/断线时 1500ms 轮询兜底恒可用（INV-3）。
// P6 详情双面分工：抽屉只做监控 peek（无决策按钮），一切人审决策（approve/reject/merge/retry)
// 只存在于全屏审查页；页由 hash 路由驱动，可刷新、可回退。
import {
  GAUGE_LANES, summarizeBoard, gaugeSegments, escapeHtml, verdictChip,
  groupTimelineByRound, roundGaugeTicks, resolveDrawerFocusTarget, parseRouteHash, rateLimitPanel,
} from './view.mjs';
import {
  barWidths, sortTableRows, formatUsd, formatPercent, formatDurationSeconds, isMetricsEmpty,
} from './metrics-view.mjs';

const LANES = GAUGE_LANES.map((key) => ({ key, label: key, you: key === 'merge' }));

let latestBoard = null;
let detailMode = null; // 'drawer'（监控 peek）| 'page'（全屏审查页）| null
let detailTaskId = null;
let lastDetail = null;
let lastDiff = null;
let selectedOption = null;
let pendingActionMessage = null;
let expandedDiffFiles = new Set();
let drawerTriggerEl = null;
let lastStreamTail = null;
let currentView = 'board';
let lastMetrics = null;
let metricsSort = { key: 'spentUsd', dir: 'desc' };

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function fmtUsd(n) { return `$${Number(n || 0).toFixed(2)}`; }

/** 当前浏览器本地时间 `HH:MM:SS`（页头「最近一次刷新时刻」用）。 */
function fmtNowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- 全局页头：五项监工上下文(骨架只建一次,轮询只 patch 变化的 stat-value 文本,避免每 1.5s 全量重建引发布局跳动) ----

const HEADER_STAT_DEFS = [
  ['target repo', 'targetRepo'],
  ['base branch', 'baseBranch'],
  ['queue/done/failed', 'queueDoneFailed'],
  ['done 花费', 'doneSpentUsd'],
  ['刷新于', 'refreshedAt'],
];
const headerStatEls = new Map(); // key -> stat-value span

function ensureHeaderStatsSkeleton() {
  if (headerStatEls.size > 0) return;
  const wrap = document.getElementById('header-stats');
  for (const [label, key] of HEADER_STAT_DEFS) {
    const valueEl = el('span', { class: 'stat-value' });
    wrap.appendChild(el('span', { class: 'stat' }, [
      el('span', { class: 'stat-label', text: `${label} ` }),
      valueEl,
    ]));
    headerStatEls.set(key, valueEl);
  }
}

function setStatText(key, text) {
  const valueEl = headerStatEls.get(key);
  if (valueEl.textContent !== text) valueEl.textContent = text;
}

function renderHeaderStats(board) {
  ensureHeaderStatsSkeleton();
  const stats = summarizeBoard(board);
  const cfg = board.config || {};
  setStatText('targetRepo', cfg.targetRepo || '(unset)');
  setStatText('baseBranch', cfg.baseBranch || '(currentBranch)');
  setStatText('queueDoneFailed', `${stats.queue} / ${stats.done} / ${stats.failed}`);
  setStatText('doneSpentUsd', fmtUsd(stats.doneSpentUsd));
  setStatText('refreshedAt', fmtNowLocal());
}

// ---- 屏 1：看板（keyed 增量渲染：卡片按任务 id 复用节点，签名变化才重建，避免轮询闪烁） ----

const cardCache = new Map(); // id -> { node, sig }
const laneEls = new Map();   // lane key -> { flag, row, wrap }

function workingLabel() {
  return el('div', { class: 'working' }, [el('span', { class: 'spin', text: '↻' }), ' working…']);
}

function cardSig(entry) {
  return [entry.stage, entry.needsHuman, entry.working, entry.spentUsd, entry.kind, entry.title].join('|');
}

function buildGaugeNode(entry) {
  const segs = gaugeSegments(entry);
  return el('div', { class: 'gauge' }, segs.map((state) => el('span', { class: `seg ${state}` })));
}

/** 卡片点击分流：needs-human 直达全屏审查页（少一跳），推进中任务开监控 peek 抽屉。 */
function openTaskEntry(entry, triggerEl) {
  if (entry.needsHuman) gotoTask(entry.id);
  else openDrawer(entry.id, triggerEl);
}

function buildCardNode(entry) {
  const card = el('div', {
    class: 'card' + (entry.needsHuman ? ' needs-human' : ''),
    'data-id': entry.id,
    tabindex: '0',
    role: 'button',
    onclick: (e) => openTaskEntry(entry, e.currentTarget),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openTaskEntry(entry, e.currentTarget);
    },
  }, [
    el('div', { class: 'top-row' }, [
      el('span', { class: 'task-id', text: entry.id }),
      el('span', { class: 'spent', text: fmtUsd(entry.spentUsd) }),
    ]),
    el('div', {}, [
      el('span', { class: 'badge badge-kind', text: String(entry.kind || '?').toUpperCase() }),
    ]),
    el('div', { class: 'title', text: entry.title || '(无标题)' }),
    buildGaugeNode(entry),
  ]);
  if (entry.needsHuman) {
    card.appendChild(el('div', { class: 'needs-you', text: '⚑ needs you' }));
    card.appendChild(el('div', { class: 'review-btn', text: 'Review →' }));
  } else if (entry.working) {
    card.appendChild(workingLabel());
  }
  return card;
}

/** 泳道骨架只建一次；轮询只做 per-lane 补丁。 */
function ensureLaneSkeleton() {
  if (laneEls.size > 0) return;
  const container = document.getElementById('lanes');
  LANES.forEach((laneDef, i) => {
    const flag = el('span', { class: 'lane-flag', text: '⚑' });
    flag.style.display = 'none';
    const header = el('div', { class: 'lane-header' }, [
      el('span', { class: 'lane-name', text: laneDef.label }),
      flag,
      el('span', { class: 'lane-sub', text: laneDef.you ? 'you · merge' : `${laneDef.label} agent` }),
    ]);
    const row = el('div', { class: 'lane-row' });
    const wrap = el('div', { class: 'lane' }, [header, row]);
    wrap.style.setProperty('--lane-i', i);
    container.appendChild(wrap);
    laneEls.set(laneDef.key, { flag, row, wrap });
  });
}

function renderEmptyState() {
  const slot = document.getElementById('empty-state-slot');
  slot.innerHTML = '';
  slot.appendChild(el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-title', text: '队列为空' }),
    el('div', { class: 'empty-hint', text: '尚无任何任务在跑 — 用「新建任务」投递第一个任务' }),
    el('button', {
      class: 'btn btn-primary', text: '+ 新建任务',
      onclick: () => { document.getElementById('btn-new-task').click(); },
    }),
  ]));
}

function renderLanes(board) {
  ensureLaneSkeleton();
  const lanesContainer = document.getElementById('lanes');
  const emptySlot = document.getElementById('empty-state-slot');
  const totalQueue = board.lanes.reduce((sum, l) => sum + l.tasks.length, 0);

  if (totalQueue === 0) {
    lanesContainer.style.display = 'none';
    renderEmptyState();
    for (const [, cached] of cardCache) cached.node.remove();
    cardCache.clear();
    return;
  }
  lanesContainer.style.display = '';
  emptySlot.innerHTML = '';

  const seen = new Set();
  for (const laneDef of LANES) {
    const { flag, row, wrap } = laneEls.get(laneDef.key);
    const laneData = board.lanes.find((l) => l.lane === laneDef.key) || { tasks: [] };
    const idle = laneData.tasks.length === 0;
    wrap.classList.toggle('idle', idle);
    if (idle) {
      row.innerHTML = '';
      if (!wrap.querySelector('.idle-bar')) {
        wrap.appendChild(el('div', { class: 'idle-bar' }, [
          el('span', { class: 'idle-name', text: laneDef.label }),
          el('span', { class: 'idle-count', text: '0' }),
        ]));
      }
      flag.style.display = 'none';
      continue;
    }
    const existingIdleBar = wrap.querySelector('.idle-bar');
    if (existingIdleBar) existingIdleBar.remove();
    flag.style.display = laneData.tasks.some((t) => t.needsHuman) ? '' : 'none';
    let anchor = null; // 已就位的前一张卡，用于保序且不打扰未变动节点（DOM 重插会重置 CSS 动画）
    for (const entry of laneData.tasks) {
      seen.add(entry.id);
      const sig = cardSig(entry);
      let cached = cardCache.get(entry.id);
      if (!cached) {
        cached = { node: buildCardNode(entry), sig };
        cached.node.classList.add('card-enter');
        cardCache.set(entry.id, cached);
      } else if (cached.sig !== sig) {
        const fresh = buildCardNode(entry);
        fresh.classList.add('card-updated');
        if (cached.node.parentNode) cached.node.replaceWith(fresh);
        cached.node = fresh;
        cached.sig = sig;
      }
      const expected = anchor ? anchor.nextSibling : row.firstChild;
      if (cached.node !== expected) row.insertBefore(cached.node, expected);
      anchor = cached.node;
    }
  }
  for (const [id, cached] of cardCache) {
    if (!seen.has(id)) { cached.node.remove(); cardCache.delete(id); }
  }
}

const boxListSig = new Map(); // containerId -> 上次渲染的内容签名（变化才重建，保住 hover 与动画）

function renderBoxList(containerId, tasks) {
  const sig = tasks.map((t) => `${t.id}|${t.kind}|${t.title}|${t.spentUsd}`).join(';');
  if (boxListSig.get(containerId) === sig) return;
  boxListSig.set(containerId, sig);
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const entry of tasks) {
    // done/failed 都是复盘场景：直达全屏审查页，不走监控抽屉。
    container.appendChild(el('div', {
      class: 'box-row',
      'data-id': entry.id,
      tabindex: '0',
      role: 'button',
      onclick: () => gotoTask(entry.id),
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        gotoTask(entry.id);
      },
    }, [
      el('span', { class: 'task-id', text: entry.id }),
      el('span', { class: 'badge badge-kind', text: String(entry.kind || '?').toUpperCase() }),
      el('span', { text: entry.title || '' }),
      el('span', { class: 'spent', text: fmtUsd(entry.spentUsd) }),
    ]));
  }
}

function renderBrokenBanner(broken) {
  const slot = document.getElementById('broken-banner-slot');
  slot.innerHTML = '';
  if (!broken || broken.length === 0) return;
  slot.appendChild(el('div', {
    class: 'broken-banner',
    text: `⚠ ${broken.length} 个任务目录状态异常：${broken.map((b) => b.id).join(', ')}`,
  }));
}

async function loadBoard() {
  const { status, body } = await api('/api/board');
  if (status !== 200 || !body) return;
  latestBoard = body;
  document.getElementById('done-count').textContent = body.done.length;
  document.getElementById('failed-count').textContent = body.failed.length;
  renderHeaderStats(body);
  renderLanes(body);
  renderBoxList('done-list', body.done);
  renderBoxList('failed-list', body.failed);
  renderBrokenBanner(body.broken);
  loadActivity();
}

// ---- 实时活动面（P4-G2）：页头显示「现在哪个 agent 在跑」，无活跃时静默 ----

const activityCache = new Map(); // "taskId|role|round" -> node，跨轮询保留未变节点，beacon 呼吸动效不因轮询重启

function activityKey(a) { return `${a.taskId}|${a.role}|${a.round}`; }

function buildActivityBadgeNode(a) {
  return el('span', { class: 'activity-badge activity-badge--live' }, [
    el('span', { class: 'activity-dot' }),
    el('span', { class: 'mono', text: `${a.taskId} · ${a.role} r${a.round}` }),
  ]);
}

/** keyed 增量渲染(同 renderLanes 的卡片缓存手法):未变的活跃项复用节点,避免每次轮询重建导致
 *  beacon 呼吸动效从头重播、也避免不必要的 DOM 抖动(轮询刷新禁布局跳动)。 */
function renderActivity(active) {
  const wrap = document.getElementById('header-activity');
  const seen = new Set();
  let anchor = null;
  for (const a of active) {
    const key = activityKey(a);
    seen.add(key);
    let node = activityCache.get(key);
    if (!node) {
      node = buildActivityBadgeNode(a);
      node.classList.add('badge-enter');
      activityCache.set(key, node);
    }
    const expected = anchor ? anchor.nextSibling : wrap.firstChild;
    if (node !== expected) wrap.insertBefore(node, expected);
    anchor = node;
  }
  for (const [key, node] of activityCache) {
    if (!seen.has(key)) { node.remove(); activityCache.delete(key); }
  }
}

async function loadActivity() {
  const { status, body } = await api('/api/activity');
  if (status !== 200 || !body) return;
  renderActivity(body.active || []);
}

document.getElementById('toggle-done').addEventListener('click', () => {
  document.getElementById('done-wrap').classList.toggle('open');
});
document.getElementById('toggle-failed').addEventListener('click', () => {
  document.getElementById('failed-wrap').classList.toggle('open');
});

// ---- hash 路由（P6）：'' → 看板、#/metrics → 指标、#/task/<id> → 全屏审查页。 ----
// hash 是唯一路由事实源：导航按钮/卡片只改 hash，渲染统一走 hashchange → applyRoute。

function gotoBoard() {
  if (parseRouteHash(location.hash).view === 'board') return;
  location.hash = ''; // 留下裸 '#' 无害，仍解析为 board
}

function gotoMetrics() {
  if (location.hash === '#/metrics') return;
  location.hash = '#/metrics';
}

function gotoTask(id) {
  const target = `#/task/${id}`;
  if (location.hash === target) return;
  location.hash = target;
}

function applyRoute() {
  const route = parseRouteHash(location.hash);
  if (route.view === 'task') { openTaskPage(route.id); return; }
  if (detailMode === 'page') closeTaskPage();
  switchView(route.view);
}

// ---- 屏 4：指标视图（P5）：花费/良率/打回归因/阶段耗时聚合 + 零依赖手绘条形图 ----

function switchView(view) {
  currentView = view;
  document.getElementById('nav-board').classList.toggle('active', view === 'board');
  document.getElementById('nav-metrics').classList.toggle('active', view === 'metrics');
  document.getElementById('view-board').hidden = view !== 'board';
  document.getElementById('view-metrics').hidden = view !== 'metrics';
  document.getElementById('view-task').hidden = view !== 'task';
  if (view === 'metrics') loadMetrics();
}
document.getElementById('nav-board').addEventListener('click', gotoBoard);
document.getElementById('nav-metrics').addEventListener('click', gotoMetrics);

async function loadMetrics() {
  const { status, body } = await api('/api/metrics');
  if (status !== 200 || !body) return;
  lastMetrics = body;
  renderMetrics(body);
}

function metricBarNode(label, displayValue, widthPct, isFail) {
  return el('div', { class: 'metric-bar-row' }, [
    el('span', { class: 'metric-bar-label mono', text: label }),
    el('div', { class: 'metric-bar-track' }, [
      el('div', { class: `metric-bar-fill${isFail ? ' fail' : ''}`, style: `width:${widthPct}%` }),
    ]),
    el('span', { class: 'metric-bar-value mono', text: displayValue }),
  ]);
}

function metricsChartNode(title, meta) {
  return el('div', { class: 'metrics-chart' }, [
    el('h3', { text: title }),
    el('div', { class: 'metrics-chart-meta', text: meta }),
  ]);
}

function buildCostChart(totals) {
  const wrap = metricsChartNode('花费分布', '单位：USD（分位） · 数据来源：state/{done,failed}/<id>/runtime.json 的 spent_usd');
  const sp = totals.spentPercentiles;
  if (sp.n === 0) { wrap.appendChild(el('div', { class: 'metrics-empty-inline', text: '暂无花费样本' })); return wrap; }
  const rows = [['p50', sp.p50], ['p90', sp.p90], ['max', sp.max]];
  const widths = barWidths(rows.map(([, v]) => v ?? 0));
  rows.forEach(([label, v], i) => wrap.appendChild(metricBarNode(label, formatUsd(v), widths[i], false)));
  return wrap;
}

const REJECT_DOOR_LABELS = [['verifier', 'verifier'], ['test-gate', 'test gate'], ['green-gate', 'green gate'], ['maker', 'maker']];

function buildRejectChart(table) {
  const wrap = metricsChartNode(
    '打回归因',
    '单位：任务数 · 数据来源：各轮 verify-r*.verdict.json / test-gate-r*.json / green-gate-r*.json / maker-r*.json（任务最大轮首个命中门）',
  );
  if (table.length === 0) { wrap.appendChild(el('div', { class: 'metrics-empty-inline', text: '暂无任务明细' })); return wrap; }
  const counts = Object.fromEntries(REJECT_DOOR_LABELS.map(([key]) => [key, 0]));
  for (const row of table) if (row.primaryRejectDoor && counts[row.primaryRejectDoor] !== undefined) counts[row.primaryRejectDoor]++;
  const values = REJECT_DOOR_LABELS.map(([key]) => counts[key]);
  const widths = barWidths(values);
  REJECT_DOOR_LABELS.forEach(([, label], i) => wrap.appendChild(metricBarNode(label, String(values[i]), widths[i], true)));
  return wrap;
}

function buildDurationChart(durations) {
  const wrap = metricsChartNode('阶段耗时', '单位：秒/分（p50 中位数） · 数据来源：dossier/<id>/timeline.md 的 stage → 转移时间戳差分');
  const lanes = durations.lanes;
  if (lanes.every((l) => l.n === 0)) { wrap.appendChild(el('div', { class: 'metrics-empty-inline', text: '暂无阶段耗时样本' })); return wrap; }
  const widths = barWidths(lanes.map((l) => l.p50 ?? 0));
  lanes.forEach((l, i) => wrap.appendChild(metricBarNode(l.lane, formatDurationSeconds(l.p50), widths[i], false)));
  return wrap;
}

function buildKpiRow(metrics) {
  const wrap = el('div', { class: 'metrics-kpi-row' });
  const kpi = (label, value) => wrap.appendChild(el('div', { class: 'metrics-kpi' }, [
    el('span', { class: 'metrics-kpi-label', text: label }),
    el('span', { class: 'metrics-kpi-value mono', text: value }),
  ]));
  kpi('总花费', formatUsd(metrics.totals.totalSpentUsd));
  kpi('任务数（done/failed）', `${metrics.totals.taskCount.done} / ${metrics.totals.taskCount.failed}`);
  kpi('一次通过率', formatPercent(metrics.yield.firstPassRate.value));
  kpi('平均轮次', metrics.yield.avgRounds.value == null ? '—' : metrics.yield.avgRounds.value.toFixed(1));
  kpi('maker miss 率', formatPercent(metrics.yield.makerMissRate.value));
  kpi('verifier 打回率', formatPercent(metrics.yield.verifierRejectRate.value));
  return wrap;
}

const METRICS_TABLE_COLUMNS = [
  { key: 'id', label: 'id' }, { key: 'kind', label: 'kind' }, { key: 'box', label: 'box' },
  { key: 'rounds', label: 'rounds' }, { key: 'spentUsd', label: 'spent' }, { key: 'primaryRejectDoor', label: 'reject door' },
];

function buildMetricsTable(table) {
  const wrap = metricsChartNode('逐任务明细', '数据来源：state/{done,failed}/<id>/{task.json,runtime.json} + dossier/<id>/ 各轮门 JSON');
  if (table.length === 0) { wrap.appendChild(el('div', { class: 'metrics-empty-inline', text: '暂无任务明细' })); return wrap; }
  const sorted = sortTableRows(table, metricsSort.key, metricsSort.dir);
  const thead = el('tr', {}, METRICS_TABLE_COLUMNS.map((col) => {
    const arrow = metricsSort.key === col.key ? (metricsSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      text: col.label + arrow,
      onclick: () => {
        metricsSort = { key: col.key, dir: metricsSort.key === col.key && metricsSort.dir === 'asc' ? 'desc' : 'asc' };
        renderMetrics(lastMetrics);
      },
    });
  }));
  const t = el('table', { class: 'metrics-table' }, [thead]);
  for (const row of sorted) {
    t.appendChild(el('tr', {}, [
      el('td', { class: 'mono', text: row.id }),
      el('td', { text: row.kind || '?' }),
      el('td', { text: row.box }),
      el('td', { class: 'mono', text: String(row.rounds) }),
      el('td', { class: 'mono', text: formatUsd(row.spentUsd) }),
      el('td', { class: `mono${row.primaryRejectDoor ? ' reject-fail' : ''}`, text: row.primaryRejectDoor || '—' }),
    ]));
  }
  wrap.appendChild(t);
  return wrap;
}

function renderMetrics(metrics) {
  const container = document.getElementById('view-metrics');
  container.innerHTML = '';
  if (!metrics) return;
  if (isMetricsEmpty(metrics)) {
    container.appendChild(el('div', { class: 'metrics-empty' }, [
      el('div', { class: 'empty-title', text: '暂无指标数据' }),
      el('div', { class: 'empty-hint', text: 'done/failed 箱都还是空的 — 等 loop 跑完至少一个任务后回来看这里；先去「看板」确认队列进度' }),
    ]));
    return;
  }
  const wrap = el('div', { class: 'metrics-view' }, [
    buildKpiRow(metrics),
    buildCostChart(metrics.totals),
    buildRejectChart(metrics.table),
    buildDurationChart(metrics.durations),
    buildMetricsTable(metrics.table),
  ]);
  container.appendChild(wrap);
}

// ---- overlay 开合（class 驱动过渡；hidden 只负责最终 display） ----

const overlayHideTimers = new Map();

function showOverlay(id) {
  const ov = document.getElementById(id);
  clearTimeout(overlayHideTimers.get(id)); // 取消未决的延迟隐藏，避免快速重开被藏掉
  ov.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('open')));
}

function hideOverlay(id) {
  const ov = document.getElementById(id);
  ov.classList.remove('open');
  overlayHideTimers.set(id, setTimeout(() => { ov.hidden = true; }, 240));
}

// ---- 屏 2：详情（抽屉 peek + 全屏审查页共用一条数据管线） ----

/** 需要「diff 入口」的 review kind：merge 门 + done/failed 复盘（AC-010）。仅全屏页拉取。 */
const DIFF_ENTRY_KINDS = ['merge', 'done', 'failed'];

function resetDetailState() {
  lastDetail = null;
  lastDiff = null;
  lastStreamTail = null;
  selectedOption = null;
  pendingActionMessage = null;
  expandedDiffFiles = new Set();
}

function closeDrawer() {
  if (detailMode !== 'drawer') return;
  const id = detailTaskId;
  detailMode = null;
  detailTaskId = null;
  resetDetailState();
  hideOverlay('drawer-overlay');
  if (drawerTriggerEl) {
    if (document.contains(drawerTriggerEl)) {
      drawerTriggerEl.focus();
    } else {
      // renderLanes 轮询用 replaceWith 换节点，触发元素可能已脱离文档：按 id 回退到可见卡片/箱行，
      // 再不济回退看板容器，绝不静默丢焦点到 body。
      const cardEl = id != null ? document.querySelector(`[data-id="${id}"]`) : null;
      const container = document.getElementById('board-shell');
      resolveDrawerFocusTarget(false, drawerTriggerEl, cardEl, container).focus();
    }
    drawerTriggerEl = null;
  }
}

async function openDrawer(id, triggerEl) {
  drawerTriggerEl = triggerEl ?? null;
  detailMode = 'drawer';
  detailTaskId = id;
  resetDetailState();
  showOverlay('drawer-overlay');
  await refreshDetail();
  document.getElementById('drawer').focus();
}

let boardScrollY = 0; // 进审查页前的看板滚动位，返回时还原（页面推入语义：进页置顶）

function openTaskPage(id) {
  if (detailMode === 'drawer') closeDrawer();
  const alreadyOpen = detailMode === 'page' && detailTaskId === id;
  detailMode = 'page';
  detailTaskId = id;
  if (!alreadyOpen) {
    boardScrollY = window.scrollY;
    resetDetailState();
    document.getElementById('view-task').innerHTML = '';
  }
  switchView('task');
  if (!alreadyOpen) window.scrollTo(0, 0);
  refreshDetail().then(() => {
    if (!alreadyOpen && detailMode === 'page' && detailTaskId === id) {
      document.getElementById('view-task').focus({ preventScroll: true });
    }
  });
}

function closeTaskPage() {
  if (detailMode !== 'page') return;
  detailMode = null;
  detailTaskId = null;
  resetDetailState();
  document.getElementById('view-task').innerHTML = '';
  window.scrollTo(0, boardScrollY);
}

async function refreshDetail() {
  if (!detailTaskId) return;
  const id = detailTaskId;
  const mode = detailMode;
  const { status, body } = await api(`/api/task/${encodeURIComponent(id)}`);
  if (detailTaskId !== id || detailMode !== mode) return;
  lastDetail = status === 200 ? body : null;
  lastDiff = null;
  lastStreamTail = null;
  if (mode === 'page' && lastDetail && DIFF_ENTRY_KINDS.includes(lastDetail.review.kind)) {
    const diffRes = await api(`/api/task/${encodeURIComponent(id)}/diff`);
    if (detailTaskId === id) lastDiff = diffRes.status === 200 ? diffRes.body : null;
  }
  if (lastDetail && lastDetail.working) {
    const tailRes = await api(`/api/task/${encodeURIComponent(id)}/stream-tail`);
    if (detailTaskId === id) lastStreamTail = tailRes.status === 200 ? tailRes.body.lines : null;
  }
  if (detailTaskId === id && detailMode === mode) renderDetailFromCache();
}

function renderDetailFromCache() {
  if (detailMode === 'drawer') {
    const drawer = document.getElementById('drawer');
    drawer.innerHTML = '';
    if (!lastDetail) { drawer.appendChild(el('div', { text: '任务未找到或已归档' })); return; }
    renderDrawerPeek(drawer, detailTaskId, lastDetail);
  } else if (detailMode === 'page') {
    const page = document.getElementById('view-task');
    page.innerHTML = '';
    if (!lastDetail) {
      page.appendChild(el('div', { class: 'task-page' }, [
        el('div', { class: 'task-page-topbar' }, [
          el('button', { class: 'btn btn-ghost', text: '← 看板', onclick: gotoBoard }),
        ]),
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-title', text: '任务未找到或已归档' }),
          el('div', { class: 'empty-hint', text: `id: ${detailTaskId}` }),
        ]),
      ]));
      return;
    }
    renderTaskPage(page, detailTaskId, lastDetail);
  }
}

/** ISO 字符串 → 浏览器本地时间 `HH:MM`；与当日不同天时前缀 `MM-DD `。 */
function formatLocalTimestamp(iso) {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** box → roundGaugeTicks 的存活性输入（queue 是仍在推进的 active，done/failed 已终局）。 */
function livenessOf(box) {
  if (box === 'done') return 'done';
  if (box === 'failed') return 'failed';
  return 'active';
}

function buildRoundTicksNode(ticks) {
  const row = el('div', { class: 'round-ticks' });
  for (const t of ticks) {
    row.appendChild(el('span', { class: `round-tick round-tick-${t.state}`, title: `r${t.round}: ${t.state}`, text: `r${t.round}` }));
  }
  return row;
}

/** 详情放大回路刻度：maker/verify 段下叠加轮次刻度点（design-language §4）。 */
function stageDots(lane, box, rounds) {
  const wrap = el('div', { class: 'stage-dots' });
  const curIdx = lane != null ? LANES.findIndex((l) => l.key === lane) : -1;
  const ticks = roundGaugeTicks(rounds || [], livenessOf(box));
  LANES.forEach((laneDef, i) => {
    let state = 'future';
    if (box === 'done') state = 'done';
    else if (curIdx >= 0) {
      if (i < curIdx) state = 'done';
      else if (i === curIdx) state = 'current';
    }
    const dotClass = state === 'done' ? ' done' : state === 'current' ? ' current' : '';
    const group = el('div', { class: 'dot-group' }, [
      el('span', { class: 'dot' + dotClass, title: laneDef.label }),
      el('span', { class: 'dot-label' + dotClass, text: laneDef.label }),
    ]);
    if ((laneDef.key === 'maker' || laneDef.key === 'verify') && ticks.length > 0) {
      group.appendChild(buildRoundTicksNode(ticks));
    }
    wrap.appendChild(group);
    if (i < LANES.length - 1) wrap.appendChild(el('span', { class: 'dot-line' }));
  });
  return wrap;
}

// ---- P3：轮次证据链——每轮四门 chip + attempts 折叠区 ----

/** 门 → P2 三态 chip 状态：仅门本身 status==='ok' 才有 pass/fail 判定，否则 unknown（未到达/损坏）。 */
function doorChipStatus(kind, door) {
  if (!door || door.status !== 'ok') return 'unknown';
  if (kind === 'maker') return door.ok === true ? 'pass' : door.ok === false ? 'fail' : 'unknown';
  if (kind === 'testGate') return door.verdict === 'vacuous' ? 'fail' : 'pass';
  if (kind === 'greenGate') return door.pass ? 'pass' : 'fail';
  if (kind === 'verifier') return door.overall === 'pass' ? 'pass' : door.overall === 'fail' ? 'fail' : 'unknown';
  return 'unknown';
}

/** 门 → 关键数字文案；未到达/损坏均给明确文案，不留空白。 */
function doorDetailText(kind, door) {
  if (!door || door.status === 'absent') return '未到达';
  if (door.status === 'corrupt') return '数据损坏';
  if (kind === 'maker') return `$${(door.costUsd ?? 0).toFixed(2)} · ${door.turns ?? '?'} turns`;
  if (kind === 'testGate') return door.verdict ?? '?';
  if (kind === 'greenGate') return door.pass ? 'pass' : 'fail';
  if (kind === 'verifier') return `${door.passCount}/${door.total} AC`;
  return '';
}

function buildDoorNode(kind, label, door) {
  const chip = verdictChip(doorChipStatus(kind, door));
  return el('div', { class: 'round-door' }, [
    el('span', { class: 'round-door-label', text: label }),
    el('span', { class: `chip ${chip.className}`, text: chip.symbol }),
    el('span', { class: 'round-door-detail mono', text: doorDetailText(kind, door) }),
  ]);
}

function buildRoundNode(round, defaultOpen) {
  const doors = el('div', { class: 'round-doors' }, [
    buildDoorNode('maker', 'maker', round.maker),
    buildDoorNode('testGate', 'test gate', round.testGate),
    buildDoorNode('greenGate', 'green gate', round.greenGate),
    buildDoorNode('verifier', 'verifier', round.verifier),
  ]);
  const body = el('div', { class: 'round-body' }, [doors]);
  const rc = round.repairContext;
  if (rc && rc.status === 'ok' && rc.instruction) {
    body.appendChild(el('div', { class: 'round-repair mono', text: `打回（${rc.source}）：${rc.instruction}` }));
  } else if (rc && rc.status === 'corrupt') {
    body.appendChild(el('div', { class: 'round-repair', text: 'repair-context 数据损坏' }));
  }
  return el('details', { class: 'round-section', open: defaultOpen ? '' : null }, [
    el('summary', { class: 'round-header mono', text: `r${round.round}` }),
    body,
  ]);
}

function buildRoundsSectionNode(rounds) {
  const wrap = el('div', { class: 'rounds-section' });
  wrap.appendChild(el('h3', { text: '轮次' }));
  if (!rounds || rounds.length === 0) {
    wrap.appendChild(el('div', { class: 'verdict-empty', text: '尚无轮次记录' }));
    return wrap;
  }
  const list = el('div', { class: 'rounds-list' });
  rounds.forEach((r, i) => list.appendChild(buildRoundNode(r, i === rounds.length - 1)));
  wrap.appendChild(list);
  return wrap;
}

/** 「实时输出」折叠区（P4-G3）：stream tail 增量文本，纯文本渲染（textContent，不解析 HTML）。 */
function buildStreamTailNode(lines) {
  const wrap = el('details', { class: 'stream-tail', open: '' }, [
    el('summary', { text: `实时输出${lines && lines.length ? ` · ${lines.length}` : ''}` }),
  ]);
  const pre = el('pre', { class: 'stream-tail-pre', text: lines && lines.length ? lines.join('\n') : '(暂无输出)' });
  wrap.appendChild(pre);
  return wrap;
}

function buildAttemptsSectionNode(attempts) {
  if (!attempts || attempts.length === 0) return null;
  const wrap = el('details', { class: 'attempts-section' }, [
    el('summary', { text: `早前攻坚周期 · ${attempts.length}` }),
  ]);
  for (const group of attempts) {
    const groupWrap = el('div', { class: 'attempt-group' }, [
      el('div', { class: 'attempt-stamp mono', text: group.stamp }),
    ]);
    for (const r of group.rounds) groupWrap.appendChild(buildRoundNode(r, false));
    wrap.appendChild(groupWrap);
  }
  return wrap;
}

/** Timeline 条目列表（抽屉纵向区与页侧栏共用）；返回可直接 append 的 fragment。 */
function buildTimelineListNode(entries) {
  const frag = document.createDocumentFragment();
  if (!entries || entries.length === 0) {
    frag.appendChild(el('div', { class: 'timeline-item', text: '(无记录)' }));
    return frag;
  }
  let i = 0;
  for (const group of groupTimelineByRound(entries)) {
    if (group.round != null) {
      frag.appendChild(el('div', { class: 'timeline-round-header mono', text: `r${group.round}` }));
    }
    for (const entry of group.entries) {
      const prefix = entry.ts == null ? '' : `${formatLocalTimestamp(entry.ts)} `;
      const item = el('div', { class: 'timeline-item', text: `${prefix}${entry.text}` });
      item.style.setProperty('--i', Math.min(i, 12));
      frag.appendChild(item);
      i++;
    }
  }
  return frag;
}

async function doAction(id, action, body) {
  const { body: resBody } = await api(`/api/task/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return resBody;
}

async function submitAction(id, action, body) {
  pendingActionMessage = await doAction(id, action, body);
  loadBoard();
  await refreshDetail();
}

/** 决定性动作（通过/打回/合并/重试）统一走浏览器原生二次确认（AC-011）。 */
function confirmAndSubmit(id, action, body, confirmMessage) {
  if (!window.confirm(confirmMessage)) return;
  submitAction(id, action, body);
}

/** merge/retry 已 job 化（P4-G4）：POST 立即拿到 jobId，轮询 /api/jobs 到终态；
 *  连上 SSE 时 handleServerEvent 的 type:'job' 分支会先一步收敛到同样的终态展示，二者不冲突。 */
async function pollJobUntilDone(id, jobId) {
  for (;;) {
    const { body } = await api('/api/jobs');
    const job = body && Array.isArray(body.jobs) ? body.jobs.find((j) => j.id === jobId) : null;
    if (job && job.state !== 'running') {
      if (detailTaskId === id) {
        pendingActionMessage = { ok: job.state === 'ok', message: job.message || (job.state === 'ok' ? 'ok' : 'failed') };
        loadBoard();
        await refreshDetail();
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function confirmAndSubmitJob(id, action, confirmMessage) {
  if (!window.confirm(confirmMessage)) return;
  const resBody = await doAction(id, action, {});
  if (!resBody || typeof resBody.jobId !== 'string') {
    pendingActionMessage = { ok: false, message: (resBody && resBody.error) || '提交失败' };
    await refreshDetail();
    return;
  }
  pendingActionMessage = { ok: null, message: `已提交，job ${resBody.jobId} 处理中…` };
  renderDetailFromCache();
  pollJobUntilDone(id, resBody.jobId);
}

// ---- 在 VS Code 打开 worktree：POST /api/task/:id/open-editor，状态就地内联显示，不打断当前面 ----

function buildEditorControls(id) {
  const status = el('span', { class: 'editor-status' });
  const btn = el('button', {
    class: 'btn btn-ghost', text: '在 VS Code 打开 ↗',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = '打开中…';
      status.classList.remove('editor-status-fail');
      const { body } = await api(`/api/task/${encodeURIComponent(id)}/open-editor`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      btn.disabled = false;
      const ok = body && body.ok === true;
      status.textContent = ok ? '已打开' : ((body && body.message) || '打开失败');
      if (body && body.message) status.title = body.message;
      status.classList.toggle('editor-status-fail', !ok);
    },
  });
  return el('span', { class: 'editor-controls' }, [btn, status]);
}

/** worktree 大概率在场的阶段才在抽屉里给编辑器入口（maker 起建、merge 后清理）。 */
function editorRelevant(detail) {
  return ['maker', 'verify', 'merge'].includes(detail.lane) || detail.box === 'failed';
}

// ---- verdict / spec-verify 面板 + 分文件 diff（P2） ----

function chipNode(status) {
  const chip = verdictChip(status);
  return el('span', { class: `chip ${chip.className}` }, [`${chip.symbol} ${chip.label}`]);
}

/** criteria → { pass, fail, other } 计数，供裁决面板的 AC 汇总条。 */
function countCriteria(criteria) {
  const counts = { pass: 0, fail: 0, other: 0 };
  for (const c of criteria || []) {
    if (c.status === 'pass') counts.pass++;
    else if (c.status === 'fail') counts.fail++;
    else counts.other++;
  }
  return counts;
}

function buildVerdictPanelNode(verdict, { title = 'Verifier 裁决' } = {}) {
  const wrap = el('div', { class: 'verdict-block' });
  wrap.appendChild(el('h3', { text: title }));
  if (!verdict || verdict.missing) {
    wrap.appendChild(el('div', { class: 'verdict-empty', text: '尚无 verifier 裁决记录' }));
    return wrap;
  }
  if (verdict.corrupt) {
    wrap.appendChild(el('div', { class: 'verdict-empty', text: 'verifier 裁决文件已损坏，无法解析' }));
    return wrap;
  }
  const counts = countCriteria(verdict.criteria);
  wrap.appendChild(el('div', { class: 'verdict-summary' }, [
    chipNode(verdict.overall),
    el('span', { class: 'verdict-round mono', text: `round ${verdict.round}` }),
    el('span', {
      class: 'verdict-counts mono',
      text: `✓ ${counts.pass} · ✗ ${counts.fail}${counts.other ? ` · ? ${counts.other}` : ''} / ${(verdict.criteria || []).length} AC`,
    }),
  ]));
  const list = el('div', { class: 'criteria-list' });
  for (const c of verdict.criteria) {
    const statusCls = c.status === 'pass' ? 'criterion-pass' : c.status === 'fail' ? 'criterion-fail' : 'criterion-unknown';
    const item = el('div', { class: `criterion ${statusCls}` }, [
      el('div', { class: 'criterion-head' }, [
        chipNode(c.status),
        el('span', { class: 'criterion-id mono', text: c.ac_id }),
      ]),
      el('div', { class: 'criterion-reason', text: c.reason || '' }),
    ]);
    for (const e of c.evidence || []) {
      item.appendChild(el('div', { class: 'evidence-item mono' }, [`${e.file}:${e.start_line}-${e.end_line} — ${e.summary}`]));
    }
    list.appendChild(item);
  }
  wrap.appendChild(list);
  if (verdict.reportMarkdown) {
    wrap.appendChild(el('details', { class: 'verdict-report' }, [
      el('summary', { text: '完整 verify 报告' }),
      el('pre', { class: 'readonly', text: verdict.reportMarkdown }),
    ]));
  }
  return wrap;
}

function buildSpecVerifyNode(specVerify) {
  const wrap = el('div', { class: 'verdict-block' });
  wrap.appendChild(el('h3', { text: 'Spec-verifier 机器审' }));
  if (!specVerify || specVerify.missing) {
    wrap.appendChild(el('div', { class: 'verdict-empty', text: '尚无 spec-verifier 机器审记录' }));
    return wrap;
  }
  if (specVerify.corrupt) {
    wrap.appendChild(el('div', { class: 'verdict-empty', text: 'spec-verifier 裁决文件已损坏，无法解析' }));
    return wrap;
  }
  wrap.appendChild(el('div', { class: 'verdict-summary' }, [
    chipNode(specVerify.overall),
    el('span', { class: 'verdict-round mono', text: `round ${specVerify.round}` }),
  ]));
  wrap.appendChild(el('div', { class: 'spec-verify-summary', text: specVerify.summary }));
  if (specVerify.findings.length > 0) {
    const list = el('div', { class: 'findings-list' });
    for (const f of specVerify.findings) {
      list.appendChild(el('div', { class: 'finding' }, [
        el('div', { class: 'finding-head' }, [
          el('span', { class: 'finding-severity', text: f.severity }),
          el('span', { class: 'finding-audience', text: f.audience }),
        ]),
        el('div', { class: 'finding-issue', text: f.issue }),
        el('div', { class: 'finding-recommendation', text: `→ ${f.recommendation}` }),
      ]));
    }
    wrap.appendChild(list);
  }
  if (specVerify.reportMarkdown) {
    wrap.appendChild(el('details', { class: 'verdict-report' }, [
      el('summary', { text: '完整 spec-verify 报告' }),
      el('pre', { class: 'readonly', text: specVerify.reportMarkdown }),
    ]));
  }
  return wrap;
}

/** unified patch → 逐行着色的 HTML（+ 行 pass-bg、− 行 fail-bg，行内不逐词高亮）；全文经 escapeHtml 转义（AC-004/011）。 */
function renderPatchHtml(patch) {
  return (patch || '').split('\n').map((line) => {
    let cls = 'diff-line-ctx';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) cls = 'diff-line-meta';
    else if (line.startsWith('+')) cls = 'diff-line-add';
    else if (line.startsWith('-')) cls = 'diff-line-del';
    return `<span class="diff-line ${cls}">${escapeHtml(line) || ' '}</span>`;
  }).join('\n');
}

function buildDiffFileNode(f) {
  const isOpen = expandedDiffFiles.has(f.path);
  const header = el('div', {
    class: 'diff-file-header',
    onclick: () => { toggleDiffFile(f.path); },
  }, [
    el('span', { class: 'diff-file-toggle', text: isOpen ? '▾' : '▸' }),
    el('span', { class: 'diff-file-status mono', text: f.status || 'M' }),
    el('span', { class: 'diff-file-path mono', text: f.path }),
    el('span', { class: 'diff-file-stat mono' }, [
      el('span', { class: 'diff-add', text: `+${f.added}` }),
      el('span', { class: 'diff-del', text: `-${f.deleted}` }),
    ]),
  ]);
  const body = el('div', { class: 'diff-file-body' });
  if (isOpen) {
    if (f.binary) {
      body.appendChild(el('div', { class: 'diff-empty', text: '(二进制文件，不展示 patch)' }));
    } else if (f.oversize) {
      body.appendChild(el('div', { class: 'diff-empty', text: 'diff 过大，已省略正文（仍计入 +/− 统计）' }));
    } else {
      const pre = el('pre', { class: 'diff-patch mono' });
      pre.innerHTML = renderPatchHtml(f.patch);
      body.appendChild(pre);
    }
  }
  return el('div', { class: 'diff-file' }, [header, body]);
}

function toggleDiffFile(path) {
  if (expandedDiffFiles.has(path)) expandedDiffFiles.delete(path);
  else expandedDiffFiles.add(path);
  renderDetailFromCache();
}

/** 分文件 diff 区。定位是「粗览改动范围」的分诊面，不替代编辑器里的逐行审查——
 *  故标题行直接挂 shortstat 汇总，工具条常备 VS Code 跳转。 */
function buildDiffSectionNode(diff, { taskId, shortstat } = {}) {
  const wrap = el('div', { class: 'diff-block' });
  wrap.appendChild(el('div', { class: 'diff-head' }, [
    el('h3', { text: 'Diff' }),
    shortstat ? el('span', { class: 'diff-shortstat mono', text: shortstat }) : null,
  ]));
  wrap.appendChild(el('div', { class: 'diff-note', text: '在这里粗览改动范围与文件分布；逐行深审建议跳到 VS Code 里进行。' }));
  if (!diff) {
    wrap.appendChild(el('div', { class: 'diff-empty', text: 'diff 加载中或加载失败' }));
    return wrap;
  }
  if (diff.cleaned || diff.files.length === 0) {
    wrap.appendChild(el('div', { class: 'diff-empty', text: '分支已清理，无可展示的 diff（任务已合并或从未产生改动）' }));
    return wrap;
  }
  const allOpen = diff.files.every((f) => expandedDiffFiles.has(f.path));
  const toggleAllBtn = el('button', {
    class: 'btn btn-ghost',
    text: allOpen ? '收起全部' : '展开全部',
    onclick: () => {
      if (allOpen) expandedDiffFiles = new Set();
      else expandedDiffFiles = new Set(diff.files.map((f) => f.path));
      renderDetailFromCache();
    },
  });
  wrap.appendChild(el('div', { class: 'diff-toolbar' }, [toggleAllBtn, taskId ? buildEditorControls(taskId) : null]));
  const filesWrap = el('div', { class: 'diff-files' });
  for (const f of diff.files) filesWrap.appendChild(buildDiffFileNode(f));
  wrap.appendChild(filesWrap);
  return wrap;
}

// ---- 屏 2a：抽屉 peek（纯监控：无审查内容、无决策按钮；入口只有「完整详情」与编辑器跳转） ----

function renderDrawerPeek(drawer, id, detail) {
  const task = detail.task;
  const runtime = detail.runtime;
  const needsHuman = detail.needsHuman;
  const roundsView = detail.rounds || { rounds: [], attempts: [] };

  drawer.appendChild(el('div', { class: 'drawer-header' }, [
    el('div', {}, [
      el('div', { class: 'mono', text: id }),
      task ? el('span', { class: 'badge badge-kind', text: String(task.kind).toUpperCase() }) : null,
      el('h2', { text: task ? task.title : '(损坏任务目录)' }),
      el('div', { class: 'mono drawer-stage', text: `stage: ${runtime ? runtime.stage : '(unknown)'}` }),
      needsHuman ? el('span', { class: 'needs-you', text: '⚑ needs you' }) : null,
    ]),
    el('button', { class: 'close-x', text: '×', onclick: closeDrawer }),
  ]));

  drawer.appendChild(el('div', { class: 'action-row' }, [
    el('button', {
      class: 'btn btn-primary',
      text: needsHuman ? '进入审查 →' : '完整详情 →',
      onclick: () => gotoTask(id),
    }),
    editorRelevant(detail) ? buildEditorControls(id) : null,
  ]));

  if (detail.review && detail.review.kind === 'broken') {
    drawer.appendChild(el('div', { class: 'broken-banner', text: detail.review.error }));
  }

  drawer.appendChild(stageDots(detail.lane, detail.box, roundsView.rounds));

  if (pendingActionMessage) {
    drawer.appendChild(el('div', { class: 'result-box' }, [
      el('pre', { class: 'readonly', text: pendingActionMessage.message || (pendingActionMessage.ok ? 'ok' : 'failed') }),
    ]));
  }

  if (detail.working) {
    drawer.appendChild(workingLabel());
    drawer.appendChild(buildStreamTailNode(lastStreamTail));
  }

  drawer.appendChild(buildRoundsSectionNode(roundsView.rounds));
  const attemptsNode = buildAttemptsSectionNode(roundsView.attempts);
  if (attemptsNode) drawer.appendChild(attemptsNode);

  const timelineWrap = el('div', { class: 'drawer-timeline' }, [el('h3', { text: 'Timeline' })]);
  const scroll = el('div', { class: 'timeline-scroll' });
  scroll.appendChild(buildTimelineListNode(detail.timelineEntries || []));
  timelineWrap.appendChild(scroll);
  drawer.appendChild(timelineWrap);
}

// ---- 屏 2b：全屏审查页（报告优先：verify/spec 报告是主角，diff 只做分诊，决策按钮固定在底部动作条） ----

/** review kind → { content: node[], actions: node[] }。content 顺序即页面主列顺序：报告在前。 */
function buildReviewMain(id, detail) {
  const task = detail.task;
  const review = detail.review;
  const content = [];
  const actions = [];

  if (review.kind === 'feasibility') {
    content.push(el('h3', { text: 'Feasibility memo' }));
    content.push(el('pre', { class: 'readonly', text: review.missing ? review.message : review.markdown }));
    content.push(el('h3', { text: 'YOUR DECISION · PICK AN OPTION' }));
    const optionsWrap = el('div', {});
    for (const opt of review.options || []) {
      optionsWrap.appendChild(el('div', {
        class: 'option-card' + (selectedOption === opt.option_id ? ' selected' : ''),
        onclick: () => { selectedOption = opt.option_id; renderDetailFromCache(); },
      }, [
        el('span', { class: 'option-id', text: opt.option_id }),
        el('span', { text: opt.text }),
      ]));
    }
    content.push(optionsWrap);
    const notes = el('textarea', { id: 'fb-notes', rows: 3 });
    content.push(el('div', { class: 'field' }, [el('label', { text: '备注（可选）' }), notes]));
    const approveLabel = selectedOption ? `通过 · 选 ${selectedOption} 继续` : '通过 · 请先选择一个 option';
    const approveBtn = el('button', {
      class: 'btn btn-primary', text: approveLabel,
      onclick: () => confirmAndSubmit(
        id, 'approve-feasibility', { option: selectedOption, notes: notes.value },
        `确定通过 feasibility 并选 ${selectedOption} 继续？`,
      ),
    });
    approveBtn.disabled = !selectedOption;
    const rejectBtn = el('button', {
      class: 'btn btn-danger', text: '打回并留言',
      onclick: () => confirmAndSubmit(id, 'reject-feasibility', { notes: notes.value }, '确定打回 feasibility 并留言？'),
    });
    actions.push(approveBtn, rejectBtn);
  } else if (review.kind === 'setup') {
    content.push(el('h3', { text: 'Setup profile 草稿' }));
    content.push(el('pre', { class: 'readonly', text: review.missing ? review.message : review.markdown }));
    actions.push(el('button', {
      class: 'btn btn-primary', text: '通过',
      onclick: () => confirmAndSubmit(id, 'approve-setup', {}, '确定通过 setup profile？'),
    }));
  } else if (review.kind === 'spec') {
    // 报告优先：spec-verifier 机器审在草稿之前——人先看机器挑出的问题，再对着草稿核对。
    content.push(buildSpecVerifyNode(review.specVerify));
    content.push(el('h3', { text: 'Spec 草稿' }));
    content.push(el('pre', { class: 'readonly readonly-tall', text: review.missing ? review.message : review.markdown }));
    const notes = el('textarea', { id: 'spec-notes', rows: 3 });
    content.push(el('div', { class: 'field' }, [el('label', { text: 'Reject 备注（必填）' }), notes]));
    const approveBtn = el('button', {
      class: 'btn btn-primary', text: '通过 spec',
      onclick: () => confirmAndSubmit(id, 'approve', {}, '确定通过 spec？'),
    });
    const rejectBtn = el('button', {
      class: 'btn btn-danger', text: '打回并留言',
      onclick: () => confirmAndSubmit(id, 'reject', { notes: notes.value }, '确定打回 spec 并留言？'),
    });
    rejectBtn.disabled = true;
    notes.addEventListener('input', () => { rejectBtn.disabled = notes.value.trim() === ''; });
    actions.push(approveBtn, rejectBtn);
  } else if (review.kind === 'scope') {
    // 规模升闸：人裁的是「要不要拆」，不是 spec 内容对错——规模对照排在机器审与草稿之前。
    content.push(el('h3', { text: '规模升闸 · 要不要拆' }));
    content.push(el('div', {
      text: review.scope.acCount == null
        ? 'spec 草稿缺失，无法机械计数'
        : `本 spec 含 ${review.scope.acCount} 条 AC，阈值 ${review.scope.max == null ? '?' : review.scope.max}；`
          + 'spec-verifier 本轮 fail 已挂起（miss 未计），等你裁决。',
    }));
    content.push(buildSpecVerifyNode(review.specVerify));
    content.push(el('h3', { text: 'Spec 草稿' }));
    content.push(el('pre', { class: 'readonly readonly-tall', text: review.missing ? review.message : review.markdown }));
    const notes = el('textarea', { id: 'scope-notes', rows: 3 });
    content.push(el('div', { class: 'field' }, [el('label', { text: '拆分意图备注（可选）' }), notes]));
    actions.push(el('button', {
      class: 'btn btn-primary', text: '接受规模 · 继续修复',
      onclick: () => confirmAndSubmit(id, 'approve-scope', {}, '确定接受当前规模、让挂起的 fail 入账继续修复循环？'),
    }));
    actions.push(el('button', {
      class: 'btn btn-danger', text: '选择拆分 · 收箱',
      onclick: () => confirmAndSubmit(id, 'reject-scope', { notes: notes.value }, '确定选择拆分？任务会进 failed 箱等你手工拆成多个任务。'),
    }));
  } else if (review.kind === 'merge') {
    // 报告优先：verifier 裁决（AC 逐条证据）在 diff 之前。
    content.push(buildVerdictPanelNode(review.verdict));
    content.push(buildDiffSectionNode(lastDiff, {
      taskId: id,
      shortstat: review.error ? review.error : review.diffShortstat,
    }));
    actions.push(el('button', {
      class: 'btn btn-primary', text: `合并到 ${task ? task.baseBranch : 'base'}`,
      onclick: () => confirmAndSubmitJob(id, 'merge', `确定合并到 ${task ? task.baseBranch : 'base'}？此操作不可撤销。`),
    }));
  } else if (review.kind === 'failed') {
    content.push(el('h3', { text: '失败信息' }));
    content.push(el('div', { text: review.lastFailureType || '(未知失败类型)' }));
    const rl = rateLimitPanel(review.rateLimit);
    if (rl) {
      // 限额收箱：只有人能恢复，且必须在重置时刻之后（与 CLI retry 同一条规则）。
      content.push(el('div', { class: 'rate-limit-note', text: rl.label }));
      actions.push(el('button', {
        class: 'btn btn-danger', text: '↻ 恢复', disabled: rl.canResume ? null : 'disabled',
        title: rl.canResume ? null : `限额重置于 ${rl.resetText} 之后才能恢复`,
        onclick: rl.canResume ? () => confirmAndSubmitJob(id, 'retry', '确定恢复该任务？') : null,
      }));
    } else {
      actions.push(el('button', {
        class: 'btn btn-danger', text: '↻ 重试',
        onclick: () => confirmAndSubmitJob(id, 'retry', '确定重试该任务？'),
      }));
    }
    content.push(buildVerdictPanelNode(review.verdict, { title: '最终 verifier 裁决' }));
    content.push(buildDiffSectionNode(lastDiff, { taskId: id }));
  } else if (review.kind === 'done') {
    content.push(el('h3', { text: '任务已完成' }));
    content.push(buildVerdictPanelNode(review.verdict, { title: '最终 verifier 裁决' }));
    content.push(buildDiffSectionNode(lastDiff, { taskId: id }));
  } else if (review.kind === 'broken') {
    content.push(el('div', { class: 'broken-banner', text: review.error }));
  } else {
    content.push(el('div', { text: `当前 stage：${detail.runtime ? detail.runtime.stage : '?'}` }));
  }
  return { content, actions };
}

function renderTaskPage(page, id, detail) {
  const task = detail.task;
  const runtime = detail.runtime;
  const roundsView = detail.rounds || { rounds: [], attempts: [] };
  const wrap = el('div', { class: 'task-page' });

  wrap.appendChild(el('div', { class: 'task-page-topbar' }, [
    el('button', { class: 'btn btn-ghost', text: '← 看板', onclick: gotoBoard }),
    el('div', { class: 'task-topbar-right' }, [
      buildEditorControls(id),
      typeof runtime?.spent_usd === 'number' ? el('span', { class: 'spent mono', text: fmtUsd(runtime.spent_usd) }) : null,
    ]),
  ]));

  const header = el('div', { class: 'task-page-header' }, [
    el('div', { class: 'task-page-meta' }, [
      el('span', { class: 'mono', text: id }),
      task ? el('span', { class: 'badge badge-kind', text: String(task.kind).toUpperCase() }) : null,
      detail.needsHuman ? el('span', { class: 'needs-you', text: '⚑ needs you' }) : null,
    ]),
    el('h2', { class: 'task-page-title', text: task ? task.title : '(损坏任务目录)' }),
    el('div', { class: 'task-page-stage' }, [
      el('span', { class: 'mono', text: `stage: ${runtime ? runtime.stage : '(unknown)'}` }),
      detail.working ? workingLabel() : null,
    ]),
    stageDots(detail.lane, detail.box, roundsView.rounds),
  ]);
  wrap.appendChild(header);

  const main = el('div', { class: 'task-main' });
  if (pendingActionMessage) {
    main.appendChild(el('div', { class: 'result-box' }, [
      el('pre', { class: 'readonly', text: pendingActionMessage.message || (pendingActionMessage.ok ? 'ok' : 'failed') }),
    ]));
  }

  const { content, actions } = buildReviewMain(id, detail);
  for (const node of content) main.appendChild(node);

  if (detail.working) main.appendChild(buildStreamTailNode(lastStreamTail));
  main.appendChild(buildRoundsSectionNode(roundsView.rounds));
  const attemptsNode = buildAttemptsSectionNode(roundsView.attempts);
  if (attemptsNode) main.appendChild(attemptsNode);
  if (actions.length > 0) main.appendChild(el('div', { class: 'task-actionbar' }, actions));

  const aside = el('div', { class: 'task-aside' });
  const asideInner = el('div', { class: 'task-aside-inner' }, [el('h3', { text: 'Timeline' })]);
  asideInner.appendChild(buildTimelineListNode(detail.timelineEntries || []));
  aside.appendChild(asideInner);

  wrap.appendChild(el('div', { class: 'task-page-body' }, [main, aside]));
  page.appendChild(wrap);
}

document.getElementById('drawer-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'drawer-overlay') closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (detailMode === 'drawer') closeDrawer();
  else if (detailMode === 'page') gotoBoard();
});

// ---- 屏 3：新建任务面板 ----

let newTaskState = { kind: null, feasibility: null };

document.getElementById('btn-new-task').addEventListener('click', () => {
  newTaskState = { kind: null, feasibility: null };
  showOverlay('panel-overlay');
  renderNewTaskPanel();
});
document.getElementById('panel-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'panel-overlay') hideOverlay('panel-overlay');
});

function renderNewTaskPanel(resultBody) {
  const panel = document.getElementById('new-task-panel');
  panel.innerHTML = '';
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', { text: '新建任务' }),
    el('button', { class: 'close-x', text: '×', onclick: () => hideOverlay('panel-overlay') }),
  ]));

  const kindWrap = el('div', { class: 'kind-cards' });
  for (const k of ['bugfix', 'feature']) {
    kindWrap.appendChild(el('div', {
      class: 'kind-card' + (newTaskState.kind === k ? ' selected' : ''),
      onclick: () => { newTaskState.kind = k; renderNewTaskPanel(); },
      text: k === 'bugfix' ? 'bugfix 修 bug' : 'feature 加功能',
    }));
  }
  panel.appendChild(kindWrap);

  if (newTaskState.kind === 'feature') {
    const fWrap = el('div', { class: 'field' }, [el('label', { text: 'Feasibility gate' })]);
    fWrap.appendChild(el('div', {
      class: 'option-card' + (newTaskState.feasibility === false ? ' selected' : ''),
      onclick: () => { newTaskState.feasibility = false; renderNewTaskPanel(); },
      text: 'Skip feasibility → 直接产出 spec',
    }));
    fWrap.appendChild(el('div', {
      class: 'option-card' + (newTaskState.feasibility === true ? ' selected' : ''),
      onclick: () => { newTaskState.feasibility = true; renderNewTaskPanel(); },
      text: 'Run feasibility gate first',
    }));
    panel.appendChild(fWrap);
  }

  panel.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Title' }), el('input', { type: 'text', id: 'nt-title' })]));
  panel.appendChild(el('div', { class: 'field' }, [
    el('label', { text: 'Brief（原始需求描述，创建后随任务保存）' }),
    el('textarea', { id: 'nt-brief', rows: 5 }),
  ]));

  const cfg = (latestBoard && latestBoard.config) || {};
  panel.appendChild(el('details', { class: 'advanced' }, [
    el('summary', { text: '高级参数（只读）' }),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'target repo' }), el('span', { text: cfg.targetRepo || '' })]),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'base branch' }), el('span', { text: cfg.baseBranch || '(currentBranch)' })]),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'test command' }), el('span', { text: cfg.testCommand || '' })]),
  ]));

  const resultSlot = el('div', { class: 'result-box' });
  if (resultBody) {
    resultSlot.appendChild(el('pre', { class: 'readonly', text: resultBody.message || (resultBody.ok ? 'ok' : 'failed') }));
  }

  const submitBtn = el('button', {
    class: 'btn btn-primary', text: '创建并运行 · Create & Run',
    onclick: async () => {
      const title = document.getElementById('nt-title').value;
      const brief = document.getElementById('nt-brief').value;
      const reqBody = { kind: newTaskState.kind, title, brief };
      if (newTaskState.kind === 'feature') reqBody.feasibility = newTaskState.feasibility === true;
      const { body: resBody } = await api('/api/new-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      loadBoard();
      renderNewTaskPanel(resBody);
    },
  });
  submitBtn.disabled = !newTaskState.kind;
  const cancelBtn = el('button', {
    class: 'btn btn-ghost', text: '取消',
    onclick: () => hideOverlay('panel-overlay'),
  });
  panel.appendChild(el('div', { class: 'action-row' }, [submitBtn, cancelBtn]));
  panel.appendChild(resultSlot);
}

// ---- 实时失效通知（P4-G1）：SSE 连上后停用轮询；断线/不可用时轮询兜底自动恢复（INV-3）----

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(loadBoard, 1500);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function handleServerEvent(evt) {
  if (!evt || typeof evt.type !== 'string') return;
  if (evt.type === 'board-dirty') {
    loadBoard();
    if (currentView === 'metrics') loadMetrics();
  } else if (evt.type === 'task-dirty') {
    if (evt.id === detailTaskId) refreshDetail();
  } else if (evt.type === 'job') {
    loadBoard();
    if (evt.taskId === detailTaskId) {
      pendingActionMessage = { ok: evt.state === 'ok', message: evt.message };
      refreshDetail();
    }
  }
}

function startRealtime() {
  startPolling(); // 旧轮询路径恒保留可用：先起轮询，SSE 连上后再停用
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => stopPolling());
  es.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleServerEvent(data);
  });
  es.addEventListener('error', () => startPolling());
}

loadBoard();
startRealtime();
window.addEventListener('hashchange', applyRoute);
applyRoute();
