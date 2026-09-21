// 单元：角色的工具集、白名单、读/写/Stop hook 与 maxTurns（AC-025 的纯函数面）。
// 这些边界不是风格问题：router 多一个 Bash 就能执行 git，spec 方案模式多一条 spec 路径
// 就能改范围（Invariant 8），reviewer 多一条写路径就能改它正在审的代码，maker 的 --tools
// 一旦回到「不传 = 全工具集」就白送出 Task / Cron / SendMessage 这些不入账、不受停止控制的旁路。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgentSpawnSpec, buildAgentSettings, writeAgentSettings, allowedWritePaths, makerAllowedTools,
  workerExecAllowedTools, workerWorktreePath, isExecSpawn,
  artifactBase, logPathFor, reportPathFor, verdictsPathFor, routerNotesPath, maxTurnsFor,
  READONLY_TOOLS, ROLE_TOOLS, WORKER_TOOLS, EXEC_TOOLS, MAKER_ALLOWED_TOOLS, DEFAULT_MAX_TURNS, CWD_KIND,
} from '../../conductor/lib/agent-settings.mjs';

/** 文件权限规则的绝对路径写法：`//` 才是文件系统根，单个 `/` 是相对 settings 源。 */
const editRule = (absPath) => `Edit(//${absPath.replace(/^\/+/, '')})`;

const ID = 'task-20260830-001';

/**
 * 真实 CLI 全工具集里那些「不经内核授权、不单独入账、不受停止控制」的旁路。
 * 只要 EXEC_TOOLS 里漏进一个，有执行能力的角色就能自己再派 agent / 挂定时器 / 对外发消息，
 * 内核的轮次、预算、停止请求全部失效——所以逐个点名，而不是只数长度。
 */
const BYPASS_TOOLS = ['Task', 'Agent', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'ScheduleWakeup', 'Workflow', 'Skill'];

function makeCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    specsDir: path.join(root, 'specs'),
    dossierDir: path.join(root, 'dossier'),
    worktreesDir: path.join(root, 'worktrees'),
  };
}

const preHooks = (settings) => settings.hooks.PreToolUse;
const preCommand = (settings) => settings.hooks.PreToolUse[0].hooks[0].command;
const hookBy = (settings, matcher) => settings.hooks.PreToolUse.find((h) => h.matcher === matcher) ?? null;
const stopCommands = (settings) => settings.hooks.Stop[0].hooks.map((h) => h.command);

test('AC-025: 工具集逐项与角色表一致 —— router 有只读三件但绝无 Bash', () => {
  // 契约变更：router 现在要读摘要、按引用回原文、看产物再决定，所以给了只读三件 + Write。
  // 「没有 Bash」这一条没变，而且正是它保证 router 不可能执行 git、更不可能 push。
  assert.deepEqual([...ROLE_TOOLS.router], ['Read', 'Grep', 'Glob', 'Write']);
  assert.equal(ROLE_TOOLS.router.includes('Bash'), false, 'router 一旦有 Bash 就能执行 git / push');
  assert.equal(ROLE_TOOLS.router.some((tl) => tl.startsWith('Bash')), false, '连 Bash(...) 形式的窄白名单都不给');
  assert.equal(ROLE_TOOLS.router.includes('Edit'), false, 'router 不改任何文件内容，只能整份 Write 自己的两个产物');

  // digest 连读盘能力都没有：spec 原文由内核带行号内联进 prompt。
  assert.deepEqual([...ROLE_TOOLS.digest], ['Write']);

  assert.deepEqual([...ROLE_TOOLS.reviewer], [
    'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Write',
  ]);
  assert.deepEqual([...ROLE_TOOLS.spec], [
    'Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Write', 'Edit',
  ]);
  assert.deepEqual([...READONLY_TOOLS], ['Read', 'Grep', 'Glob']);
  assert.deepEqual([...MAKER_ALLOWED_TOOLS], ['Bash']);

  for (const role of ['router', 'digest', 'spec', 'reviewer', 'maker']) {
    assert.ok(Object.isFrozen(ROLE_TOOLS[role]), `${role} 的工具表必须冻结：运行期被改就等于边界被改`);
  }
});

