// lib/agent-settings.mjs — 各角色的 spawn 参数与 hook 护栏（spec §角色、工具、hook、模型）。
// 纯函数 buildAgentSpawnSpec 负责「派出参数长什么样」，writeAgentSettings 是唯一的落盘口
// （逐轮 `.settings.json` 进 dossier 留档）。显式 --settings 注入，不依赖 target 仓库自带的
// .claude/settings.json（不可信、不可控）。
//
// 权限按**真实副作用**分档，不按角色名分档：
//   - 无执行能力（router / digest / reviewer / spec / worker:read）：`--tools` 里根本没有 Bash，
//     写入只能走 Write/Edit，而它们被 write-guard 的绝对路径白名单收口。这一档的边界是硬的：
//     工具集由宿主 CLI 的 `--tools` 保证，写白名单由本仓 hook 保证。
//   - 有执行能力（maker / worker:sandbox / worker:write）：Bash 是任意执行。我们能保证的是：
//     工具集是显式白名单（没有 Task / Cron / RemoteTrigger / SendMessage 之类不入账、不继承限制的
//     旁路）、git 与 claude CLI 的命令文本护栏（尽力而为，**不是隔离**）、以及内核在每次执行后的
//     机械核对（lib/integrity.mjs：历史案卷 / 冻结 spec / 人闸裁决 / 内核策略文件被动过就还原并记违规；
//     sandbox 档结束后任务分支 ref 必须原样）。真正的文件 / 网络 / 进程隔离只能由宿主运行时给：
//     `workerSandbox.enabled=true` 时把 Claude Code 的 OS 沙盒（macOS Seatbelt / Linux bubblewrap）
//     配进该轮 settings，并在 spawn 记录里如实标 `isolation`。默认不开——各目标仓的工具链缓存
//     （pnpm store、~/.npm …）与所需域名要人按仓配置，内核不猜。
//
// 边界纪律（AC-025）：
//   - router 没有 Bash：只读三件 + Write，写白名单只有自己的 log 与工作记忆（router-notes.json），
//     读范围由 read-guard 收口在本任务的案卷 / spec / worktree —— 它能读懂内容，但读取能力不扩大
//     执行权限：不执行 git、不改任何产品文件、更不可能 push，也改不了 spec。
//   - digest 只有 Write：spec 原文由内核带行号内联进 prompt，它连读盘能力都没有；
//     写白名单只有这一版摘要与自己的 log。
//   - reviewer 只读三件 + Write（`--tools` 里的 `Bash(git …)` 写法实测不会给出 Bash，它靠内核物化的
//     `views/<head>.patch` 读大 diff），白名单是 log + 本轮判决台账 + 报告。
//   - spec 写 spec 时白名单是 spec + packages + log；**方案模式只有 packages + log**
//     （Invariant 8：方案不改范围，对 spec 正文的 Write/Edit 必须在落盘前被拒）。
//   - maker 是显式工具白名单（EXEC_TOOLS）、Bash 免审批，护栏是 maker-git-guard；worktree 之外只放行
//     本轮 log 这一个文件（`Edit(//…log.json)` 权限规则，见 makerAllowedTools），dossier 其余文件仍不可写
//     （Bash 绕得过这条规则，所以另有 lib/integrity.mjs 的事后核对）。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * hook 脚本是内核代码，跟着内核走，不跟着数据根（cfg.root）走：CONDUCTOR_ROOT 指到别处
 * （隔离的验收根、测试根）时，那里只有 config / state / dossier，没有 conductor/hooks/。
 * 曾经按 cfg.root 拼路径——脚本找不到时 Claude Code 只报一条非阻断的 hook 错误就继续，
 * 等于所有写白名单 / 读范围 / Stop 校验静默失效（受控真实执行里抓到的）。
 */
const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

