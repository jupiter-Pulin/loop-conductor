// dashboard/rounds.mjs — 纯读 dossier 的轮次聚合层（P3）：把每轮 maker→test gate→verifier→
// green gate 四道门 + repair-context 归并成结构化数据，供 model.mjs::buildTaskDetail 挂到
// /api/task/:id。只用 fs 只读，无 git、无缓存、无写盘；任意输入（缺失/半途/损坏）永不抛错。
import fs from 'node:fs';
import path from 'node:path';
import { dossierPath } from '../lib/state.mjs';
import { composeRecords } from '../lib/records.mjs';

/** 读单个 JSON 文件 → { status:'ok', value } / { status:'absent' } / { status:'corrupt' }。 */
function readJsonSafe(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { status: 'absent' }; }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { status: 'corrupt' };
    return { status: 'ok', value };
  } catch {
    return { status: 'corrupt' };
  }
}

/** stdout_tail 末尾非空行，供 greenGate.summary 用。 */
function tailSummary(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// ---- 单门解析（每个门独立容错，互不连累） ----

function parseMakerDoor(dir, round, committed) {
  const r = readJsonSafe(path.join(dir, `maker-r${round}.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  return {
    status: 'ok',
    ok: v.ok ?? null,
    costUsd: v.cost_usd ?? null,
    turns: v.raw?.num_turns ?? null,
    committed,
  };
}

function parseTestGateDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `test-gate-r${round}.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  return { status: 'ok', verdict: v.verdict ?? null, mode: v.mode ?? null };
}

function parseGreenGateDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `green-gate-r${round}.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  const exitCode = v.exit_code ?? null;
  return { status: 'ok', pass: exitCode === 0, exitCode, summary: tailSummary(v.stdout_tail) };
}

function parseVerifierDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `verify-r${round}.verdict.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  if (!Array.isArray(v.criteria_results)) return { status: 'corrupt' };
  const total = v.criteria_results.length;
  const passCount = v.criteria_results.filter((c) => c?.status === 'pass').length;
  return { status: 'ok', overall: v.overall ?? null, passCount, total };
}

function parseRepairContextDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `repair-context-r${round}.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  return {
    status: 'ok',
    source: v.source ?? null,
    overall: v.overall ?? null,
    instruction: v.instruction ?? null,
    failedCount: Array.isArray(v.failed_criteria) ? v.failed_criteria.length : 0,
  };
}

function parseSpecAgentDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `spec-agent-r${round}.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  return { status: 'ok', ok: v.ok ?? null, costUsd: v.cost_usd ?? null, turns: v.raw?.num_turns ?? null };
}

function parseSpecVerifyDoor(dir, round) {
  const r = readJsonSafe(path.join(dir, `spec-verify-r${round}.verdict.json`));
  if (r.status !== 'ok') return { status: r.status };
  const v = r.value;
  return { status: 'ok', overall: v.overall ?? null };
}

function parseSpecCheckDoor(dir, round) {
  const primary = readJsonSafe(path.join(dir, `spec-check-r${round}.json`));
  const record = primary.status === 'absent' ? readJsonSafe(path.join(dir, `spec-check-r${round}.hook.json`)) : primary;
  if (record.status !== 'ok') return { status: record.status };
  const v = record.value;
  return { status: 'ok', ok: v.ok ?? null, errors: Array.isArray(v.errors) ? v.errors.length : 0 };
}

// ---- 轮号枚举（联合全部门类文件名里的轮号，覆盖「某门缺失但其它门存在」的半途轮） ----

const MAKER_ROUND_PATTERNS = [
  /^maker-r(\d+)\.json$/,
  /^test-gate-r(\d+)\.json$/,
  /^green-gate-r(\d+)\.json$/,
  /^verify-r(\d+)\.verdict\.json$/,
  /^repair-context-r(\d+)\.json$/,
];

const SPEC_ROUND_PATTERNS = [
  /^spec-agent-r(\d+)\.json$/,
  /^spec-verify-r(\d+)\.verdict\.json$/,
  /^spec-check-r(\d+)\.json$/,
  /^spec-check-r(\d+)\.hook\.json$/,
];

function listRoundNumbers(dir, patterns) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const set = new Set();
  for (const name of names) {
    for (const re of patterns) {
      const m = name.match(re);
      if (m) set.add(Number(m[1]));
    }
  }
  return [...set].sort((a, b) => a - b);
}

