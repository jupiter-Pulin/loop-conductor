#!/usr/bin/env node
// tools/alerts-scan.mjs — 事件驱动即时播报（传感层，fable-loop E24/H30）。
// 独立推送服务：只读 dossier/events.jsonl + shadow-compare + state 三箱，套规则表发 Slack。
// 架构硬约束：conductor 对本工具一无所知（零状态机改动）——Slack 挂了绝不影响路由。
// cursor 文件（默认 state/alerts-cursor.json，运行时数据勿入库）记录已播报 key，防重发；
// 发送失败不推进 cursor，下次扫描自动重试。--dry-run 只打印、不发送、不写 cursor。
// 用法：node tools/alerts-scan.mjs [--dry-run] [--cursor <path>] [--channel C..] [root]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEventsWithTs } from './weekly-report.mjs';
import { sendSlackMessage, sendSlackWebhook, loadSlackEnv } from './slack-notify.mjs';

const TASK_DIR_RE = /^task-\d{8}-\d{3}$/;
const AGING_THRESHOLD_MS = 72 * 3600_000;

/**
 * 规则表（设计定稿，后续只填字段不改结构）：
 * | id                 | 触发源                                      | severity | @人 |
 * | await_entered      | events: stage 进入 AWAIT_*                  | info     | 否  |
 * | await_aging        | queue 任务停靠 AWAIT_* 超 72h               | warn     | 是  |
 * | task_failed        | state/failed 新增（含 spawn_failed/budget_exceeded 等 failure_type） | error | 是 |
 * | merge_failed       | events: merge_failed（E30/F14——「以为合了」类脱节的即时纠偏） | error | 是 |
 * | shadow_high_risk   | shadow-compare: agreement.high_risk_count>0 | critical | 是  |
 * | shadow_disagree    | shadow-compare: 分歧>0 且无 high-risk       | warn     | 否  |
 * | review_high_risk   | review-compare: high_risk=true（verifier pass 但 reviewer blocked——-001 拦截曾只留 timeline 的补课） | critical | 是 |
 * | review_disagree    | review-compare: disagreement=true 且非 high-risk | warn  | 否  |
 */