// 契约变更：maker 以前是「不传 --tools = 宿主 CLI 的全工具集」（ROLE_TOOLS.maker === null）。
// 那份全集里有 Task / CronCreate / RemoteTrigger / SendMessage / ScheduleWakeup / Workflow——
// 每一个都能绕过内核的轮次、成本入账与停止控制。现在是显式白名单，名单之外对会话不存在。
test('AC-025: 有执行能力的角色用显式 EXEC_TOOLS 白名单，不含任何递归委派 / 外呼旁路', () => {
  assert.deepEqual([...EXEC_TOOLS], ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  assert.notEqual(ROLE_TOOLS.maker, null, 'maker 不再是「不传 --tools」');
  assert.equal(ROLE_TOOLS.maker, EXEC_TOOLS, 'maker 与 worker 的执行档共用同一份白名单');
  for (const bad of BYPASS_TOOLS) {
    assert.equal(EXEC_TOOLS.includes(bad), false, `EXEC_TOOLS 不得含 ${bad}：它不入账、不受停止控制`);
  }
  assert.equal(EXEC_TOOLS.includes('Bash'), true, '执行档的定义就是有 Bash');
});

test('AC-025: WORKER_TOOLS 按 profile 分档 —— read 档没有 Bash，sandbox / write 档才有', () => {
  assert.deepEqual(Object.keys(WORKER_TOOLS), ['read', 'sandbox', 'write']);
  // read 档是「静态只读 + 写自己的产物 + 可查文档」：一旦混进 Bash，调查任务就能改产品代码。
  assert.deepEqual([...WORKER_TOOLS.read], ['Read', 'Grep', 'Glob', 'Write', 'WebFetch', 'WebSearch']);
  assert.equal(WORKER_TOOLS.read.some((tl) => tl.startsWith('Bash')), false, 'read 档不得有任何形式的 Bash');
  assert.equal(WORKER_TOOLS.read.includes('Edit'), false, 'read 档连 Edit 都没有：产物只能整份 Write');
  assert.equal(WORKER_TOOLS.sandbox, EXEC_TOOLS);
  assert.equal(WORKER_TOOLS.write, EXEC_TOOLS);
  for (const p of ['read', 'sandbox', 'write']) {
    for (const bad of BYPASS_TOOLS) assert.equal(WORKER_TOOLS[p].includes(bad), false, `worker:${p} 不得含 ${bad}`);
  }
});

// 契约变更：router 从 4 提到 40（它要读摘要、回原文、看产物，4 轮只够写一行 log），reviewer 40→60，
// 另加 digest 与三档 worker。单次上限不是任务容量：撞上限留下增量 log，下一轮续会话或重新分派。
test('AC-025: maxTurns 表整体 —— router 40 / digest 12 / spec 40 / plan 25 / maker 70 / reviewer 60 / worker 三档', (t) => {
  const cfg = makeCfg(t);
  assert.deepEqual({ ...DEFAULT_MAX_TURNS }, {
    router: 40, digest: 12, spec: 40, plan: 25, maker: 70, reviewer: 60,
    workerRead: 60, workerSandbox: 120, workerWrite: 150,
  });
  assert.ok(Object.isFrozen(DEFAULT_MAX_TURNS));

  assert.equal(maxTurnsFor(cfg, 'router'), 40);
  assert.equal(maxTurnsFor(cfg, 'digest'), 12);
  assert.equal(maxTurnsFor(cfg, 'spec'), 40);
  assert.equal(maxTurnsFor(cfg, 'spec', { mode: 'plan' }), 25, '方案模式走独立的 plan 键');
  assert.equal(maxTurnsFor(cfg, 'maker'), 70);
  assert.equal(maxTurnsFor(cfg, 'reviewer'), 60);
  assert.equal(maxTurnsFor(cfg, 'worker', { profile: 'read' }), 60);
  assert.equal(maxTurnsFor(cfg, 'worker', { profile: 'sandbox' }), 120);
  assert.equal(maxTurnsFor(cfg, 'worker', { profile: 'write' }), 150);
});

test('AC-025: maxTurnsFor —— config 的对象形式逐键覆盖，旧的标量 maxTurns 一律忽略', (t) => {
  const cfg = makeCfg(t);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { maker: 12 } }, 'maker'), 12);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { plan: 7 } }, 'spec', { mode: 'plan' }), 7);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { workerSandbox: 9 } }, 'worker', { profile: 'sandbox' }), 9);
  // 覆盖是逐键的：配了别的键不影响本角色，仍回落到默认表。
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { workerSandbox: 9 } }, 'worker', { profile: 'write' }), 150);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { router: 'many' } }, 'router'), 40, '非有限数的配置值不生效');
  // 遗留配置里 maxTurns 是个标量（早期只有一个角色）。继续喂给新角色会让 worker:write 只剩 30 轮，
  // 所以标量必须被无视——不是报错，是回落到默认表。
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: 30 }, 'maker'), 70, '旧的标量 maxTurns 不再喂新角色');
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: 30 }, 'worker', { profile: 'write' }), 150);
});

test('AC-025: 产物基名与 log 路径 —— 方案模式 spec-plan、包 maker 带包段、worker 带委派 key', (t) => {
  const cfg = makeCfg(t);
  assert.equal(artifactBase('router'), 'router');
  assert.equal(artifactBase('digest'), 'digest');
  assert.equal(artifactBase('spec', { mode: 'plan' }), 'spec-plan');
  assert.equal(artifactBase('maker', { pkg: 'P-001' }), 'maker-P-001');
  assert.equal(artifactBase('worker', { key: 'api' }), 'worker-api');
  assert.equal(path.basename(logPathFor(cfg, ID, 'reviewer', 3)), 'reviewer-r3.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'digest', 1)), 'digest-r1.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'maker', 2, { pkg: 'P-002' })), 'maker-P-002-r2.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'spec', 1, { mode: 'plan' })), 'spec-plan-r1.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'worker', 5, { key: 'api' })), 'worker-api-r5.log.json');
  assert.throws(() => artifactBase('committer'), /未知角色/);
  // worker 的产物名必须带 key：并行 worker 共用一个轮次号，没有 key 就会互相覆盖案卷。
  assert.throws(() => artifactBase('worker'), /worker 的产物名需要委派 key/);
});

