#!/usr/bin/env node
// conductor.mjs — CLI 入口 + drain 循环。确定性、可重入、幂等：conductor 是脚本，不是 agent。
// 子命令：run / new / approve / reject / resume / abandon / retry / status / spy。
// 人只在两道闸出现（spec 与 merge），外加 router 或内核发起的 help；其余去向一律由 router 决定。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as state from './lib/state.mjs';
import { acquireLock, releaseLock, lockDirPath, STALE_MS, startLockHeartbeat } from './lib/lock.mjs';
import { runScheduler, initRunBudget } from './lib/scheduler.mjs';
import { withTaskLock, TaskLockBusyError } from './lib/task-lock.mjs';
import { currentBranch, mergeBranch } from './lib/git.mjs';
import { validateSpecDoc } from './lib/spec-contract.mjs';
import { composeRecords } from './lib/records.mjs';
import { needPrecommit, needReview } from './lib/version-gate.mjs';
import { collectModelIds, probeModels } from './lib/model-probe.mjs';
import { PRECOMMIT_PROFILE_SAMPLE, setupProfilePaths, validatePrecommitProfile } from './lib/profile.mjs';
import { DEFAULT_MAX_TURNS } from './lib/agent-settings.mjs';
import { STAGES } from './stages/decisions.mjs';
import routingHandler from './stages/routing.mjs';
import awaitHumanHandler from './stages/await_human.mjs';
import {
  archiveSpecDraft, cleanupTaskArtifacts, humanRecordPath, revParseOrNull, specDraftPath,
  taskBranchName, taskCfg, writeRouterState,
} from './stages/router-kernel.mjs';

/**
 * 状态机只有两个可推进的 stage：ROUTING 每轮问一次 router，AWAIT_HUMAN 停着等 CLI。
 * FAILED_BOX / DONE 是终态，没有 handler——它们只响应人的 retry。
 * queue 里出现遗留 stage 名（P3 之前建的任务）时 scheduler 打印「未知 stage，跳过」并放过，
 * 不抛错（AC-001）：旧任务只保留可读性，不再被这台机器推进。
 */
const STAGE_HANDLERS = {
  ROUTING: routingHandler,
  AWAIT_HUMAN: awaitHumanHandler,
  FAILED_BOX: async () => ({ changed: false }),
};

// ---- 配置与路径 ----

