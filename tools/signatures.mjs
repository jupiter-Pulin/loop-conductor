#!/usr/bin/env node
// tools/signatures.mjs — 失败签名台账与三次规则（传感层，fable-loop E26/H31）。
// 生命周期：open →(distinct 出现 ≥3)→ proposal_due →(人/loop 关联修复 E#)→ resolved；
//           open/proposal_due 静默 28 天 → closed；closed 后再现 → reopened（升级信号）。
// 唯一写入方 = weekly-report（--signatures 时调用 updateSignatures）；本模块自身不发不推。
// 幂等：occurrence 用稳定 key（task:round:细粒度）去重——全库重扫多少次计数都不变。
// 提案防通胀：每 ISO 周最多向人提 2 条（emit 不足额的下周再排，计数不丢）。
import fs from 'node:fs';
import path from 'node:path';
import { collectStats } from './dossier-stats.mjs';

const PROPOSAL_THRESHOLD = 3;
const CLOSE_AFTER_MS = 28 * 86400_000;
const WEEKLY_PROPOSAL_CAP = 2;

/** 签名族 → 提案路由（四类：guard=conductor 机械守卫 H / addendum=弱模型规范条目 / skill / profile）。 */
export const SIGNATURE_ROUTES = {
  'maker:error_max_turns': 'guard',
  'maker:cold_degraded': 'guard',
  'committer:degraded': 'addendum',
  'verifier:invalid': 'addendum',
  'testgate:vacuous': 'addendum',
  'shadow:disagreement': 'guard',
  'anchors:hard': 'guard',
  'guard:existing_test_change': 'guard', // E27：既有测试被改（reward hacking 可见性信号）
  'failed:': 'guard', // 前缀族：failed:budget_exceeded / failed:spawn_failed / …
};

export function routeOf(sig) {
  if (SIGNATURE_ROUTES[sig]) return SIGNATURE_ROUTES[sig];
  for (const [prefix, route] of Object.entries(SIGNATURE_ROUTES)) {
    if (prefix.endsWith(':') && sig.startsWith(prefix)) return route;
  }
  return 'guard';
}

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 全库机械提取签名出现（不做窗口过滤——幂等 key 保证重扫不重计）。
 * 每条：{ sig, key }。key 粒度 = 该现象的最小可区分单位（task / task:round / task:round:ac）。
 */
export function extractOccurrences(root) {
  const { tasks } = collectStats(root);
  const occs = [];

  for (const t of tasks) {
    if (t.box === 'failed') {
      occs.push({ sig: `failed:${t.last_failure_type ?? 'unknown'}`, key: t.id });
    }
    for (const r of t.maker_rounds) {
      if (r.subtype === 'error_max_turns') occs.push({ sig: 'maker:error_max_turns', key: `${t.id}:r${r.round}` });
      if (r.mode === 'cold-degraded' || r.resume_failed) occs.push({ sig: 'maker:cold_degraded', key: `${t.id}:r${r.round}` });
    }
    if (t.committer_degraded) occs.push({ sig: 'committer:degraded', key: t.id });
    for (let n = 1; n <= t.verifier_invalid_files; n++) {
      occs.push({ sig: 'verifier:invalid', key: `${t.id}:invalid${n}` });
    }
    for (const g of t.test_gates) {
      if (g.verdict === 'vacuous') occs.push({ sig: 'testgate:vacuous', key: `${t.id}:r${g.round}` });
    }

    // dossier 文件级：shadow 分歧 + evidence anchors 硬错误
    const dDir = path.join(root, 'dossier', t.id);
    let entries = [];
    try {
      entries = fs.readdirSync(dDir);
    } catch { /* dossier 缺失容错 */ }
    for (const name of entries.sort()) {
      let m;
      if ((m = name.match(/^verify-r(\d+)\.shadow-compare\.json$/))) {
        const ag = readJsonIf(path.join(dDir, name))?.agreement;
        for (const d of ag?.disagreements ?? []) {
          occs.push({ sig: 'shadow:disagreement', key: `${t.id}:r${m[1]}:${d.ac_id}` });
        }
      } else if ((m = name.match(/^verify-r(\d+)\.evidence-anchors\.json$/))) {
        const a = readJsonIf(path.join(dDir, name));
        const hardN = a?.hard_count ?? (Array.isArray(a?.hard) ? a.hard.length : 0);
        for (let i = 1; i <= hardN; i++) {
          occs.push({ sig: 'anchors:hard', key: `${t.id}:r${m[1]}:h${i}` });
        }
      } else if ((m = name.match(/^verify-r(\d+)\.test-change-guard\.json$/))) {
        occs.push({ sig: 'guard:existing_test_change', key: `${t.id}:r${m[1]}` });
      }
    }
  }
  return occs;
}