test('AC-025: 完整产物路径 —— reviewer 的 verdicts / report，worker 的 report，router 的工作记忆', (t) => {
  const cfg = makeCfg(t);
  const dossier = path.join(cfg.dossierDir, ID);
  assert.equal(verdictsPathFor(cfg, ID, 4), path.join(dossier, 'reviewer-r4.verdicts.json'));
  assert.equal(reportPathFor(cfg, ID, 'reviewer', 4), path.join(dossier, 'reviewer-r4.report.md'));
  assert.equal(reportPathFor(cfg, ID, 'worker', 4, { key: 'api' }), path.join(dossier, 'worker-api-r4.report.md'));
  // 工作记忆跨轮保留，所以不带轮次号（内核逐轮另留快照，见 lib/router-notes.mjs）。
  assert.equal(routerNotesPath(cfg, ID), path.join(dossier, 'router-notes.json'));
  assert.equal(/-r\d+\./.test(path.basename(routerNotesPath(cfg, ID))), false, 'router-notes 是跨轮的单一文件');
});

// 契约变更：router / digest 的 cwd 从 conductor root 改成**本任务的案卷目录**。
// 这是读范围收口的第一层——连 cwd 都不在仓库根上，Grep / Glob 不带 path 时也只搜本任务案卷。
test('AC-025: cwd 语义 —— router / digest 在任务案卷目录，spec 两种只读 worktree，包 maker 在包 worktree', (t) => {
  const cfg = makeCfg(t);
  const spec = (role, opts) => buildAgentSpawnSpec(cfg, ID, role, 1, opts);
  const dossier = path.join(cfg.dossierDir, ID);

  assert.equal(spec('router').cwdKind, CWD_KIND.router);
  assert.equal(CWD_KIND.router, 'task-dossier');
  assert.equal(spec('router').cwd, dossier);
  assert.equal(spec('digest').cwdKind, CWD_KIND.digest);
  assert.equal(spec('digest').cwd, dossier, 'digest 与 router 同一档 cwd');
  assert.notEqual(spec('router').cwd, cfg.root, 'cwd 不再是 conductor root：别的任务案卷 / state / 配置都不在脚下');

  assert.equal(spec('spec').cwd, path.join(cfg.worktreesDir, `${ID}.spec-ro`));
  assert.equal(spec('spec', { mode: 'plan' }).cwd, path.join(cfg.worktreesDir, `${ID}.plan-ro`));
  assert.equal(spec('maker').cwd, path.join(cfg.worktreesDir, ID));
  assert.equal(spec('maker', { pkg: 'P-003' }).cwd, path.join(cfg.worktreesDir, `${ID}--P-003`));
  assert.equal(spec('maker', { pkg: 'P-003' }).cwdKind, CWD_KIND.makerPackage);
  assert.equal(spec('reviewer').cwd, path.join(cfg.worktreesDir, ID));
  assert.equal(spec('reviewer').cwdKind, CWD_KIND.reviewer);
});

test('AC-025: worker 的三种 worktree 布局互不相同 —— 快照 / scratch / 委派各占一处', (t) => {
  const cfg = makeCfg(t);
  assert.equal(workerWorktreePath(cfg, ID, 'read', 'api'), path.join(cfg.worktreesDir, `${ID}.r-api`));
  assert.equal(workerWorktreePath(cfg, ID, 'sandbox', 'api'), path.join(cfg.worktreesDir, `${ID}.x-api`));
  assert.equal(workerWorktreePath(cfg, ID, 'write', 'api'), path.join(cfg.worktreesDir, `${ID}--api`));
  // 三档必须落在三个目录：同 key 的 scratch 实验一旦和 write 档共用 worktree，
  // 「产物不并入产品」这条就当场失守。
  const paths = ['read', 'sandbox', 'write'].map((p) => workerWorktreePath(cfg, ID, p, 'api'));
  assert.equal(new Set(paths).size, 3);

  const spec = (profile) => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile, key: 'api' });
  assert.equal(spec('read').cwd, paths[0]);
  assert.equal(spec('read').cwdKind, CWD_KIND.workerRead);
  assert.equal(spec('sandbox').cwd, paths[1]);
  assert.equal(spec('sandbox').cwdKind, CWD_KIND.workerSandbox);
  assert.equal(spec('write').cwd, paths[2]);
  assert.equal(spec('write').cwdKind, CWD_KIND.workerWrite);
});