export function resolveRoot() {
  if (process.env.CONDUCTOR_ROOT) return path.resolve(process.env.CONDUCTOR_ROOT);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 四角色的默认模型（spec §角色、工具、hook、模型：默认沿用现配置，四角色均 claude-opus-5）。 */
export const DEFAULT_ROLE_MODEL = 'claude-opus-5';

/** 新状态机认识的模型键；其余（setup / feasibility / specVerifier / verifier / committer）是遗留键。 */
export const ROLE_MODEL_KEYS = Object.freeze(['router', 'spec', 'maker', 'reviewer']);

/**
 * spec §config 的删除清单（AC-027）：这些键已随旧状态机一并消失，读到只警告不生效。
 * 每个**人在配置文件里显式给了的**遗留键各打印一次警告；没给的键不警告——
 * 默认值不是「人的配置」，对它们喊话只是噪音。
 */
export const LEGACY_CONFIG_KEYS = Object.freeze([
  'specMaxAcs',
  'autoApproveSpecEnabled', 'autoApproveSpecMaxAcs',
  'autoMergeEnabled', 'autoMergeKinds', 'autoMergeMaxDiffLines', 'autoMergeMaxAcs', 'autoMergeDeniedPaths',
  'testGateEnabled', 'testGateTestGlobs', 'testGateProbeConcurrency',
  'testChangeGuardEnabled',
  'verifierShadowEnabled', 'verifierShadowBackend', 'verifierShadowModel', 'verifierShadowTimeoutMs',
  'verifierEvidenceAnchorsMode',
  'reviewStage',
  'crashAutoRecoveryLimit',
  'feasibilityEnabled',
  'specChainIsolationEnabled',
]);

/** models 里的遗留角色键（旧 stage 仍读，新状态机不看）。 */
export const LEGACY_MODEL_KEYS = Object.freeze(['setup', 'feasibility', 'specVerifier', 'verifier', 'committer']);

function warnLegacyKey(key) {
  console.error(`[conductor] legacy config key ignored: ${key}`);
}

/**
 * `maxTurns` 归一（AC-027）：形态是 `{router, spec, plan, maker, reviewer}`。
 * 配置给的是数字 → 视为 legacy 标量：警告一次并赋给 `maker`（其余角色用默认值），
 * 而不是把四个角色一起压到同一个数字。
 */
export function normalizeMaxTurns(configured) {
  if (Number.isFinite(configured)) {
    warnLegacyKey(`maxTurns（标量 ${configured} 视为 maker 上限；新形态是 { router, spec, plan, maker, reviewer }）`);
    return { ...DEFAULT_MAX_TURNS, maker: configured };
  }
  const obj = configured != null && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  return { ...DEFAULT_MAX_TURNS, ...obj };
}

/** `models` 归一（AC-027）：四角色键缺省回落 claude-opus-5；遗留角色键各警告一次并忽略。 */
export function normalizeModels(defaults, userModels) {
  const models = { ...defaults, ...(userModels ?? {}) };
  for (const key of ROLE_MODEL_KEYS) {
    if (typeof models[key] !== 'string' || models[key].trim() === '') models[key] = DEFAULT_ROLE_MODEL;
  }
  for (const key of LEGACY_MODEL_KEYS) {
    if (Object.hasOwn(userModels ?? {}, key)) warnLegacyKey(`models.${key}`);
    delete models[key]; // 遗留角色不存在了，别让它出现在模型探测清单里
  }
  return models;
}

export function loadCfg(root = resolveRoot()) {
  const defaults = {
    budgetUsd: 5,
    testCommand: 'node --test',
    targetRepo: './target',
    baseBranch: null, // null = new 时读 currentBranch(targetRepo) 兜底 'main'
    greenGateOutputTailBytes: 12000, // precommit 每步 stdout/stderr tail 字节上限
    greenGateTimeoutMs: 1800000, // 单条命令的墙钟上限（precommit 各步默认沿用它）
    verifierDiffMaxBytes: 200000, // reviewer prompt 内嵌 diff 的字节上限，超限降级为 name-status 清单
    eventsLogEnabled: false, // 观测面：给 transitionState 的 stage 事件加个开关；router 纪元的事实事件恒写
    unknownSpawnCostEstimateEnabled: false, // killed/无 result spawn 按角色 dossier 历史均价估计入账（标 estimated，独立累计 runtime.estimated_cost_usd；无样本退回 lower-bound）
    spawnRetries: 6, // Claude 瞬态重试次数
    spawnBackoffMs: [15000, 30000, 60000], // 瞬态重试退避三档；五小时/周限额走零重试收箱路径，不靠长尾退避硬穿
    maxConcurrentTasks: 3,
    inactivityTimeoutMs: 600000,
    spawnWallClockMs: 14400000,
    precommitStepTimeoutMs: null, // precommit 单步墙钟上限；null = 取 greenGateTimeoutMs（spec §config）
    precommitLockTimeoutMs: 1800000, // 等 state/.precommit.lock 的上限，超时记 lock_timeout（AC-050）
    lockHeartbeatMs: 60000,
    maxStepsPerTask: 20,
    fuseStreak: 3, // 保险丝（AC-024）：同一 (role, package) 连续 N 条记录签名相同即收箱；0=关
    maxParallelPackages: 2, // 一个任务同轮最多并行几个工作包（P2b 才用得上）
    maxPackages: 12, // 一份方案最多几个包（validatePackages 的上限）
    packagesEnabled: false, // 阶段闸：P2b 前恒关——plan 动作被拒、spec prompt 无工作包段、router 的 packages 字段即非法
    runBudgetUsd: null,
    models: { router: null, spec: null, maker: null, reviewer: null },
  };
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(root, 'conductor.config.json'), 'utf8'));
  } catch { /* 配置缺失时用默认值 */ }
  const deprecatedMaxDrainStepsConfigured = Object.hasOwn(user, 'maxDrainSteps');
  for (const key of LEGACY_CONFIG_KEYS) {
    if (Object.hasOwn(user, key)) warnLegacyKey(key);
  }
  const merged = {
    ...defaults,
    ...user,
    maxTurns: normalizeMaxTurns(user.maxTurns),
    models: normalizeModels(defaults.models, user.models),
  };
  for (const key of LEGACY_CONFIG_KEYS) delete merged[key]; // 读得到、警告过，但绝不进 cfg
  delete merged.maxDrainSteps;
  return {
    ...merged,
    // 缺省即「与绿门同一量级」：precommit 的每一步都是跑真命令，没有理由比绿门更短。
    precommitStepTimeoutMs: merged.precommitStepTimeoutMs ?? merged.greenGateTimeoutMs,
    deprecatedMaxDrainStepsConfigured,
    root,
    targetRepo: path.resolve(root, merged.targetRepo),
    stateDir: path.join(root, 'state'),
    queueDir: path.join(root, 'state', 'queue'),
    doneDir: path.join(root, 'state', 'done'),
    failedDir: path.join(root, 'state', 'failed'),
    parkedDir: path.join(root, 'state', 'parked'),
    specsDir: path.join(root, 'specs'),
    dossierDir: path.join(root, 'dossier'),
    worktreesDir: path.join(root, 'worktrees'),
    targetProfilesDir: path.join(root, 'target-profiles'),
    agentsDir: path.join(root, 'agents'),
  };
}

