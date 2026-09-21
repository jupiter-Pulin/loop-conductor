// lib/recovery.mjs — runner 退出（含崩溃、被 SIGKILL）之后的重启恢复。
//
// 恢复只依据两样东西：持久记录（spawn 记录、委派台账、merge-intent、runtime）与实际状态
// （进程是否还活着、worktree 脏不脏、分支是不是已经合进去了）。上一个进程内存里的任何东西都不算数。
//
// 逐任务做四件事（调用方已持有全局 run 锁与该任务的写锁，所以同一时刻不会有第二个 runner 在推进它）：
//   1. 收割残留 agent：spawn 记录有 started 没有 done = 上一个 runner 派出后没等到结果。
//      记录里的 pid 身份（pid + 启动时刻）对得上且还活着 → 它是残留执行者，先杀进程组再继续，
//      绝不让新旧两个执行者同时改同一个 worktree；pid 被复用（身份对不上）→ 原进程早没了，**不杀**。
//      然后把这条记录补记为 interrupted + 成本未知（按既有 unknown 成本策略入账），留 salvage。
//   2. 收尾没关账的 dispatch：已落盘的工作该提交的提交、该集成的集成——每一步都先看 git 事实，
//      已经发生过的不重做（不重复提交、不重复集成）。不重新派出任何 agent：要不要续、怎么续是 router 的事。
//   3. 单 maker 的残留：任务 worktree 里没提交的改动固化成一条恢复提交（否则 diff / review 看不见它）。
//   4. 成本对账：runtime.spent_usd 低于案卷合计就补齐（崩在入账与落盘之间的那一笔）。
// 另有一条独立路径 recoverMergeIntent：merge 批准崩在「已合并、未归档」之间时，认出已合并的事实，
// 补完归档而不是再合一次、也不是把任务误判回 ROUTING。
//
// 每一处恢复都写 timeline 与 `recovered` 事件：人看得到恢复做了什么、哪些是已知、哪些仍未知。

import fs from 'node:fs';
import path from 'node:path';
import * as state from './state.mjs';
import { processState, killProcessGroup } from './proc.mjs';
import { commitIfDirty, ensureWorktree, headOf, isAncestor, isDirty } from './git.mjs';
import { openLedgers, writeLedger } from './dispatch-ledger.mjs';
import { observeStream, writeSalvage } from './salvage.mjs';
import { currentSpec } from './spec-version.mjs';

