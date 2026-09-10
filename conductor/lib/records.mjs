// lib/records.mjs — 记录合成与渲染：router 与 dashboard 读到的唯一「发生过什么」视图。
//
// 一条记录 = 内核的 spawn 记录（`<role>[-P-xxx]-r<n>.json`，含 cost / truncated / package /
// mode / head_sha / base_sha）+ agent 自己写的执行 log（`…-r<n>.log.json`）合成体。内核**从不
// 修改 agent 写的 log**（Invariant 3）：盖章发生在读取时，不落回文件。
//
// 缺失或非法不是异常路径，只是记录里的一个字段：
//   product: "ok"      —— log 在盘上且过 validateLog
//   product: "missing" —— 没写（撞 max-turns 之类）
//   product: "invalid" —— JSON 非法或不合 schema，product_error 附校验错误
// 三种都原样交给 router，内核不推断 outcome、不自动重派。
//
// composeRecords 只读不写（AC-009：合成过程不写任何文件）。

import fs from 'node:fs';
import path from 'node:path';
import { validateLog } from './log-contract.mjs';

/** 内核派出的 spawn 记录文件名：`<base>[-P-xxx]-r<n>.json`。 */
const SPAWN_FILE_RE = /^(router|spec-plan|spec|maker|reviewer)(?:-(P-\d{3}))?-r(\d+)\.json$/;
const PRECOMMIT_FILE_RE = /^precommit-r(\d+)\.json$/;
const HUMAN_FILE_RE = /^human-r(\d+)\.json$/;

