#!/usr/bin/env node
// conductor.mjs — CLI 入口 + drain 循环。确定性、可重入、幂等：conductor 是脚本，不是 agent。
// 子命令：run / new / approve-setup / approve / reject / status / merge / retry。
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
import { runCommitterProposal } from './stages/shared.mjs';
import { validateFeasibilityDoc } from './lib/feasibility-contract.mjs';
import { validateSpecDoc } from './lib/spec-contract.mjs';
import needsTargetSetupHandler from './stages/needs_target_setup.mjs';
import awaitSetupApprovalHandler from './stages/await_setup_approval.mjs';
import needsFeasibilityHandler from './stages/needs_feasibility.mjs';
import awaitFeasibilityApprovalHandler from './stages/await_feasibility_approval.mjs';
import needsSpecHandler from './stages/needs_spec.mjs';
import specVerifyHandler from './stages/spec_verify.mjs';
import specFixingHandler from './stages/spec_fixing.mjs';
import awaitSpecApprovalHandler from './stages/await_spec_approval.mjs';
import readyHandler from './stages/ready.mjs';
import verifyHandler from './stages/verify.mjs';
import fixingHandler from './stages/fixing.mjs';

const STAGE_HANDLERS = {
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
  // 终态：只响应人工 merge / retry 命令
  AWAIT_HUMAN_MERGE: async () => ({ changed: false }),
  FAILED_BOX: async () => ({ changed: false }),
};

// ---- 配置与路径 ----