function ensureDirs(cfg) {
  for (const d of [cfg.queueDir, cfg.doneDir, cfg.failedDir, cfg.specsDir, cfg.dossierDir, cfg.worktreesDir, cfg.targetProfilesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 三箱遍历入参（box 名 + 目录）。 */
const BOXES = (cfg) => [['queue', cfg.queueDir], ['failed', cfg.failedDir], ['done', cfg.doneDir]];

/** 按 id 找任务目录 → TaskState（含 box）。找不到/损坏返回 null（损坏附 error）。 */
function findTask(cfg, id) {
  for (const [box, dir] of BOXES(cfg)) {
    const taskDir = path.join(dir, id);
    if (fs.existsSync(path.join(taskDir, 'task.json'))) {
      try { return state.readTaskState(taskDir, box); } catch (e) {
        return { box, dir: taskDir, id, error: e.message };
      }
    }
  }
  return null;
}

/** 检测旧 .md 任务布局，非空则清晰告警（绝不静默当新任务）。返回是否发现旧任务。 */
function warnLegacyTasks(cfg) {
  let found = false;
  for (const [box, dir] of BOXES(cfg)) {
    const legacy = state.findLegacyTaskFiles(dir);
    if (legacy.length > 0) {
      found = true;
      console.error(
        `[conductor] 检测到旧布局 .md 任务（${box}）：${legacy.map((p) => path.relative(cfg.root, p)).join(', ')}。` +
        '本期只支持任务目录布局，旧任务被跳过（不当新任务处理）。请删除或手动迁移。',
      );
    }
  }
  return found;
}

// ---- run：drain 循环 ----

/**
 * 模型可用性探测（AC-052）。全部可用（或没有可探的 id）→ true；否则打印原因并令本次 run
 * 在处理任何任务前终止，任务状态零变化。缓存命中不再探测（键 = 模型 id + claude 二进制版本）。
 */
async function ensureModelsAvailable(cfg) {
  if (collectModelIds(cfg.models).length === 0) return true;
  const probe = await probeModels({ cfg });
  if (probe.ok) return true;
  if (probe.rateLimited) {
    const resets = probe.rateLimited.resets_at;
    console.error(
      `[conductor] 模型探测撞限额（${probe.rateLimited.type ?? 'unknown'}），本次 run 终止，任务状态未变。`
      + (Number.isFinite(resets) ? `重置时刻：${formatLocalTime(resets)}` : '重置时刻未知'),
    );
  }
  for (const u of probe.unavailable) {
    console.error(`[conductor] 模型不可用：${u.model} —— ${u.error}`);
  }
  if (probe.unavailable.length > 0) {
    console.error('[conductor] 本次 run 终止，任务状态未变。请修正 conductor.config.json 的 models 后重试。');
  }
  process.exitCode = 1;
  return false;
}

async function cmdRun(cfg) {
  const lock = acquireLock(cfg.stateDir, {
    onSelfHeal: (info) => {
      console.error(`[conductor] 检测到锁 pid=${info?.pid ?? '?'} 已不存活，已自动清除残锁并重新获锁。`);
    },
  });
  if (!lock.acquired) {
    if (lock.stale) {
      console.error(
        `[conductor] 警告：锁 ${lockDirPath(cfg.stateDir)} 已超过 ${STALE_MS / 60000} 分钟未更新（stale）。` +
        '确认没有 conductor 在跑后手动删除该目录。',
      );
    }
    console.error(
      `[conductor] 锁被占用（pid=${lock.info?.pid ?? '?'} since ${lock.info?.acquired_at ?? '?'}），直接退出。`,
    );
    process.exitCode = 1;
    return;
  }
  let stopHeartbeat = null;
  try {
    stopHeartbeat = startLockHeartbeat(cfg.stateDir, cfg.lockHeartbeatMs);
    if (cfg.deprecatedMaxDrainStepsConfigured) {
      console.error('[conductor] 警告：maxDrainSteps 已废弃，本次 run 忽略；请改用 maxStepsPerTask。');
    }
    if (!(Number(cfg.maxConcurrentTasks) > 0)) {
      console.error(`[conductor] 警告：maxConcurrentTasks=${cfg.maxConcurrentTasks} 非法，按 1 处理。`);
    }
    // AC-052：处理任何任务之前先确认配置的模型 id 都能起会话。id 打错/没权限/被下线时，
    // 代价是 run 启动即停，而不是四个角色各 spawn 失败、各烧一遍退避阶梯、把任务推错分支。
    if (!(await ensureModelsAvailable(cfg))) return;
    warnLegacyTasks(cfg);
    const repaired = state.patrolBoxStageConsistency(cfg);
    for (const r of repaired) {
      console.error(`[${r.id}] box/stage 巡检自愈：${r.from} → ${r.to}（stage=${r.stage}）`);
    }
    initRunBudget(cfg);
    await runScheduler(cfg, STAGE_HANDLERS);
  } finally {
    if (stopHeartbeat) stopHeartbeat();
    releaseLock(cfg.stateDir);
  }
  cmdStatus(cfg);
}

// ---- new ----

function nextId(cfg) {
  const today = new Date();
  const ymd = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');
  let max = 0;
  for (const dir of [cfg.queueDir, cfg.failedDir, cfg.doneDir, cfg.parkedDir]) {
    for (const name of state.listTaskDirNames(dir)) {
      const m = name.match(/^task-(\d{8})-(\d{3})$/);
      if (m && m[1] === ymd) max = Math.max(max, Number(m[2]));
    }
  }
  return `task-${ymd}-${String(max + 1).padStart(3, '0')}`;
}

/** `--x <path>` 取值：缺参或是布尔（`--x` 后面没跟值）时报错并返回 null。 */
function requirePathOpt(opts, name, { mustExist = false } = {}) {
  const v = opts[name];
  if (v == null || v === true) {
    console.error(`--${name} 需要一个${mustExist ? '存在的文件' : ''}路径`);
    return null;
  }
  const resolved = path.resolve(v);
  if (mustExist && !fs.existsSync(resolved)) {
    console.error(`--${name} 文件不存在：${resolved}`);
    return null;
  }
  return resolved;
}

/**
 * 新建任务（router conductor）：`new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]`。
 * 没有 kind——路线由 router 每轮决定，不由建单时的一个枚举锁死。
 *
 * 唯一的建单前置是**目标仓的 precommit 段**（AC-019）：precommit 的三步命令由人手写，
 * 内核不猜、不生成；缺了它这个任务将来无论如何都过不了 merge 闸，早拒比晚拒便宜。
 */
function cmdNew(cfg, opts) {
  const title = typeof opts.title === 'string' && opts.title !== '' ? opts.title : null;
  if (title == null) {
    console.error('用法：conductor new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]');
    process.exitCode = 1;
    return;
  }
  const briefPath = requirePathOpt(opts, 'brief', { mustExist: true });
  if (briefPath == null) { process.exitCode = 1; return; }

  let targetRepo = cfg.targetRepo;
  if (opts.repo != null) {
    if (opts.repo === true) { console.error('--repo 需要一个仓库路径'); process.exitCode = 1; return; }
    targetRepo = path.resolve(cfg.root, opts.repo);
  }

  // precommit profile 闸：目标仓的 setup-profile.json 必须有可用的 precommit 段。
  const profileMeta = setupProfilePaths({ ...cfg, targetRepo }).meta;
  const profileJson = state.readJsonIf(profileMeta);
  const check = validatePrecommitProfile(profileJson, { testCommand: cfg.testCommand });
  if (!check.ok) {
    console.error(`[conductor] 拒绝建任务：${path.relative(cfg.root, profileMeta)} 的 precommit 配置不可用`);
    for (const e of check.errors) console.error(`  - ${e}`);
    console.error('\n照下面的样例手写 precommit 段（precommit 的每一步命令由人给定，内核不猜）：\n');
    console.error(check.sample);
    process.exitCode = 1;
    return;
  }

  const id = nextId(cfg);
  // 阶段闸（AC-044）：packagesEnabled=false 时不接受任何方案文件残留。
  const packagesDraft = path.join(cfg.specsDir, `${id}.packages.json`);
  if (cfg.packagesEnabled !== true && fs.existsSync(packagesDraft)) {
    console.error(`[conductor] 拒绝建任务：${path.relative(cfg.root, packagesDraft)} 已存在，但 packagesEnabled=false（本阶段不支持工作包）`);
    process.exitCode = 1;
    return;
  }

  let baseBranch = opts['base-branch'] === true ? null : (opts['base-branch'] ?? cfg.baseBranch);
  if (baseBranch == null) {
    try { baseBranch = currentBranch(targetRepo); } catch { baseBranch = 'main'; }
    if (!baseBranch) baseBranch = 'main';
  }

  const task = {
    schema_version: 1,
    id,
    title,
    repo: path.basename(targetRepo),
    targetRepo,
    baseBranch,
    testCommand: cfg.testCommand,
    created_at: new Date().toISOString(),
  };
  // runtime 只有 spec 列的字段：没有 miss / inval / epoch 计数——阶梯已经被 router 取代。
  const runtime = {
    schema_version: 1,
    stage: 'ROUTING',
    current_round: 0,
    awaiting: null,
    spec_approved: false,
    plan_active: false,
    plan_source: null,
    rate_limit: null,
    spent_usd: 0,
    last_failure_type: null,
    updated_at: new Date().toISOString(),
  };
  const dir = state.writeNewTask(cfg.queueDir, task, runtime);
  state.writeFileEnsured(path.join(dir, 'brief.md'), fs.readFileSync(briefPath, 'utf8'));
  state.appendTimeline(cfg, id, `created (stage=ROUTING, brief 已落盘)`);
  console.log(`已创建 ${path.relative(cfg.root, dir)}/（stage=ROUTING）`);
  console.log('conductor run 会让 router 读 brief 与内核事实，从动作闭集里选下一步；人只在 spec 闸与 merge 闸出现');
  console.log(`id: ${id}`);
}

// ---- approve / reject ----

async function withCliTaskMutation(cfg, id, fn) {
  if (!id) {
    console.error('缺少任务 id');
    process.exitCode = 1;
    return;
  }
  try {
    return await withTaskLock(cfg, id, fn, { retries: 3, retryDelayMs: 200 });
  } catch (err) {
    if (err instanceof TaskLockBusyError) {
      console.error(`[${id}] 任务正被推进，请稍后重试。`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// ---- 人闸（新状态机）：approve / reject / resume / abandon ----

/**
 * 把人的裁决合并进本轮的 human-r<n>.json（内核写的产物，可续写；agent 的 log 才是只增不改）。
 * 合成后它就是记录列表里的一条 `role: "human"`，router 在「已裁决事项」里逐字读到 notes。
 */
function recordHumanDecision(cfg, ts, { decision, notes = null, noPackages = false }) {
  const round = ts.runtime.awaiting?.round ?? ts.runtime.current_round ?? 0;
  const p = humanRecordPath(cfg, ts.id, round);
  const existing = state.readJsonIf(p) ?? { schema_version: 1, kind: ts.runtime.awaiting?.kind ?? null, requested_by: 'kernel', summary: '', refs: [] };
  const merged = {
    ...existing,
    decision,
    notes: typeof notes === 'string' && notes !== '' ? notes : null,
    no_packages: noPackages === true,
    decided_at: new Date().toISOString(),
  };
  state.writeJson(p, merged);
  state.appendEventAlways(cfg, ts.id, 'human_decision', {
    round, kind: merged.kind, decision, notes: merged.notes, no_packages: merged.no_packages,
  });
  return merged;
}

/** 离开人闸回 ROUTING：awaiting 置 null，其余字段由调用方通过 extra 一并落盘。 */
function backToRouting(cfg, ts, note, extra = {}) {
  state.transitionState(ts, cfg, 'ROUTING', note, { awaiting: null, ...extra });
}

/** spec 闸批准：冻结 spec → dossier/<id>/spec.md，草稿归档，spec_approved=true，回 ROUTING。 */
function approveSpecGate(cfg, ts, opts) {
  const id = ts.id;
  const draft = specDraftPath(cfg, id);
  if (!fs.existsSync(draft)) {
    console.error(`拒绝 approve：specs/${id}.md 不存在（spec 闸的产物已被移走？）`);
    process.exitCode = 1;
    return;
  }
  const body = fs.readFileSync(draft, 'utf8');
  const check = validateSpecDoc(body);
  if (!check.ok) {
    // 人审期间草稿可能被人工改写（合法动作），但冻结后不再过契约门：这里是最后一次终审。
    console.error(`拒绝 approve：specs/${id}.md 不满足 spec-doc/v1，冻结会让 AC 枚举退化。`);
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  if (opts['no-packages'] && cfg.packagesEnabled !== true) {
    console.log('提示：packagesEnabled=false，--no-packages 本阶段无意义，已忽略');
  }
  state.writeFileEnsured(state.dossierPath(cfg, id, 'spec.md'), body);
  archiveSpecDraft(cfg, id, 'approved');
  recordHumanDecision(cfg, ts, { decision: 'approved', notes: opts.notes === true ? null : opts.notes });
  backToRouting(cfg, ts, 'spec 批准', { spec_approved: true });
  console.log(`${id} spec 已冻结（dossier/${id}/spec.md，AC×${check.acs.length}）→ ROUTING`);
}

/**
 * merge 闸批准：按**批准时刻**的 H / B 重算版本规则（Invariant 4/6）。
 * 任一为 true → 拒绝并回 ROUTING（人的 notes 不能豁免版本）。通过 → 本地 merge、清产物、DONE。
 * 任何路径都不 push。
 */
function approveMergeGate(cfg, ts, opts) {
  const id = ts.id;
  const tcfg = taskCfg(ts, cfg);
  const repo = tcfg.targetRepo;
  const branch = taskBranchName(id);
  const head = revParseOrNull(repo, branch);
  const base = revParseOrNull(repo, ts.task.baseBranch);
  const records = composeRecords(cfg, id, { planActive: ts.runtime.plan_active === true });

  if (needReview(records, head)) {
    state.appendEventAlways(cfg, id, 'stale_review', { head_sha: head, base_sha: base });
    backToRouting(cfg, ts, 'merge 批准被版本规则拒绝：当前 HEAD 没有通过的整体 review');
    console.error(`${id} merge 拒绝：任务分支 HEAD 已变，当前版本没有通过的整体 review（need_review=true）→ 回 ROUTING`);
    process.exitCode = 1;
    return;
  }
  if (needPrecommit(records, head, base)) {
    state.appendEventAlways(cfg, id, 'main_moved', { head_sha: head, base_sha: base });
    backToRouting(cfg, ts, 'merge 批准被版本规则拒绝：当前 H/B 上没有通过的 precommit');
    console.error(`${id} merge 拒绝：precommit 基线已过期（need_precommit=true）→ 回 ROUTING`);
    process.exitCode = 1;
    return;
  }
  const cur = currentBranch(repo);
  if (cur !== ts.task.baseBranch) {
    console.error(`merge 拒绝：target 仓库当前分支 ${cur} ≠ 任务 baseBranch ${ts.task.baseBranch}（任务保持原状）`);
    state.appendTimeline(cfg, id, `merge 拒绝：target 仓库当前分支 ${cur} ≠ ${ts.task.baseBranch}`);
    process.exitCode = 1;
    return;
  }
  const message = typeof opts.message === 'string' && opts.message !== ''
    ? opts.message
    : `task ${id}: ${ts.task.title ?? id}`;
  try {
    mergeBranch(repo, branch, message); // 本地 merge，绝不 push
  } catch (err) {
    console.error(`${id} merge 失败（任务保持原状）：${err.message}`);
    state.appendTimeline(cfg, id, `merge 失败：${err.message}`);
    process.exitCode = 1;
    return;
  }
  state.appendEventAlways(cfg, id, 'merged', { branch, message, head_sha: head, base_sha: base });
  state.appendTimeline(cfg, id, `merged ${branch} → ${ts.task.baseBranch}（${message}）`);
  recordHumanDecision(cfg, ts, { decision: 'approved', notes: opts.notes === true ? null : opts.notes });
  cleanupTaskArtifacts(ts, cfg, { deleteTaskBranch: true });
  state.transitionState(ts, cfg, 'DONE', 'merge 批准', { awaiting: null });
  console.log(`${id} 已 merge 并归档（state/done/），worktree 与任务分支已清理。未 push。`);
}

/** router 纪元认识的 stage；其余（P3 之前的遗留 stage 名）一律只读。 */
const ROUTER_STAGE_NAMES = new Set(STAGES);

/**
 * 只有旧状态机才会写的 runtime 字段。`FAILED_BOX` / `DONE` 这两个 stage 名新旧通用，
 * 光看 stage 认不出旧任务——它的 miss / inval / approval 计数才是指纹。
 */
const LEGACY_RUNTIME_FIELDS = [
  'maker_miss_count', 'verifier_invalid_count', 'spec_miss_count', 'spec_epoch',
  'approval', 'setup_approval', 'feasibility_approval', 'scope_decision', 'crash_recovery_count',
];

export function isLegacyTask(runtime) {
  if (runtime == null) return false;
  if (!ROUTER_STAGE_NAMES.has(runtime.stage)) return true;
  return LEGACY_RUNTIME_FIELDS.some((k) => Object.hasOwn(runtime, k));
}

/**
 * 遗留任务闸：state/queue|done|failed 里 P3 之前的旧任务只保留可读性（dashboard 与
 * dossier-stats 照常渲染），但没有任何动词能操作它们——旧状态机连同它的人闸一起删了，
 * 硬跑只会写出半新半旧的 runtime。命中即打印清晰错误、退非零、**不改它们的任何状态**。
 */
function refuseLegacyTask(ts) {
  if (!isLegacyTask(ts.runtime)) return false;
  console.error(
    `${ts.id} 是遗留任务（stage=${ts.runtime?.stage ?? '?'}`
    + `${ts.runtime?.last_failure_type ? `, last_failure_type=${ts.runtime.last_failure_type}` : ''}）：`
    + 'legacy task, not operable by this conductor。旧状态机已在 P3 删除，案卷与看板仍可读，'
    + '需要继续做请按当前 brief 重新 conductor new。',
  );
  process.exitCode = 1;
  return true;
}

async function cmdResume(cfg, id, opts = {}) {
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
    if (refuseLegacyTask(ts)) return;
    if (ts.runtime.stage !== 'AWAIT_HUMAN' || ts.runtime.awaiting?.kind !== 'help') {
      console.error(`resume 仅适用于 AWAIT_HUMAN(help) 的任务（当前 stage=${ts.runtime.stage}, kind=${ts.runtime.awaiting?.kind ?? '-'}）`);
      process.exitCode = 1;
      return;
    }
    const notes = opts.notes === true ? null : (opts.notes ?? null);
    state.appendEventAlways(cfg, id, 'human_intervened', { round: ts.runtime.awaiting?.round ?? null, notes });
    recordHumanDecision(cfg, ts, { decision: 'resumed', notes });
    backToRouting(cfg, ts, `help 闸 resume${notes ? `：${notes}` : ''}`);
    console.log(`${id} → ROUTING（notes 只进记录，不豁免版本规则：HEAD 变过就还得重新 review / precommit）`);
  });
}

async function cmdAbandon(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
    if (refuseLegacyTask(ts)) return;
    if (ts.box !== 'queue') {
      console.error(`abandon 仅适用于 queue 中的任务（当前 box=${ts.box}）`);
      process.exitCode = 1;
      return;
    }
    cleanupTaskArtifacts(ts, cfg, { deleteTaskBranch: true, force: true });
    state.appendTimeline(cfg, id, 'human abandon');
    state.transitionState(ts, cfg, 'FAILED_BOX', 'human abandon', {
      awaiting: null, last_failure_type: 'abandoned',
    });
    console.log(`${id} → FAILED_BOX(abandoned)，worktree 与任务分支已清理；conductor retry ${id} 可回 ROUTING`);
  });
}

async function cmdApprove(cfg, id, opts = {}) {
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
    if (refuseLegacyTask(ts)) return;
    if (ts.runtime.stage !== 'AWAIT_HUMAN') {
      console.error(`approve 仅适用于停在人闸上的任务（当前 stage=${ts.runtime.stage}）`);
      process.exitCode = 1;
      return;
    }
    const kind = ts.runtime.awaiting?.kind ?? null;
    if (kind === 'spec') return approveSpecGate(cfg, ts, opts);
    if (kind === 'merge') return approveMergeGate(cfg, ts, opts);
    if (kind === 'help') {
      console.error(`${id} 停在 help 闸：用 conductor resume ${id} [--notes "…"]，approve 只用于 spec / merge 闸`);
      process.exitCode = 1;
      return;
    }
    console.error(`${id} 的 runtime.awaiting 为空或未知（kind=${kind}），无法判断在等哪道闸`);
    process.exitCode = 1;
  });
}

async function cmdReject(cfg, id, notes) {
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
    if (refuseLegacyTask(ts)) return;
    if (ts.runtime.stage !== 'AWAIT_HUMAN') {
      console.error(`reject 仅适用于停在人闸上的任务（当前 stage=${ts.runtime.stage}）`);
      process.exitCode = 1;
      return;
    }
    const kind = ts.runtime.awaiting?.kind ?? null;
    if (kind !== 'spec' && kind !== 'merge') {
      console.error(`reject 仅适用于 spec / merge 闸（当前 kind=${kind ?? '-'}；help 闸用 resume）`);
      process.exitCode = 1;
      return;
    }
    const text = notes === true ? null : (notes ?? null);
    if (!text) {
      console.error(`用法：conductor reject ${id} --notes "打回理由"（notes 是 router 与下一轮 agent 的唯一输入）`);
      process.exitCode = 1;
      return;
    }
    recordHumanDecision(cfg, ts, { decision: 'rejected', notes: text });
    backToRouting(cfg, ts, `${kind} 闸打回：${text}`);
    console.log(`${id} ${kind} 闸已打回 → ROUTING（notes 进「已裁决事项」，router 自行决定下一步）`);
  });
}

