#!/usr/bin/env node
// conductor.mjs — CLI 入口 + drain 循环。确定性、可重入、幂等：conductor 是脚本，不是 agent。
// 子命令：run / new / approve-setup / approve / reject / approve-scope / reject-scope / status / merge / retry。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as state from './lib/state.mjs';
import { acquireLock, releaseLock, lockDirPath, STALE_MS, startLockHeartbeat } from './lib/lock.mjs';
import { runScheduler, initRunBudget } from './lib/scheduler.mjs';
import { withTaskLock, TaskLockBusyError } from './lib/task-lock.mjs';
import { currentBranch, mergeBranch, removeWorktree, deleteBranch } from './lib/git.mjs';
import { DEFAULT_TEST_GLOBS } from './lib/test-gate.mjs';
import { hasApprovedSetupProfile } from './lib/profile.mjs';
import { taskCfg } from './lib/task-cfg.mjs';
import { runCommitterProposal, computeTestChangeGuard, performMerge } from './stages/shared.mjs';
import { validateFeasibilityDoc } from './lib/feasibility-contract.mjs';
import { validateSpecDoc } from './lib/spec-contract.mjs';
import { composeRecords } from './lib/records.mjs';
import { needPrecommit, needReview } from './lib/version-gate.mjs';
import { collectModelIds, probeModels } from './lib/model-probe.mjs';
import { PRECOMMIT_PROFILE_SAMPLE, setupProfilePaths, validatePrecommitProfile } from './lib/profile.mjs';
import { DEFAULT_MAX_TURNS } from './lib/agent-settings.mjs';
import routingHandler from './stages/routing.mjs';
import awaitHumanHandler from './stages/await_human.mjs';
import {
  cleanupTaskArtifacts, humanRecordPath, readRouterState, revParseOrNull, specDraftPath,
  taskBranchName, writeRouterState,
} from './stages/router-kernel.mjs';
import { archiveSpecDraft } from './stages/shared.mjs';
import needsTargetSetupHandler from './stages/needs_target_setup.mjs';
import awaitSetupApprovalHandler from './stages/await_setup_approval.mjs';
import needsFeasibilityHandler from './stages/needs_feasibility.mjs';
import awaitFeasibilityApprovalHandler from './stages/await_feasibility_approval.mjs';
import needsSpecHandler from './stages/needs_spec.mjs';
import specVerifyHandler, { applySpecFail } from './stages/spec_verify.mjs';
import specFixingHandler from './stages/spec_fixing.mjs';
import awaitSpecApprovalHandler from './stages/await_spec_approval.mjs';
import readyHandler from './stages/ready.mjs';
import verifyHandler from './stages/verify.mjs';
import fixingHandler from './stages/fixing.mjs';