// 契约变更：router 的白名单从「只有 log」加了一条工作记忆（router-notes.json）。
// 加的是一个**具名文件**，不是目录：多一条通配或换成案卷目录，router 就能改别人的 log 与判决。
test('AC-025: 白名单 —— router 是 log + 工作记忆，digest 是摘要 + log，reviewer 是 log + verdicts + report', (t) => {
  const cfg = makeCfg(t);

  assert.deepEqual(allowedWritePaths(cfg, ID, 'router', 1), [
    logPathFor(cfg, ID, 'router', 1), routerNotesPath(cfg, ID),
  ]);

  const digestPath = path.join(cfg.dossierDir, ID, 'digest-abc123.json');
  assert.deepEqual(allowedWritePaths(cfg, ID, 'digest', 1, { digestPath }), [
    digestPath, logPathFor(cfg, ID, 'digest', 1),
  ]);
  // 没带摘要路径时只剩 log：内核没点名要写哪一版摘要，就一个字节都不许写。
  assert.deepEqual(allowedWritePaths(cfg, ID, 'digest', 1), [logPathFor(cfg, ID, 'digest', 1)]);

  // reviewer 写 log + 逐条判决台账 + 完整报告；一条产品路径都没有——它改不了自己正在审的代码。
  assert.deepEqual(allowedWritePaths(cfg, ID, 'reviewer', 2), [
    logPathFor(cfg, ID, 'reviewer', 2), verdictsPathFor(cfg, ID, 2), reportPathFor(cfg, ID, 'reviewer', 2),
  ]);
  for (const p of allowedWritePaths(cfg, ID, 'reviewer', 2)) {
    assert.ok(p.startsWith(path.join(cfg.dossierDir, ID) + path.sep), 'reviewer 的写路径必须全在本任务案卷内');
  }
});

test('AC-025: 白名单 —— spec 起草是 spec+packages+log；方案模式仅 packages+log', (t) => {
  const cfg = makeCfg(t);
  const specPath = path.join(cfg.specsDir, `${ID}.md`);
  const pkgPath = path.join(cfg.specsDir, `${ID}.packages.json`);

  const draftOn = allowedWritePaths(cfg, ID, 'spec', 1, { packagesEnabled: true });
  assert.deepEqual(draftOn, [specPath, pkgPath, logPathFor(cfg, ID, 'spec', 1)]);

  // AC-044：阶段闸关时连 packages 路径都不放行
  const draftOff = allowedWritePaths(cfg, ID, 'spec', 1, { packagesEnabled: false });
  assert.deepEqual(draftOff, [specPath, logPathFor(cfg, ID, 'spec', 1)]);

  // AC-047 / Invariant 8：方案模式对 spec 正文的 Write/Edit 必须被拒
  const plan = allowedWritePaths(cfg, ID, 'spec', 1, { mode: 'plan', packagesEnabled: true });
  assert.deepEqual(plan, [pkgPath, logPathFor(cfg, ID, 'spec', 1, { mode: 'plan' })]);
  assert.equal(plan.includes(specPath), false, '方案模式绝不放行 spec 正文');
});

test('AC-025: 白名单 —— worker:read 是 log + report；有执行能力的 worker 不挂 write-guard', (t) => {
  const cfg = makeCfg(t);
  const readWhitelist = allowedWritePaths(cfg, ID, 'worker', 3, { profile: 'read', key: 'api' });
  assert.deepEqual(readWhitelist, [
    logPathFor(cfg, ID, 'worker', 3, { key: 'api' }), reportPathFor(cfg, ID, 'worker', 3, { key: 'api' }),
  ]);
  // 有执行能力的档返回空：Bash 本来就绕得过 PreToolUse 的文件白名单，挂上只会给人「被拦住了」的错觉。
  // 它们的 worktree 内编辑由 acceptEdits 放行，worktree 之外只有权限规则点名的两个文件。
  for (const profile of ['sandbox', 'write']) {
    assert.deepEqual(allowedWritePaths(cfg, ID, 'worker', 3, { profile, key: 'api' }), []);
  }
});