// ---- status ----

function cmdStatus(cfg) {
  warnLegacyTasks(cfg); // 旧 .md 任务在任务表里看不到，单独 stderr 告警，避免「(no tasks)」误导（契约 §12）
  const rows = [];
  for (const [box, dir] of BOXES(cfg)) {
    for (const ts of state.listTaskStates(dir, box)) {
      if (ts.error) {
        rows.push({ id: ts.id, stage: `(损坏: ${ts.error})`, awaiting: '?', spent: '?', box });
        continue;
      }
      const stage = ts.runtime.stage ?? '?';
      rows.push({
        id: ts.task.id ?? ts.id,
        // 遗留 stage 名照常打出来（旧任务只读，但要看得见），只是这台机器不再推进它们。
        stage,
        awaiting: ts.runtime.awaiting?.kind ?? ts.runtime.last_failure_type ?? '-',
        spent: `$${(ts.runtime.spent_usd ?? 0).toFixed(3)}`,
        box,
      });
    }
  }
  const cols = [
    ['id', 'ID', 22], ['stage', 'STAGE', 21], ['awaiting', 'AWAITING/FAILURE', 26],
    ['spent', 'SPENT', 10], ['box', 'BOX', 7],
  ];
  console.log(cols.map(([, h, w]) => h.padEnd(w)).join(''));
  if (rows.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const r of rows) {
    console.log(cols.map(([k, , w]) => String(r[k]).padEnd(w)).join(''));
  }
}

