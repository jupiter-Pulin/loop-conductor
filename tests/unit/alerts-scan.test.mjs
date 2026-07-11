// 单元：tools/alerts-scan.mjs —— 即时播报规则表与 cursor 幂等（E24/H30）。
// 核心不变量：①五条规则各自触发且 severity/@ 正确；②cursor 见过的 key 绝不重报；
// ③发送失败不推进 cursor（由 CLI 层保证，这里钉 saveCursor 只记 delivered）；④空库零告警。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAlerts, renderAlerts, loadCursor, saveCursor } from '../../tools/alerts-scan.mjs';
import { sendSlackWebhook } from '../../tools/slack-notify.mjs';

const DAY = 86400_000;

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-scan-'));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'dossier']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTask(root, box, id, { runtime = {}, dossier = {}, events = null } = {}) {
  const stateDir = path.join(root, 'state', box, id);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task.json'), JSON.stringify({ id }));
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ stage: 'DONE', spent_usd: 0, ...runtime }));
  const dDir = path.join(root, 'dossier', id);
  fs.mkdirSync(dDir, { recursive: true });
  for (const [name, content] of Object.entries(dossier)) {
    fs.writeFileSync(path.join(dDir, name), JSON.stringify(content));
  }
  if (events) {
    fs.writeFileSync(path.join(dDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

test('scanAlerts：五条规则触发、severity 与 @ 标记、排序', (t) => {
  const root = makeRoot(t);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // await_entered（info，不 @）+ await_aging（warn，@）：停靠 4 天
  writeTask(root, 'queue', 'task-20260701-001', {
    runtime: { stage: 'AWAIT_HUMAN_MERGE', spent_usd: 5 },
    events: [{ ts: iso(now - 4 * DAY), type: 'stage', stage: 'AWAIT_HUMAN_MERGE', note: 'verdict pass r1' }],
  });
  // shadow_high_risk（critical，@）
  writeTask(root, 'queue', 'task-20260701-002', {
    runtime: { stage: 'AWAIT_HUMAN_MERGE' },
    events: [{ ts: iso(now - 3600_000), type: 'stage', stage: 'AWAIT_HUMAN_MERGE' }],
    dossier: {
      'verify-r1.shadow-compare.json': {
        agreement: { total_acs: 4, agreed: 3, high_risk_count: 1, disagreements: [{ ac_id: 'AC-002', main: 'pass', shadow: 'fail', high_risk: true }] },
      },
    },
  });
  // shadow_disagree（warn，不 @）
  writeTask(root, 'done', 'task-20260701-003', {
    dossier: {
      'verify-r1.shadow-compare.json': {
        agreement: { total_acs: 5, agreed: 4, high_risk_count: 0, disagreements: [{ ac_id: 'AC-003', main: 'pass', shadow: 'unknown', high_risk: false }] },
      },
    },
  });
  // task_failed（error，@）
  writeTask(root, 'failed', 'task-20260701-004', {
    runtime: { stage: 'FAILED_BOX', last_failure_type: 'budget_exceeded', spent_usd: 61.2 },
  });
  // merge_failed（error，@，E30/F14）+ review_high_risk（critical，@）+ review_disagree（warn，不 @）
  writeTask(root, 'queue', 'task-20260701-005', {
    runtime: { stage: 'AWAIT_HUMAN_MERGE' },
    events: [
      { ts: iso(now - 3000_000), type: 'stage', stage: 'AWAIT_HUMAN_MERGE' },
      { ts: iso(now - 1800_000), type: 'merge_failed', reason: 'git_merge_failed', auto: false, detail: 'CONFLICT in lib/stats.mjs' },
    ],
    dossier: {
      'review-r1.compare.json': { main: { overall: 'pass' }, review: { valid: true, gate: 'blocked' }, disagreement: true, high_risk: true },
    },
  });
  writeTask(root, 'done', 'task-20260701-006', {
    dossier: {
      'review-r1.compare.json': { main: { overall: 'pass' }, review: { valid: true, gate: 'ready_with_concerns' }, disagreement: true, high_risk: false },
      'review-r2.compare.json': { main: { overall: 'pass' }, review: { valid: false, gate: null }, disagreement: null, high_risk: false },
    },
  });

  const alerts = scanAlerts(root, { seen: {} }, { nowMs: now });
  const byKey = Object.fromEntries(alerts.map((a) => [a.key.split(':').slice(0, 2).join(':') + ':' + a.key.split(':').pop(), a]));

  // 逐规则断言
  const highRisk = alerts.find((a) => a.severity === 'critical');
  assert.ok(highRisk && highRisk.mention === true && highRisk.text.includes('AC-002 pass→fail'), 'high-risk 分歧 critical + @');
  const failed = alerts.find((a) => a.key.includes(':failed:'));
  assert.ok(failed && failed.severity === 'error' && failed.mention === true && failed.text.includes('budget_exceeded'), 'failed 箱 error + @');
  const aging = alerts.find((a) => a.key.includes('aging72h'));
  assert.ok(aging && aging.severity === 'warn' && aging.mention === true && aging.text.includes('4 天'), '停靠超 72h warn + @');
  const disagree = alerts.find((a) => a.key.includes('disagree'));
  assert.ok(disagree && disagree.severity === 'warn' && disagree.mention === false && disagree.text.includes('AC-003 pass→unknown'), '非 high-risk 分歧 warn 不 @');
  const entered = alerts.filter((a) => a.key.includes(':await:'));
  assert.equal(entered.length, 3, 'AWAIT 进入事件各报一次');
  assert.ok(entered.every((a) => a.severity === 'info' && a.mention === false));

  // E30 三条新规则
  const mergeFailed = alerts.find((a) => a.key.includes('merge_failed'));
  assert.ok(mergeFailed && mergeFailed.severity === 'error' && mergeFailed.mention === true
    && mergeFailed.text.includes('git_merge_failed') && mergeFailed.text.includes('CONFLICT'), 'merge 失败 error + @ + git 摘要');
  const reviewHigh = alerts.find((a) => a.key.includes('review_high_risk'));
  assert.ok(reviewHigh && reviewHigh.severity === 'critical' && reviewHigh.mention === true
    && reviewHigh.text.includes('gate=blocked'), 'reviewer 拦截 critical + @');
  const reviewDisagree = alerts.find((a) => a.key.includes('review_disagree'));
  assert.ok(reviewDisagree && reviewDisagree.severity === 'warn' && reviewDisagree.mention === false
    && reviewDisagree.text.includes('ready_with_concerns'), 'reviewer 非高危分歧 warn 不 @');
  assert.ok(!alerts.some((a) => a.key.includes('review-r2')), 'review 无效（协议失败）不告警');

  // 排序：critical 最前
  assert.equal(alerts[0].severity, 'critical');

  // 渲染：批量单条消息 + mention 只在需要时出现
  const text = renderAlerts(alerts, { mention: '<@U999>' });
  assert.match(text, /^🔔 loop-conductor 告警（10 条） <@U999>/);
  const noMention = renderAlerts([disagree], { mention: '<@U999>' });
  assert.ok(!noMention.includes('<@U999>'), '全部不 @ 的批次不出现 mention');
});

test('scanAlerts：cursor 幂等——已报 key 二次扫描零告警；saveCursor 只记 delivered', (t) => {
  const root = makeRoot(t);
  const now = Date.now();
  writeTask(root, 'failed', 'task-20260701-010', {
    runtime: { stage: 'FAILED_BOX', last_failure_type: 'spawn_failed', spent_usd: 0.5 },
  });

  const first = scanAlerts(root, { seen: {} }, { nowMs: now });
  assert.equal(first.length, 1);

  const cursorPath = path.join(root, 'state', 'alerts-cursor.json');
  const cursor = saveCursor(cursorPath, { seen: {} }, first, now);
  assert.ok(cursor.seen[first[0].key], 'delivered key 入 cursor');

  const second = scanAlerts(root, loadCursor(cursorPath), { nowMs: now });
  assert.equal(second.length, 0, '已报告警不重发');

  // 模拟发送失败：cursor 不推进（saveCursor 未被调用）→ 三扫仍报
  const third = scanAlerts(root, { seen: {} }, { nowMs: now });
  assert.equal(third.length, 1, '未推进 cursor 时下次扫描重试');
});

test('scanAlerts：空库零告警；AWAIT 未超 72h 不催办', (t) => {
  const root = makeRoot(t);
  const now = Date.now();
  assert.equal(scanAlerts(root, { seen: {} }, { nowMs: now }).length, 0);

  writeTask(root, 'queue', 'task-20260701-020', {
    runtime: { stage: 'AWAIT_HUMAN_MERGE' },
    events: [{ ts: new Date(now - 3600_000).toISOString(), type: 'stage', stage: 'AWAIT_HUMAN_MERGE' }],
  });
  const alerts = scanAlerts(root, { seen: {} }, { nowMs: now });
  assert.equal(alerts.length, 1, '只有 await_entered，无 aging');
  assert.ok(alerts[0].key.includes(':await:'));
});

test('sendSlackWebhook：200+ok 成功；非 ok body 与网络异常收敛 ok:false', async () => {
  const calls = [];
  const okImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, text: async () => 'ok' };
  };
  const res = await sendSlackWebhook({ url: 'https://hooks.slack.com/services/T/B/x', text: 'hi', fetchImpl: okImpl });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: 'hi' });

  const badImpl = async () => ({ status: 403, text: async () => 'invalid_token' });
  const bad = await sendSlackWebhook({ url: 'https://hooks', text: 'x', fetchImpl: badImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^webhook_403: invalid_token/);

  const throwImpl = async () => {
    throw new Error('ETIMEDOUT');
  };
  const net = await sendSlackWebhook({ url: 'https://hooks', text: 'x', fetchImpl: throwImpl });
  assert.match(net.error, /^network: ETIMEDOUT/);

  const missing = await sendSlackWebhook({ url: null, text: 'x', fetchImpl: okImpl });
  assert.match(missing.error, /missing_webhook_url/);
});