/** ISO 周键（提案配额的记账单位），如 '2026-W28'。 */
export function isoWeekKey(ms) {
  const d = new Date(ms);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow); // 周四所在年份决定 ISO 年
  const jan1 = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - jan1) / 86400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function emptyLedger() {
  return { schema_version: 1, updated_at: null, signatures: {}, proposals_emitted: [] };
}

/**
 * 纯函数：占有 → 状态机推进。返回 { ledger, added, newly_due, reopened, closed }。
 * resolves = { '<sig>': 'E25' } 人工/loop 关联修复（唯一的非自动转移）。
 */
export function updateLedger(ledger, occurrences, { nowMs, resolves = {} } = {}) {
  const L = structuredClone(ledger ?? emptyLedger());
  const nowIso = new Date(nowMs).toISOString();
  const week = isoWeekKey(nowMs);
  const added = [];
  const reopened = [];

  for (const { sig, key } of occurrences) {
    const e = (L.signatures[sig] ??= {
      state: 'open', first_seen: nowIso, last_seen: nowIso, count: 0, occurrences: [], route: routeOf(sig),
      resolved_by: null, resolved_at: null,
    });
    if (e.occurrences.includes(key)) continue; // 幂等：见过的 key 不重计
    e.occurrences.push(key);
    e.count = e.occurrences.length;
    e.last_seen = nowIso;
    added.push({ sig, key });
    if (e.state === 'closed' || e.state === 'resolved') {
      e.state = 'reopened'; // 已关/已修后再现 = 升级信号（resolved 再现意味着修复无效）
      reopened.push(sig);
    }
  }

  // 人工关联修复：resolved 是终态（除非再现 → reopened）。
  for (const [sig, eid] of Object.entries(resolves)) {
    const e = L.signatures[sig];
    if (!e) continue;
    e.state = 'resolved';
    e.resolved_by = eid;
    e.resolved_at = nowIso;
  }

  // 三次规则 → proposal_due（每周配额 WEEKLY_PROPOSAL_CAP，超额的留在 open 下周再排）。
  const emittedThisWeek = L.proposals_emitted.filter((p) => p.week === week).length;
  let budget = Math.max(0, WEEKLY_PROPOSAL_CAP - emittedThisWeek);
  const newlyDue = [];
  const eligible = Object.entries(L.signatures)
    .filter(([, e]) => (e.state === 'open' || e.state === 'reopened') && e.count >= PROPOSAL_THRESHOLD)
    .sort((a, b) => b[1].count - a[1].count);
  for (const [sig, e] of eligible) {
    if (budget <= 0) break;
    e.state = 'proposal_due';
    L.proposals_emitted.push({ week, sig, route: e.route, count: e.count });
    newlyDue.push({ sig, route: e.route, count: e.count });
    budget--;
  }

  // 静默关闭：open/proposal_due/reopened 超 28 天无新 occurrence → closed。
  const closed = [];
  for (const [sig, e] of Object.entries(L.signatures)) {
    if (['open', 'proposal_due', 'reopened'].includes(e.state)
      && nowMs - Date.parse(e.last_seen) > CLOSE_AFTER_MS) {
      e.state = 'closed';
      closed.push(sig);
    }
  }

  L.updated_at = nowIso;
  return { ledger: L, added: added.length, newly_due: newlyDue, reopened, closed };
}

/** 读-改-写一站式入口（weekly-report 专用）。返回 updateLedger 的结果摘要。 */
export function updateSignatures(root, ledgerPath, { nowMs = Date.now(), resolves = {} } = {}) {
  const prior = readJsonIf(ledgerPath) ?? emptyLedger();
  const occs = extractOccurrences(root);
  const res = updateLedger(prior, occs, { nowMs, resolves });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(res.ledger, null, 2)}\n`);
  return res;
}

/** 人读摘要行（周报 Markdown / digest 共用）。 */
export function renderSignatureSummary(res) {
  const L = [];
  const due = Object.entries(res.ledger.signatures).filter(([, e]) => e.state === 'proposal_due');
  L.push(`签名台账：本次新增 ${res.added} 次出现；提案到期 ${due.length} 条${res.reopened.length ? `；复发 ${res.reopened.join('、')}` : ''}${res.closed.length ? `；静默关闭 ${res.closed.join('、')}` : ''}`);
  for (const [sig, e] of due) {
    L.push(`  - [${sig}] ×${e.count} → 路由 ${e.route}（skill 草稿/addendum/守卫 H/profile 按路由落地，人批后执行）`);
  }
  for (const { sig } of (res.newly_due ?? [])) {
    if (!due.some(([s]) => s === sig)) L.push(`  - [${sig}] 本次触发三次规则`);
  }
  return L.join('\n');
}
