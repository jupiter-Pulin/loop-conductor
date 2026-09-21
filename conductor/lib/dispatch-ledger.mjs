// lib/dispatch-ledger.mjs — 委派台账（`dossier/<id>/dispatch-r<n>.json`）：一次 dispatch 的预写日志。
//
// 内核在**派出任何 agent 之前**先把这一轮绑定好的委派原子落盘，之后每过一个关键边界就重写一次：
//   bound → running → finished → committed → integrated | conflict | stale | skipped
// runner 在任何一步崩溃，重启后都能从台账 + spawn 记录 + git 的实际状态判断：哪些已经发生、
// 哪些没发生、哪些需要核对（lib/recovery.mjs）。恢复依据是这些持久记录，不是上一段进程的内存。
//
// 台账是内核事实，不是 router 的计划：router 的计划在它自己的 router-notes.json 里，可以随时改；
// 台账只记「内核实际授权并执行了什么、结果绑定在哪个版本上」。
//
// 每个委派在派出时绑定三样版本：`base_head`（当时的任务分支 HEAD）、`spec_sha`（当时的获批 spec
// 版本）、所属 dispatch 轮次。结果回来时 spec 版本已经变了 → 标 stale：分支与报告保留作诊断，
// 不集成进任务分支，也不作为当前版本的依据。

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './state.mjs';

const LEDGER_RE = /^dispatch-r(\d+)\.json$/;

/** 终态：这些状态的委派不再需要恢复流程处理。 */
export const TERMINAL_STATES = Object.freeze(['integrated', 'conflict', 'stale', 'skipped', 'done']);

export function ledgerPath(cfg, id, round) {
  return path.join(cfg.dossierDir, id, `dispatch-r${round}.json`);
}

export function readLedger(cfg, id, round) {
  try { return JSON.parse(fs.readFileSync(ledgerPath(cfg, id, round), 'utf8')); } catch { return null; }
}

export function writeLedger(cfg, id, ledger) {
  ledger.updated_at = new Date().toISOString();
  writeJsonAtomic(ledgerPath(cfg, id, ledger.round), ledger);
  return ledger;
}

export function listLedgers(cfg, id) {
  const dir = path.join(cfg.dossierDir, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => n.match(LEDGER_RE))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((round) => readLedger(cfg, id, round))
    .filter(Boolean);
}

/** 没有正常收尾的 dispatch（runner 在派出与收尾之间崩溃）。 */
export function openLedgers(cfg, id) {
  return listLedgers(cfg, id).filter((l) => l.closed !== true);
}

export function newLedger({ round, baseHead, specSha, assignments }) {
  return {
    schema_version: 1,
    round,
    base_head: baseHead ?? null,
    spec_sha: specSha ?? null,
    created_at: new Date().toISOString(),
    closed: false,
    closed_at: null,
    recovered: false,
    assignments,
  };
}

/**
 * 每个 key 最近一次委派的现状（router 事实段与 CLI / 看板共用）。
 * 返回按 key 首次出现顺序排列的 [{ key, dispatch_round, …assignment }]。
 */
export function latestAssignments(ledgers) {
  const byKey = new Map();
  for (const l of ledgers ?? []) {
    for (const a of l.assignments ?? []) {
      byKey.set(a.key, { ...a, dispatch_round: l.round, dispatch_closed: l.closed === true, dispatch_spec_sha: l.spec_sha ?? null });
    }
  }
  return [...byKey.values()];
}

function lastSpawn(a) {
  const spawns = Array.isArray(a.spawns) ? a.spawns : [];
  return spawns.length > 0 ? spawns[spawns.length - 1] : null;
}

/**
 * 能不能续接上一次会话：最后一次 spawn 被轮次上限截断或被中断，且留下了 session_id。
 * （能续 ≠ 必须续：router 也可以缩小任务或换人重派。）
 */
export function resumableSpawn(a) {
  const s = lastSpawn(a);
  if (!s || !s.session_id) return null;
  if (s.outcome === 'ok') return null; // 写下 ok 之后才撞上限：已经做完了，没什么可续的
  return s.truncated === true || s.interrupted === true ? s : null;
}

/** 台账 → router 事实段的「委派台账」表：一行一个 key。 */
export function renderAssignmentTable(ledgers, { currentSpecSha = null } = {}) {
  const rows = latestAssignments(ledgers);
  if (rows.length === 0) return '';
  return rows.map((a) => {
    const s = lastSpawn(a);
    const fields = [
      a.key,
      `「${a.title ?? ''}」`,
      `profile=${a.profile}`,
      `intent=${a.intent}`,
      `state=${a.state}`,
      `dispatched=r${a.dispatch_round}`,
    ];
    if (s) {
      fields.push(`last=r${s.round}`, `outcome=${s.outcome ?? '未知(无合格 log)'}`);
      if (s.truncated) fields.push('truncated=yes');
      if (s.interrupted) fields.push('interrupted=yes');
    }
    const resumable = resumableSpawn(a);
    if (resumable) fields.push(`可续接=continue_from:${resumable.round}`);
    if (a.integrated_sha) fields.push(`integrated@${String(a.integrated_sha).slice(0, 6)}`);
    if (a.conflict_files?.length) fields.push(`conflict_files=${a.conflict_files.join(',')}`);
    if (a.out_of_scope_files?.length) fields.push(`声明 paths 之外的改动=${a.out_of_scope_files.slice(0, 8).join(',')}`);
    if (a.dispatch_spec_sha && currentSpecSha && a.dispatch_spec_sha !== currentSpecSha) fields.push('spec 版本已过期');
    if (a.note) fields.push(`note=${a.note}`);
    return fields.join('  ');
  }).join('\n');
}
