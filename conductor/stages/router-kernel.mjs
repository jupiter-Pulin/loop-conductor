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
import { buildAgentSpawnSpec, isExecSpawn, writeAgentSettings } from '../lib/agent-settings.mjs';
import { checkFuse } from '../lib/fuse.mjs';
import { pidStartTime } from '../lib/proc.mjs';
import { currentSpec } from '../lib/spec-version.mjs';
import { reviewCoverage } from '../lib/review-ledger.mjs';
import { stopRequested } from '../lib/run-session.mjs';
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
  progress: null, // 停滞保险丝：上一轮的硬进展指纹 + 连续无进展轮数（checkStallAndBox）
  notes_error: null, // 上一轮工作记忆写坏了的原因（已还原），渲染进下一轮事实段
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
 * 分配一个新的轮次号并立刻落盘。轮次号是案卷文件名的一部分（`<base>-r<n>.*`），先落盘再派出
 * 才能保证：spawn 中途崩溃、自动续接、并行 worker 各自续接，都不会覆盖任何一轮的案卷。
 * 单线程事件循环里这是原子的（读-加-写之间没有 await）。
 */
export function allocateRound(ts) {
  const round = (ts.runtime.current_round ?? 0) + 1;
  ts.runtime.current_round = round;
  state.saveRuntime(ts);
  return round;
}

/**
 * OS 沙盒参数（宿主运行时保证的那一层）。只对有执行能力的派出生效，且只在 cfg.workerSandbox.enabled
 * 时打开。沙盒管的是 **Bash**：可写范围 = cwd 与系统临时目录（CLI 默认）+ 人在配置里点名的工具链缓存目录。
 * 整个案卷目录、spec、state、内核代码与配置一律显式 denyWrite——受控真实执行里核对过：denyWrite 优先，
 * 即使目标落在默认可写的临时目录里也写不进去。agent 的 log / report 走的是 Write 工具（不经沙盒，
 * 由 `Edit(//绝对路径)` 权限规则精确放行），所以把整个案卷对 Bash 封死不影响交付。
 */
export function sandboxFor(cfg, id, { logPath, reportPath = null }) {
  const sb = cfg.workerSandbox;
  if (!sb || sb.enabled !== true) return null;
  void logPath; void reportPath; // 交付文件不需要、也不应该对 Bash 放行
  return {
    enabled: true,
    allowWrite: [...(Array.isArray(sb.allowWrite) ? sb.allowWrite : [])],
    denyWrite: [
      cfg.dossierDir, cfg.specsDir, cfg.stateDir, path.join(cfg.root, 'conductor'), path.join(cfg.root, 'agents'),
      path.join(cfg.root, 'conductor.config.json'), cfg.targetProfilesDir,
    ],
    denyRead: Array.isArray(sb.denyRead) ? sb.denyRead : [],
    allowedDomains: Array.isArray(sb.allowedDomains) ? sb.allowedDomains : [],
  };
}

/** 全进程的并发 spawn 上限（多个任务 × 每任务多个并行 worker 共用一组槽位）。 */
async function acquireSpawnSlot(cfg) {
  const max = Number.isInteger(cfg.maxConcurrentSpawns) && cfg.maxConcurrentSpawns > 0 ? cfg.maxConcurrentSpawns : Infinity;
  cfg.__spawnSlots ??= { active: 0, waiters: [] };
  const slots = cfg.__spawnSlots;
  if (slots.active >= max) await new Promise((resolve) => slots.waiters.push(resolve));
  slots.active += 1;
  return () => {
    slots.active -= 1;
    const next = slots.waiters.shift();
    if (next) next();
  };
}