const STAGE_HANDLERS = {
  // ---- 新状态机（router conductor）：new 创建的任务只走这两个 stage ----
  ROUTING: routingHandler,
  AWAIT_HUMAN: awaitHumanHandler,
  // ---- 以下为遗留 stage：P3 删。仍注册着，让 P2 之前建的 queue 任务跑完自己的链 ----
  NEEDS_TARGET_SETUP: needsTargetSetupHandler,
  AWAIT_SETUP_APPROVAL: awaitSetupApprovalHandler,
  NEEDS_FEASIBILITY: needsFeasibilityHandler,
  AWAIT_FEASIBILITY_APPROVAL: awaitFeasibilityApprovalHandler,
  NEEDS_SPEC: needsSpecHandler,
  SPEC_VERIFY: specVerifyHandler,
  SPEC_FIXING: specFixingHandler,
  AWAIT_SPEC_APPROVAL: awaitSpecApprovalHandler,
  READY: readyHandler,
  VERIFY: verifyHandler,
  FIXING: fixingHandler,
  // 规模人闸：只响应 approve-scope / reject-scope（任务留在 queue box，与其它 AWAIT_* 一致）
  AWAIT_SCOPE_DECISION: async () => ({ changed: false }),
  // 终态：只响应人工 merge / close / retry 命令
  AWAIT_HUMAN_MERGE: async () => ({ changed: false }),
  AWAIT_PROBE_CLOSE: async () => ({ changed: false }),
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
 * spec §config 的删除清单（AC-027）：仍读得到（旧 stage 还靠它们跑完自己的链），
 * 但新状态机一概不看，因此每个**人在配置文件里显式给了的**遗留键各打印一次警告。
 * 没给的键不警告——默认值不是「人的配置」，对它们喊话只是噪音。
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
 * `maxTurns` 归一（AC-027）：新形态是 `{router, spec, plan, maker, reviewer}`。
 * 配置给的是数字 → 视为 legacy 标量：赋给 `maker`，同时留给旧 stage 用（legacyMaxTurns）。
 * 返回 { maxTurns, legacyMaxTurns }。
 */
export function normalizeMaxTurns(configured) {
  if (Number.isFinite(configured)) {
    warnLegacyKey(`maxTurns（标量 ${configured} 视为 maker 上限；新形态是 { router, spec, plan, maker, reviewer }）`);
    return { maxTurns: { ...DEFAULT_MAX_TURNS, maker: configured }, legacyMaxTurns: configured };
  }
  const obj = configured != null && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  return { maxTurns: { ...DEFAULT_MAX_TURNS, ...obj }, legacyMaxTurns: 30 };
}

/** `models` 归一（AC-027）：四角色键缺省回落 claude-opus-5；遗留角色键保留可读但各警告一次。 */
export function normalizeModels(defaults, userModels) {
  const models = { ...defaults, ...(userModels ?? {}) };
  for (const key of ROLE_MODEL_KEYS) {
    if (typeof models[key] !== 'string' || models[key].trim() === '') models[key] = DEFAULT_ROLE_MODEL;
  }
  for (const key of LEGACY_MODEL_KEYS) {
    if (Object.hasOwn(userModels ?? {}, key)) warnLegacyKey(`models.${key}`);
  }
  return models;
}

export function loadCfg(root = resolveRoot()) {
  const defaults = {
    budgetUsd: 5,
    maxTurns: 30,
    testCommand: 'node --test',
    targetRepo: './target',
    baseBranch: null, // null = new 时读 currentBranch(targetRepo) 兜底 'main'
    maxMakerMisses: 3, // maker 可行动失败阶梯上限（契约 §3）
    crashAutoRecoveryLimit: 1, // maker 孤儿腿（maker-r<n> 有 started 无 done）自动恢复次数上限；0=关，退回「直接 FAILED_BOX(crashed)」旧行为。恢复动作就是 cmdRetry 对 queue 崩溃残留的既有机械复位（孤儿产物归档 + 重 spawn，无任何人类判断输入），设界只为防「崩溃→恢复→再崩溃」的无限循环
    maxVerifierInvalidRetries: 2, // verifier 协议失败重试上限（契约 §3）
    maxSpecMisses: 3, // spec-verifier fail：两次修复，第三次冷启动新 spec-agent
    maxSpecVerifierInvalidRetries: 2,
    maxSpecContractRetries: 2, // spec-agent 交付契约门（spec-doc/v1）失败重试上限：初始+2=3 次尝试
    maxSpecEpochs: 2,
    feasibilityEnabled: false, // feature 档默认是否走 feasibility gate（new --feasibility 可逐任务覆盖）
    maxFeasibilityContractRetries: 2, // feasibility 交付契约门（feasibility-doc/v1）失败重试上限
    greenGateOutputTailBytes: 12000, // green gate stdout/stderr tail 字节上限（契约 §6）
    testGateEnabled: true, // green pass 后的基线空转测试探针（docs/features/test-gate/tech-spec.md）
    testGateTestGlobs: DEFAULT_TEST_GLOBS, // 测试文件识别 glob（探针 overlay 用）
    testGateProbeConcurrency: 1, // per-AC 探针并发上限；>1 是 opt-in（命令共享探针 worktree，须自证无共享端口/文件/全局状态）
    verifierDiffMaxBytes: 200000, // verifier prompt 内嵌 diff 的字节上限，超限降级为 name-status 清单
    verifierEvidenceAnchorsMode: 'off', // verifier evidence 机械锚定核验（R5-H15）：off=旧行为；observe=只落对照产物；enforce=文件不存在/行号越界判协议 invalid（引用 diff 外文件任何模式都只观测）
    testChangeGuardEnabled: false, // H16 测试改动守卫：机械 diff 出被改/删/改名的既有测试文件，注入 verifier prompt + merge 摘要高亮（观测型，绝不 block）
    eventsLogEnabled: false, // H17 结构化事件流：dossier/<id>/events.jsonl（NDJSON）供机器消费，timeline 回归纯人读；best-effort 绝不打断主链
    specChainIsolationEnabled: false, // H19 spec/feasibility 链物理隔离：探索 cwd 换 baseBranch 一次性 detached worktree（交付走编排侧绝对路径不受影响；只见已提交状态）
    unknownSpawnCostEstimateEnabled: false, // H20 killed/无 result spawn 按角色 dossier 历史均价估计入账（标 estimated，独立累计 runtime.estimated_cost_usd；无样本退回 lower-bound）
    specMaxAcs: null, // H18 spec 规模闸（软档）：AC 数超此阈值时要求 spec-verifier 附 severity=advisory 拆分建议 finding（不参与 overall、不改路由，拆分权在人审）；null=关
    reviewStage: 'off', // H21 独立 Reviewer：off=关；shadow=verifier pass 后对照跑（只落盘+分歧对照，绝不影响 stage）；gate 档属 H22（未实现，等 shadow 数据）
    autoMergeEnabled: false, // H33 机械全绿自动本地合并：默认关；开=verdict pass 后 evaluateAutoMerge 谓词全绿即本地 merge（绝不 push）。拨开须人签字（红区），且先有 shadow 期无假绿数据
    autoMergeKinds: ['bugfix'], // H33 允许自动合并的任务 kind（feature 一律人审）
    autoMergeMaxDiffLines: 400, // H33 机械低风险判定：numstat 总改动行数上限
    autoMergeMaxAcs: 8, // H33 机械低风险判定：AC 数上限
    autoMergeDeniedPaths: [], // H33 危险路径清单（命中即不放行）：'dir/' 前缀匹配，其余子串匹配；空=不限（开启提案时应配真实清单）
    autoApproveSpecEnabled: false, // spec 审批门机器放行：默认关；开=AWAIT_SPEC_APPROVAL 且 evaluateAutoApproveSpec 谓词全绿即冻结进 READY（merge 闸门不动）。new --auto-approve-spec 可逐任务覆盖
    autoApproveSpecMaxAcs: 8, // 机器放行的 AC 数上限：超上限（或 verdict 带 blocker/major/advisory finding）一律留人审
    spawnRetries: 6, // Claude 瞬态重试次数（H7：长尾覆盖限流窗口）
    spawnBackoffMs: [15000, 30000, 60000], // 瞬态重试退避三档；五小时/周限额走零重试收箱路径，不靠长尾退避硬穿
    verifierShadowEnabled: false, // verifier shadow 观测实验（R4-E11）：默认关；开启也绝不影响状态机
    verifierShadowBackend: 'codex-exec', // 当前唯一支持的 shadow 后端（codex CLI 非交互形态）
    verifierShadowModel: null, // 传给 codex exec -m；null 用 codex 本地默认
    verifierShadowTimeoutMs: 1800000, // shadow 墙钟上限（与 green gate 同量级），超时只记 shadow 失败
    makerMaxTurnsContinuations: 1, // maker 撞 max-turns 时同会话续跑次数上限（0 = 关闭，恢复截断即进 gate 的旧行为）
    commitLanguage: 'en', // committer 提案语言门（团队政策：commit 一律英文）；非 en=旧行为逃生口
    maxConcurrentTasks: 3,
    inactivityTimeoutMs: 600000,
    spawnWallClockMs: 14400000,
    greenGateTimeoutMs: 1800000,
    precommitStepTimeoutMs: null, // precommit 单步墙钟上限；null = 取 greenGateTimeoutMs（spec §config）
    precommitLockTimeoutMs: 1800000, // 等 state/.precommit.lock 的上限，超时记 lock_timeout（AC-050）
    lockHeartbeatMs: 60000,
    maxStepsPerTask: 20,
    fuseStreak: 3, // 保险丝（AC-024）：同一 (role, package) 连续 N 条记录签名相同即收箱；0=关
    maxParallelPackages: 2, // 一个任务同轮最多并行几个工作包（P2b 才用得上）
    maxPackages: 12, // 一份方案最多几个包（validatePackages 的上限）
    packagesEnabled: false, // 阶段闸：P2b 前恒关——plan 动作被拒、spec prompt 无工作包段、router 的 packages 字段即非法
    runBudgetUsd: null,
    models: { setup: null, feasibility: null, spec: null, specVerifier: null, maker: null, verifier: null, committer: null, reviewer: null },
  };
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(root, 'conductor.config.json'), 'utf8'));
  } catch { /* 配置缺失时用默认值 */ }
  const deprecatedMaxDrainStepsConfigured = Object.hasOwn(user, 'maxDrainSteps');
  for (const key of LEGACY_CONFIG_KEYS) {
    if (Object.hasOwn(user, key)) warnLegacyKey(key);
  }
  const { maxTurns, legacyMaxTurns } = normalizeMaxTurns(user.maxTurns);
  const merged = {
    ...defaults,
    ...user,
    maxTurns,
    legacyMaxTurns,
    models: normalizeModels(defaults.models, user.models),
  };
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
 *
 * 带 `--kind` 时走遗留路径（旧五闸状态机），让 P3 之前的既有任务与测试照常。
 */