test('AC-025: PreToolUse —— 无执行能力走 write-guard 白名单，有执行能力走 git 护栏', (t) => {
  const cfg = makeCfg(t);
  const router = buildAgentSettings(cfg, ID, 'router', 1);
  assert.equal(router.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.match(preCommand(router), /write-guard\.mjs/);
  assert.match(preCommand(router), /--allow/);
  assert.ok(preCommand(router).includes(logPathFor(cfg, ID, 'router', 1)));
  assert.ok(preCommand(router).includes(routerNotesPath(cfg, ID)));

  const maker = buildAgentSettings(cfg, ID, 'maker', 1);
  assert.equal(maker.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(preCommand(maker), /maker-git-guard\.mjs/);
  assert.equal(/write-guard\.mjs/.test(preCommand(maker)), false);
  assert.deepEqual(buildAgentSpawnSpec(cfg, ID, 'maker', 1).allowedWritePaths, []);

  // worker 的两个执行档与 maker 同一条护栏：git 破坏性操作 + 嵌套 claude CLI 都归 maker-git-guard 管。
  for (const profile of ['sandbox', 'write']) {
    const w = buildAgentSettings(cfg, ID, 'worker', 1, { profile, key: 'api' });
    assert.equal(preHooks(w).length, 1);
    assert.equal(preHooks(w)[0].matcher, 'Bash');
    assert.match(preCommand(w), /maker-git-guard\.mjs/);
  }
  // read 档没有 Bash，挂的是写白名单。
  const wr = buildAgentSettings(cfg, ID, 'worker', 1, { profile: 'read', key: 'api' });
  assert.equal(preHooks(wr)[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.match(preCommand(wr), /write-guard\.mjs/);
});

// read-guard 是「能读 ≠ 能读任何地方」那一层：router 现在读得懂内容，但只有内核点名的根之内可读。
// 只给 router / worker 两类角色，且 readRoots 为空时不挂（配置缺失不该变成硬故障，也不该悄悄放开）。
test('AC-025: read-guard 只挂给 router / worker，且只在 readRoots 非空时出现', (t) => {
  const cfg = makeCfg(t);
  const roots = [path.join(cfg.dossierDir, ID), path.join(cfg.specsDir, `${ID}.md`)];

  const router = buildAgentSettings(cfg, ID, 'router', 1, { readRoots: roots });
  assert.equal(preHooks(router).length, 2, 'write-guard 之外另挂一条读范围');
  const rg = hookBy(router, 'Read|Grep|Glob');
  assert.ok(rg, '读范围 hook 的 matcher 必须精确覆盖三个读工具');
  assert.match(rg.hooks[0].command, /read-guard\.mjs/);
  for (const r of roots) assert.ok(rg.hooks[0].command.includes(`--root "${r}"`), `每个根各一条 --root：${r}`);

  // readRoots 为空 → 只剩 write-guard 一条（没有「零 --root 的 read-guard」这种半开状态）。
  assert.equal(preHooks(buildAgentSettings(cfg, ID, 'router', 1)).length, 1);
  assert.equal(preHooks(buildAgentSettings(cfg, ID, 'router', 1, { readRoots: [] })).length, 1);

  const wr = buildAgentSettings(cfg, ID, 'worker', 1, { profile: 'read', key: 'api', readRoots: roots });
  assert.equal(preHooks(wr).length, 2);
  assert.match(hookBy(wr, 'Read|Grep|Glob').hooks[0].command, /read-guard\.mjs/);

  // 其余角色即便传了 readRoots 也不挂：spec / reviewer 的读范围由只读 worktree 本身决定。
  for (const role of ['spec', 'reviewer', 'digest']) {
    const s = buildAgentSettings(cfg, ID, role, 1, { readRoots: roots });
    assert.equal(preHooks(s).length, 1, `${role} 不该多出读范围 hook`);
    assert.equal(hookBy(s, 'Read|Grep|Glob'), null);
  }
  // 有执行能力的 worker 也不挂：有 Bash 时 read-guard 只是障眼法，读范围得靠 OS 沙盒。
  const wx = buildAgentSettings(cfg, ID, 'worker', 1, { profile: 'sandbox', key: 'api', readRoots: roots });
  assert.equal(preHooks(wx).length, 1);
  assert.equal(hookBy(wx, 'Read|Grep|Glob'), null);
});

test('AC-025: Stop hook —— 每个角色都挂 check-log；spec 起草轮叠加 check-spec，方案模式不叠加', (t) => {
  const cfg = makeCfg(t);
  for (const [role, opts] of [
    ['router', {}], ['spec', {}], ['maker', {}], ['reviewer', {}],
    ['digest', {}], ['worker', { profile: 'read', key: 'api' }], ['worker', { profile: 'write', key: 'api' }],
  ]) {
    const cmds = stopCommands(buildAgentSettings(cfg, ID, role, 1, opts));
    assert.match(cmds[0], /check-log\.mjs/, `${role} 必须挂 check-log`);
    assert.match(cmds[0], new RegExp(`--role "${role}"`));
    assert.ok(cmds[0].includes(logPathFor(cfg, ID, role, 1, opts)));
    assert.ok(cmds[0].includes('.log.hook.json'), '报告文件名固定为 <base>-r<n>.log.hook.json');
  }
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'spec', 1)).length, 2);
  assert.match(stopCommands(buildAgentSettings(cfg, ID, 'spec', 1))[1], /check-spec\.mjs/);
  const plan = stopCommands(buildAgentSettings(cfg, ID, 'spec', 1, { mode: 'plan' }));
  assert.equal(plan.length, 1, '方案模式不写 spec 正文，不挂 spec 契约门');
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'maker', 1)).length, 1);
});

// check-digest 是摘要的会话内快反馈（与内核终审共用 lib/digest-contract.mjs）。三个参数缺一，
// hook 自己会「放行交给内核终审」——所以内核这边直接不挂，免得留下一个恒放行的假门。
test('AC-025: check-digest 只在 role=digest 且 path/sourcePath/sha 三者齐全时挂上', (t) => {
  const cfg = makeCfg(t);
  const digest = {
    path: path.join(cfg.dossierDir, ID, 'digest-abc123.json'),
    sourcePath: path.join(cfg.dossierDir, ID, 'spec.md'),
    sha: 'abc123',
  };
  const cmds = stopCommands(buildAgentSettings(cfg, ID, 'digest', 2, { digest }));
  assert.equal(cmds.length, 2);
  assert.match(cmds[1], /check-digest\.mjs/);
  assert.ok(cmds[1].includes(`--digest "${digest.path}"`));
  assert.ok(cmds[1].includes(`--source "${digest.sourcePath}"`));
  assert.ok(cmds[1].includes(`--sha "${digest.sha}"`));
  assert.ok(cmds[1].includes(path.join(cfg.dossierDir, ID, 'digest-check-r2.hook.json')));

  for (const missing of ['path', 'sourcePath', 'sha']) {
    const partial = { ...digest, [missing]: null };
    assert.equal(
      stopCommands(buildAgentSettings(cfg, ID, 'digest', 2, { digest: partial })).length, 1,
      `缺 ${missing} 时不挂 check-digest（挂了也只会恒放行）`,
    );
  }
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'digest', 2)).length, 1);
  // 别的角色带上 digest 参数也不该长出摘要门。
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'router', 2, { digest })).length, 1);
});

