// lib/agent-settings.mjs — 四个角色的 spawn 参数与 hook 护栏（spec §角色、工具、hook、模型）。
// 纯函数 buildAgentSpawnSpec 负责「派出参数长什么样」，writeAgentSettings 是唯一的落盘口
// （逐轮 `.settings.json` 进 dossier 留档）。显式 --settings 注入，不依赖 target 仓库自带的
// .claude/settings.json（不可信、不可控）。
//
// 边界纪律（AC-025）：
//   - router 只有 Write，白名单只放自己的 log —— 它不执行 git、不改任何文件、更不可能 push。
//   - reviewer 只读三件 + git diff/log/show + Write，白名单同样只有 log。
//   - spec 写 spec 时白名单是 spec + packages + log；**方案模式只有 packages + log**
//     （Invariant 8：方案不改范围，对 spec 正文的 Write/Edit 必须在落盘前被拒）。
//   - maker 全工具、Bash 免审批，护栏是既有的 maker-git-guard。

import path from 'node:path';
import fs from 'node:fs';

export const READONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);

/** `--tools` 硬限制。maker 为 null = 不传 --tools（全工具集）。 */
export const ROLE_TOOLS = Object.freeze({
  router: Object.freeze(['Write']),
  spec: Object.freeze([...READONLY_TOOLS, 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Write', 'Edit']),
  maker: null,
  reviewer: Object.freeze([...READONLY_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Write']),
});

/** maker 的免审批集合：Bash（工具集不设限，只免 Bash 的审批，其余走 acceptEdits）。 */
export const MAKER_ALLOWED_TOOLS = Object.freeze(['Bash']);

/** 各角色轮次上限；plan 是方案模式的 spec-agent（独立配置，spec §config）。 */
export const DEFAULT_MAX_TURNS = Object.freeze({ router: 4, spec: 40, plan: 25, maker: 70, reviewer: 40 });

/** cwd 语义（表格第二列）：内核据此建/复用 worktree。 */
export const CWD_KIND = Object.freeze({
  router: 'conductor-root',
  spec: 'spec-ro-worktree',
  plan: 'plan-ro-worktree',
  maker: 'task-worktree',
  makerPackage: 'package-worktree',
  reviewer: 'task-worktree',
});

const AGENT_ROLES = Object.freeze(['router', 'spec', 'maker', 'reviewer']);

function assertRole(role) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`未知角色：${role}（应为 ${AGENT_ROLES.join(' | ')}）`);
}

/** 产物基名：方案模式是 spec-plan，包 maker 带包段，其余就是角色名。 */
export function artifactBase(role, { mode = null, pkg = null } = {}) {
  assertRole(role);
  if (role === 'spec' && mode === 'plan') return 'spec-plan';
  return pkg ? `${role}-${pkg}` : role;
}

/** `dossier/<id>/<base>-r<n>.<suffix>` 的统一构造点（log / hook 报告 / settings 三者同名不同后缀）。 */
export function artifactPath(cfg, id, role, round, suffix, { mode = null, pkg = null } = {}) {
  return path.join(cfg.dossierDir, id, `${artifactBase(role, { mode, pkg })}-r${round}.${suffix}`);
}

export function logPathFor(cfg, id, role, round, opts = {}) {
  return artifactPath(cfg, id, role, round, 'log.json', opts);
}

/** 轮次上限：config 覆盖优先（cfg.maxTurns 可以是数字或按角色的对象），否则用表格默认值。 */
export function maxTurnsFor(cfg, role, { mode = null } = {}) {
  assertRole(role);
  const key = role === 'spec' && mode === 'plan' ? 'plan' : role;
  const configured = cfg?.maxTurns;
  if (configured != null && typeof configured === 'object' && Number.isFinite(configured[key])) {
    return configured[key];
  }
  return DEFAULT_MAX_TURNS[key];
}

function cwdKindFor(role, { mode = null, pkg = null } = {}) {
  if (role === 'spec') return mode === 'plan' ? CWD_KIND.plan : CWD_KIND.spec;
  if (role === 'maker') return pkg ? CWD_KIND.makerPackage : CWD_KIND.maker;
  return CWD_KIND[role];
}

function cwdFor(cfg, id, role, { mode = null, pkg = null } = {}) {
  switch (cwdKindFor(role, { mode, pkg })) {
    case CWD_KIND.router: return cfg.root;
    case CWD_KIND.spec: return path.join(cfg.worktreesDir, `${id}.spec-ro`);
    case CWD_KIND.plan: return path.join(cfg.worktreesDir, `${id}.plan-ro`);
    case CWD_KIND.makerPackage: return path.join(cfg.worktreesDir, `${id}--${pkg}`);
    default: return path.join(cfg.worktreesDir, id);
  }
}

/** 写路径白名单（PreToolUse: write-guard 的 --allow 列表）。maker 不走白名单，走 git 护栏。 */
export function allowedWritePaths(cfg, id, role, round, { mode = null, pkg = null, packagesEnabled = false } = {}) {
  const logPath = logPathFor(cfg, id, role, round, { mode, pkg });
  if (role !== 'spec') return [logPath];
  const packagesPath = path.join(cfg.specsDir, `${id}.packages.json`);
  if (mode === 'plan') return [packagesPath, logPath]; // 方案模式：spec 正文不可写
  const paths = [path.join(cfg.specsDir, `${id}.md`)];
  if (packagesEnabled) paths.push(packagesPath); // 阶段闸关时连路径都不放行（AC-044）
  paths.push(logPath);
  return paths;
}

const q = (s) => JSON.stringify(s); // 路径含空格时 shell 安全

function hookCmd(cfg, script, args) {
  return `${q(process.execPath)} ${q(path.join(cfg.root, 'conductor', 'hooks', script))} ${args.join(' ')}`;
}

/**
 * 该轮的 settings JSON（hooks 护栏）。纯函数：不碰磁盘。
 * PreToolUse：写白名单（write-guard）或 maker 的 git 护栏；Stop：check-log，spec 起草轮叠加
 * check-spec（spec 交付契约）。
 */
export function buildAgentSettings(cfg, id, role, round, opts = {}) {
  assertRole(role);
  const { mode = null, pkg = null, planActive = false, packagesEnabled = false } = opts;
  const logPath = logPathFor(cfg, id, role, round, { mode, pkg });
  const report = artifactPath(cfg, id, role, round, 'log.hook.json', { mode, pkg });

  const preToolUse = role === 'maker'
    ? [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd(cfg, 'maker-git-guard.mjs', []) }] }]
    : [{
      matcher: 'Write|Edit|MultiEdit|NotebookEdit',
      hooks: [{
        type: 'command',
        command: hookCmd(cfg, 'write-guard.mjs', allowedWritePaths(cfg, id, role, round, { mode, pkg, packagesEnabled }).map((p) => `--allow ${q(p)}`)),
      }],
    }];

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

  return { hooks: { PreToolUse: preToolUse, Stop: [{ hooks: stopHooks }] } };
}