function latestActiveSpawn(cfg, id) {
  const dir = state.dossierPath(cfg, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const active = [];
  for (const n of names) {
    // 新旧两套角色名都要认（AC：status / spy 兼容新旧任务）。
    const m = n.match(/^(setup|feasibility-agent|spec-agent|spec-verifier|verifier|router|spec-plan|spec|maker(?:-P-\d{3})?|reviewer)-r(\d+)\.json$/);
    if (!m) continue;
    const p = path.join(dir, n);
    const rec = state.readJsonIf(p);
    if (!rec?.started || rec.done) continue;
    const streamFile = path.join(dir, `${m[1]}-r${m[2]}.stream.jsonl`);
    let lastActivity = rec.started;
    try {
      lastActivity = new Date(fs.statSync(streamFile).mtimeMs).toISOString();
    } catch {
      try { lastActivity = new Date(fs.statSync(p).mtimeMs).toISOString(); } catch { /* keep started */ }
    }
    active.push({
      role: rec.role ?? m[1],
      round: rec.round ?? Number(m[2]),
      started: rec.started,
      lastActivity,
    });
  }
  active.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return active[0] ?? null;
}

function cmdSpy(cfg) {
  const rows = [];
  for (const ts of state.listTaskStates(cfg.queueDir, 'queue')) {
    if (ts.error) {
      rows.push({ id: ts.id, stage: `(损坏)`, active: '-', last: '-', spent: '?' });
      continue;
    }
    const active = latestActiveSpawn(cfg, ts.id);
    rows.push({
      id: ts.id,
      stage: ts.runtime.stage ?? '?',
      active: active ? `${active.role} r${active.round}` : '-',
      last: active?.lastActivity ?? ts.runtime.updated_at ?? '-',
      spent: `$${(ts.runtime.spent_usd ?? 0).toFixed(3)}`,
    });
  }
  const cols = [
    ['id', 'ID', 22], ['stage', 'STAGE', 21], ['active', 'ACTIVE', 18], ['last', 'LAST_ACTIVITY', 28], ['spent', 'SPENT', 10],
  ];
  console.log(cols.map(([, h, w]) => h.padEnd(w)).join(''));
  if (rows.length === 0) {
    console.log('(no queue tasks)');
    return;
  }
  for (const r of rows) console.log(cols.map(([k, , w]) => String(r[k]).padEnd(w)).join(''));
}

// ---- retry ----

/** Unix 秒 → 本地时间文案（带 UTC 偏移，便于人对表；不依赖 locale 顺序）。 */
export function formatLocalTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (UTC${sign}${oh}:${om})`;
}

function isRateLimitedTask(ts) {
  return ts.box === 'failed' && ts.runtime?.last_failure_type === 'rate_limited';
}

/**
 * 限额恢复（契约 §限额）：`now < resets_at` 拒绝（打印本地重置时刻，exit 非 0，--force 越过）；
 * 到点则回到命中时所在 stage（runtime.rate_limit.resume_stage），**不归档任何轮次产物、
 * 不重置任何计数**——限额不是任务的失败，产物与进度原样接着用。
 */
function applyRateLimitRetry(cfg, ts, { force = false } = {}) {
  const id = ts.id;
  const rl = ts.runtime.rate_limit ?? {};
  const resetsAt = typeof rl.resets_at === 'number' ? rl.resets_at : null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && resetsAt != null && nowSec < resetsAt) {
    console.log(
      `${id} 限额（${rl.type ?? 'unknown'}）尚未重置：重置时刻 ${formatLocalTime(resetsAt)}。`
      + `到点后再 \`conductor retry ${id}\`，或加 --force 越过（会再次撞限额）。`,
    );
    process.exitCode = 1;
    return false;
  }
  const stage = rl.resume_stage ?? 'ROUTING';
  Object.assign(ts.runtime, { stage, last_failure_type: null, rate_limit: null });
  state.saveRuntime(ts);
  const dest = state.taskDir(cfg.queueDir, id);
  fs.mkdirSync(cfg.queueDir, { recursive: true });
  fs.renameSync(ts.dir, dest);
  ts.dir = dest;
  ts.box = 'queue';
  const forced = force && resetsAt != null && nowSec < resetsAt ? '（--force 越过重置时刻）' : '';
  state.appendTimeline(cfg, id, `human retry：限额恢复 → ${stage}${forced}，无产物归档、计数不变`);
  console.log(`${id} 已重回 queue（stage=${stage}），限额已恢复${forced}；执行 \`conductor run\` 继续`);
  return true;
}