function cmdNew(cfg, opts) {
  if (opts.kind != null) return cmdNewLegacy(cfg, opts);

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

function cmdNewLegacy(cfg, opts) {
  const kind = opts.kind;
  if (kind !== 'bugfix' && kind !== 'feature' && kind !== 'probe') {
    console.error('用法：conductor new --kind bugfix|feature|probe --title "..."');
    process.exitCode = 1;
    return;
  }
  console.error('[conductor] 警告：--kind 是遗留建单形态（旧五闸状态机），新任务请用 conductor new --title … --brief <file>');
  const title = opts.title ?? '(untitled)';
  // --brief <file>：需求原文落盘 <taskdir>/brief.md（喂 feasibility/spec 链，缓解「只有 title」的输入饥饿）。
  let brief = null;
  if (opts.brief != null) {
    if (opts.brief === true) {
      console.error('--brief 需要一个文件路径（brief 原文所在文件）');
      process.exitCode = 1;
      return;
    }
    const briefPath = path.resolve(opts.brief);
    if (!fs.existsSync(briefPath)) {
      console.error(`--brief 文件不存在：${briefPath}`);
      process.exitCode = 1;
      return;
    }
    brief = fs.readFileSync(briefPath, 'utf8');
  }
  // --repo <path>：覆盖快照的 targetRepo（含该仓库的 setup-profile 判定与 baseBranch 解析）。
  let targetRepo = cfg.targetRepo;
  if (opts.repo != null) {
    if (opts.repo === true) {
      console.error('--repo 需要一个仓库路径');
      process.exitCode = 1;
      return;
    }
    targetRepo = path.resolve(cfg.root, opts.repo);
  }
  const id = nextId(cfg);
  // feasibility gate：--feasibility 强制开 / --feasibility false 强制关，缺省随 config.feasibilityEnabled；仅 feature 有意义。
  const feasibility = kind === 'feature' && (
    opts.feasibility != null ? opts.feasibility !== 'false' : cfg.feasibilityEnabled === true
  );
  // --auto-approve-spec：spec 审批门机器放行（仅 feature 有意义；task.json 显式值 > config.autoApproveSpecEnabled）。
  const autoApproveSpec = kind === 'feature' && opts['auto-approve-spec'] != null
    ? opts['auto-approve-spec'] !== 'false'
    : undefined;
  const naturalStage = kind === 'feature'
    ? (feasibility ? 'NEEDS_FEASIBILITY' : 'NEEDS_SPEC')
    : kind === 'probe' ? 'NEEDS_FEASIBILITY' // probe 链（H26）：只读调查，复用 feasibility agent
      : 'READY';
  const stage = hasApprovedSetupProfile({ ...cfg, targetRepo }) ? naturalStage : 'NEEDS_TARGET_SETUP';

  // task.json 不可变快照（契约 §1）：baseBranch = config.baseBranch ?? currentBranch(targetRepo) ?? 'main'。
  let baseBranch = cfg.baseBranch;
  if (baseBranch == null) {
    try { baseBranch = currentBranch(targetRepo); } catch { baseBranch = 'main'; }
    if (!baseBranch) baseBranch = 'main';
  }
  const task = {
    schema_version: 1,
    id,
    kind,
    title,
    ...(kind === 'feature' ? { feasibility } : {}),
    ...(autoApproveSpec !== undefined ? { autoApproveSpec } : {}),
    repo: path.basename(targetRepo),
    targetRepo,
    baseBranch,
    testCommand: cfg.testCommand,
    created_at: new Date().toISOString(),
  };
  const runtime = {
    schema_version: 1,
    stage,
    maker_miss_count: 0,
    crash_recovery_count: 0, // 已用掉的 maker 孤儿腿自动恢复次数（对 crashAutoRecoveryLimit 计数）
    verifier_invalid_count: 0,
    spec_miss_count: 0,
    spec_verifier_invalid_count: 0,
    spec_contract_invalid_count: 0,
    spec_epoch: 1,
    scope_decision: null, // null=未裁 / 'waived'=人已接受规模（任务作用域持久豁免）/ 'split'=人选择拆分（收箱）
    feasibility_approval: null,
    feasibility_contract_invalid_count: 0,
    current_feasibility_round: 0,
    feasibility_agent_session_id: null,
    chosen_option: null,
    spent_usd: 0,
    approval: null,
    setup_approval: null,
    maker_session_id: null,
    spec_agent_session_id: null,
    current_round: 0,
    current_spec_round: 0,
    last_failure_type: null,
    updated_at: new Date().toISOString(),
  };
  // bugfix 额外写 spec.md 草稿（# <title> + ## 验收标准 模板 TODO）。
  const specDraft = kind === 'bugfix'
    ? `# ${title}\n\n## 验收标准\n\n- TODO: 填写可机器/人工验证的验收标准\n`
    : undefined;
  const dir = state.writeNewTask(cfg.queueDir, task, runtime, { specDraft });
  if (brief != null) {
    state.writeFileEnsured(path.join(dir, 'brief.md'), brief);
  }
  state.appendTimeline(cfg, id, `created (kind=${kind}, stage=${stage}${brief != null ? ', brief 已落盘' : ''})`);
  console.log(`已创建 ${path.relative(cfg.root, dir)}/（kind=${kind}, stage=${stage}）`);
  if (kind === 'bugfix') {
    console.log('提醒：编辑该目录的 spec.md「## 验收标准」段（它就是 bugfix 档的 spec），然后 conductor run');
  } else if (kind === 'probe') {
    console.log('probe 档（只读调查）：conductor run 会让 feasibility-agent 产出调查报告，人读后 conductor close 归档（无实现链）');
  } else if (feasibility) {
    console.log('feature 档（feasibility gate）：conductor run 会先让 feasibility-agent 产出决策 memo，等你 approve-feasibility --option 点名后再进 spec 链');
  } else {
    console.log('feature 档：conductor run 会先让 spec-agent 产出草稿，经 spec-verifier 后等你 approve/reject');
  }
  if (autoApproveSpec === true) {
    console.log('auto-approve-spec 已开：spec-verifier pass 且谓词全绿（无 blocker/major/advisory finding、AC 数达标）时机器代章进 READY；merge 闸门不动');
  }
  if (stage === 'NEEDS_TARGET_SETUP') {
    console.log('当前 target repo 没有 approved setup profile：conductor run 会先进入 setup-agent + approve-setup 闸门');
  }
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

async function cmdResume(cfg, id, opts = {}) {
  return withCliTaskMutation(cfg, id, async () => {
    const ts = findTask(cfg, id);
    if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
    if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
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
  if (ts.runtime.stage === 'AWAIT_HUMAN') {
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
    return;
  }
  if (ts.runtime.stage !== 'AWAIT_SPEC_APPROVAL') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_SPEC_APPROVAL），仍写入 approval=approved`);
  }
  // 人审期间 spec 草稿可能被人工改写（合法动作），但 approve 后冻结不再过契约门：
  // 标题/AC 枚举不合格会静默兜底成 1 条笼统 AC，整条 per-AC 验证链退化。
  // 所以在人审落章处终审一次：不合格拒绝写入，任务保持原状（真实案例：20260706-002
  // 人工重写后用了英文标题「## Acceptance Criteria」，枚举为 0）。
  const draftPath = path.join(cfg.specsDir, `${id}.md`);
  if (fs.existsSync(draftPath)) {
    const check = validateSpecDoc(fs.readFileSync(draftPath, 'utf8'));
    if (!check.ok) {
      console.error(`拒绝 approve：specs/${id}.md 不满足 spec-doc/v1，冻结会退化为兜底单条 AC。`);
      for (const e of check.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
  }
  ts.runtime.approval = 'approved';
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, 'human approve');
  console.log(`${id} approval=approved。下次 conductor run 时冻结 spec 并进入 READY`);
  });
}

async function cmdApproveSetup(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.runtime.stage !== 'AWAIT_SETUP_APPROVAL') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_SETUP_APPROVAL），仍写入 setup_approval=approved`);
  }
  ts.runtime.setup_approval = 'approved';
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, 'human approve setup profile');
  console.log(`${id} setup_approval=approved。下次 conductor run 时冻结 setup profile 并进入任务流程`);
  });
}