test('AC-025: --has-plan 只在 planActive 时出现在 check-log 参数里', (t) => {
  const cfg = makeCfg(t);
  assert.equal(/--has-plan/.test(stopCommands(buildAgentSettings(cfg, ID, 'router', 1))[0]), false);
  assert.match(stopCommands(buildAgentSettings(cfg, ID, 'router', 1, { planActive: true }))[0], /--has-plan/);
});

test('AC-025: 逐轮 .settings.json 落盘 dossier，内容与纯函数产物一致', (t) => {
  const cfg = makeCfg(t);
  const p = writeAgentSettings(cfg, ID, 'reviewer', 2);
  assert.equal(p, path.join(cfg.dossierDir, ID, 'reviewer-r2.settings.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), buildAgentSettings(cfg, ID, 'reviewer', 2));

  const pkgPath = writeAgentSettings(cfg, ID, 'maker', 1, { pkg: 'P-001' });
  assert.equal(path.basename(pkgPath), 'maker-P-001-r1.settings.json');

  // 新角色的留档同样按基名走：并行 worker 各写各的，不会互相覆盖。
  const workerPath = writeAgentSettings(cfg, ID, 'worker', 4, { profile: 'read', key: 'api' });
  assert.equal(path.basename(workerPath), 'worker-api-r4.settings.json');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(workerPath, 'utf8')),
    buildAgentSettings(cfg, ID, 'worker', 4, { profile: 'read', key: 'api' }),
  );
  assert.equal(path.basename(writeAgentSettings(cfg, ID, 'digest', 1)), 'digest-r1.settings.json');
});

test('AC-025: spawn spec 的 tools/allowedTools/permissionMode 与角色一一对应', (t) => {
  const cfg = makeCfg(t);
  const router = buildAgentSpawnSpec(cfg, ID, 'router', 1);
  // 契约变更：router 的 --tools 从 ['Write'] 扩到只读三件 + Write（仍然没有 Bash）。
  assert.deepEqual(router.tools, ['Read', 'Grep', 'Glob', 'Write']);
  assert.deepEqual(router.allowedTools, ['Read', 'Grep', 'Glob', 'Write'], '无执行能力的角色 allowedTools = --tools 全集');
  assert.equal(router.permissionMode, null);
  assert.equal(router.maxTurns, 40);
  assert.notEqual(router.tools, ROLE_TOOLS.router, '返回的是副本：调用方改不动冻结的角色表');

  const digest = buildAgentSpawnSpec(cfg, ID, 'digest', 1);
  assert.deepEqual(digest.tools, ['Write'], 'digest 连读盘能力都没有：spec 原文由内核内联进 prompt');
  assert.deepEqual(digest.allowedTools, ['Write']);
  assert.equal(digest.permissionMode, null);

  const maker = buildAgentSpawnSpec(cfg, ID, 'maker', 1);
  // 契约变更：maker.tools 不再是 null（「不传 --tools = 全工具集」），而是显式 EXEC_TOOLS。
  assert.notEqual(maker.tools, null);
  assert.deepEqual(maker.tools, [...EXEC_TOOLS]);
  assert.deepEqual(maker.allowedTools, ['Bash', editRule(logPathFor(cfg, ID, 'maker', 1))]);
  assert.equal(maker.permissionMode, 'acceptEdits');

  const reviewer = buildAgentSpawnSpec(cfg, ID, 'reviewer', 1);
  assert.equal(reviewer.tools.includes('Edit'), false, 'reviewer 不改代码');
  assert.equal(reviewer.tools.includes('Bash'), false, '只有 Bash(git …:*) 三条白名单');
  assert.equal(reviewer.reportPath, reportPathFor(cfg, ID, 'reviewer', 1));
  assert.equal(router.reportPath, null, '只有 worker / reviewer 有完整报告');
});

test('AC-025: isExecSpawn 按真实副作用分档，isolation 三态如实标注', (t) => {
  const cfg = makeCfg(t);
  assert.equal(isExecSpawn('maker'), true);
  assert.equal(isExecSpawn('worker', 'sandbox'), true);
  assert.equal(isExecSpawn('worker', 'write'), true);
  assert.equal(isExecSpawn('worker', 'read'), false, 'read 档没有 Bash，属于无执行能力那一档');
  for (const role of ['router', 'digest', 'spec', 'reviewer']) assert.equal(isExecSpawn(role), false);

  const iso = (role, opts) => buildAgentSpawnSpec(cfg, ID, role, 1, opts).isolation;
  // isolation 会原样进 spawn 记录：事后追责时「有没有 OS 沙盒」必须是记录里的事实，不是推测。
  assert.equal(iso('router'), 'no-exec');
  assert.equal(iso('digest'), 'no-exec');
  assert.equal(iso('worker', { profile: 'read', key: 'api' }), 'no-exec');
  assert.equal(iso('maker'), 'hooks-only', '有执行能力但没开 OS 沙盒：只有 hook 护栏，不是隔离');
  assert.equal(iso('worker', { profile: 'write', key: 'api' }), 'hooks-only');
  assert.equal(iso('maker', { sandbox: { enabled: true } }), 'os-sandbox');
  assert.equal(iso('worker', { profile: 'sandbox', key: 'api', sandbox: { enabled: true } }), 'os-sandbox');
  // 无执行能力的角色传了 sandbox 也不许自称被沙盒隔离——它本来就没有执行能力。
  assert.equal(iso('router', { sandbox: { enabled: true } }), 'no-exec');
  assert.equal(iso('maker', { sandbox: { enabled: false } }), 'hooks-only');
});