/** 新状态机的可恢复失败类型（限额另有 applyRateLimitRetry 走 resume_stage）。 */
const ROUTER_RETRY_TYPES = new Set(['fuse_no_progress', 'budget_exhausted', 'abandoned']);

/**
 * 新状态机的 retry：回 ROUTING，不归档任何轮次产物（案卷是 router 的记忆，动了它等于失忆），
 * 并把**复位轮次**记进 router-state —— 保险丝的连击从此刻重新数（Edge Case「保险丝触发后人 retry」）。
 */
function applyRouterRetry(cfg, ts) {
  const id = ts.id;
  const from = ts.runtime.last_failure_type;
  writeRouterState(cfg, id, {
    failures: [],
    last_action_rejected: null,
    fuse_reset_round: (ts.runtime.current_round ?? 0) + 1,
  });
  Object.assign(ts.runtime, { stage: 'ROUTING', last_failure_type: null, awaiting: null, rate_limit: null });
  state.saveRuntime(ts);
  const dest = state.taskDir(cfg.queueDir, id);
  fs.mkdirSync(cfg.queueDir, { recursive: true });
  fs.renameSync(ts.dir, dest);
  ts.dir = dest;
  ts.box = 'queue';
  state.appendTimeline(cfg, id, `human retry：FAILED_BOX(${from}) → ROUTING，案卷保留，保险丝连击从 r${(ts.runtime.current_round ?? 0) + 1} 重新计`);
  console.log(`${id} 已重回 queue（stage=ROUTING，${from} 已恢复，案卷未动）`);
  if ((ts.runtime.spent_usd ?? 0) >= cfg.budgetUsd) {
    console.error(
      `警告：spent_usd=$${ts.runtime.spent_usd} 仍 >= budgetUsd=$${cfg.budgetUsd}，`
      + '下次 run 会再次进 FAILED_BOX。请上调 conductor.config.json 的 budgetUsd。',
    );
  }
}