async function cmdReject(cfg, id, notes) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.runtime.stage === 'AWAIT_HUMAN') {
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
    return;
  }
  if (ts.runtime.stage !== 'AWAIT_SPEC_APPROVAL') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_SPEC_APPROVAL），仍写入 approval=rejected`);
  }
  ts.runtime.approval = 'rejected';
  if (notes) {
    // 打回意见累加到任务目录的 reject_notes.md（喂给 spec-agent），不入 runtime。
    const p = path.join(ts.dir, 'reject_notes.md');
    let existing = '';
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* optional */ }
    state.writeFileEnsured(p, `${existing}- ${new Date().toISOString().slice(0, 10)}: ${notes}\n`);
  }
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `human reject${notes ? `: ${notes}` : ''}`);
  console.log(`${id} approval=rejected。下次 conductor run 时退回 spec-agent 重写 spec`);
  });
}

/** 裁决时的机械 AC 计数（与规模闸同一口径）；草稿缺失返回 null。 */
function specAcCount(cfg, id) {
  try {
    return state.extractAcceptanceCriteria(fs.readFileSync(path.join(cfg.specsDir, `${id}.md`), 'utf8')).length;
  } catch {
    return null;
  }
}

/**
 * 规模人闸「接受规模」（AWAIT_SCOPE_DECISION）：豁免是任务作用域且持久（跨轮、跨 epoch），
 * 之后规模闸退回 H18 软档（只往 spec-verifier prompt 注入 advisory 要求），永不再升闸。
 * 升闸时挂起的那次 fail 此刻才入账——去向由既有 miss 阶梯决定（SPEC_FIXING / 冷启动 / 耗尽收箱）。
 */
async function cmdApproveScope(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.runtime.stage !== 'AWAIT_SCOPE_DECISION') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_SCOPE_DECISION），仍写入 scope_decision=waived`);
  }
  const round = ts.runtime.current_spec_round ?? 0;
  const acCount = specAcCount(cfg, id);
  // 先产物后状态：裁决固化进 dossier（不随任务目录搬箱，永久可查），再落 runtime、再放 fail 入账。
  state.writeJson(state.dossierPath(cfg, id, 'scope-decision.json'), {
    schema_version: 1,
    decision: 'waived',
    round,
    ac_count: acCount,
    max: Number.isFinite(cfg.specMaxAcs) ? cfg.specMaxAcs : null,
    decided_at: new Date().toISOString(),
  });
  ts.runtime.scope_decision = 'waived';
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `human approve scope：接受当前规模（AC×${acCount ?? '?'}），挂起的 spec-verifier fail r${round} 入账`);
  applySpecFail(ts, cfg, round);
  console.log(`${id} scope_decision=waived → stage=${ts.runtime.stage}（规模闸此后只作软档提示，不再升闸）`);
  });
}

