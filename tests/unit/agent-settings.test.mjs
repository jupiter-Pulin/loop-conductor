// 单元：角色的工具集、白名单、Stop hook 与 maxTurns（AC-025 的纯函数面）。
// 这些边界不是风格问题：router 多一个 Bash 就能执行 git，spec 方案模式多一条 spec 路径
// 就能改范围（Invariant 8），reviewer 多一条写路径就能改它正在审的代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgentSpawnSpec, buildAgentSettings, writeAgentSettings, allowedWritePaths,
  artifactBase, logPathFor, maxTurnsFor, ROLE_TOOLS, MAKER_ALLOWED_TOOLS, DEFAULT_MAX_TURNS, CWD_KIND,
} from '../../conductor/lib/agent-settings.mjs';

const ID = 'task-20260830-001';

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

const preCommand = (settings) => settings.hooks.PreToolUse[0].hooks[0].command;
const stopCommands = (settings) => settings.hooks.Stop[0].hooks.map((h) => h.command);

test('AC-025: 工具集逐项与角色表一致', () => {
  assert.deepEqual([...ROLE_TOOLS.router], ['Write'], 'router 只有 Write —— 没有 Bash 就不可能执行 git');
  assert.deepEqual([...ROLE_TOOLS.reviewer], [
    'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Write',
  ]);
  assert.deepEqual([...ROLE_TOOLS.spec], [
    'Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)', 'Write', 'Edit',
  ]);
  assert.equal(ROLE_TOOLS.maker, null, 'maker 不设 --tools（全工具集）');
  assert.deepEqual([...MAKER_ALLOWED_TOOLS], ['Bash']);
});

test('AC-025: maxTurns 默认 router 4 / spec 40 / plan 25 / maker 70 / reviewer 40，可被 config 覆盖', (t) => {
  const cfg = makeCfg(t);
  assert.deepEqual({ ...DEFAULT_MAX_TURNS }, { router: 4, spec: 40, plan: 25, maker: 70, reviewer: 40 });
  assert.equal(maxTurnsFor(cfg, 'router'), 4);
  assert.equal(maxTurnsFor(cfg, 'spec'), 40);
  assert.equal(maxTurnsFor(cfg, 'spec', { mode: 'plan' }), 25);
  assert.equal(maxTurnsFor(cfg, 'maker'), 70);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: { maker: 12 } }, 'maker'), 12);
  assert.equal(maxTurnsFor({ ...cfg, maxTurns: 30 }, 'maker'), 70, '旧的标量 maxTurns 不再喂新角色');
});