export const READONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * 有执行能力的角色（maker / worker:sandbox / worker:write）的显式工具白名单。
 * 曾经是「不传 --tools = 全工具集」，而真实 CLI 的全工具集里有 Task、CronCreate、RemoteTrigger、
 * SendMessage、ScheduleWakeup、Workflow……（见 dossier 里任一份 maker stream 的 init 事件）——
 * 每一个都是不经内核授权、不单独入账、不受停止控制的旁路。白名单之外一律不可见。
 * 递归委派本版不开放：要再拆任务，回到 router。
 */
export const EXEC_TOOLS = Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'WebSearch']);

/** `--tools` 硬限制（宿主 CLI 保证：名单之外的工具对该会话不存在）。 */
export const ROLE_TOOLS = Object.freeze({
  router: Object.freeze([...READONLY_TOOLS, 'Write']),
  digest: Object.freeze(['Write']),
  spec: Object.freeze([...READONLY_TOOLS, 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Write', 'Edit']),
  maker: EXEC_TOOLS,
  reviewer: Object.freeze([...READONLY_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Write']),
});

/** worker 的工具集由 profile 决定（lib/assignment-contract.mjs::PROFILES）。 */
export const WORKER_TOOLS = Object.freeze({
  read: Object.freeze([...READONLY_TOOLS, 'Write', 'WebFetch', 'WebSearch']),
  sandbox: EXEC_TOOLS,
  write: EXEC_TOOLS,
});

/**
 * maker 的静态免审批集合：Bash（工具集不设限，只免 Bash 的审批，其余走 acceptEdits）。
 * 逐轮再叠加一条只放行本轮 log 的 Edit 规则，见 makerAllowedTools。
 */
export const MAKER_ALLOWED_TOOLS = Object.freeze(['Bash']);

/**
 * 各角色单次会话的轮次上限；plan 是方案模式的 spec-agent（独立配置，spec §config）。
 * router 从 4 提到 40：它现在要读摘要、按引用回原文、看产物再决定，4 轮只够写一行 log。
 * 单次上限不是任务容量：撞上限的会话留下增量 log 与已落盘的工作，下一轮续会话或重新分派
 * （见 stages/actions/dispatch.mjs）；整任务的上限是 budgetUsd 与 maxRoundsPerTask。
 */
export const DEFAULT_MAX_TURNS = Object.freeze({
  router: 40, digest: 12, spec: 40, plan: 25, maker: 70, reviewer: 60,
  workerRead: 60, workerSandbox: 120, workerWrite: 150,
});

/** cwd 语义（表格第二列）：内核据此建/复用 worktree。 */
export const CWD_KIND = Object.freeze({
  router: 'task-dossier',
  digest: 'task-dossier',
  workerRead: 'snapshot-worktree',
  workerSandbox: 'scratch-worktree',
  workerWrite: 'assignment-worktree',
  spec: 'spec-ro-worktree',
  plan: 'plan-ro-worktree',
  maker: 'task-worktree',
  makerPackage: 'package-worktree',
  reviewer: 'task-worktree',
});

const AGENT_ROLES = Object.freeze(['router', 'spec', 'maker', 'reviewer', 'digest', 'worker']);

const PROFILE_TURN_KEY = Object.freeze({ read: 'workerRead', sandbox: 'workerSandbox', write: 'workerWrite' });

function assertProfile(role, profile) {
  if (role === 'worker' && !Object.hasOwn(PROFILE_TURN_KEY, profile ?? '')) {
    throw new Error(`worker 必须带 profile（read | sandbox | write），实际 ${JSON.stringify(profile)}`);
  }
}

function assertRole(role) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`未知角色：${role}（应为 ${AGENT_ROLES.join(' | ')}）`);
}

/** 产物基名：方案模式是 spec-plan，包 maker 带包段，worker 带委派 key，其余就是角色名。 */
export function artifactBase(role, { mode = null, pkg = null, key = null } = {}) {
  assertRole(role);
  if (role === 'spec' && mode === 'plan') return 'spec-plan';
  if (role === 'worker') {
    if (!key) throw new Error('worker 的产物名需要委派 key');
    return `worker-${key}`;
  }
  return pkg ? `${role}-${pkg}` : role;
}

/** `dossier/<id>/<base>-r<n>.<suffix>` 的统一构造点（log / hook 报告 / settings 三者同名不同后缀）。 */
export function artifactPath(cfg, id, role, round, suffix, { mode = null, pkg = null, key = null } = {}) {
  return path.join(cfg.dossierDir, id, `${artifactBase(role, { mode, pkg, key })}-r${round}.${suffix}`);
}

/** 完整产物（不受短 log 长度限制）：worker / maker 的报告，reviewer 的逐条判决台账。 */
export function reportPathFor(cfg, id, role, round, opts = {}) {
  return artifactPath(cfg, id, role, round, 'report.md', opts);
}

export function verdictsPathFor(cfg, id, round) {
  return artifactPath(cfg, id, 'reviewer', round, 'verdicts.json');
}

/** router 的工作记忆（跨轮保留；内核逐轮留快照，见 lib/router-notes.mjs）。 */
export function routerNotesPath(cfg, id) {
  return path.join(cfg.dossierDir, id, 'router-notes.json');
}

export function logPathFor(cfg, id, role, round, opts = {}) {
  return artifactPath(cfg, id, role, round, 'log.json', opts);
}

/** 轮次上限：config 覆盖优先（cfg.maxTurns 可以是数字或按角色的对象），否则用表格默认值。 */
export function maxTurnsFor(cfg, role, { mode = null, profile = null } = {}) {
  assertRole(role);
  assertProfile(role, profile);
  const key = role === 'worker' ? PROFILE_TURN_KEY[profile] : (role === 'spec' && mode === 'plan' ? 'plan' : role);
  const configured = cfg?.maxTurns;
  if (configured != null && typeof configured === 'object' && Number.isFinite(configured[key])) {
    return configured[key];
  }
  return DEFAULT_MAX_TURNS[key];
}

function cwdKindFor(role, { mode = null, pkg = null, profile = null } = {}) {
  if (role === 'spec') return mode === 'plan' ? CWD_KIND.plan : CWD_KIND.spec;
  if (role === 'maker') return pkg ? CWD_KIND.makerPackage : CWD_KIND.maker;
  if (role === 'worker') return CWD_KIND[PROFILE_TURN_KEY[profile]];
  return CWD_KIND[role];
}

/** worker 的默认 worktree 位置（`inplace` 的 write 直接用任务 worktree，由调用方显式传 cwd）。 */
export function workerWorktreePath(cfg, id, profile, key) {
  if (profile === 'read') return path.join(cfg.worktreesDir, `${id}.r-${key}`);
  if (profile === 'sandbox') return path.join(cfg.worktreesDir, `${id}.x-${key}`);
  return path.join(cfg.worktreesDir, `${id}--${key}`);
}

function cwdFor(cfg, id, role, { mode = null, pkg = null, profile = null, key = null } = {}) {
  if (role === 'worker') return workerWorktreePath(cfg, id, profile, key);
  switch (cwdKindFor(role, { mode, pkg })) {
    case CWD_KIND.router: return path.join(cfg.dossierDir, id); // router / digest 同一档：案卷目录
    case CWD_KIND.spec: return path.join(cfg.worktreesDir, `${id}.spec-ro`);
    case CWD_KIND.plan: return path.join(cfg.worktreesDir, `${id}.plan-ro`);
    case CWD_KIND.makerPackage: return path.join(cfg.worktreesDir, `${id}--${pkg}`);
    default: return path.join(cfg.worktreesDir, id);
  }
}

/** 有执行能力的派出（Bash 可用）：maker，以及 sandbox / write 档的 worker。 */
export function isExecSpawn(role, profile = null) {
  return role === 'maker' || (role === 'worker' && (profile === 'sandbox' || profile === 'write'));
}

/**
 * 写路径白名单（PreToolUse: write-guard 的 --allow 列表）。有执行能力的派出不挂 write-guard：
 * worktree 内的编辑由 acceptEdits 放行，worktree 之外只有本轮 log / report 由权限规则放行。
 */
export function allowedWritePaths(cfg, id, role, round, opts = {}) {
  const { mode = null, pkg = null, key = null, profile = null, packagesEnabled = false, digestPath = null } = opts;
  const logPath = logPathFor(cfg, id, role, round, { mode, pkg, key });
  if (role === 'router') return [logPath, routerNotesPath(cfg, id)];
  if (role === 'digest') return [...(digestPath ? [digestPath] : []), logPath];
  if (role === 'reviewer') return [logPath, verdictsPathFor(cfg, id, round), reportPathFor(cfg, id, role, round)];
  if (role === 'worker') return isExecSpawn(role, profile) ? [] : [logPath, reportPathFor(cfg, id, role, round, { key })];
  if (role !== 'spec') return [logPath];
  const packagesPath = path.join(cfg.specsDir, `${id}.packages.json`);
  if (mode === 'plan') return [packagesPath, logPath]; // 方案模式：spec 正文不可写
  const paths = [path.join(cfg.specsDir, `${id}.md`)];
  if (packagesEnabled) paths.push(packagesPath); // 阶段闸关时连路径都不放行（AC-044）
  paths.push(logPath);
  return paths;
}

/**
 * 文件权限规则的绝对路径写法：`//` 开头才是文件系统根（单个 `/` 是相对 settings 源）。
 * Claude Code 只查 `Edit(path)` / `Read(path)` 两种文件规则，`Write(path)` 会被接受但从不生效
 * （v2.1.210+，docs/en/permissions「Read and Edit」节；2.1.270 无头实测同样被拒），
 * 而 Edit 规则覆盖所有内置写文件工具（含 Write），所以放行 Write 也要写成 Edit(…)。
 */
function editRuleFor(absPath) {
  return `Edit(//${path.resolve(absPath).replace(/^\/+/, '')})`;
}

/**
 * maker 的 `--allowedTools`：Bash 免审批 + 只放行本轮 log 绝对路径的 Edit 规则。
 * acceptEdits 只自动放行 cwd（任务 worktree）内的编辑；log 在 worktree 之外的 dossier/<id>/，
 * 无头模式下没有这条规则时 Write 会被当作 user-rejected，内核记成 product: "missing"
 * （task-20260914-003 r6/r7 即此）。规则精确到文件，不用 --add-dir 放开整个 dossier。
 */
export function makerAllowedTools(cfg, id, round, { pkg = null } = {}) {
  return [...MAKER_ALLOWED_TOOLS, editRuleFor(logPathFor(cfg, id, 'maker', round, { pkg }))];
}

/**
 * 有执行能力的 worker 的 `--allowedTools`：Bash 免审批、只读三件免审批（spec / 摘要 / 别人的报告都在
 * worktree 之外的案卷里——Bash 本来就读得到，放行 Read 不增加任何能力），外加只放行本轮 log 与
 * report 两个文件的 Edit 规则。联网工具只在 `workerWebAccess !== false` 时免审批。
 */
export function workerExecAllowedTools(cfg, id, round, { key }) {
  return [
    'Bash', ...READONLY_TOOLS,
    editRuleFor(logPathFor(cfg, id, 'worker', round, { key })),
    editRuleFor(reportPathFor(cfg, id, 'worker', round, { key })),
    ...(cfg?.workerWebAccess === false ? [] : ['WebFetch', 'WebSearch']),
  ];
}

/**
 * 读取类工具的秘密拒读规则（宿主 CLI 执法，覆盖 Read，并尽力覆盖 Grep / Glob 的搜索结果）。
 * read-guard hook 只看得到工具的目标路径；「在允许的目录里 Grep 到了 .env 的内容」要靠这一层。
 * `.env.example` 这类占位模板不在其内。
 */
export const SECRET_READ_DENY = Object.freeze([
  'Read(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.*.local)', 'Read(**/.env.development)',
  'Read(**/.env.production)', 'Read(**/.env.staging)', 'Read(**/.env.test)',
  'Read(**/.npmrc)', 'Read(**/.netrc)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa)', 'Read(**/id_ed25519)',
]);

const q = (s) => JSON.stringify(s); // 路径含空格时 shell 安全

function hookCmd(cfg, script, args) {
  return `${q(process.execPath)} ${q(path.join(HOOKS_DIR, script))} ${args.join(' ')}`;
}

/**
 * OS 沙盒段（宿主运行时保证的那一层）。`sandbox` 由内核按 cfg.workerSandbox 与该轮的 cwd / 产物
 * 路径算好传进来（stages/router-kernel.mjs::sandboxFor）；这里只负责编码成 Claude Code 的 settings 键。
 * allowUnsandboxedCommands=false：不许模型用 dangerouslyDisableSandbox 自己逃出去。
 */
function sandboxSettings(sandbox) {
  if (!sandbox || sandbox.enabled !== true) return {};
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [...(sandbox.allowWrite ?? [])],
        denyWrite: [...(sandbox.denyWrite ?? [])],
        denyRead: [...(sandbox.denyRead ?? [])],
      },
      network: {
        allowedDomains: [...(sandbox.allowedDomains ?? [])],
        strictAllowlist: true,
      },
    },
  };
}