/**
 * 规模人闸「选择拆分」（AWAIT_SCOPE_DECISION）：任务收箱等人手工拆成多个任务重开；
 * notes 是给人自己的拆分意图留档。不用 failToBox——那是机器判负的 stderr 口径，
 * 这里是人主动裁决，走 stdout（收箱与搬箱仍由 transitionState 统一负责）。
 */
async function cmdRejectScope(cfg, id, notes) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.runtime.stage !== 'AWAIT_SCOPE_DECISION') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_SCOPE_DECISION），仍写入 scope_decision=split`);
  }
  const round = ts.runtime.current_spec_round ?? 0;
  const acCount = specAcCount(cfg, id);
  state.writeJson(state.dossierPath(cfg, id, 'scope-decision.json'), {
    schema_version: 1,
    decision: 'split',
    round,
    ac_count: acCount,
    max: Number.isFinite(cfg.specMaxAcs) ? cfg.specMaxAcs : null,
    notes: typeof notes === 'string' && notes.trim() !== '' ? notes : null,
    decided_at: new Date().toISOString(),
  });
  state.appendTimeline(cfg, id, `human reject scope：选择拆分（AC×${acCount ?? '?'}）${notes ? `：${notes}` : ''}`);
  state.transitionState(ts, cfg, 'FAILED_BOX', `human 选择拆分（spec 规模升闸 r${round}）`, {
    scope_decision: 'split',
    last_failure_type: 'scope_split',
  });
  console.log(`${id} scope_decision=split → FAILED_BOX（state/failed/）。请按拆分方案新建多个任务；retry 会复位 scope_decision`);
  });
}

/**
 * option 人审闸门（AWAIT_FEASIBILITY_APPROVAL）：approve 必须显式 --option 点名，
 * 无「默认采纳推荐」的静默通过；所选 option 必须真实存在于草稿枚举（机器锚点校验），
 * 校验不过拒绝写入、任务保持原状。notes 是人对所选 option 的补充约束（如「选 O-B 但
 * 去掉缓存部分」），随 decision 冻结进 dossier，成为 spec-agent 的输入。
 */
async function cmdApproveFeasibility(cfg, id, option, notes) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (typeof option !== 'string' || option === '') {
    console.error(`用法：conductor approve-feasibility ${id} --option O-X [--notes "…"]（必须显式点名 option）`);
    process.exitCode = 1;
    return;
  }
  if (ts.runtime.stage !== 'AWAIT_FEASIBILITY_APPROVAL') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_FEASIBILITY_APPROVAL），仍尝试写入 feasibility_approval=approved`);
  }
  // 机器锚点：所选 option 必须存在于草稿的「## 选项对比」枚举。
  let md = null;
  try { md = fs.readFileSync(path.join(ts.dir, 'feasibility-study.md'), 'utf8'); } catch { /* 缺失也是校验失败 */ }
  const check = validateFeasibilityDoc(md);
  const known = check.options.map((o) => o.option_id);
  if (!known.includes(option)) {
    console.error(
      `approve-feasibility 拒绝：option ${option} 不在草稿枚举 {${known.join(', ') || '(空)'}} 中` +
      `${check.ok ? '' : `（草稿本身未过契约门：${check.errors.join('; ')}）`}，任务保持原状`,
    );
    process.exitCode = 1;
    return;
  }
  ts.runtime.feasibility_approval = 'approved';
  ts.runtime.chosen_option = option;
  ts.runtime.feasibility_decision_notes = typeof notes === 'string' && notes.trim() !== '' ? notes : null;
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `human approve feasibility: option=${option}${ts.runtime.feasibility_decision_notes ? `, notes: ${notes}` : ''}`);
  console.log(`${id} feasibility_approval=approved（option=${option}）。下次 conductor run 冻结 memo + decision 并进入 NEEDS_SPEC`);
  });
}