export function resolveRoot() {
  if (process.env.CONDUCTOR_ROOT) return path.resolve(process.env.CONDUCTOR_ROOT);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function loadCfg(root = resolveRoot()) {
  const defaults = {
    budgetUsd: 5,
    maxTurns: 30,
    testCommand: 'node --test',
    targetRepo: './target',
    baseBranch: null, // null = new 时读 currentBranch(targetRepo) 兜底 'main'
    maxMakerMisses: 3, // maker 可行动失败阶梯上限（契约 §3）
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
    spawnRetries: 6, // Claude 瞬态重试次数（H7：长尾覆盖限流窗口）
    spawnBackoffMs: [15000, 30000, 60000, 120000, 300000, 600000], // 瞬态重试退避（H7：尾部 5min/10min 穿越 429 窗口）
    verifierShadowEnabled: false, // verifier shadow 观测实验（R4-E11）：默认关；开启也绝不影响状态机
    verifierShadowBackend: 'codex-exec', // 当前唯一支持的 shadow 后端（codex CLI 非交互形态）
    verifierShadowModel: null, // 传给 codex exec -m；null 用 codex 本地默认
    verifierShadowTimeoutMs: 1800000, // shadow 墙钟上限（与 green gate 同量级），超时只记 shadow 失败
    makerMaxTurnsContinuations: 1, // maker 撞 max-turns 时同会话续跑次数上限（0 = 关闭，恢复截断即进 gate 的旧行为）
    maxConcurrentTasks: 3,
    inactivityTimeoutMs: 600000,
    spawnWallClockMs: 14400000,
    greenGateTimeoutMs: 1800000,
    lockHeartbeatMs: 60000,
    maxStepsPerTask: 20,
    runBudgetUsd: null,
    models: { setup: null, feasibility: null, spec: null, specVerifier: null, maker: null, verifier: null, committer: null },
  };
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(root, 'conductor.config.json'), 'utf8'));
  } catch { /* 配置缺失时用默认值 */ }
  const deprecatedMaxDrainStepsConfigured = Object.hasOwn(user, 'maxDrainSteps');
  const merged = { ...defaults, ...user, models: { ...defaults.models, ...(user.models ?? {}) } };
  delete merged.maxDrainSteps;
  return {
    ...merged,
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

function cmdNew(cfg, opts) {
  const kind = opts.kind;
  if (kind !== 'bugfix' && kind !== 'feature') {
    console.error('用法：conductor new --kind bugfix|feature --title "..."');
    process.exitCode = 1;
    return;
  }
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
  const naturalStage = kind === 'feature' ? (feasibility ? 'NEEDS_FEASIBILITY' : 'NEEDS_SPEC') : 'READY';
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
    verifier_invalid_count: 0,
    spec_miss_count: 0,
    spec_verifier_invalid_count: 0,
    spec_contract_invalid_count: 0,
    spec_epoch: 1,
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
  } else if (feasibility) {
    console.log('feature 档（feasibility gate）：conductor run 会先让 feasibility-agent 产出决策 memo，等你 approve-feasibility --option 点名后再进 spec 链');
  } else {
    console.log('feature 档：conductor run 会先让 spec-agent 产出草稿，经 spec-verifier 后等你 approve/reject');
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

async function cmdApprove(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
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
    const m = n.match(/^(setup|feasibility-agent|spec-agent|spec-verifier|maker|verifier)-r(\d+)\.json$/);
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
  const tcfg = taskCfg(ts, cfg);
  const cur = currentBranch(tcfg.targetRepo);
  if (cur !== ts.task.baseBranch) {
    console.error(`merge 拒绝：target 仓库当前分支 ${cur} ≠ 任务 baseBranch ${ts.task.baseBranch}（任务保持原状）`);
    process.exitCode = 1;
    return;
  }
  const branch = `task/${id}`;
  const wt = path.join(cfg.worktreesDir, id);
  // merge commit 文案：committer 提案 + validateCommitMessage 裁决，两次不过 / 预算超限
  // 降级机器文案（fail-open，绝不 block merge）。轮次 commit 颗粒度不丢：merge 保持
  // --no-ff，任务分支上的 maker r<n> commit 原样保留在历史里。
  const proposal = await runCommitterProposal(ts, cfg);
  try {
    mergeBranch(tcfg.targetRepo, branch, proposal ?? `merge ${branch} (conductor)`);
  } catch (err) {
    console.error(`merge 失败（任务保持原状）：${err.message}`);
    process.exitCode = 1;
    return;
  }
  state.appendTimeline(cfg, id, `merged ${branch} → ${currentBranch(tcfg.targetRepo)}`);
  removeWorktree(tcfg.targetRepo, wt);
  deleteBranch(tcfg.targetRepo, branch);
  // 归档：先产物（merge 已完成）后状态。
  ts.runtime.stage = 'DONE';
  state.saveRuntime(ts);
  const dest = state.taskDir(cfg.doneDir, id);
  fs.mkdirSync(cfg.doneDir, { recursive: true });
  fs.renameSync(ts.dir, dest);
  state.appendTimeline(cfg, id, '归档 → state/done/');
  console.log(`${id} 已 merge 并归档（state/done/），worktree 已清理`);
  });
}

// ---- retry ----

/** 把 dossier 内匹配 pattern 的产物移入 attempts/<ts>/；无匹配则不建目录，返回 0。 */
function archiveArtifactsMatching(cfg, id, pattern) {
  const dir = state.dossierPath(cfg, id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const targets = names.filter((n) => pattern.test(n));
  if (targets.length === 0) return 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, 'attempts', stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const n of targets) fs.renameSync(path.join(dir, n), path.join(dest, n));
  return targets.length;
}