/**
 * 该轮的 settings JSON（hooks 护栏 + 可选 OS 沙盒）。纯函数：不碰磁盘。
 * PreToolUse：无执行能力的角色挂写白名单（write-guard），router / worker:read 另挂读范围（read-guard）；
 * 有执行能力的角色挂 Bash 护栏（maker-git-guard：git 破坏性操作 + 嵌套 claude CLI）。
 * Stop：check-log；spec 起草轮叠加 check-spec，digest 叠加 check-digest。
 */
export function buildAgentSettings(cfg, id, role, round, opts = {}) {
  assertRole(role);
  const {
    mode = null, pkg = null, key = null, profile = null, planActive = false,
    readRoots = [], digest = null, sandbox = null,
  } = opts;
  assertProfile(role, profile);
  const logPath = logPathFor(cfg, id, role, round, { mode, pkg, key });
  const report = artifactPath(cfg, id, role, round, 'log.hook.json', { mode, pkg, key });

  let preToolUse;
  if (isExecSpawn(role, profile)) {
    preToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd(cfg, 'maker-git-guard.mjs', []) }] }];
  } else {
    const allows = allowedWritePaths(cfg, id, role, round, { ...opts, digestPath: digest?.path ?? null });
    preToolUse = [{
      matcher: 'Write|Edit|MultiEdit|NotebookEdit',
      hooks: [{ type: 'command', command: hookCmd(cfg, 'write-guard.mjs', allows.map((p) => `--allow ${q(p)}`)) }],
    }];
    if ((role === 'router' || role === 'worker') && readRoots.length > 0) {
      preToolUse.push({
        matcher: 'Read|Grep|Glob',
        hooks: [{ type: 'command', command: hookCmd(cfg, 'read-guard.mjs', readRoots.map((p) => `--root ${q(p)}`)) }],
      });
    }
  }

  const stopHooks = [{
    type: 'command',
    command: hookCmd(cfg, 'check-log.mjs', [
      `--log ${q(logPath)}`,
      `--role ${q(role)}`,
      ...(planActive ? ['--has-plan'] : []),
      `--report ${q(report)}`,
    ]),
  }];
  // spec 起草轮另挂 spec 交付契约（方案模式不写 spec 正文，不挂）。
  if (role === 'spec' && mode !== 'plan') {
    stopHooks.push({
      type: 'command',
      command: hookCmd(cfg, 'check-spec.mjs', [
        `--spec ${q(path.join(cfg.specsDir, `${id}.md`))}`,
        `--report ${q(path.join(cfg.dossierDir, id, `spec-check-r${round}.hook.json`))}`,
      ]),
    });
  }
  // digest 另挂摘要的机械校验（与内核终审同一份裁判代码）。
  if (role === 'digest' && digest?.path && digest?.sourcePath && digest?.sha) {
    stopHooks.push({
      type: 'command',
      command: hookCmd(cfg, 'check-digest.mjs', [
        `--digest ${q(digest.path)}`,
        `--source ${q(digest.sourcePath)}`,
        `--sha ${q(digest.sha)}`,
        `--report ${q(path.join(cfg.dossierDir, id, `digest-check-r${round}.hook.json`))}`,
      ]),
    });
  }

  const readsFiles = role === 'router' || (role === 'worker' && profile === 'read');
  return {
    hooks: { PreToolUse: preToolUse, Stop: [{ hooks: stopHooks }] },
    ...(readsFiles ? { permissions: { deny: [...SECRET_READ_DENY] } } : {}),
    ...(isExecSpawn(role, profile) ? sandboxSettings(sandbox) : {}),
  };
}