async function cmdRejectFeasibility(cfg, id, notes) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.runtime.stage !== 'AWAIT_FEASIBILITY_APPROVAL') {
    console.error(`警告：${id} 当前 stage=${ts.runtime.stage}（非 AWAIT_FEASIBILITY_APPROVAL），仍写入 feasibility_approval=rejected`);
  }
  ts.runtime.feasibility_approval = 'rejected';
  if (notes) {
    // 打回意见累加到任务目录的 feasibility_reject_notes.md（喂给 feasibility-agent），不入 runtime。
    const p = path.join(ts.dir, 'feasibility_reject_notes.md');
    let existing = '';
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* optional */ }
    state.writeFileEnsured(p, `${existing}- ${new Date().toISOString().slice(0, 10)}: ${notes}\n`);
  }
  state.saveRuntime(ts);
  state.appendTimeline(cfg, id, `human reject feasibility${notes ? `: ${notes}` : ''}`);
  console.log(`${id} feasibility_approval=rejected。下次 conductor run 时退回 feasibility-agent 重产 memo`);
  });
}

// ---- status ----

function cmdStatus(cfg) {
  warnLegacyTasks(cfg); // 旧 .md 任务在任务表里看不到，单独 stderr 告警，避免「(no tasks)」误导（契约 §12）
  const rows = [];
  for (const [box, dir] of BOXES(cfg)) {
    for (const ts of state.listTaskStates(dir, box)) {
      if (ts.error) {
        rows.push({ id: ts.id, kind: '?', stage: `(损坏: ${ts.error})`, miss: '?', inval: '?', spent: '?', box });
        continue;
      }
      rows.push({
        id: ts.task.id ?? ts.id,
        kind: ts.task.kind ?? '?',
        stage: ts.runtime.stage ?? '?',
        miss: String(ts.runtime.maker_miss_count ?? 0),
        inval: String(ts.runtime.verifier_invalid_count ?? 0),
        spent: `$${(ts.runtime.spent_usd ?? 0).toFixed(3)}`,
        box,
      });
    }
  }
  const cols = [
    ['id', 'ID', 22], ['kind', 'KIND', 9], ['stage', 'STAGE', 21],
    ['miss', 'MISS', 6], ['inval', 'INVAL', 7], ['spent', 'SPENT', 10], ['box', 'BOX', 7],
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

// ---- merge ----

async function cmdMerge(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.box !== 'queue' || ts.runtime.stage !== 'AWAIT_HUMAN_MERGE') {
    console.error(`merge 仅适用于 queue 中 stage=AWAIT_HUMAN_MERGE 的任务（当前 box=${ts.box}, stage=${ts.runtime.stage}）`);
    process.exitCode = 1;
    return;
  }
  // merge 舞步（守卫高亮 / committer 提案 / --no-ff / 归档）提取为 performMerge，
  // 与 H33 auto-merge 共用同一实现——文案与行为逐字保持。
  const res = await performMerge(ts, cfg);
  if (!res.ok) {
    console.error(res.error);
    process.exitCode = 1;
    return;
  }
  console.log(`${id} 已 merge 并归档（state/done/），worktree 已清理`);
  });
}

/**
 * probe 终点闸门（H26）：queue 中 AWAIT_PROBE_CLOSE 的任务，调查报告固化进
 * dossier/<id>/probe-report.md 后整目录归档 done。无 merge、无 worktree 清理（probe 不建 worktree）。
 */
async function cmdClose(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.box !== 'queue' || ts.runtime.stage !== 'AWAIT_PROBE_CLOSE') {
    console.error(`close 仅适用于 queue 中 stage=AWAIT_PROBE_CLOSE 的任务（当前 box=${ts.box}, stage=${ts.runtime.stage}）`);
    process.exitCode = 1;
    return;
  }
  // 先产物后状态：报告固化进 dossier（dossier 不随任务目录搬箱，永久可查）。
  const draft = path.join(ts.dir, 'feasibility-study.md');
  if (fs.existsSync(draft)) {
    state.writeFileEnsured(state.dossierPath(cfg, id, 'probe-report.md'), fs.readFileSync(draft, 'utf8'));
    state.appendTimeline(cfg, id, 'probe 报告固化 → dossier/probe-report.md');
  }
  ts.runtime.stage = 'DONE';
  state.saveRuntime(ts);
  const dest = state.taskDir(cfg.doneDir, id);
  fs.mkdirSync(cfg.doneDir, { recursive: true });
  fs.renameSync(ts.dir, dest);
  state.appendTimeline(cfg, id, '归档 → state/done/（probe closed）');
  state.appendEvent(cfg, id, 'stage', { stage: 'DONE', note: 'probe closed' });
  console.log(`${id} 已 close 并归档（state/done/），报告：dossier/${id}/probe-report.md`);
  });
}

// ---- retry ----