async function cmdRetry(cfg, id, opts = {}) {
  if (opts['rate-limited']) return cmdRetryRateLimited(cfg, opts);
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
    if (ts.box === 'done') {
      console.error(`${id} 已归档（done），不支持 retry`);
      process.exitCode = 1;
      return;
    }
    if (refuseLegacyTask(ts)) return;
    if (isRateLimitedTask(ts)) { applyRateLimitRetry(cfg, ts, { force: opts.force === true }); return; }
    if (ts.box === 'failed' && ROUTER_RETRY_TYPES.has(ts.runtime.last_failure_type)) {
      applyRouterRetry(cfg, ts);
      return;
    }
    // 收箱类型只有这四种（AC-005 的六条自发转移里，进箱的那三条 + abandon）。
    // 其余一律拒绝：retry 是「把任务放回 ROUTING」，不是通用的状态修理工具。
    console.error(
      ts.box === 'failed'
        ? `${id} 的 last_failure_type=${ts.runtime.last_failure_type ?? '(空)'} 不是可恢复类型`
          + `（可恢复：rate_limited / ${[...ROUTER_RETRY_TYPES].join(' / ')}）`
        : `retry 仅适用于 FAILED_BOX 的任务（当前 box=${ts.box}, stage=${ts.runtime.stage}）`,
    );
    process.exitCode = 1;
  });
}

