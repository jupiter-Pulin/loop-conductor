// dashboard/static/app.mjs — 看板屏浏览器入口：屏 1 看板增量渲染 / 屏 2 详情（窄抽屉监控态 +
// #/task/<id> 全屏审查页）/ 屏 3 新建任务面板 / 屏 4 指标视图。
// 契约不变：/api/board、/api/task/:id、五个同步动作、/api/new-task；轮询周期恒 1500ms（I-4），
// P4 起以 /api/events SSE 失效通知驱动增量刷新，SSE 不可用/断线时 1500ms 轮询兜底恒可用（INV-3）。
// P6 详情双面分工：抽屉只做监控 peek（无决策按钮），一切人审决策（approve/reject/merge/retry)
// 只存在于全屏审查页；页由 hash 路由驱动，可刷新、可回退。
import {
  GAUGE_LANES, BOARD_COLUMNS, awaitingLabel, summarizeBoard, gaugeSegments, escapeHtml, verdictChip,
  groupTimelineByRound, roundGaugeTicks, resolveDrawerFocusTarget, parseRouteHash, rateLimitPanel,
} from './view.mjs';
import {
  barWidths, sortTableRows, formatUsd, formatPercent, formatDurationSeconds, isMetricsEmpty,
} from './metrics-view.mjs';

const LANES = GAUGE_LANES.map((key) => ({ key, label: key, you: key === 'merge' }));

/** 新看板四列：stage 就是列，副标题写「这一列在等谁」。 */
const COLUMN_SUBS = {
  ROUTING: 'router agent',
  AWAIT_HUMAN: 'you · spec / merge / help',
  FAILED_BOX: 'you · retry',
  DONE: 'merged',
};
const COLUMNS = BOARD_COLUMNS.map((key) => ({ key, label: key, you: key === 'AWAIT_HUMAN' || key === 'FAILED_BOX' }));

let latestBoard = null;
let detailMode = null; // 'drawer'（监控 peek）| 'page'（全屏审查页）| null
let detailTaskId = null;
let lastDetail = null;
let lastDiff = null;
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
  return [entry.stage, entry.awaitingKind, entry.needsHuman, entry.working, entry.spentUsd, entry.kind, entry.title].join('|');
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

/**
 * 新状态机卡片：没有六段泳道刻度可用（stage 就是列），改用「闸别 / 失败类型」一行事实。
 * 其余（点击分流、needs-you、working）与旧卡片完全一致，视觉沿用同一套 .card 语言。
 */
function buildColumnCardNode(entry) {
  const badges = [];
  if (entry.awaitingKind) badges.push(el('span', { class: 'badge badge-kind', text: awaitingLabel(entry.awaitingKind) }));
  if (entry.stage === 'FAILED_BOX' && entry.lastFailureType) {
    badges.push(el('span', { class: 'badge badge-kind', text: entry.lastFailureType }));
  }
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
    badges.length > 0 ? el('div', {}, badges) : null,
    el('div', { class: 'title', text: entry.title || '(无标题)' }),
  ]);
  if (entry.needsHuman) {
    card.appendChild(el('div', { class: 'needs-you', text: '⚑ needs you' }));
    card.appendChild(el('div', { class: 'review-btn', text: 'Review →' }));
  } else if (entry.working) {
    card.appendChild(workingLabel());
  }
  return card;
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

// ---- 新看板四列（keyed 增量渲染，与泳道同一套骨架/复用策略，只是列的含义变了） ----

const columnCardCache = new Map(); // id -> { node, sig }
const columnEls = new Map();       // column key -> { flag, row, wrap }

function ensureColumnSkeleton() {
  if (columnEls.size > 0) return;
  const container = document.getElementById('columns');
  COLUMNS.forEach((def, i) => {
    const flag = el('span', { class: 'lane-flag', text: '⚑' });
    flag.hidden = true;
    const header = el('div', { class: 'lane-header' }, [
      el('span', { class: 'lane-name', text: def.label }),
      flag,
      el('span', { class: 'lane-sub', text: COLUMN_SUBS[def.key] || '' }),
    ]);
    const row = el('div', { class: 'lane-row' });
    const wrap = el('div', { class: 'lane' }, [header, row]);
    wrap.style.setProperty('--lane-i', i);
    container.appendChild(wrap);
    columnEls.set(def.key, { flag, row, wrap });
  });
}