/** 渲染时的角色列序（同轮内先 spec/human 再 maker，最后 reviewer/precommit，与 few-shot 例子一致）。 */
const ROLE_ORDER = { router: 0, spec: 1, human: 2, maker: 3, reviewer: 4, precommit: 5 };

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function mtimeIso(p) {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

/** spawn 记录 → 派出角色与模式。`spec-plan` 是方案模式的 spec-agent（role 仍是 spec）。 */
function roleOfBase(base) {
  return base === 'spec-plan' ? 'spec' : base;
}

function durationOf(rec) {
  if (Number.isFinite(rec?.duration_ms)) return rec.duration_ms;
  if (Number.isFinite(rec?.raw?.duration_ms)) return rec.raw.duration_ms;
  if (rec?.started && rec?.done) {
    const ms = Date.parse(rec.done) - Date.parse(rec.started);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 撞 max-turns：内核盖章优先，缺省时从 CLI result 事件的 subtype 推。 */
function truncatedOf(rec) {
  if (typeof rec?.truncated === 'boolean') return rec.truncated;
  return rec?.raw?.subtype === 'error_max_turns';
}

/**
 * 一条 agent 记录：spawn 事实（内核）+ log 契约字段（agent）。
 * product ≠ ok 时契约字段一律 null——不合契约的 log 不携带契约级语义（版本规则、tier 下界、
 * 动作闭集都读这些字段，绝不能被一份非法 log 蒙混）；summary 仍按原样带出，供 router 读。
 */
function composeAgentRecord(dir, fileName, base, pkg, round, planActive) {
  const role = roleOfBase(base);
  const spawn = readJsonIf(path.join(dir, fileName)) ?? {};
  const logName = fileName.replace(/\.json$/, '.log.json');
  const logPath = path.join(dir, logName);
  const exists = fs.existsSync(logPath);

  let product = 'ok';
  let productError = null;
  let log = null;
  if (!exists) {
    product = 'missing';
  } else {
    let raw = null;
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { raw = null; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      product = 'invalid';
      productError = [`log 不是合法 JSON：${e.message}`];
    }
    if (product === 'ok') {
      log = parsed; // summary 一律带出（哪怕不合契约，router 也该看见 agent 说了什么）
      const check = validateLog(parsed, role, { planActive });
      if (!check.ok) { product = 'invalid'; productError = check.errors; }
    }
  }

  return {
    round,
    role,
    package: spawn.package ?? pkg ?? null,
    mode: spawn.mode ?? (base === 'spec-plan' ? 'plan' : null),
    product,
    product_error: productError,
    outcome: product === 'ok' ? log.outcome : null,
    tier: product === 'ok' ? (log.tier ?? null) : null,
    action: product === 'ok' ? (log.action ?? null) : null,
    packages: product === 'ok' ? (log.packages ?? null) : null,
    head_sha: spawn.head_sha ?? null,
    base_sha: spawn.base_sha ?? null,
    summary: typeof log?.summary === 'string' ? log.summary : null,
    cost_usd: Number.isFinite(spawn.cost_usd) ? spawn.cost_usd : 0,
    truncated: truncatedOf(spawn),
    duration_ms: durationOf(spawn),
    session_id: spawn.session_id ?? null,
    written_at: exists ? mtimeIso(logPath) : null,
  };
}

/** precommit 没有 agent：内核跑完三步自己合成同构的一条，用 role="precommit" 走同一契约。 */
function composePrecommitRecord(dir, fileName, round) {
  const obj = readJsonIf(path.join(dir, fileName));
  if (obj == null) {
    return {
      round, role: 'precommit', package: null, mode: null,
      product: 'invalid', product_error: ['precommit 记录不是合法 JSON'],
      outcome: null, tier: null, action: null, packages: null,
      head_sha: null, base_sha: null, summary: null,
      cost_usd: 0, truncated: false, duration_ms: null, session_id: null,
      written_at: mtimeIso(path.join(dir, fileName)),
    };
  }
  const check = validateLog(obj, 'precommit');
  return {
    round,
    role: 'precommit',
    package: null,
    mode: null,
    product: check.ok ? 'ok' : 'invalid',
    product_error: check.ok ? null : check.errors,
    outcome: check.ok ? obj.outcome : null,
    tier: check.ok ? obj.tier : null,
    action: null,
    packages: null,
    head_sha: obj.head_sha ?? null,
    base_sha: obj.base_sha ?? null,
    summary: typeof obj.summary === 'string' ? obj.summary : null,
    cost_usd: 0,
    truncated: false,
    duration_ms: Number.isFinite(obj.duration_ms) ? obj.duration_ms : null,
    session_id: null,
    steps: Array.isArray(obj.steps) ? obj.steps : null,
    conflict_files: Array.isArray(obj.conflict_files) ? obj.conflict_files : null,
    written_at: mtimeIso(path.join(dir, fileName)),
  };
}

/** 人的裁决也进记录列表（AC-012）：kind / decision / notes 原文 / no_packages。 */
function composeHumanRecord(dir, fileName, round) {
  const obj = readJsonIf(path.join(dir, fileName)) ?? {};
  return {
    round,
    role: 'human',
    kind: obj.kind ?? null,
    requested_by: obj.requested_by ?? null,
    decision: obj.decision ?? null,
    notes: obj.notes ?? null,
    no_packages: obj.no_packages === true,
    summary: typeof obj.summary === 'string' ? obj.summary : null,
    refs: Array.isArray(obj.refs) ? obj.refs : [],
    written_at: obj.decided_at ?? obj.requested_at ?? mtimeIso(path.join(dir, fileName)),
  };
}

function sortKey(rec) {
  return [rec.round ?? 0, ROLE_ORDER[rec.role] ?? 9, rec.written_at ?? '', rec.package ?? ''];
}

/**
 * 合成一个任务的全部记录（按轮次 → 角色序 → 时间排序）。
 * planActive 影响 router log 的 packages 规则（无方案任务出现 packages 即 invalid）。
 */
export function composeRecords(cfg, id, { planActive = false } = {}) {
  const dir = path.join(cfg.dossierDir, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const records = [];
  for (const name of names.sort()) {
    const spawn = name.match(SPAWN_FILE_RE);
    if (spawn) {
      records.push(composeAgentRecord(dir, name, spawn[1], spawn[2] ?? null, Number(spawn[3]), planActive));
      continue;
    }
    const pre = name.match(PRECOMMIT_FILE_RE);
    if (pre) { records.push(composePrecommitRecord(dir, name, Number(pre[1]))); continue; }
    const human = name.match(HUMAN_FILE_RE);
    if (human) records.push(composeHumanRecord(dir, name, Number(human[1])));
  }

  records.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return records;
}

// ---- 渲染（router prompt 与 dashboard 共用） ----

const LABEL_WIDTH = 18;

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 6 ? sha.slice(0, 6) : (sha ?? null);
}

function money(n) {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function labelOf(rec) {
  const base = `r${rec.round} ${rec.role}${rec.package ? ` ${rec.package}` : ''}`;
  return base.length >= LABEL_WIDTH ? `${base} ` : base.padEnd(LABEL_WIDTH, ' ');
}

function agentFields(rec) {
  const fields = [`outcome=${rec.outcome ?? '-'}`];
  if (rec.tier) fields.push(`tier=${rec.tier}`);
  if (rec.action) fields.push(`action=${rec.action}`);
  if (rec.packages?.length) fields.push(`packages=${rec.packages.join(',')}`);
  if (rec.head_sha) fields.push(`head=${shortSha(rec.head_sha)}`);
  if (rec.base_sha) fields.push(`base=${shortSha(rec.base_sha)}`);
  fields.push(`cost=${money(rec.cost_usd)}`);
  fields.push(`truncated=${rec.truncated ? 'yes' : 'no'}`);
  fields.push(`product=${rec.product}`);
  if (rec.product_error?.length) fields.push(`product_error=${rec.product_error.join('; ')}`);
  return fields.join('  ');
}

function humanFields(rec) {
  const fields = [`kind=${rec.kind ?? '-'}`, `decision=${rec.decision ?? 'pending'}`];
  if (rec.no_packages) fields.push('no_packages=yes');
  fields.push(`notes=${JSON.stringify(rec.notes ?? '')}`);
  return fields.join('  ');
}

/**
 * 记录列表 → router prompt 的紧凑文本：一条两行（人的裁决只有一行）。
 * summary 的换行整体缩进 3 空格，reviewer 的逐条 AC 判决因此仍逐行可读。
 */
export function renderRecordsForRouter(records) {
  const lines = [];
  for (const rec of records ?? []) {
    if (rec.role === 'human') {
      lines.push(`${labelOf(rec)}${humanFields(rec)}`);
      continue;
    }
    lines.push(`${labelOf(rec)}${agentFields(rec)}`);
    if (rec.summary) {
      for (const l of String(rec.summary).split('\n')) lines.push(`   ${l}`);
    }
  }
  return lines.join('\n');
}

/**
 * 工作包状态表（P2b 填内容；P1 只保证接口存在）。
 * rows = [{ id, title, acs, deps, files, state, integrated_sha, rounds, cost_usd, note }]
 */
export function renderPackageStatusTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return rows.map((r) => [
    r.id,
    r.title ?? '',
    `acs=${(r.acs ?? []).join(',') || '-'}`,
    `deps=${(r.deps ?? []).join(',') || '-'}`,
    `files=${(r.files ?? []).join(',') || '-'}`,
    `state=${r.state}${r.integrated_sha ? `@${shortSha(r.integrated_sha)}` : ''}`,
    `rounds=${r.rounds ?? 0}`,
    `cost=${money(r.cost_usd)}`,
    `note=${r.note ?? '-'}`,
  ].join('  ')).join('\n');
}

/** 每条 AC 的主责包（Q13：恰一个）；P2b 填内容。 */
export function renderAcOwners(acOwners) {
  const entries = Object.entries(acOwners ?? {});
  if (entries.length === 0) return '';
  return entries.map(([ac, pkg]) => `${ac} → ${pkg}`).join('；');
}

/** 已裁决事项：每条 human 记录的 kind / decision / notes 原文（Invariant 7 的执法依据）。 */
export function renderDecisions(records) {
  const humans = (records ?? []).filter((r) => r.role === 'human' && r.decision);
  if (humans.length === 0) return '';
  return humans
    .map((r) => `- r${r.round} kind=${r.kind ?? '-'} decision=${r.decision} notes=${JSON.stringify(r.notes ?? '')}`)
    .join('\n');
}

/**
 * 内核事实段（单独渲染，不混进记录）。router 不必自己推导版本规则——两个布尔量与两个 sha
 * 直接给它。空段一律省略，不给 router 制造噪音。
 */
export function renderFacts({
  stage = null,
  round = null,
  head = null,
  base = null,
  needReview = null,
  needPrecommit = null,
  hasDiff = null,
  lastActionRejected = null,
  rateLimit = null,
  spentUsd = null,
  budgetUsd = null,
  records = [],
  packageRows = [],
  acOwners = {},
} = {}) {
  const lines = [];
  if (stage) lines.push(`stage=${stage}${round == null ? '' : `  round=r${round}`}`);
  lines.push(`H=${shortSha(head) ?? '(无任务分支)'}  B=${shortSha(base) ?? '(未知)'}`);
  lines.push(`need_review=${needReview === true}  need_precommit=${needPrecommit === true}`);
  if (hasDiff != null) lines.push(`任务分支相对 base 有 diff：${hasDiff ? 'yes' : 'no'}`);
  if (lastActionRejected) lines.push(`最近一次 action_rejected：${lastActionRejected}`);
  if (rateLimit) {
    const iso = Number.isFinite(rateLimit.resets_at) ? new Date(rateLimit.resets_at * 1000).toISOString() : 'unknown';
    lines.push(`限额：${rateLimit.type ?? 'unknown'}，重置于 ${iso}`);
  }
  if (spentUsd != null || budgetUsd != null) {
    lines.push(`预算：已花 ${money(spentUsd)} / 上限 ${budgetUsd == null ? '(无)' : money(budgetUsd)}`);
  }

  const decisions = renderDecisions(records);
  if (decisions) lines.push('', '已裁决事项（同一事项不得再次 human）：', decisions);

  const table = renderPackageStatusTable(packageRows);
  if (table) lines.push('', '工作包状态表：', table);
  const owners = renderAcOwners(acOwners);
  if (owners) lines.push('', `AC 主责包：${owners}`);

  return lines.join('\n');
}