test('AC-025: OS 沙盒段只对有执行能力的派出生成，且键名严格按 Claude Code 的 settings 写', (t) => {
  const cfg = makeCfg(t);
  const sandbox = {
    enabled: true,
    allowWrite: [path.join(cfg.dossierDir, ID, 'maker-r1.log.json')],
    denyWrite: [cfg.specsDir],
    denyRead: [path.join(cfg.root, 'secrets')],
    allowedDomains: ['registry.npmjs.org'],
  };
  const on = buildAgentSettings(cfg, ID, 'maker', 1, { sandbox });
  assert.deepEqual(on.sandbox, {
    enabled: true,
    failIfUnavailable: true, // 沙盒起不来就别跑：静默降级成无隔离是最坏的结果
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false, // 不许模型用 dangerouslyDisableSandbox 自己逃出去
    filesystem: { allowWrite: sandbox.allowWrite, denyWrite: sandbox.denyWrite, denyRead: sandbox.denyRead },
    network: { allowedDomains: sandbox.allowedDomains, strictAllowlist: true },
  });
  assert.notEqual(on.sandbox.filesystem.allowWrite, sandbox.allowWrite, '数组是拷贝，不是把内核的对象别名出去');

  // 缺省字段补空数组：strictAllowlist 下「没写允许域名」= 一个域名都不许连。
  const bare = buildAgentSettings(cfg, ID, 'maker', 1, { sandbox: { enabled: true } }).sandbox;
  assert.deepEqual(bare.filesystem, { allowWrite: [], denyWrite: [], denyRead: [] });
  assert.deepEqual(bare.network, { allowedDomains: [], strictAllowlist: true });

  // 关 / 不传 / 非严格 true → 根本不出现 sandbox 键（settings 里没有这一段 = 宿主不开沙盒）。
  for (const s of [null, undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }]) {
    assert.equal(Object.hasOwn(buildAgentSettings(cfg, ID, 'maker', 1, { sandbox: s }), 'sandbox'), false,
      `sandbox=${JSON.stringify(s)} 不该生成沙盒段`);
  }
  // 无执行能力的角色：即便传了 enabled=true 也不写沙盒段，免得记录里假装有隔离。
  for (const [role, opts] of [['router', {}], ['digest', {}], ['reviewer', {}], ['worker', { profile: 'read', key: 'api' }]]) {
    const s = buildAgentSettings(cfg, ID, role, 1, { ...opts, sandbox });
    assert.equal(Object.hasOwn(s, 'sandbox'), false, `${role} 不该有 sandbox 段`);
  }
  const wx = buildAgentSettings(cfg, ID, 'worker', 1, { profile: 'sandbox', key: 'api', sandbox });
  assert.equal(wx.sandbox.enabled, true, 'sandbox 档的 worker 正是这层隔离的主要使用者');
});

// profile 决定权限档，不是给人看的标签：缺了它内核就不知道该不该给 Bash，缺了 key 并行 worker
// 会互相覆盖案卷。两者都必须在构造派出参数时当场炸，而不是默默落到某个档上。
test('AC-025: worker 必须同时带 profile 与 key —— 缺失 / 非法都当场抛', (t) => {
  const cfg = makeCfg(t);
  const re = /worker 必须带 profile（read \| sandbox \| write）/;

  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { key: 'api' }), re);
  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile: null, key: 'api' }), re);
  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile: 'writer', key: 'api' }), re);
  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile: 'READ', key: 'api' }), re, 'profile 大小写敏感');
  assert.throws(() => buildAgentSettings(cfg, ID, 'worker', 1, { profile: 'exec', key: 'api' }), re);
  assert.throws(() => maxTurnsFor(cfg, 'worker'), re);

  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile: 'read' }), /worker 的产物名需要委派 key/);
  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'worker', 1, { profile: 'write', key: '' }), /worker 的产物名需要委派 key/);

  // 别的角色不受 profile 约束（传了也只是被忽略）。
  assert.equal(buildAgentSpawnSpec(cfg, ID, 'router', 1, { profile: 'write' }).profile, 'write');
  assert.throws(() => buildAgentSpawnSpec(cfg, ID, 'committer', 1), /未知角色/);
});