/**
 * 一次 spawn 的完整派出参数（纯函数）。内核把 tools / allowedTools / maxTurns / settings
 * 原样交给 lib/claude.mjs，把 logPath 注入 prompt。
 */
export function buildAgentSpawnSpec(cfg, id, role, round, opts = {}) {
  assertRole(role);
  const { mode = null, pkg = null } = opts;
  const tools = ROLE_TOOLS[role];
  return {
    role,
    mode,
    package: pkg,
    round,
    cwdKind: cwdKindFor(role, { mode, pkg }),
    cwd: cwdFor(cfg, id, role, { mode, pkg }),
    tools: tools ? [...tools] : null,
    allowedTools: role === 'maker' ? [...MAKER_ALLOWED_TOOLS] : (tools ? [...tools] : null),
    permissionMode: role === 'maker' ? 'acceptEdits' : null,
    maxTurns: maxTurnsFor(cfg, role, { mode }),
    logPath: logPathFor(cfg, id, role, round, { mode, pkg }),
    hookReportPath: artifactPath(cfg, id, role, round, 'log.hook.json', { mode, pkg }),
    settingsPath: artifactPath(cfg, id, role, round, 'settings.json', { mode, pkg }),
    allowedWritePaths: role === 'maker' ? [] : allowedWritePaths(cfg, id, role, round, opts),
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