function buildRoundsForDir(dir) {
  return listRoundNumbers(dir, MAKER_ROUND_PATTERNS).map((round) => {
    const committed = fs.existsSync(path.join(dir, `green-gate-r${round}.json`));
    return {
      round,
      maker: parseMakerDoor(dir, round, committed),
      testGate: parseTestGateDoor(dir, round),
      greenGate: parseGreenGateDoor(dir, round),
      verifier: parseVerifierDoor(dir, round),
      repairContext: parseRepairContextDoor(dir, round),
    };
  });
}

function buildSpecRoundsForDir(dir) {
  return listRoundNumbers(dir, SPEC_ROUND_PATTERNS).map((round) => ({
    round,
    specAgent: parseSpecAgentDoor(dir, round),
    specVerify: parseSpecVerifyDoor(dir, round),
    specCheck: parseSpecCheckDoor(dir, round),
  }));
}

function buildAttemptsGroups(dossierDir) {
  const attemptsDir = path.join(dossierDir, 'attempts');
  let entries = [];
  try { entries = fs.readdirSync(attemptsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((stamp) => {
      const dir = path.join(attemptsDir, stamp);
      return { stamp, rounds: buildRoundsForDir(dir), specRounds: buildSpecRoundsForDir(dir) };
    });
}

// ---- 新状态机的轮次：router 轮次 + 该轮产生的记录（唯一来源是 lib/records.mjs） ----
//
// 旧任务的 `maker-r<n>.json` 与新契约同名但没有 `.log.json`，合成出来只会是一串
// product=missing 的噪音；因此只有案卷里真有 router 轮次的任务才走这条线（AC-029）。

const ROUTER_SPAWN_RE = /^router-r\d+\.json$/;

function hasRouterRounds(dossierDir) {
  try {
    return fs.readdirSync(dossierDir).some((n) => ROUTER_SPAWN_RE.test(n));
  } catch {
    return false;
  }
}

/**
 * 记录列表 → 按 router 轮次分组：`{ round, router, agents[], precommit, human }`。
 * 一轮里 router 先决策，随后是它派出的角色与人的裁决——渲染与统计都读这一个形状。
 */
export function groupRecordsByRound(records) {
  const byRound = new Map();
  for (const rec of records ?? []) {
    const round = rec.round ?? 0;
    if (!byRound.has(round)) byRound.set(round, { round, router: null, agents: [], precommit: null, human: null });
    const slot = byRound.get(round);
    if (rec.role === 'router') slot.router = rec;
    else if (rec.role === 'precommit') slot.precommit = rec;
    else if (rec.role === 'human') slot.human = rec;
    else slot.agents.push(rec);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/**
 * 任务 dossier → { rounds, specRounds, attempts, routerRounds, records }（契约见 spec.md §Contract）。
 * `records` / `routerRounds` 只对新状态机任务非空；旧任务保持原有三个字段的口径不变。
 * 全程容错：任意输入（缺失/半途/损坏 JSON）永不抛错，最坏退化为空数组。
 */
export function buildRoundsView(cfg, id) {
  try {
    const dossierDir = dossierPath(cfg, id);
    // 一个任务只属于一个纪元：新案卷里的 `maker-r<n>.json` 是新契约的 spawn 记录，
    // 不是旧的 maker 门产物——拿旧四门解析它只会得到一堆假的「半途轮」，还会污染良率盘。
    const isRouter = hasRouterRounds(dossierDir);
    const records = isRouter ? composeRecords(cfg, id) : [];
    return {
      rounds: isRouter ? [] : buildRoundsForDir(dossierDir),
      specRounds: isRouter ? [] : buildSpecRoundsForDir(dossierDir),
      attempts: buildAttemptsGroups(dossierDir),
      records,
      routerRounds: groupRecordsByRound(records),
    };
  } catch {
    return { rounds: [], specRounds: [], attempts: [], records: [], routerRounds: [] };
  }
}
