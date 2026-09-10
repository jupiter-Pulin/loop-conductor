// stages/router-kernel.mjs — 新状态机（ROUTING / AWAIT_HUMAN / 四个动作）共用的内核面。
//
// 边界：这里只做「内核该做的事」——spawn、记事实、开人闸、清理产物。判断留给 router，
// 副作用与终止权留在内核（Invariant 1）。任何函数都不解析 spec 正文、不读 diff 内容做决定。
//
// 与旧 stages/shared.mjs 的关系：spawn 留档（startSpawnRecord / finishSpawnRecord）、成本入账
// （accountSpawnCost）、限额收箱（rateLimitedToBox）、预算闸（budgetExceeded）都直接复用，
// 不另起一套；本文件只补新状态机独有的东西。

import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { git, removeWorktree, deleteBranch } from '../lib/git.mjs';
import { runClaudeWithRetry } from '../lib/claude.mjs';
import { buildAgentSpawnSpec, writeAgentSettings } from '../lib/agent-settings.mjs';
import { checkFuse } from '../lib/fuse.mjs';
import { accountSpawnCost, canStartSpawn, failToBox, finishSpawnRecord, startSpawnRecord } from './shared.mjs';

/**
 * 任务级配置解析：task.json 快照的 targetRepo 覆盖全局 cfg.targetRepo，使同一次 drain 中
 * 面向不同仓库的任务各自命中自己的 target repo。不改 cfg 本体；task.json 无该字段时
 * 原样返回 cfg（旧任务的回退行为）。
 */
export function taskCfg(ts, cfg) {
  const targetRepo = ts?.task?.targetRepo ?? cfg.targetRepo;
  return targetRepo === cfg.targetRepo ? cfg : { ...cfg, targetRepo };
}

/** 任务分支名（唯一构造点）。 */
export function taskBranchName(id) {
  return `task/${id}`;
}