/**
 * 一次 spawn 的完整派出参数（纯函数）。内核把 tools / allowedTools / maxTurns / settings
 * 原样交给 lib/claude.mjs，把 logPath 注入 prompt。
 * allowedTools：无执行能力的角色 = 其 --tools 全集（写路径另由 write-guard 收口）；
 * maker = Bash + 本轮 log 的 Edit 规则；有执行能力的 worker 见 workerExecAllowedTools。
 */
export function buildAgentSpawnSpec(cfg, id, role, round, opts = {}) {
  assertRole(role);
  const { mode = null, pkg = null, key = null, profile = null } = opts;
  assertProfile(role, profile);
  const tools = role === 'worker' ? WORKER_TOOLS[profile] : ROLE_TOOLS[role];
  const exec = isExecSpawn(role, profile);
  let allowedTools = tools ? [...tools] : null;
  if (role === 'maker') allowedTools = makerAllowedTools(cfg, id, round, { pkg });
  else if (exec) allowedTools = workerExecAllowedTools(cfg, id, round, { key });
  else if (role === 'worker' && cfg?.workerWebAccess === false) allowedTools = allowedTools.filter((t) => !t.startsWith('Web'));
  return {
    role,
    mode,
    package: pkg,
    key,
    profile,
    round,
    cwdKind: cwdKindFor(role, { mode, pkg, profile }),
    cwd: cwdFor(cfg, id, role, { mode, pkg, profile, key }),
    tools: tools ? [...tools] : null,
    allowedTools,
    permissionMode: exec ? 'acceptEdits' : null,
    isolation: exec ? (opts.sandbox?.enabled === true ? 'os-sandbox' : 'hooks-only') : 'no-exec',
    maxTurns: maxTurnsFor(cfg, role, { mode, profile }),
    logPath: logPathFor(cfg, id, role, round, { mode, pkg, key }),
    reportPath: role === 'worker' || role === 'reviewer' ? reportPathFor(cfg, id, role, round, { key }) : null,
    hookReportPath: artifactPath(cfg, id, role, round, 'log.hook.json', { mode, pkg, key }),
    settingsPath: artifactPath(cfg, id, role, round, 'settings.json', { mode, pkg, key }),
    allowedWritePaths: exec ? [] : allowedWritePaths(cfg, id, role, round, { ...opts, digestPath: opts.digest?.path ?? null }),
    settings: buildAgentSettings(cfg, id, role, round, opts),
  };
}

/** 唯一落盘口：把该轮 settings 写进 dossier 并返回路径（参考 shared.mjs 的既有写法）。 */
export function writeAgentSettings(cfg, id, role, round, opts = {}) {
  const spec = buildAgentSpawnSpec(cfg, id, role, round, opts);
  fs.mkdirSync(path.dirname(spec.settingsPath), { recursive: true });
  fs.writeFileSync(spec.settingsPath, `${JSON.stringify(spec.settings, null, 2)}\n`);
  return spec.settingsPath;
}