/** 把上一攻坚周期的轮次产物移入 attempts/<ts>/（保留案卷，腾出轮次命名空间）。 */
function archiveRoundArtifacts(cfg, id) {
  const n = state.archiveArtifactsMatching(cfg, id, /^((setup|feasibility-agent|spec-agent|spec-verifier|maker|verifier)-r\d+\.stream\.jsonl|maker-r\d+\.json|maker-r\d+\.settings\.json|verifier-r\d+\.json|setup-r\d+\.json|feasibility-agent-r\d+\.json|feasibility-agent-r\d+\.settings\.json|feasibility-check-r\d+(\.hook)?\.json|spec-agent-r\d+\.json|spec-agent-r\d+\.settings\.json|spec-verifier-r\d+\.json|verify-r\d+\.(md|verdict\.json)|verify-r\d+\.invalid-a\d+\.json|spec-verify-r\d+\.(md|verdict\.json)|spec-verify-r\d+\.invalid-a\d+\.json|spec-check-r\d+(\.hook)?\.json|green-gate-r\d+\.json|test-gate-r\d+\.json|repair-context-r\d+\.json|spec-repair-context-r\d+\.json|review-findings\.md)$/);
  if (n > 0) state.appendTimeline(cfg, id, `retry：${n} 个轮次产物移入 attempts/（案卷保留）`);
  return n;
}

/**
 * failed box 的失败类型感知恢复（契约变更：verifier/spec-verifier 协议耗尽不该连累无辜的
 * maker/spec-agent 产出整轮重跑）。前置产物（worktree / spec 草稿）缺失时返回 null，
 * 交回调用方走原有全量重置路径。
 */
function narrowRetryKind(cfg, ts) {
  const type = ts.runtime.last_failure_type;
  if (type === 'verifier_protocol_exhausted' && fs.existsSync(path.join(cfg.worktreesDir, ts.id))) {
    return 'verifier';
  }
  if (type === 'spec_verifier_protocol_exhausted' && fs.existsSync(path.join(cfg.specsDir, `${ts.id}.md`))) {
    return 'spec_verifier';
  }
  if (type === 'env_failure_repeated' && fs.existsSync(path.join(cfg.worktreesDir, ts.id))) {
    return 'env_failure_repeated';
  }
  return null;
}

/** 只归档对应协议失败的 invalid 产物，任务回 queue 且 stage 回到失败前的验收环节，不重跑 maker/spec-agent。 */
function applyNarrowRetry(cfg, ts, kind) {
  const id = ts.id;
  if (kind === 'env_failure_repeated') {
    // 环境类短路收箱：不归档 maker 轮次产物（maker-r<n>.json 双标记原样保留），复位 READY + miss=0；
    // 配合 READY 既有的「maker 标记 done → 跳过 spawn 只复跑绿门」幂等分支，实现
    // 「人工修好环境 → retry → 直接重验，不重跑 maker」。
    Object.assign(ts.runtime, { stage: 'READY', maker_miss_count: 0, last_failure_type: null });
    state.saveRuntime(ts);
    const dest = state.taskDir(cfg.queueDir, id);
    fs.mkdirSync(cfg.queueDir, { recursive: true });
    fs.renameSync(ts.dir, dest);
    ts.dir = dest;
    ts.box = 'queue';
    state.appendTimeline(cfg, id, 'retry → READY（不重跑 maker，直接复跑绿门），maker 轮次产物保留');
    console.log(`${id} 已重回 queue（stage=READY, miss=0），环境类失败已恢复，maker 产出保留，下次 run 只复跑绿门`);
    return;
  }
  const isVerifier = kind === 'verifier';
  const n = state.archiveArtifactsMatching(
    cfg, id,
    isVerifier ? /^verify-r\d+\.invalid-a\d+\.json$/ : /^spec-verify-r\d+\.invalid-a\d+\.json$/,
  );
  Object.assign(ts.runtime, isVerifier
    ? { stage: 'VERIFY', verifier_invalid_count: 0, last_failure_type: null }
    : { stage: 'SPEC_VERIFY', spec_verifier_invalid_count: 0, last_failure_type: null });
  state.saveRuntime(ts);
  const dest = state.taskDir(cfg.queueDir, id);
  fs.mkdirSync(cfg.queueDir, { recursive: true });
  fs.renameSync(ts.dir, dest);
  ts.dir = dest;
  ts.box = 'queue';
  const label = isVerifier ? 'VERIFY（不重跑 maker）' : 'SPEC_VERIFY（不重跑 spec-agent）';
  state.appendTimeline(cfg, id, `retry → ${label}，${n} 个 invalid 产物移入 attempts/`);
  console.log(`${id} 已重回 queue（stage=${ts.runtime.stage}），协议失败已恢复，${isVerifier ? 'maker' : 'spec 草稿'}产出保留`);
}

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
  const stage = rl.resume_stage ?? 'READY';
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
  if (isRateLimitedTask(ts)) { applyRateLimitRetry(cfg, ts, { force: opts.force === true }); return; }
  if (ts.box === 'failed' && ROUTER_RETRY_TYPES.has(ts.runtime.last_failure_type)) {
    applyRouterRetry(cfg, ts);
    return;
  }
  if (ts.box === 'failed') {
    const narrow = narrowRetryKind(cfg, ts);
    if (narrow) { applyNarrowRetry(cfg, ts, narrow); return; }
  }
  archiveRoundArtifacts(cfg, id);
  if (ts.box === 'failed') {
    // reset runtime（契约 §12）。复位目标按「冻结产物走到哪」倒推：
    // feasibility gate 任务缺冻结 memo → NEEDS_FEASIBILITY；缺冻结 spec → NEEDS_SPEC；否则 READY。
    // probe（H26）没有实现链，恒回 NEEDS_FEASIBILITY 重产报告。
    const retryStage = ts.task.kind === 'probe' ? 'NEEDS_FEASIBILITY'
      : ts.task.kind !== 'feature' ? 'READY'
        : ts.task.feasibility === true && !fs.existsSync(state.dossierPath(cfg, id, 'feasibility-study.md')) ? 'NEEDS_FEASIBILITY'
          : !fs.existsSync(state.dossierPath(cfg, id, 'spec.md')) ? 'NEEDS_SPEC' : 'READY';
    Object.assign(ts.runtime, {
      stage: retryStage,
      maker_miss_count: 0,
      crash_recovery_count: 0, // 人工 retry 后重新享有完整自动恢复额度（人已看过一眼，界重新计）
      verifier_invalid_count: 0,
      spec_miss_count: 0,
      spec_verifier_invalid_count: 0,
      spec_contract_invalid_count: 0,
      feasibility_contract_invalid_count: 0,
      scope_decision: null, // scope_split 收箱后 retry 应回到「可再升闸」的状态，豁免不随任务复活
      maker_session_id: null,
      last_failure_type: null,
    });
    state.saveRuntime(ts);
    const dest = state.taskDir(cfg.queueDir, id);
    fs.mkdirSync(cfg.queueDir, { recursive: true });
    fs.renameSync(ts.dir, dest);
    ts.dir = dest;
    ts.box = 'queue';
    state.appendTimeline(cfg, id, `human retry：FAILED_BOX → ${ts.runtime.stage}（miss/inval 重置，案卷保留）`);
    console.log(`${id} 已重回 queue（stage=${ts.runtime.stage}, miss=0, inval=0）`);
    if ((ts.runtime.spent_usd ?? 0) >= cfg.budgetUsd) {
      console.error(
        `警告：spent_usd=$${ts.runtime.spent_usd} 仍 >= budgetUsd=$${cfg.budgetUsd}，` +
        '下次 run 会再次进 FAILED_BOX。请上调 conductor.config.json 的 budgetUsd 或手动改 runtime.json 的 spent_usd。',
      );
    }
  } else {
    // queue 中崩溃残留（started 无 done）的人工清理路径。自动恢复额度同样复位：与 FAILED_BOX
    // 全量重置一个语义——人工介入过一次，界就重新计。
    ts.runtime.crash_recovery_count = 0;
    state.saveRuntime(ts);
    state.appendTimeline(cfg, id, 'human retry：清理崩溃残留标记');
    console.log(`${id} 在 queue 中（stage=${ts.runtime.stage}），已清理轮次标记，下次 run 重新 spawn`);
  }
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
  new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]
                                       新建任务（stage=ROUTING，由 router 逐轮决定下一步）；
                                       目标仓必须已配好 setup-profile.json 的 precommit 段
  approve <id> [--notes "…"] [--message "…"]
                                       人闸批准：spec 闸冻结 spec 回 ROUTING；merge 闸本地合并后归档
                                       （按批准时刻的 H/B 重算版本规则，不满足则拒并回 ROUTING；不 push）
  reject <id> --notes "…"              spec / merge 闸打回 → ROUTING，notes 进「已裁决事项」
  resume <id> [--notes "…"]            help 闸恢复 → ROUTING（notes 只进记录，不豁免版本规则）
  abandon <id>                         放弃任务 → FAILED_BOX(abandoned)，清 worktree 与任务分支