/** 把上一攻坚周期的轮次产物移入 attempts/<ts>/（保留案卷，腾出轮次命名空间）。 */
function archiveRoundArtifacts(cfg, id) {
  const n = archiveArtifactsMatching(cfg, id, /^((setup|feasibility-agent|spec-agent|spec-verifier|maker|verifier)-r\d+\.stream\.jsonl|maker-r\d+\.json|maker-r\d+\.settings\.json|verifier-r\d+\.json|setup-r\d+\.json|feasibility-agent-r\d+\.json|feasibility-agent-r\d+\.settings\.json|feasibility-check-r\d+(\.hook)?\.json|spec-agent-r\d+\.json|spec-agent-r\d+\.settings\.json|spec-verifier-r\d+\.json|verify-r\d+\.(md|verdict\.json)|verify-r\d+\.invalid-a\d+\.json|spec-verify-r\d+\.(md|verdict\.json)|spec-verify-r\d+\.invalid-a\d+\.json|spec-check-r\d+(\.hook)?\.json|green-gate-r\d+\.json|test-gate-r\d+\.json|repair-context-r\d+\.json|spec-repair-context-r\d+\.json|review-findings\.md)$/);
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
  const n = archiveArtifactsMatching(
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

async function cmdRetry(cfg, id) {
  return withCliTaskMutation(cfg, id, async () => {
  const ts = findTask(cfg, id);
  if (!ts) { console.error(`找不到任务 ${id}`); process.exitCode = 1; return; }
  if (ts.error) { console.error(`${id} 任务目录损坏：${ts.error}`); process.exitCode = 1; return; }
  if (ts.box === 'done') {
    console.error(`${id} 已归档（done），不支持 retry`);
    process.exitCode = 1;
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
    const retryStage = ts.task.kind !== 'feature' ? 'READY'
      : ts.task.feasibility === true && !fs.existsSync(state.dossierPath(cfg, id, 'feasibility-study.md')) ? 'NEEDS_FEASIBILITY'
        : !fs.existsSync(state.dossierPath(cfg, id, 'spec.md')) ? 'NEEDS_SPEC' : 'READY';
    Object.assign(ts.runtime, {
      stage: retryStage,
      maker_miss_count: 0,
      verifier_invalid_count: 0,
      spec_miss_count: 0,
      spec_verifier_invalid_count: 0,
      spec_contract_invalid_count: 0,
      feasibility_contract_invalid_count: 0,
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
    // queue 中崩溃残留（started 无 done）的人工清理路径
    state.appendTimeline(cfg, id, 'human retry：清理崩溃残留标记');
    console.log(`${id} 在 queue 中（stage=${ts.runtime.stage}），已清理轮次标记，下次 run 重新 spawn`);
  }
  });
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
  new --kind bugfix|feature --title "…" [--brief <file>] [--feasibility] [--repo <path>]
                                       新建任务（--brief 落盘需求原文；--feasibility 让 feature 先走
                                       feasibility gate，缺省随 config.feasibilityEnabled；--repo 覆盖
                                       快照的 targetRepo，缺省用 conductor.config.json 的 targetRepo）
  approve-feasibility <id> --option O-X [--notes "…"]
                                       按 option ID 点名批准 feasibility memo（无静默通过）
  reject-feasibility <id> [--notes "…"] 打回 feasibility memo，notes 追加进 feasibility_reject_notes.md
  approve <id>                         批准 spec（AWAIT_SPEC_APPROVAL 闸门）
  approve-setup <id>                   批准 target repo setup profile（AWAIT_SETUP_APPROVAL 闸门）
  reject <id> [--notes "…"]            打回 spec，notes 追加进任务目录 reject_notes.md
  status                               打印任务表（queue / failed / done）
  spy                                  只读查看 queue 任务的运行中角色与最近活动
  merge <id>                           人工终点闸门：合入分支、归档、清 worktree
  retry <id>                           FAILED_BOX → READY（重置 miss，保留案卷）/ 清理崩溃标记`;

export async function main(argv = process.argv.slice(2)) {
  const { cmd, opts } = parseArgs(argv);
  const cfg = loadCfg();
  ensureDirs(cfg);
  switch (cmd) {
    case 'run': await cmdRun(cfg); break;
    case 'new': cmdNew(cfg, opts); break;
    case 'approve': await cmdApprove(cfg, opts._[0]); break;
    case 'approve-setup': await cmdApproveSetup(cfg, opts._[0]); break;
    case 'approve-feasibility': await cmdApproveFeasibility(cfg, opts._[0], opts.option, opts.notes); break;
    case 'reject-feasibility': await cmdRejectFeasibility(cfg, opts._[0], opts.notes); break;
    case 'reject': await cmdReject(cfg, opts._[0], opts.notes); break;
    case 'status': cmdStatus(cfg); break;
    case 'spy': cmdSpy(cfg); break;
    case 'merge': await cmdMerge(cfg, opts._[0]); break;
    case 'retry': await cmdRetry(cfg, opts._[0]); break;
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