const SEVERITY_ICON = { info: 'ℹ️', warn: '⚠️', error: '🔴', critical: '🚨' };

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listTaskIds(boxDir) {
  try {
    return fs.readdirSync(boxDir).filter((n) => TASK_DIR_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** 纯扫描：不发送不写盘。返回 cursor 未见过的告警清单（key 幂等去重）。 */
export function scanAlerts(root, cursor = { seen: {} }, { nowMs = Date.now() } = {}) {
  const seen = cursor.seen ?? {};
  const alerts = [];
  const add = (key, severity, mention, text) => {
    if (seen[key]) return;
    alerts.push({ key, severity, mention, text });
  };

  const boxes = { queue: listTaskIds(path.join(root, 'state', 'queue')), done: listTaskIds(path.join(root, 'state', 'done')), failed: listTaskIds(path.join(root, 'state', 'failed')) };
  const allIds = [...new Set([...boxes.queue, ...boxes.done, ...boxes.failed])];

  for (const id of allIds) {
    const dossierDir = path.join(root, 'dossier', id);
    const events = readEventsWithTs(dossierDir);
    const box = boxes.queue.includes(id) ? 'queue' : (boxes.failed.includes(id) ? 'failed' : 'done');
    const runtime = readJsonIf(path.join(root, 'state', box, id, 'runtime.json')) ?? {};

    // 规则 await_entered：只报「当前仍停靠 AWAIT_*」的任务（历史 AWAIT 事件对已推进的任务无行动价值）。
    // key 带进入时刻：同任务再次回到同 stage（如 reject 后再 pass）会重新提醒一次。
    if (typeof runtime.stage === 'string' && runtime.stage.startsWith('AWAIT_')) {
      const enterEv = [...events].reverse().find((e) => e.type === 'stage' && e.stage === runtime.stage);
      let enteredAt = enterEv?.ts ?? null;
      if (!enteredAt) {
        try {
          enteredAt = new Date(fs.statSync(path.join(root, 'state', box, id, 'runtime.json')).mtimeMs).toISOString();
        } catch {
          enteredAt = 'unknown';
        }
      }
      add(`${id}:await:${runtime.stage}:${enteredAt}`, 'info', false, `${id} 进入 ${runtime.stage}${enterEv?.note ? `（${enterEv.note}）` : ''} — 待人工处理`);
    }

    // 规则 merge_failed（E30/F14）：merge 失败事件即时纠偏「以为合了」。每次失败独立报（key 带 ts）。
    for (const ev of events) {
      if (ev.type === 'merge_failed') {
        add(`${id}:merge_failed:${ev.ts}`, 'error', true, `${id} merge 失败（${ev.reason ?? '?'}${ev.auto ? ',auto' : ''}）：${(ev.detail ?? '').slice(0, 120)} — 任务留在闸门,需人处置`);
      }
    }

    // 规则 shadow_high_risk / shadow_disagree
    let entries = [];
    try {
      entries = fs.readdirSync(dossierDir);
    } catch { /* dossier 缺失容错 */ }
    for (const name of entries.sort()) {
      if (/^verify-r\d+\.shadow-compare\.json$/.test(name)) {
        const ag = readJsonIf(path.join(dossierDir, name))?.agreement;
        if (!ag) continue;
        const ds = ag.disagreements ?? [];
        if ((ag.high_risk_count ?? 0) > 0) {
          const detail = ds.filter((d) => d.high_risk).map((d) => `${d.ac_id} ${d.main}→${d.shadow}`).join('、');
          add(`${id}:${name}:high_risk`, 'critical', true, `${id} shadow HIGH-RISK 分歧：${detail || `${ag.high_risk_count} 处`} — 立即人工核`);
        } else if (ds.length > 0) {
          const detail = ds.map((d) => `${d.ac_id} ${d.main}→${d.shadow}`).join('、');
          add(`${id}:${name}:disagree`, 'warn', false, `${id} shadow 分歧（非 high-risk）：${detail} — merge 前必看`);
        }
      } else if (/^review-r\d+\.compare\.json$/.test(name)) {
        // 规则 review_high_risk / review_disagree（E30）：reviewer 第二意见的拦截必须进告警——
        // -001 的真拦截（gate=blocked）当时只留在 timeline,人若不翻案卷就错过。
        const c = readJsonIf(path.join(dossierDir, name));
        if (!c || c.review?.valid !== true) continue;
        if (c.high_risk === true) {
          add(`${id}:${name}:review_high_risk`, 'critical', true, `${id} reviewer HIGH-RISK：verifier pass 但 review gate=${c.review?.gate ?? '?'}（false-pass 候选）— merge 前必须人工核`);
        } else if (c.disagreement === true) {
          add(`${id}:${name}:review_disagree`, 'warn', false, `${id} reviewer 分歧（gate=${c.review?.gate ?? '?'}，非 high-risk）— merge 前一看`);
        }
      }
    }
  }

  // 规则 task_failed：failed 箱现存任务（含 budget_exceeded / spawn_failed 等归因）
  for (const id of boxes.failed) {
    const runtime = readJsonIf(path.join(root, 'state', 'failed', id, 'runtime.json')) ?? {};
    const type = runtime.last_failure_type ?? 'unknown';
    add(`${id}:failed:${type}`, 'error', true, `${id} 收箱 failed（${type}，已花 $${runtime.spent_usd ?? '?'}）— 需人工 retry/归因`);
  }

  // 规则 await_aging：queue 任务停靠 AWAIT_* 超 72h（每个 stage 只催一次）
  for (const id of boxes.queue) {
    const runtime = readJsonIf(path.join(root, 'state', 'queue', id, 'runtime.json')) ?? {};
    const stage = runtime.stage;
    if (typeof stage !== 'string' || !stage.startsWith('AWAIT_')) continue;
    const events = readEventsWithTs(path.join(root, 'dossier', id));
    const stageEvents = events.filter((e) => e.type === 'stage');
    let sinceMs = stageEvents.length ? stageEvents[stageEvents.length - 1]._ms : null;
    if (sinceMs === null) {
      try {
        sinceMs = fs.statSync(path.join(root, 'state', 'queue', id, 'runtime.json')).mtimeMs;
      } catch { /* 容错 */ }
    }
    if (sinceMs !== null && nowMs - sinceMs > AGING_THRESHOLD_MS) {
      const days = Math.round(((nowMs - sinceMs) / 86400_000) * 10) / 10;
      add(`${id}:aging72h:${stage}`, 'warn', true, `${id} 停靠 ${stage} 已 ${days} 天 — 催办`);
    }
  }

  const order = { critical: 0, error: 1, warn: 2, info: 3 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return alerts;
}

/** 批量渲染为一条 Slack 消息。mention 字符串来自 env（如 "<@U123>" / "<!channel>"），未配则省略。 */
export function renderAlerts(alerts, { mention = '' } = {}) {
  const needMention = mention && alerts.some((a) => a.mention);
  const L = [`🔔 loop-conductor 告警（${alerts.length} 条）${needMention ? ` ${mention}` : ''}`];
  for (const a of alerts) {
    L.push(`${SEVERITY_ICON[a.severity] ?? '•'} [${a.severity}] ${a.text}`);
  }
  return L.join('\n');
}

export function loadCursor(p) {
  return readJsonIf(p) ?? { seen: {} };
}

export function saveCursor(p, cursor, deliveredAlerts, nowMs = Date.now()) {
  const seen = { ...(cursor.seen ?? {}) };
  for (const a of deliveredAlerts) seen[a.key] = new Date(nowMs).toISOString();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({ schema_version: 1, seen }, null, 2)}\n`);
  return { seen };
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--cursor', '--channel'].includes(args[i - 1]));
  const root = positional[0]
    ? path.resolve(positional[0])
    : (process.env.CONDUCTOR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const cursorPath = flag('--cursor') ?? path.join(root, 'state', 'alerts-cursor.json');

  const cursor = loadCursor(cursorPath);
  const alerts = scanAlerts(root, cursor);
  if (!alerts.length) {
    process.stdout.write('无新告警\n');
    process.exit(0);
  }
  const env = loadSlackEnv(root);
  const text = renderAlerts(alerts, { mention: process.env.SLACK_ALERT_MENTION ?? '' });

  if (args.includes('--dry-run')) {
    process.stdout.write(`--- dry-run（未发送、cursor 未写）---\n${text}\n`);
    process.exit(0);
  }
  const webhook = process.env.SLACK_WEBHOOK_URL ?? null;
  const res = webhook
    ? await sendSlackWebhook({ url: webhook, text })
    : await sendSlackMessage({ token: env.token, channel: flag('--channel') ?? env.channel, text });
  if (res.ok) {
    saveCursor(cursorPath, cursor, alerts);
    process.stdout.write(`已发送 ${alerts.length} 条告警；cursor 已推进（${cursorPath}）\n`);
  } else {
    process.stderr.write(`发送失败（cursor 未推进，下次扫描重试）：${res.error}\n`);
    process.exit(1);
  }
}