遗留动词（P3 删；只服务 P2 之前建的任务）：
  new --kind bugfix|feature|probe --title "…" [--brief <file>] [--feasibility] [--repo <path>]
                                       旧五闸状态机的建单形态
  approve-feasibility <id> --option O-X [--notes "…"]
                                       按 option ID 点名批准 feasibility memo（无静默通过）
  reject-feasibility <id> [--notes "…"] 打回 feasibility memo，notes 追加进 feasibility_reject_notes.md
  approve-setup <id>                   批准 target repo setup profile（AWAIT_SETUP_APPROVAL 闸门）
  approve-scope <id>                   规模人闸（AWAIT_SCOPE_DECISION）：接受当前 spec 规模，
                                       挂起的 spec-verifier fail 入账继续修复循环，此后不再升闸
  reject-scope <id> [--notes "…"]      规模人闸：选择拆分 → 任务收箱（last_failure_type=scope_split），
                                       notes 随裁决落 dossier/scope-decision.json
  status                               打印任务表（queue / failed / done）
  spy                                  只读查看 queue 任务的运行中角色与最近活动
  merge <id>                           人工终点闸门：合入分支、归档、清 worktree
  close <id>                           probe 终点闸门：调查报告固化进 dossier 后归档（无 merge）
  retry <id> [--force]                 新任务：FAILED_BOX(fuse_no_progress|budget_exhausted|abandoned)
                                       → ROUTING（案卷不动，保险丝连击复位）；旧任务 → READY（重置 miss）；
                                       限额收箱（rate_limited）的任务回到命中时的 stage，且必须在
                                       重置时刻之后（--force 可越过，会再次撞限额）
  retry --rate-limited [--force]       批量恢复 failed 箱里全部限额收箱的任务`;

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
    case 'approve-setup': await cmdApproveSetup(cfg, opts._[0]); break;
    case 'approve-feasibility': await cmdApproveFeasibility(cfg, opts._[0], opts.option, opts.notes); break;
    case 'reject-feasibility': await cmdRejectFeasibility(cfg, opts._[0], opts.notes); break;
    case 'reject': await cmdReject(cfg, opts._[0], opts.notes); break;
    case 'approve-scope': await cmdApproveScope(cfg, opts._[0]); break;
    case 'reject-scope': await cmdRejectScope(cfg, opts._[0], opts.notes); break;
    case 'status': cmdStatus(cfg); break;
    case 'spy': cmdSpy(cfg); break;
    case 'merge': await cmdMerge(cfg, opts._[0]); break;
    case 'close': await cmdClose(cfg, opts._[0]); break;
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