test('AC-025: 产物基名与 log 路径 —— 方案模式 spec-plan、包 maker 带包段', (t) => {
  const cfg = makeCfg(t);
  assert.equal(artifactBase('router'), 'router');
  assert.equal(artifactBase('spec', { mode: 'plan' }), 'spec-plan');
  assert.equal(artifactBase('maker', { pkg: 'P-001' }), 'maker-P-001');
  assert.equal(path.basename(logPathFor(cfg, ID, 'reviewer', 3)), 'reviewer-r3.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'maker', 2, { pkg: 'P-002' })), 'maker-P-002-r2.log.json');
  assert.equal(path.basename(logPathFor(cfg, ID, 'spec', 1, { mode: 'plan' })), 'spec-plan-r1.log.json');
  assert.throws(() => artifactBase('committer'), /未知角色/);
});

test('AC-025: cwd 语义 —— router 在 conductor root，spec 两种只读 worktree，包 maker 在包 worktree', (t) => {
  const cfg = makeCfg(t);
  const spec = (role, opts) => buildAgentSpawnSpec(cfg, ID, role, 1, opts);
  assert.equal(spec('router').cwdKind, CWD_KIND.router);
  assert.equal(spec('router').cwd, cfg.root);
  assert.equal(spec('spec').cwd, path.join(cfg.worktreesDir, `${ID}.spec-ro`));
  assert.equal(spec('spec', { mode: 'plan' }).cwd, path.join(cfg.worktreesDir, `${ID}.plan-ro`));
  assert.equal(spec('maker').cwd, path.join(cfg.worktreesDir, ID));
  assert.equal(spec('maker', { pkg: 'P-003' }).cwd, path.join(cfg.worktreesDir, `${ID}--P-003`));
  assert.equal(spec('reviewer').cwd, path.join(cfg.worktreesDir, ID));
});

test('AC-025: 白名单 —— router / reviewer 仅 log；spec 起草是 spec+packages+log；方案模式仅 packages+log', (t) => {
  const cfg = makeCfg(t);
  const specPath = path.join(cfg.specsDir, `${ID}.md`);
  const pkgPath = path.join(cfg.specsDir, `${ID}.packages.json`);

  assert.deepEqual(allowedWritePaths(cfg, ID, 'router', 1), [logPathFor(cfg, ID, 'router', 1)]);
  assert.deepEqual(allowedWritePaths(cfg, ID, 'reviewer', 1), [logPathFor(cfg, ID, 'reviewer', 1)]);

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

test('AC-025: PreToolUse —— 非 maker 走 write-guard 白名单，maker 沿用 git 护栏', (t) => {
  const cfg = makeCfg(t);
  const router = buildAgentSettings(cfg, ID, 'router', 1);
  assert.equal(router.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.match(preCommand(router), /write-guard\.mjs/);
  assert.match(preCommand(router), /--allow/);
  assert.ok(preCommand(router).includes(logPathFor(cfg, ID, 'router', 1)));

  const maker = buildAgentSettings(cfg, ID, 'maker', 1);
  assert.equal(maker.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(preCommand(maker), /maker-git-guard\.mjs/);
  assert.equal(/write-guard\.mjs/.test(preCommand(maker)), false);
  assert.deepEqual(buildAgentSpawnSpec(cfg, ID, 'maker', 1).allowedWritePaths, []);
});

test('AC-025: Stop hook —— 每个角色都挂 check-log；spec 起草轮叠加 check-spec，方案模式不叠加', (t) => {
  const cfg = makeCfg(t);
  for (const role of ['router', 'spec', 'maker', 'reviewer']) {
    const cmds = stopCommands(buildAgentSettings(cfg, ID, role, 1));
    assert.match(cmds[0], /check-log\.mjs/, `${role} 必须挂 check-log`);
    assert.match(cmds[0], new RegExp(`--role "${role}"`));
    assert.ok(cmds[0].includes(logPathFor(cfg, ID, role, 1)));
    assert.ok(cmds[0].includes('.log.hook.json'), '报告文件名固定为 <role>-r<n>.log.hook.json');
  }
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'spec', 1)).length, 2);
  assert.match(stopCommands(buildAgentSettings(cfg, ID, 'spec', 1))[1], /check-spec\.mjs/);
  const plan = stopCommands(buildAgentSettings(cfg, ID, 'spec', 1, { mode: 'plan' }));
  assert.equal(plan.length, 1, '方案模式不写 spec 正文，不挂 spec 契约门');
  assert.equal(stopCommands(buildAgentSettings(cfg, ID, 'maker', 1)).length, 1);
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
});

test('AC-025: spawn spec 的 tools/allowedTools/permissionMode 与角色一一对应', (t) => {
  const cfg = makeCfg(t);
  const router = buildAgentSpawnSpec(cfg, ID, 'router', 1);
  assert.deepEqual(router.tools, ['Write']);
  assert.deepEqual(router.allowedTools, ['Write']);
  assert.equal(router.permissionMode, null);
  assert.equal(router.maxTurns, 4);

  const maker = buildAgentSpawnSpec(cfg, ID, 'maker', 1);
  assert.equal(maker.tools, null);
  assert.deepEqual(maker.allowedTools, ['Bash']);
  assert.equal(maker.permissionMode, 'acceptEdits');

  const reviewer = buildAgentSpawnSpec(cfg, ID, 'reviewer', 1);
  assert.equal(reviewer.tools.includes('Edit'), false, 'reviewer 不改代码');
  assert.equal(reviewer.tools.includes('Bash'), false, '只有 Bash(git …:*) 三条白名单');
});