const SPAWN_RECORD_RE = /^((?:router|spec-plan|spec|maker|reviewer|digest)(?:-P-\d{3})?|worker-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)-r(\d+)\.json$/;

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 案卷里全部「派出过但没收尾」的 spawn 记录。 */
export function unfinishedSpawns(cfg, id) {
  const dir = state.dossierPath(cfg, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(SPAWN_RECORD_RE);
    if (!m) continue;
    const p = path.join(dir, n);
    const rec = readJsonIf(p);
    if (!rec || !rec.started || rec.done) continue;
    out.push({ path: p, base: m[1], round: Number(m[2]), record: rec });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * 收割并补记一条没收尾的 spawn。返回 { base, round, process: 'killed'|'dead'|'reused'|'unknown', killed_ok }。
 * accountUnknown(base, round, rec) 由调用方注入（走 stages/shared.mjs 的既有 unknown 成本策略）。
 */
export async function reapUnfinishedSpawn(cfg, id, item, { accountUnknown = null, graceMs = 10_000 } = {}) {
  const { record, base, round } = item;
  const st = record.pid != null ? processState({ pid: Number(record.pid), pid_started: record.pid_started ?? null }) : 'dead';
  let proc = st;
  let killedOk = null;
  if (st === 'alive') {
    killedOk = await killProcessGroup(Number(record.pid), { graceMs });
    proc = 'killed';
  }
  const streamFile = record.stream_file ? path.resolve(cfg.root, record.stream_file) : state.dossierPath(cfg, id, `${base}-r${round}.stream.jsonl`);
  const observed = observeStream(streamFile);
  record.done = new Date().toISOString();
  record.ok = false;
  record.interrupted = true;
  record.killed = 'runner_crashed';
  record.error = 'runner_crashed';
  record.cost_usd = 0;
  record.cost_unknown = true;
  record.session_id = observed?.session_id ?? record.session_id ?? null;
  record.recovered = { at: new Date().toISOString(), process: proc, killed_ok: killedOk };
  state.writeJson(item.path, record);

  const logPath = state.dossierPath(cfg, id, `${base}-r${round}.log.json`);
  if (!fs.existsSync(logPath)) {
    writeSalvage(state.dossierPath(cfg, id, `${base}-r${round}.salvage.json`), {
      role: record.role ?? base, key: record.key ?? null, round, reason: 'runner_crashed', streamFile,
      known: { process_at_recovery: proc, cwd: record.cwd ?? null },
    });
  }
  if (accountUnknown) accountUnknown(base, round, { path: item.path, record });
  state.appendTimeline(cfg, id, `恢复：${base} r${round} 派出后未收尾（上一个 runner 已退出）；残留进程=${proc}${killedOk === false ? '（未能确认已退出）' : ''}，已补记为 interrupted、成本未知`);
  return { base, round, process: proc, killed_ok: killedOk };
}

/**
 * 逐任务恢复入口。依赖注入避免 lib → stages 的反向依赖：
 *   deps.closeLedger(ctx, {recovered})   —— stages/actions/dispatch.mjs
 *   deps.accountUnknown(ts, base, round, rec)
 *   deps.reconcileSpent(ts, cfg)
 *   deps.taskRepo(ts), deps.taskWorktree(id), deps.taskBranch(id), deps.excludePatterns
 * 返回做过的恢复动作清单（空数组 = 无事发生）。
 */
export async function recoverTask(ts, cfg, deps) {
  const id = ts.id;
  const actions = [];

  // 1. 残留 agent
  const pending = unfinishedSpawns(cfg, id);
  for (const item of pending) {
    const r = await reapUnfinishedSpawn(cfg, id, item, {
      accountUnknown: (base, round, rec) => deps.accountUnknown?.(ts, base, round, rec),
      graceMs: cfg.recoveryKillGraceMs ?? 10_000,
    });
    actions.push({ kind: 'spawn_reaped', ...r });
  }

  const repo = deps.taskRepo(ts);
  const branch = deps.taskBranch(id);
  const mainWtPath = deps.taskWorktree(id);
  const mainWtExists = fs.existsSync(path.join(mainWtPath, '.git'));

  // 2. 没关账的 dispatch
  for (const ledger of openLedgers(cfg, id)) {
    for (const a of ledger.assignments ?? []) {
      for (const s of a.spawns ?? []) {
        if (s.state !== 'running') continue;
        const rec = readJsonIf(state.dossierPath(cfg, id, `worker-${a.key}-r${s.round}.json`));
        Object.assign(s, {
          state: 'done', outcome: null, interrupted: true, truncated: false,
          session_id: rec?.session_id ?? null, progress: null, finished_at: new Date().toISOString(),
        });
        const log = readJsonIf(state.dossierPath(cfg, id, `worker-${a.key}-r${s.round}.log.json`));
        if (log && typeof log.outcome === 'string') s.outcome = log.outcome; // 增量 log 在崩溃前已落盘：照原样带出
      }
      if (a.state === 'bound' && (a.spawns ?? []).length === 0) { a.state = 'skipped'; a.note = 'runner 在派出之前退出，本委派从未开始'; }
      else if (a.state === 'running' || a.state === 'bound') a.state = 'finished';
    }
    writeLedger(cfg, id, ledger);
    const mainWt = mainWtExists ? mainWtPath : ensureWorktree(repo, mainWtPath, branch, deps.excludePatterns ?? [], ts.task.baseBranch);
    const spec = ts.runtime.spec_approved === true ? currentSpec(cfg, ts) : null;
    deps.closeLedger({
      ts, cfg, id, repo, mainWt, baseHead: ledger.base_head, round: ledger.round, ledger,
      currentSpecSha: spec?.sha256 ?? null,
    }, { recovered: true });
    actions.push({ kind: 'dispatch_closed', round: ledger.round, states: ledger.assignments.map((a) => `${a.key}=${a.state}`) });
  }

  // 3. 单 maker 的残留：worktree 里有未提交改动，且最近一次 maker 派出没有正常收尾
  if (mainWtExists && pending.some((p) => p.base === 'maker' || p.base.startsWith('maker-')) && isDirty(mainWtPath)) {
    const makerRound = Math.max(...pending.filter((p) => p.base.startsWith('maker')).map((p) => p.round));
    const sha = commitIfDirty(mainWtPath, `task ${id}: maker r${makerRound} (recovered partial work)`);
    state.appendTimeline(cfg, id, `恢复：maker r${makerRound} 中断前留在 worktree 的改动已固化为提交 ${String(sha).slice(0, 7)}（未完成的部分由 router 决定续做或重派）`);
    actions.push({ kind: 'maker_work_committed', round: makerRound, sha });
  }

  // 4. 成本对账
  const fixed = deps.reconcileSpent?.(ts, cfg);
  if (fixed) actions.push({ kind: 'cost_reconciled', ...fixed });

  if (actions.length > 0) {
    state.saveRuntime(ts);
    state.appendEventAlways(cfg, id, 'recovered', { actions });
  }
  return actions;
}

// ---- merge 批准的崩溃恢复 ----

export function mergeIntentPath(cfg, id) {
  return state.dossierPath(cfg, id, 'merge-intent.json');
}

/** merge 之前预写意图：批准时刻的 H / B、分支、提交信息。 */
export function writeMergeIntent(cfg, id, intent) {
  state.writeJson(mergeIntentPath(cfg, id), { schema_version: 1, started_at: new Date().toISOString(), ...intent });
}

export function clearMergeIntent(cfg, id) {
  fs.rmSync(mergeIntentPath(cfg, id), { force: true });
}

/**
 * 有没有一次「已经合并、但没来得及归档」的 merge：意图在盘上，且当时的任务 HEAD 已经是 base 的祖先。
 * 返回 intent（调用方据此直接补完归档），否则 null。意图在但还没合进去 → 清掉意图、照常重走批准。
 */
export function mergedButNotArchived(cfg, id, repo, baseBranch) {
  const intent = readJsonIf(mergeIntentPath(cfg, id));
  if (!intent || !intent.head_sha) return null;
  const baseNow = headOf(repo, `refs/heads/${baseBranch}`);
  if (baseNow && isAncestor(repo, intent.head_sha, baseNow) && baseNow !== intent.base_sha) return intent;
  return null;
}