// 有执行能力的 worker：Bash 本来就读得到 worktree 之外的案卷，所以放行只读三件不增加任何能力；
// 真正精确到文件的是 log 与 report 两条 Edit 规则（worktree 之外只有这两个文件可写）。
test('AC-025: workerExecAllowedTools —— Bash + 只读三件 + 两个文件的 Edit 规则，联网可按配置关掉', (t) => {
  const cfg = makeCfg(t);
  const log = logPathFor(cfg, ID, 'worker', 2, { key: 'api' });
  const report = reportPathFor(cfg, ID, 'worker', 2, { key: 'api' });

  assert.deepEqual(workerExecAllowedTools(cfg, ID, 2, { key: 'api' }), [
    'Bash', 'Read', 'Grep', 'Glob', editRule(log), editRule(report), 'WebFetch', 'WebSearch',
  ]);
  // workerWebAccess=false：连 WebFetch / WebSearch 的免审批都收掉（无头模式下等于不可用）。
  assert.deepEqual(workerExecAllowedTools({ ...cfg, workerWebAccess: false }, ID, 2, { key: 'api' }), [
    'Bash', 'Read', 'Grep', 'Glob', editRule(log), editRule(report),
  ]);

  for (const profile of ['sandbox', 'write']) {
    const spec = buildAgentSpawnSpec(cfg, ID, 'worker', 2, { profile, key: 'api' });
    assert.deepEqual(spec.allowedTools, workerExecAllowedTools(cfg, ID, 2, { key: 'api' }), 'spawn spec 与纯函数同源');
    assert.equal(spec.permissionMode, 'acceptEdits');
    assert.equal(spec.allowedTools.some((r) => /[*?[]/.test(r)), false, '两条 Edit 规则不含通配：只放行这两个文件');
    assert.equal(spec.allowedTools.some((r) => r.startsWith('Write(')), false, 'Write(path) 规则 Claude Code 不查');
  }

  // read 档不走这条路：allowedTools 就是它的 --tools 全集，写入由 write-guard 收口。
  const ro = buildAgentSpawnSpec(cfg, ID, 'worker', 2, { profile: 'read', key: 'api' });
  assert.deepEqual(ro.allowedTools, [...WORKER_TOOLS.read]);
  assert.deepEqual(
    buildAgentSpawnSpec({ ...cfg, workerWebAccess: false }, ID, 'worker', 2, { profile: 'read', key: 'api' }).allowedTools,
    ['Read', 'Grep', 'Glob', 'Write'],
    'workerWebAccess=false 时 read 档也不留联网工具',
  );
});

// 无头模式下 acceptEdits 只放行 worktree 内的编辑；log 在 dossier/<id>/（worktree 之外），没有这条
// 规则 Write 就被当作 user-rejected、内核记 product: "missing"（task-20260914-003 r6/r7）。
// 规则必须精确到本轮 log 文件：多一个通配或换成 --add-dir，maker 就能改案卷。
test('maker 的 --allowedTools：Bash + 只放行本轮 log 的 Edit(//绝对路径) 规则（普通模式 / 包模式）', (t) => {
  const cfg = makeCfg(t);

  const plain = buildAgentSpawnSpec(cfg, ID, 'maker', 6);
  assert.deepEqual(plain.allowedTools, ['Bash', editRule(logPathFor(cfg, ID, 'maker', 6))]);
  assert.ok(plain.allowedTools[1].endsWith(`/${ID}/maker-r6.log.json)`));
  assert.deepEqual(makerAllowedTools(cfg, ID, 6), plain.allowedTools, 'spawn spec 与 makerAllowedTools 同源');

  const pkg = buildAgentSpawnSpec(cfg, ID, 'maker', 2, { pkg: 'P-001' });
  assert.deepEqual(pkg.allowedTools, ['Bash', editRule(logPathFor(cfg, ID, 'maker', 2, { pkg: 'P-001' }))]);
  assert.ok(pkg.allowedTools[1].endsWith(`/${ID}/maker-P-001-r2.log.json)`), '包 maker 放行的是带包段的 log');
  assert.notEqual(pkg.allowedTools[1], plain.allowedTools[1]);

  for (const spec of [plain, pkg]) {
    assert.equal(spec.allowedTools.length, 2, '只多这一条规则');
    assert.match(spec.allowedTools[1], /^Edit\(\/\/[^/]/, '绝对路径以 // 开头（单个 / 是相对 settings 源）');
    assert.equal(/[*?[]/.test(spec.allowedTools[1]), false, '不含通配：只放行 log 本身');
    assert.equal(spec.allowedTools.some((r) => r.startsWith('Write(')), false, 'Write(path) 规则 Claude Code 不查，必须是 Edit(…)');
  }

  // 静态集合与其他角色不受影响
  assert.deepEqual([...MAKER_ALLOWED_TOOLS], ['Bash']);
  assert.deepEqual(buildAgentSpawnSpec(cfg, ID, 'reviewer', 1).allowedTools, [...ROLE_TOOLS.reviewer]);
  // 契约变更：router 的 --tools 扩到只读三件 + Write，allowedTools 随之变（下面这条原本是 ['Write']）。
  assert.deepEqual(buildAgentSpawnSpec(cfg, ID, 'router', 1).allowedTools, ['Read', 'Grep', 'Glob', 'Write']);
  // maker 的 --tools 不再是 null：allowedTools 只管免审批，--tools 才是工具集的硬边界。
  assert.deepEqual(buildAgentSpawnSpec(cfg, ID, 'maker', 1).tools, [...EXEC_TOOLS]);
});