function renderColumns(board) {
  ensureColumnSkeleton();
  const columns = board.columns || [];
  const seen = new Set();
  for (const def of COLUMNS) {
    const { flag, row, wrap } = columnEls.get(def.key);
    const data = columns.find((c) => c.column === def.key) || { tasks: [] };
    const idle = data.tasks.length === 0;
    wrap.classList.toggle('idle', idle);
    if (idle) {
      row.innerHTML = '';
      if (!wrap.querySelector('.idle-bar')) {
        wrap.appendChild(el('div', { class: 'idle-bar' }, [
          el('span', { class: 'idle-name', text: def.label }),
          el('span', { class: 'idle-count', text: '0' }),
        ]));
      }
      flag.hidden = true;
      continue;
    }
    const existingIdleBar = wrap.querySelector('.idle-bar');
    if (existingIdleBar) existingIdleBar.remove();
    flag.hidden = !data.tasks.some((t) => t.needsHuman);
    let anchor = null;
    for (const entry of data.tasks) {
      seen.add(entry.id);
      const sig = cardSig(entry);
      let cached = columnCardCache.get(entry.id);
      if (!cached) {
        cached = { node: buildColumnCardNode(entry), sig };
        cached.node.classList.add('card-enter');
        columnCardCache.set(entry.id, cached);
      } else if (cached.sig !== sig) {
        const fresh = buildColumnCardNode(entry);
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
  for (const [id, cached] of columnCardCache) {
    if (!seen.has(id)) { cached.node.remove(); columnCardCache.delete(id); }
  }
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

/** 遗留状态机任务（旧 stage 名）仍按旧泳道显示（AC-029）；新任务不进这里。 */
function renderLanes(board) {
  ensureLaneSkeleton();
  const lanesContainer = document.getElementById('lanes');
  const totalQueue = board.lanes.reduce((sum, l) => sum + l.tasks.length, 0);

  if (totalQueue === 0) {
    lanesContainer.style.display = 'none';
    for (const [, cached] of cardCache) cached.node.remove();
    cardCache.clear();
    return;
  }
  lanesContainer.style.display = '';

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
  renderColumns(body);
  const legacyCount = (body.legacy || []).length;
  document.getElementById('legacy-wrap').hidden = legacyCount === 0;
  renderLanes(body);
  const columnCount = (body.columns || []).reduce((sum, c) => sum + c.tasks.length, 0);
  const emptySlot = document.getElementById('empty-state-slot');
  if (columnCount + legacyCount === 0) renderEmptyState();
  else emptySlot.innerHTML = '';
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

// 打回归因的取值域按纪元分开：旧任务是四门，新任务只有 precommit / reviewer / maker。
const REJECT_DOOR_LABELS = [
  ['verifier', 'verifier'], ['test-gate', 'test gate'], ['green-gate', 'green gate'], ['maker', 'maker'],
  ['reviewer', 'reviewer'], ['precommit', 'precommit'],
];

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
  // 新任务按四列统计，旧任务按六泳道；两类都空才算「无样本」。
  const columns = durations.columns || [];
  const lanes = durations.lanes || [];
  const rows = [
    ...columns.filter((c) => c.n > 0).map((c) => ({ label: c.column, p50: c.p50 })),
    ...lanes.filter((l) => l.n > 0).map((l) => ({ label: l.lane, p50: l.p50 })),
  ];
  if (rows.length === 0) { wrap.appendChild(el('div', { class: 'metrics-empty-inline', text: '暂无阶段耗时样本' })); return wrap; }
  const widths = barWidths(rows.map((r) => r.p50 ?? 0));
  rows.forEach((r, i) => wrap.appendChild(metricBarNode(r.label, formatDurationSeconds(r.p50), widths[i], false)));
  return wrap;
}

/** 新状态机的良率盘：只在仓库里真有 router 任务时出现，绝不与旧四门口径混算。 */
function buildRouterKpiRow(routerYield) {
  if (!routerYield || routerYield.taskCount.done + routerYield.taskCount.failed === 0) return null;
  const wrap = el('div', { class: 'metrics-kpi-row' });
  const kpi = (label, value) => wrap.appendChild(el('div', { class: 'metrics-kpi' }, [
    el('span', { class: 'metrics-kpi-label', text: label }),
    el('span', { class: 'metrics-kpi-value mono', text: value }),
  ]));
  kpi('router 任务（done/failed）', `${routerYield.taskCount.done} / ${routerYield.taskCount.failed}`);
  kpi('平均 router 轮次', routerYield.avgRounds.value == null ? '—' : routerYield.avgRounds.value.toFixed(1));
  kpi('reviewer 打回率', formatPercent(routerYield.reviewerFailRate.value));
  kpi('precommit 失败率', formatPercent(routerYield.precommitFailRate.value));
  kpi('maker 交付缺失率', formatPercent(routerYield.makerProductMissRate.value));
  const gates = routerYield.humanGates;
  kpi('人闸（spec/merge/help）', `${gates.spec} / ${gates.merge} / ${gates.help}`);
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
    buildRouterKpiRow(metrics.routerYield),
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

/** 新状态机的 merge 闸同样要同屏看 diff；spec / help 闸不看代码。 */
function needsDiff(detail) {
  const review = detail?.review;
  if (!review) return false;
  if (review.kind === 'human') return review.gate?.kind === 'merge';
  return DIFF_ENTRY_KINDS.includes(review.kind);
}

function resetDetailState() {
  lastDetail = null;
  lastDiff = null;
  lastStreamTail = null;
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
  if (mode === 'page' && needsDiff(lastDetail)) {
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
/** 新状态机的四点进度条：stage 就是位置，没有轮次刻度可挂（轮次在记录列表里）。 */
function columnDots(column) {
  const wrap = el('div', { class: 'stage-dots' });
  const curIdx = COLUMNS.findIndex((c) => c.key === column);
  COLUMNS.forEach((def, i) => {
    const cls = curIdx >= 0 && i === curIdx ? ' current' : (curIdx >= 0 && i < curIdx ? ' done' : '');
    wrap.appendChild(el('div', { class: 'dot-group' }, [
      el('span', { class: `dot${cls}`, title: def.label }),
      el('span', { class: `dot-label${cls}`, text: def.label }),
    ]));
    if (i < COLUMNS.length - 1) wrap.appendChild(el('span', { class: 'dot-line' }));
  });
  return wrap;
}

/** 详情页进度条分流：新任务四点，旧任务六泳道 + 轮次刻度（AC-029）。 */
function progressDots(detail, rounds) {
  return detail.isRouterTask ? columnDots(detail.column) : stageDots(detail.lane, detail.box, rounds);
}

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
      task && task.kind ? el('span', { class: 'badge badge-kind', text: String(task.kind).toUpperCase() }) : null,
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

  drawer.appendChild(progressDots(detail, roundsView.rounds));

  if (pendingActionMessage) {
    drawer.appendChild(el('div', { class: 'result-box' }, [
      el('pre', { class: 'readonly', text: pendingActionMessage.message || (pendingActionMessage.ok ? 'ok' : 'failed') }),
    ]));
  }

  if (detail.working) {
    drawer.appendChild(workingLabel());
    drawer.appendChild(buildStreamTailNode(lastStreamTail));
  }

  if (detail.isRouterTask) {
    const recordsNode = buildRecordsSectionNode(detail.records);
    if (recordsNode) drawer.appendChild(recordsNode);
  } else {
    drawer.appendChild(buildRoundsSectionNode(roundsView.rounds));
    const attemptsNode = buildAttemptsSectionNode(roundsView.attempts);
    if (attemptsNode) drawer.appendChild(attemptsNode);
  }

  const timelineWrap = el('div', { class: 'drawer-timeline' }, [el('h3', { text: 'Timeline' })]);
  const scroll = el('div', { class: 'timeline-scroll' });
  scroll.appendChild(buildTimelineListNode(detail.timelineEntries || []));
  timelineWrap.appendChild(scroll);
  drawer.appendChild(timelineWrap);
}

// ---- 新状态机：记录列表 / 内核事实 / 事件流 / 通用人闸页 ----

/** 一条记录两行：事实行（outcome/tier/action/head/cost/truncated/product）+ summary 原文。 */
function buildRecordRowNode(rec) {
  if (rec.role === 'human') {
    return el('div', { class: 'record-row' }, [
      el('div', { class: 'record-head' }, [
        el('span', { class: 'record-role', text: `r${rec.round} human` }),
        el('span', { text: `kind=${rec.kind || '-'}` }),
        el('span', { text: `decision=${rec.decision || 'pending'}` }),
      ]),
      rec.notes ? el('div', { class: 'record-summary', text: `notes: ${rec.notes}` }) : null,
    ]);
  }
  const fields = [`outcome=${rec.outcome || '-'}`];
  if (rec.tier) fields.push(`tier=${rec.tier}`);
  if (rec.action) fields.push(`action=${rec.action}`);
  if (rec.head_sha) fields.push(`head=${String(rec.head_sha).slice(0, 6)}`);
  if (rec.base_sha) fields.push(`base=${String(rec.base_sha).slice(0, 6)}`);
  fields.push(`cost=${fmtUsd(rec.cost_usd)}`);
  fields.push(`truncated=${rec.truncated ? 'yes' : 'no'}`);
  return el('div', { class: `record-row${rec.product !== 'ok' ? ' product-bad' : ''}` }, [
    el('div', { class: 'record-head' }, [
      el('span', { class: 'record-role', text: `r${rec.round} ${rec.role}${rec.package ? ` ${rec.package}` : ''}` }),
      ...fields.map((f) => el('span', { text: f })),
      el('span', {
        class: rec.product === 'ok' ? '' : 'chip chip-fail',
        text: `product=${rec.product}`,
      }),
    ]),
    rec.product !== 'ok' && rec.product_error?.length
      ? el('div', { class: 'record-summary', text: rec.product_error.join('; ') })
      : null,
    rec.summary ? el('div', { class: 'record-summary', text: rec.summary }) : null,
  ]);
}

function buildRecordsSectionNode(records) {
  if (!records || records.length === 0) return null;
  return el('details', { class: 'attempts-section', open: 'open' }, [
    el('summary', { text: `记录（${records.length} 条）` }),
    el('div', { class: 'record-list' }, records.map(buildRecordRowNode)),
  ]);
}

function buildFactsSectionNode(facts) {
  if (!facts) return null;
  return el('details', { class: 'attempts-section', open: 'open' }, [
    el('summary', { text: '内核事实' }),
    el('pre', { class: 'readonly', text: facts.text || '' }),
  ]);
}

function buildEventsSectionNode(events) {
  if (!events || events.length === 0) return null;
  const rows = events.map((e) => {
    const rest = Object.entries(e)
      .filter(([k]) => k !== 'type' && k !== 'ts' && k !== 'task')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('  ');
    return el('div', { class: 'event-row' }, [
      el('span', { text: `${e.ts || ''} ` }),
      el('span', { class: 'event-type', text: e.type || '?' }),
      el('span', { text: rest ? `  ${rest}` : '' }),
    ]);
  });
  return el('details', { class: 'attempts-section' }, [
    el('summary', { text: `事件流（${events.length} 条）` }),
    el('div', { class: 'event-list' }, rows),
  ]);
}

/** precommit 三步结果：每步 status / 用时 / tail（merge 闸同屏必看的东西）。 */
function buildPrecommitNode(pre) {
  if (!pre) return el('div', { class: 'verdict-empty', text: '本任务尚无 precommit 记录' });
  const stepChip = (status) => {
    const chip = verdictChip(status === 'ok' ? 'pass' : (status === 'fail' ? 'fail' : 'unknown'));
    return el('span', { class: `chip ${chip.className}`, text: `${chip.symbol} ${status}` });
  };
  const steps = (pre.steps || []).map((s) => el('div', { class: 'precommit-step' }, [
    stepChip(s.status),
    el('span', { class: 'record-role', text: s.step }),
    el('span', { text: s.command || '' }),
    el('span', { text: s.duration_ms == null ? '' : `${Math.round(s.duration_ms / 1000)}s` }),
    s.ready_ms == null ? null : el('span', { text: `ready ${(s.ready_ms / 1000).toFixed(1)}s` }),
  ]));
  const tails = (pre.steps || []).filter((s) => s.status === 'fail' && s.tail);
  return el('div', { class: 'verdict-block' }, [
    el('div', { class: 'verdict-summary' }, [
      el('span', { class: `chip ${verdictChip(pre.outcome === 'ok' ? 'pass' : 'fail').className}`, text: pre.outcome || '?' }),
      el('span', { class: 'verdict-round', text: `r${pre.round} · tier=${pre.tier || '-'}` }),
      el('span', {
        class: 'verdict-counts',
        text: `head=${String(pre.headSha || '').slice(0, 6)} base=${String(pre.baseSha || '').slice(0, 6)}`,
      }),
    ]),
    pre.summary ? el('div', { class: 'record-summary', text: pre.summary }) : null,
    el('div', { class: 'precommit-steps' }, steps),
    ...tails.map((s) => el('pre', { class: 'readonly', text: `${s.step} tail:\n${s.tail}` })),
    pre.conflictFiles?.length
      ? el('div', { class: 'record-summary', text: `conflict_files: ${pre.conflictFiles.join(', ')}` })
      : null,
  ]);
}

/**
 * 通用人闸页（AC-043 在 P2 的适用部分）：三种 kind 共用同一个头部（kind / requested_by /
 * summary / refs），各自挂自己的同屏材料与按钮。按钮语义等同 CLI，一个不多一个不少。
 */
function buildHumanGateMain(id, detail, content, actions) {
  const review = detail.review;
  const gate = review.gate || {};
  content.push(el('h3', { text: `人闸 · ${awaitingLabel(gate.kind)}` }));
  content.push(el('div', { class: 'gate-meta' }, [
    el('span', { class: 'badge badge-kind', text: `kind=${gate.kind || '?'}` }),
    el('span', { class: 'badge badge-kind', text: `requested_by=${gate.requestedBy || '?'}` }),
    gate.round == null ? null : el('span', { class: 'mono', text: `r${gate.round}` }),
  ]));
  content.push(el('pre', {
    class: 'readonly',
    text: gate.summary || (gate.missing ? '(human-r<n>.json 缺失：产物与状态不一致，可按 CLI 提示直接处理)' : '(内核未写 summary)'),
  }));
  if (gate.refs && gate.refs.length > 0) {
    content.push(el('div', { class: 'gate-refs' }, gate.refs.map((r) => el('span', { text: r }))));
  }

  if (gate.kind === 'spec') {
    const spec = review.spec || {};
    if (spec.pendingQuestions) {
      content.push(el('h3', { text: '待决问题' }));
      content.push(el('pre', { class: 'readonly', text: spec.pendingQuestions }));
    }
    content.push(el('h3', { text: 'Spec 全文' }));
    content.push(el('pre', { class: 'readonly readonly-tall', text: spec.missing ? spec.message : spec.markdown }));
    const notes = el('textarea', { id: 'gate-notes', rows: 3 });
    content.push(el('div', { class: 'field' }, [el('label', { text: '备注（approve 可选，reject 必填）' }), notes]));
    const approveBtn = el('button', {
      class: 'btn btn-primary', text: '通过 spec',
      onclick: () => confirmAndSubmit(id, 'approve', { notes: notes.value }, '确定通过 spec？'),
    });
    const rejectBtn = el('button', {
      class: 'btn btn-danger', text: '打回并留言',
      onclick: () => confirmAndSubmit(id, 'reject', { notes: notes.value }, '确定打回 spec 并留言？'),
    });
    rejectBtn.disabled = true;
    notes.addEventListener('input', () => { rejectBtn.disabled = notes.value.trim() === ''; });
    actions.push(approveBtn, rejectBtn);
    return;
  }

  if (gate.kind === 'merge') {
    content.push(el('h3', { text: '最近一次整体 review' }));
    const reviewer = review.reviewer;
    content.push(reviewer
      ? el('div', { class: 'record-list' }, [buildRecordRowNode(reviewer)])
      : el('div', { class: 'verdict-empty', text: '本任务尚无 reviewer 记录' }));
    content.push(el('h3', { text: 'precommit 三步' }));
    content.push(buildPrecommitNode(review.precommit));
    content.push(buildDiffSectionNode(lastDiff, { taskId: id, shortstat: review.diffShortstat }));
    const message = el('input', { type: 'text', id: 'gate-message' });
    const notes = el('textarea', { id: 'gate-notes', rows: 3 });
    content.push(el('div', { class: 'field' }, [el('label', { text: 'merge commit 文案（可选，留空用机器文案）' }), message]));
    content.push(el('div', { class: 'field' }, [el('label', { text: '打回理由（reject 必填）' }), notes]));
    const base = detail.task ? detail.task.baseBranch : 'base';
    const approveBtn = el('button', {
      class: 'btn btn-primary', text: `批准合并到 ${base}`,
      onclick: () => confirmAndSubmit(id, 'approve', { message: message.value }, `确定合并到 ${base}？此操作不可撤销。`),
    });
    const rejectBtn = el('button', {
      class: 'btn btn-danger', text: '打回并留言',
      onclick: () => confirmAndSubmit(id, 'reject', { notes: notes.value }, '确定打回 merge 并留言？'),
    });
    rejectBtn.disabled = true;
    notes.addEventListener('input', () => { rejectBtn.disabled = notes.value.trim() === ''; });
    actions.push(approveBtn, rejectBtn);
    return;
  }

  const notes = el('textarea', { id: 'gate-notes', rows: 3 });
  content.push(el('div', { class: 'field' }, [el('label', { text: '备注（可选，进「已裁决事项」）' }), notes]));
  actions.push(el('button', {
    class: 'btn btn-primary', text: '恢复 · resume',
    onclick: () => confirmAndSubmit(id, 'resume', { notes: notes.value }, '确定恢复该任务？notes 不豁免版本规则。'),
  }));
}

// ---- 屏 2b：全屏审查页（报告优先：verify/spec 报告是主角，diff 只做分诊，决策按钮固定在底部动作条） ----

/** 旧状态机遗留的 review 形态：只读渲染，没有任何决策按钮（对应动词已随 P3 一起删）。 */
const LEGACY_REVIEW_KINDS = new Set(['feasibility', 'setup', 'spec', 'scope', 'merge']);
const LEGACY_REVIEW_LABEL = {
  feasibility: '遗留任务：feasibility memo（旧状态机产物，只读）',
  setup: '遗留任务：setup profile 草稿（旧状态机产物，只读）',
  spec: '遗留任务：spec 草稿与 spec-verifier 裁决（旧状态机产物，只读）',
  scope: '遗留任务：spec 规模升闸（旧状态机产物，只读）',
  merge: '遗留任务：旧 merge 闸（旧状态机产物，只读）',
};

/** review kind → { content: node[], actions: node[] }。content 顺序即页面主列顺序：报告在前。 */
function buildReviewMain(id, detail) {
  const task = detail.task;
  const review = detail.review;
  const content = [];
  const actions = [];

  if (review.kind === 'human') {
    buildHumanGateMain(id, detail, content, actions);
  } else if (LEGACY_REVIEW_KINDS.has(review.kind)) {
    // 旧状态机的人闸（feasibility / setup / spec-verifier / 规模 / 旧 merge）已在 P3 删除：
    // 案卷与草稿仍要看得见（AC-029），但一个决策按钮都不给——对应的 CLI 动词已经没了，
    // 点下去只会得到「legacy task, not operable by this conductor」。
    content.push(el('div', { class: 'legacy-note', text: LEGACY_REVIEW_LABEL[review.kind] }));
    if (review.markdown || review.message) {
      content.push(el('pre', { class: 'readonly readonly-tall', text: review.missing ? review.message : review.markdown }));
    }
    if (review.kind === 'merge') {
      content.push(buildVerdictPanelNode(review.verdict));
      content.push(buildDiffSectionNode(lastDiff, {
        taskId: id,
        shortstat: review.error ? review.error : review.diffShortstat,
      }));
    } else {
      content.push(buildSpecVerifyNode(review.specVerify));
    }
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
      task && task.kind ? el('span', { class: 'badge badge-kind', text: String(task.kind).toUpperCase() }) : null,
      detail.needsHuman ? el('span', { class: 'needs-you', text: '⚑ needs you' }) : null,
    ]),
    el('h2', { class: 'task-page-title', text: task ? task.title : '(损坏任务目录)' }),
    el('div', { class: 'task-page-stage' }, [
      el('span', { class: 'mono', text: `stage: ${runtime ? runtime.stage : '(unknown)'}` }),
      detail.working ? workingLabel() : null,
    ]),
    progressDots(detail, roundsView.rounds),
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
  // 新状态机任务看记录 + 内核事实；旧任务继续看四门轮次证据链（AC-029）。
  if (detail.isRouterTask) {
    const recordsNode = buildRecordsSectionNode(detail.records);
    if (recordsNode) main.appendChild(recordsNode);
    const factsNode = buildFactsSectionNode(detail.facts);
    if (factsNode) main.appendChild(factsNode);
  } else {
    main.appendChild(buildRoundsSectionNode(roundsView.rounds));
    const attemptsNode = buildAttemptsSectionNode(roundsView.attempts);
    if (attemptsNode) main.appendChild(attemptsNode);
  }
  const eventsNode = buildEventsSectionNode(detail.events);
  if (eventsNode) main.appendChild(eventsNode);
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

document.getElementById('btn-new-task').addEventListener('click', () => {
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

  // 新 CLI 只有四个字段：title / brief 正文 / repo / base branch。
  // 没有 kind、没有 feasibility、没有 auto-approve-spec——路由由 router 决定，不由建单人预判。
  const cfg = (latestBoard && latestBoard.config) || {};
  panel.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Title' }), el('input', { type: 'text', id: 'nt-title' })]));
  panel.appendChild(el('div', { class: 'field' }, [
    el('label', { text: 'Brief 正文（需求原文，随任务落盘为 brief.md）' }),
    el('textarea', { id: 'nt-brief', rows: 8 }),
  ]));
  panel.appendChild(el('div', { class: 'field' }, [
    el('label', { text: `目标仓库（留空用默认 ${cfg.targetRepo || ''}）` }),
    el('input', { type: 'text', id: 'nt-repo', placeholder: cfg.targetRepo || '' }),
  ]));
  panel.appendChild(el('div', { class: 'field' }, [
    el('label', { text: `base 分支（留空用默认 ${cfg.baseBranch || 'currentBranch'}）` }),
    el('input', { type: 'text', id: 'nt-base-branch', placeholder: cfg.baseBranch || '(currentBranch)' }),
  ]));

  panel.appendChild(el('details', { class: 'advanced' }, [
    el('summary', { text: '高级参数（只读）' }),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'target repo' }), el('span', { text: cfg.targetRepo || '' })]),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'base branch' }), el('span', { text: cfg.baseBranch || '(currentBranch)' })]),
    el('div', { class: 'advanced-field' }, [el('span', { text: 'test command' }), el('span', { text: cfg.testCommand || '' })]),
  ]));

  const resultSlot = el('div', { class: 'result-box' });
  if (resultBody) {
    // profile 缺 precommit 段时 CLI 把完整样例写进 stderr，这里原样显示给人照抄（AC-019）。
    resultSlot.appendChild(el('pre', { class: 'readonly', text: resultBody.message || (resultBody.ok ? 'ok' : 'failed') }));
  }

  const submitBtn = el('button', {
    class: 'btn btn-primary', text: '创建并运行 · Create & Run',
    onclick: async () => {
      const reqBody = {
        title: document.getElementById('nt-title').value,
        brief: document.getElementById('nt-brief').value,
        repo: document.getElementById('nt-repo').value,
        baseBranch: document.getElementById('nt-base-branch').value,
      };
      const { body: resBody } = await api('/api/new-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      loadBoard();
      renderNewTaskPanel(resBody);
    },
  });
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