/** `retry --rate-limited`：对 failed 箱里全部 rate_limited 任务执行同一恢复逻辑。 */
async function cmdRetryRateLimited(cfg, opts = {}) {
  const ids = state.listTaskStates(cfg.failedDir, 'failed')
    .filter((ts) => !ts.error && ts.runtime?.last_failure_type === 'rate_limited')
    .map((ts) => ts.id);
  if (ids.length === 0) {
    console.log('failed 箱里没有 rate_limited 任务');
    return;
  }
  for (const id of ids) {
    await withCliTaskMutation(cfg, id, async () => {
      const ts = findTask(cfg, id);
      if (!ts || ts.error || !isRateLimitedTask(ts)) return;
      applyRateLimitRetry(cfg, ts, { force: opts.force === true });
    });
  }
}

// ---- CLI 分发 ----

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    } else {
      opts._.push(a);
    }
  }
  return { cmd, opts };
}

const USAGE = `用法：conductor <command>
  run                                  drain 一轮：推进所有任务直到无状态变化
                                       （启动先探一次 models 可用性；探不通就地终止，任务零变化）
  new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]
                                       新建任务（stage=ROUTING，由 router 逐轮决定下一步）；
                                       目标仓必须已配好 setup-profile.json 的 precommit 段
  approve <id> [--notes "…"] [--message "…"]
                                       人闸批准：spec 闸冻结 spec 回 ROUTING；merge 闸本地合并后归档
                                       （按批准时刻的 H/B 重算版本规则，不满足则拒并回 ROUTING；不 push）
  reject <id> --notes "…"              spec / merge 闸打回 → ROUTING，notes 进「已裁决事项」
  resume <id> [--notes "…"]            help 闸恢复 → ROUTING（notes 只进记录，不豁免版本规则）
  abandon <id>                         放弃任务 → FAILED_BOX(abandoned)，清 worktree 与任务分支
  retry <id> [--force]                 FAILED_BOX(rate_limited|fuse_no_progress|budget_exhausted|abandoned)
                                       → ROUTING（案卷不动，保险丝连击复位）；限额收箱的任务必须等到
                                       重置时刻之后（--force 可越过，会再次撞限额）
  retry --rate-limited [--force]       批量恢复 failed 箱里全部限额收箱的任务
  status                               打印任务表（queue / failed / done）
  spy                                  只读查看 queue 任务的运行中角色与最近活动

P3 之前建的遗留任务只保留可读性（dashboard / dossier-stats 照常渲染），任何动词都会拒绝操作它们。`;

const REQUIRED_NODE_MAJOR = 24;

/** node 主版本 < 24 时输出一行 stderr 警告（不阻断，退出码/后续行为不变）。 */
export function warnIfNodeVersionUnsupported(version = process.version) {
  const major = Number.parseInt(String(version).replace(/^v/, ''), 10);
  if (Number.isFinite(major) && major < REQUIRED_NODE_MAJOR) {
    console.error(`[conductor] 警告：当前 Node ${version}，本仓测试需 v24（部分测试在低版本上可能失败）。`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  warnIfNodeVersionUnsupported();
  const { cmd, opts } = parseArgs(argv);
  const cfg = loadCfg();
  ensureDirs(cfg);
  switch (cmd) {
    case 'run': await cmdRun(cfg); break;
    case 'new': cmdNew(cfg, opts); break;
    case 'approve': await cmdApprove(cfg, opts._[0], opts); break;
    case 'reject': await cmdReject(cfg, opts._[0], opts.notes); break;
    case 'status': cmdStatus(cfg); break;
    case 'spy': cmdSpy(cfg); break;
    case 'resume': await cmdResume(cfg, opts._[0], opts); break;
    case 'abandon': await cmdAbandon(cfg, opts._[0]); break;
    case 'retry': await cmdRetry(cfg, opts._[0], opts); break;
    default:
      console.error(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[conductor] fatal: ${err?.stack ?? err?.message ?? err}`);
    process.exitCode = 1;
  });
}