/**
 * 派一个 agent 并留档。返回 lib/claude.mjs 的原始结果（限额/失败都原样交回调用方判断）。
 * 落盘顺序：settings → started 标记（含 pid 身份，供崩溃恢复收割）→ spawn → done 标记 + 成本入账
 * + runtime 落盘。内核绝不改 agent 写的 log；log 的读取一律走 lib/records.mjs。
 *
 * **run 级闸门在这里复查**（AC-021）：`canStartSpawn` 是本次 run 的限额 / runBudget 总闸，
 * 也是停止请求的总闸。ROUTING 只在派 router 前查过一次，而动作侧的 spawn（maker / reviewer /
 * spec / digest / 每一个 worker 及其自动续接）都发生在那之后——闸门是全体 spawn 的唯一入口，
 * 复查也就放在这里：新角色、重试、续跑、子委派没有一个能绕过。
 * 被拦时零副作用：不写 settings、不留 spawn 记录、不入账、不改 stage。
 *
 * resume：续接一个已有会话（`claude -r <session_id>`）。续不上（session 失效）时返回
 * `resumeFailed: true`，由调用方降级为带进度上下文的冷启动——两次的花费都已入账。
 */
export async function spawnAgentRound(ts, cfg, {
  role,
  round,
  mode = null,
  pkg = null,
  key = null,
  profile = null,
  prompt,
  cwd = null,
  resume = null,
  planActive = false,
  packagesEnabled = false,
  readRoots = [],
  digest = null,
  extraRecord = {},
}) {
  const id = ts.id;
  const baseOpts = { mode, pkg, key, profile, planActive, packagesEnabled, readRoots, digest };
  const probe = buildAgentSpawnSpec(cfg, id, role, round, baseOpts); // 纯函数：拿 log 名给闸门用
  const base = path.basename(probe.logPath).replace(/-r\d+\.log\.json$/, '');
  if (stopRequested(cfg)) {
    state.appendTimeline(cfg, id, `${base} spawn skipped: 收到停止请求`);
    return { ok: false, skipped: true, costUsd: 0, error: 'stop_requested' };
  }
  if (!canStartSpawn(ts, cfg, base)) return { ok: false, skipped: true, costUsd: 0, error: 'spawn_blocked' };
  const sandbox = isExecSpawn(role, profile) ? sandboxFor(cfg, id, { logPath: probe.logPath, reportPath: probe.reportPath }) : null;
  const opts = { ...baseOpts, sandbox };
  const spec = buildAgentSpawnSpec(cfg, id, role, round, opts);
  const release = await acquireSpawnSlot(cfg);
  try {
    writeAgentSettings(cfg, id, role, round, opts);
    const streamFile = state.dossierPath(cfg, id, `${base}-r${round}.stream.jsonl`);
    const rec = startSpawnRecord(cfg, id, base, round, {
      role,
      mode,
      package: pkg,
      key,
      profile,
      isolation: spec.isolation,
      model: cfg.models?.[role] ?? null,
      max_turns: spec.maxTurns,
      cwd: cwd ?? spec.cwd,
      resume_session: resume,
      stream_file: path.relative(cfg.root, streamFile),
      ...extraRecord,
    });
    const res = await runClaudeWithRetry({
      cwd: cwd ?? spec.cwd,
      prompt,
      resume,
      maxTurns: spec.maxTurns,
      model: cfg.models?.[role] ?? null,
      tools: spec.tools,
      allowedTools: spec.allowedTools,
      permissionMode: spec.permissionMode,
      settings: spec.settingsPath,
      streamFile,
      inactivityTimeoutMs: cfg.inactivityTimeoutMs,
      wallClockMs: cfg.spawnWallClockMs,
      onSpawn: ({ pid }) => {
        rec.record.pid = pid;
        rec.record.pid_started = pidStartTime(pid);
        state.writeJson(rec.path, rec.record);
      },
    }, {
      retries: cfg.spawnRetries,
      backoffMs: cfg.spawnBackoffMs,
      onRetry: ({ attempt, status }) =>
        state.appendTimeline(cfg, id, `${base} r${round} transient retry attempt ${attempt} (status=${status ?? 'spawn-error'})`),
    });
    if (res.killed === 'stopped') rec.record.interrupted = true;
    finishSpawnRecord(rec, res);
    accountSpawnCost(ts, cfg, base, round, res, rec);
    state.saveRuntime(ts); // 成本先落盘：spawn 花的钱不因后续分支而丢账
    if (!res.ok) {
      // 基建失败不是异常路径：log 缺失会以 product: "missing" 出现在记录里，交 router 判断。
      state.appendTimeline(cfg, id, `${base} r${round} spawn 未正常结束（${res.killed ? `killed=${res.killed}` : (res.error ?? 'unknown')}），交由记录与 router 处置`);
    }
    return res;
  } finally {
    release();
  }
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

/**
 * 停滞保险丝：数「硬进展」，不数轮数，也不看任务叫什么名字、摘要怎么写。
 * 硬进展指纹 = 任务分支的 tree（代码真的变了）+ 当前版本的 review 覆盖（多判了几条 / fail 变了）
 *            + 最近一次 precommit 的结论 + 人的裁决条数 + 获批 spec 版本。
 * 每个 ROUTING 轮开头算一次：和上一轮一样 → 连续无进展 +1；不一样 → 清零。连续
 * `fuseStallRounds` 轮（默认 8，0 = 关）没有任何硬进展 → FAILED_BOX(fuse_no_progress)。
 * 于是：一个 40 轮、每轮都在推进的大任务不会被误杀；而反复派同一件事、给委派换个 key、
 * 让 worker 改写一遍报告，都改变不了指纹，拖不过这根保险丝。调查 / 实验只产出报告、不改指纹，
 * 所以纯调研最多连续这么多轮——够把未知查清楚，不够无限打转。人 retry 后从零重新数。
 */
export function checkStallAndBox(ts, cfg, fingerprint) {
  const limit = Number.isInteger(cfg.fuseStallRounds) ? cfg.fuseStallRounds : 8;
  const st = readRouterState(cfg, ts.id);
  const prev = st.progress ?? null;
  const same = prev != null && prev.fingerprint === fingerprint;
  const stall = same ? (prev.stall_rounds ?? 0) + 1 : 0;
  writeRouterState(cfg, ts.id, { progress: { fingerprint, stall_rounds: stall } });
  if (!(limit > 0) || stall < limit) return { boxed: null, stall };
  state.appendEventAlways(cfg, ts.id, 'fuse_tripped', { role: 'task', package: null, signature: `stall|${stall}` });
  writeRouterState(cfg, ts.id, { progress: null });
  return {
    boxed: failToBox(
      ts, cfg,
      `保险丝：连续 ${stall} 轮没有任何硬进展（代码 tree、review 覆盖、precommit 结论、人的裁决、spec 版本都没变），停止`,
      'fuse_no_progress',
    ),
    stall,
  };
}

/** 整任务的轮次硬上限：单次执行有上限，整个任务也有。达到即收箱，人调高 maxRoundsPerTask 后 retry。 */
export function checkRoundCapAndBox(ts, cfg) {
  const cap = Number.isInteger(cfg.maxRoundsPerTask) && cfg.maxRoundsPerTask > 0 ? cfg.maxRoundsPerTask : null;
  if (cap == null || (ts.runtime.current_round ?? 0) < cap) return null;
  state.appendEventAlways(cfg, ts.id, 'round_cap_reached', { current_round: ts.runtime.current_round, max_rounds: cap });
  return failToBox(ts, cfg, `轮次上限：已用 ${ts.runtime.current_round} 轮 >= maxRoundsPerTask=${cap}，停止`, 'round_cap');
}

/** 预算闸（每次 spawn 前）：超出 → 事件 + FAILED_BOX(budget_exhausted)，返回结果；否则 null。 */
export function checkBudgetAndBox(ts, cfg) {
  const spent = ts.runtime.spent_usd ?? 0;
  if (!(spent >= cfg.budgetUsd)) return null;
  state.appendEventAlways(cfg, ts.id, 'budget_exhausted', { spent_usd: spent, budget_usd: cfg.budgetUsd });
  return failToBox(ts, cfg, `budget exhausted: $${spent} >= $${cfg.budgetUsd}，拒绝 spawn`, 'budget_exhausted');
}

// ---- 整体 review 的版本状态 ----

/**
 * 当前 (H, 获批 spec 版本) 上的 review 状态，三处共用（ROUTING 事实段 / 动作前置 / merge 批准复算）。
 * 无 spec 的任务 coverage 为 undefined（版本门走旧口径）；有 spec 但冻结稿读不到 → coverage=null
 * （版本门按「没有任何有效 review」处理，绝不放行）。
 */
export function reviewStateFor(ts, cfg, records, head) {
  if (ts.runtime?.spec_approved !== true) return { coverage: undefined, acIds: [], spec: null };
  const spec = currentSpec(cfg, ts);
  if (!spec) return { coverage: null, acIds: [], spec: null };
  const acIds = state.enumerateAcceptanceCriteria(spec.text).map((a) => a.ac_id);
  const coverage = reviewCoverage({ dossierDir: state.dossierPath(cfg, ts.id), records, head, specSha: spec.sha256, acIds });
  return { coverage, acIds, spec };
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

/**
 * 本任务是否曾产出过 spec（草稿、冻结稿或归档稿）——`maker` 前置「曾产出 spec 则必须已批准」
 * 的判据。归档稿也算：spec 闸打回会把草稿移进 `specs/archive/`，但「这个任务是有 spec 的」
 * 这件事没有变，否则打回一次就能让 router 绕开 spec 人闸直接派 maker。
 */
export function everProducedSpec(cfg, id) {
  if (fs.existsSync(specDraftPath(cfg, id)) || fs.existsSync(frozenSpecPath(cfg, id))) return true;
  try {
    return fs.readdirSync(path.join(cfg.specsDir, 'archive')).some((n) => n.startsWith(`${id}-`));
  } catch { return false; } // archive 目录还不存在
}

export function readFrozenSpec(cfg, id) {
  try { return fs.readFileSync(frozenSpecPath(cfg, id), 'utf8'); } catch { return ''; }
}

/**
 * spec 闸**批准**时的 notes 原文 → 「人审补充约束」段（逐字注入 maker / reviewer / plan）。
 * 只取 `decision=approved`：打回时的 notes 是给 spec-agent 的改写指令（已由 specRejectNotes
 * 注入 spec prompt），对 maker / reviewer 不是约束，混进去只会让它们照着一份已经作废的意见干活。
 */
export function specGateNotes(records) {
  return (records ?? [])
    .filter((r) => r.role === 'human' && r.kind === 'spec' && r.decision === 'approved'
      && typeof r.notes === 'string' && r.notes.trim() !== '')
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
  const failedBranches = [];
  const r = git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${taskBranchName(id)}*`], repo);
  if (r.status === 0) {
    for (const b of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (b === taskBranchName(id) && !deleteTaskBranch) continue;
      // 只列真删掉的：被别处 checkout 着的分支 `git branch -D` 会拒，报成「已清理」等于骗人
      // ——下一个任务撞上同名分支时，人手上唯一的线索就是这行 timeline。
      if (deleteBranch(repo, b, { force }).ok) branches.push(b);
      else failedBranches.push(b);
    }
  }
  if (removed.length > 0 || branches.length > 0 || failedBranches.length > 0) {
    state.appendTimeline(cfg, id, `清理：worktree ${removed.join(', ') || '(无)'}；分支 ${branches.join(', ') || '(无)'}`);
    for (const b of failedBranches) state.appendTimeline(cfg, id, `branch delete failed: ${b}`);
  }
  return { worktrees: removed, branches, failed_branches: failedBranches };
}