/** rev-parse，解析不出（分支还不存在）返回 null——「还没有任务分支」是合法事实，不是错误。 */
export function revParseOrNull(repo, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', ref], repo);
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

/** 任务分支相对 base 是否有非空 diff（`review` 动作的前置事实）。分支不存在恒为 false。 */
export function taskHasDiff(repo, base, branch) {
  if (revParseOrNull(repo, branch) == null) return false;
  const r = git(['diff', '--name-only', `${base}...${branch}`], repo);
  if (r.status !== 0) return false;
  return r.stdout.trim() !== '';
}

// ---- router-state.json：内核为 ROUTING 维护的少量私有状态 ----
//
// 为什么不进 runtime.json：spec 逐字列了 runtime 的字段集合（AC-001 的断言面），
// 失效连击计数与保险丝复位轮次不在其中。它们是「本任务的路由现场」，与案卷同寿命，
// 因此落在 dossier 里，和 packages-status.json 同一档。事件流是观测面，绝不拿来做决策。

export const ROUTER_STATE_FILE = 'router-state.json';

const EMPTY_ROUTER_STATE = Object.freeze({
  schema_version: 1,
  failures: [], // 连续失效原因（router product≠ok 或动作被拒），成功决策清零
  last_action_rejected: null, // 最近一次被拒原因，渲染进下一轮事实段
  fuse_reset_round: 0, // 人 retry 后的复位轮次，checkFuse 的 sinceRound
});

export function readRouterState(cfg, id) {
  const obj = state.readJsonIf(state.dossierPath(cfg, id, ROUTER_STATE_FILE));
  return {
    ...EMPTY_ROUTER_STATE,
    ...(obj ?? {}),
    failures: Array.isArray(obj?.failures) ? obj.failures : [],
  };
}

export function writeRouterState(cfg, id, patch) {
  const next = { ...readRouterState(cfg, id), ...patch };
  state.writeJson(state.dossierPath(cfg, id, ROUTER_STATE_FILE), next);
  return next;
}

// ---- 人闸 ----

export function humanRecordPath(cfg, id, round) {
  return state.dossierPath(cfg, id, `human-r${round}.json`);
}

/** dossier 内的路径 → 相对 conductor root 的展示路径（human-r<n>.json 的 refs 用这一种）。 */
export function relRef(cfg, absPath) {
  return path.relative(cfg.root, absPath);
}

/**
 * 开一道人闸（AC-012）：先落产物（human-r<n>.json），再落 runtime.awaiting，最后转 stage。
 * kind ∈ {spec, merge, help}；requestedBy ∈ {kernel, router}。handler 本身不推进，等 CLI 裁决。
 */
export function openHumanGate(ts, cfg, { kind, requestedBy = 'kernel', summary, refs = [], round }) {
  const id = ts.id;
  state.writeJson(humanRecordPath(cfg, id, round), {
    schema_version: 1,
    kind,
    requested_by: requestedBy,
    summary,
    refs,
    requested_at: new Date().toISOString(),
  });
  state.appendEventAlways(cfg, id, 'human_gate_opened', { round, kind, requested_by: requestedBy, summary });
  state.transitionState(ts, cfg, 'AWAIT_HUMAN', `${kind} 闸（${requestedBy}）`, {
    awaiting: { kind, round },
  });
  return { changed: true };
}

// ---- spawn ----

/** spawn 被 run 级闸门拦下：调用方据此原地返回，绝不把它当成一次「跑过的 spawn」。 */
export function spawnSkipped(res) {
  return res?.skipped === true;
}

/**
 * 派一个 agent 并留档。返回 lib/claude.mjs 的原始结果（限额/失败都原样交回调用方判断）。
 * 落盘顺序：settings → started 标记 → spawn → done 标记 + 成本入账 + runtime 落盘。
 * 内核绝不改 agent 写的 log；log 的读取一律走 lib/records.mjs。
 *
 * **run 级闸门在这里复查**（AC-021）：`canStartSpawn` 是本次 run 的限额 / runBudget 总闸。
 * ROUTING 只在派 router 前查过一次，而动作侧（maker / reviewer / spec）的 spawn 发生在那之后
 * ——`maxConcurrentTasks > 1` 时任务 A 命中限额，同一轮里任务 B 的动作 spawn 仍会发出去，
 * 违反「本次 run 内不再发起任何新 spawn」。闸门是全体 spawn 的唯一入口，复查也就放在这里。
 * 被拦时零副作用：不写 settings、不留 spawn 记录、不入账、不改 stage，只由 canStartSpawn
 * 记一行 `<role> spawn skipped: …`，调用方返回 changed:false 让本任务本轮停住。
 */
export async function spawnAgentRound(ts, cfg, {
  role,
  round,
  mode = null,
  pkg = null,
  prompt,
  cwd = null,
  planActive = false,
  packagesEnabled = false,
  extraRecord = {},
}) {
  const id = ts.id;
  const opts = { mode, pkg, planActive, packagesEnabled };
  const spec = buildAgentSpawnSpec(cfg, id, role, round, opts); // 纯函数：拿 log 名给闸门用
  const base = path.basename(spec.logPath).replace(/-r\d+\.log\.json$/, '');
  if (!canStartSpawn(ts, cfg, base)) return { ok: false, skipped: true, costUsd: 0, error: 'spawn_blocked' };
  writeAgentSettings(cfg, id, role, round, opts);
  const streamFile = state.dossierPath(cfg, id, `${base}-r${round}.stream.jsonl`);
  const rec = startSpawnRecord(cfg, id, base, round, {
    role,
    mode,
    package: pkg,
    stream_file: path.relative(cfg.root, streamFile),
    ...extraRecord,
  });
  const res = await runClaudeWithRetry({
    cwd: cwd ?? spec.cwd,
    prompt,
    maxTurns: spec.maxTurns,
    model: cfg.models?.[role] ?? null,
    tools: spec.tools,
    allowedTools: spec.allowedTools,
    permissionMode: spec.permissionMode,
    settings: spec.settingsPath,
    streamFile,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    wallClockMs: cfg.spawnWallClockMs,
  }, {
    retries: cfg.spawnRetries,
    backoffMs: cfg.spawnBackoffMs,
    onRetry: ({ attempt, status }) =>
      state.appendTimeline(cfg, id, `${base} r${round} transient retry attempt ${attempt} (status=${status ?? 'spawn-error'})`),
  });
  finishSpawnRecord(rec, res);
  accountSpawnCost(ts, cfg, base, round, res);
  state.saveRuntime(ts); // 成本先落盘：spawn 花的钱不因后续分支而丢账
  if (!res.ok) {
    // 基建失败不是异常路径：log 缺失会以 product: "missing" 出现在记录里，交 router 判断，
    // 内核不自动重派（契约第三条）。这里只留一行人读的归因。
    state.appendTimeline(cfg, id, `${base} r${round} spawn 未正常结束（${res.error ?? 'unknown'}），交由记录与 router 处置`);
  }
  return res;
}

// ---- 保险丝与预算 ----

/**
 * 每次产生新记录（maker / reviewer / precommit）后跑一次（AC-024）。
 * 触发 → 事件 + FAILED_BOX(fuse_no_progress)，返回 handler 结果；未触发返回 null。
 */
export function checkFuseAndBox(ts, cfg, records) {
  const st = readRouterState(cfg, ts.id);
  const tripped = checkFuse(records, cfg.fuseStreak, { sinceRound: st.fuse_reset_round ?? 0 });
  if (!tripped) return null;
  state.appendEventAlways(cfg, ts.id, 'fuse_tripped', {
    role: tripped.role, package: tripped.package, signature: tripped.signature,
  });
  return failToBox(
    ts, cfg,
    `保险丝：${tripped.role}${tripped.package ? ` ${tripped.package}` : ''} 连续 ${cfg.fuseStreak} 条记录签名相同（${tripped.signature}），停止`,
    'fuse_no_progress',
  );
}

/** 预算闸（每次 spawn 前）：超出 → 事件 + FAILED_BOX(budget_exhausted)，返回结果；否则 null。 */
export function checkBudgetAndBox(ts, cfg) {
  const spent = ts.runtime.spent_usd ?? 0;
  if (!(spent >= cfg.budgetUsd)) return null;
  state.appendEventAlways(cfg, ts.id, 'budget_exhausted', { spent_usd: spent, budget_usd: cfg.budgetUsd });
  return failToBox(ts, cfg, `budget exhausted: $${spent} >= $${cfg.budgetUsd}，拒绝 spawn`, 'budget_exhausted');
}

// ---- 契约面读取 ----

export function briefPath(ts) {
  return path.join(ts.dir, 'brief.md');
}

export function readBriefText(ts) {
  try { return fs.readFileSync(briefPath(ts), 'utf8'); } catch { return ''; }
}

export function specDraftPath(cfg, id) {
  return path.join(cfg.specsDir, `${id}.md`);
}

export function frozenSpecPath(cfg, id) {
  return state.dossierPath(cfg, id, 'spec.md');
}

export function packagesDraftPath(cfg, id) {
  return path.join(cfg.specsDir, `${id}.packages.json`);
}

/** spec 草稿归档（批准冻结后、或人审打回后腾出草稿位）：移进 specs/archive/，绝不删。 */
export function archiveSpecDraft(cfg, id, label = 'archived') {
  const draft = specDraftPath(cfg, id);
  if (!fs.existsSync(draft)) return null;
  const archived = path.join(cfg.specsDir, 'archive', `${id}-${label}-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(draft, archived);
  return archived;
}

/** 本任务是否曾产出过 spec（草稿或冻结稿）——`maker` 前置「曾产出 spec 则必须已批准」的判据。 */
export function everProducedSpec(cfg, id) {
  return fs.existsSync(specDraftPath(cfg, id)) || fs.existsSync(frozenSpecPath(cfg, id));
}

export function readFrozenSpec(cfg, id) {
  try { return fs.readFileSync(frozenSpecPath(cfg, id), 'utf8'); } catch { return ''; }
}

/** spec 闸 human 记录的 notes 原文 → 「人审补充约束」段（逐字注入 maker / reviewer / plan）。 */
export function specGateNotes(records) {
  return (records ?? [])
    .filter((r) => r.role === 'human' && r.kind === 'spec' && typeof r.notes === 'string' && r.notes.trim() !== '')
    .map((r) => r.notes.trim())
    .join('\n');
}

/** spec 闸被打回时的 notes（喂回 spec-agent 的「人审打回意见」段）。 */
export function specRejectNotes(records) {
  return (records ?? [])
    .filter((r) => r.role === 'human' && r.kind === 'spec' && r.decision === 'rejected'
      && typeof r.notes === 'string' && r.notes.trim() !== '')
    .map((r) => `- ${r.notes.trim()}`)
    .join('\n');
}

/** 既有 help 闸的 summary 全集（Invariant 7 的逐字比对面）。 */
export function helpSummaries(cfg, id) {
  const dir = state.dossierPath(cfg, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^human-r\d+\.json$/.test(n)) continue;
    const obj = state.readJsonIf(path.join(dir, n));
    if (obj?.kind === 'help' && typeof obj.summary === 'string') out.push(obj.summary);
  }
  return out;
}

// ---- 产物清理（AC-045） ----

/**
 * 任务 → DONE 或 abandon 时清干净：任务/包 worktree、只读 worktree、候选 worktree，
 * 以及任务分支与全部包分支。FAILED_BOX 的其他去向一律不清（人还要 retry）。
 * 全程 best-effort：清理失败不改变任务去向，只留一行 timeline。
 */
export function cleanupTaskArtifacts(ts, cfg, { deleteTaskBranch = true, force = false } = {}) {
  const id = ts.id;
  const repo = taskCfg(ts, cfg).targetRepo;
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(cfg.worktreesDir); } catch { /* 目录可能还不存在 */ }
  const mine = names.filter((n) => n === id || n.startsWith(`${id}--`) || n.startsWith(`${id}.`));
  for (const n of mine) {
    const p = path.join(cfg.worktreesDir, n);
    try {
      removeWorktree(repo, p);
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(n);
    } catch { /* 清不掉不影响任务去向 */ }
  }
  const branches = [];
  const r = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${taskBranchName(id)}*`], repo);
  if (r.status === 0) {
    for (const b of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (b === taskBranchName(id) && !deleteTaskBranch) continue;
      deleteBranch(repo, b, { force });
      branches.push(b);
    }
  }
  if (removed.length > 0 || branches.length > 0) {
    state.appendTimeline(cfg, id, `清理：worktree ${removed.join(', ') || '(无)'}；分支 ${branches.join(', ') || '(无)'}`);
  }
  return { worktrees: removed, branches };
}
