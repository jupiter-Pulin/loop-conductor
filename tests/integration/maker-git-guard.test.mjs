// 集成：maker spawn 带 --settings 指向逐轮生成的 git 护栏 settings（maker-r<n>.settings.json），
// settings 内容为 PreToolUse(Bash) → maker-git-guard.mjs；只读角色（router / reviewer）走的是
// 写白名单 write-guard，不带 git 护栏。护栏判定本身见 tests/unit/hooks.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makerThenHelp, newRouterEnv } from '../helpers/router-env.mjs';

test('maker spawn：--settings 指向 dossier 逐轮 git 护栏 settings，内容锚到 maker-git-guard', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario(makerThenHelp());

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  // maker 是 call 1（call 0 是 router）：--settings 指向 dossier 内逐轮 settings 文件
  const makerCall = env.calls()[1];
  const settingsPath = makerCall.argv[makerCall.argv.indexOf('--settings') + 1];
  assert.equal(settingsPath, env.dossier(id, 'maker-r1.settings.json'), '--settings 指向逐轮 git 护栏文件');

  // maker（cold）：headless 无人审批，--allowedTools 须放行 Bash（跑测试/本地 git commit）。
  // --tools 是显式白名单：真实 CLI 的「全工具集」里有 Task / CronCreate / RemoteTrigger / SendMessage
  // 之类不经内核授权、不单独入账、不受停止控制的旁路，白名单之外一律不可见。
  const tools = makerCall.argv[makerCall.argv.indexOf('--tools') + 1].split(',');
  assert.ok(makerCall.argv.includes('--tools'), 'maker 带 --tools 显式白名单');
  assert.ok(tools.includes('Bash') && tools.includes('Edit') && tools.includes('Read'));
  for (const bypass of ['Task', 'Agent', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'ScheduleWakeup', 'Workflow', 'Skill']) {
    assert.equal(tools.includes(bypass), false, `maker 的工具集不得含 ${bypass}`);
  }
  const allowedTools = makerCall.argv[makerCall.argv.indexOf('--allowedTools') + 1];
  assert.ok(allowedTools, 'maker cold spawn 带 --allowedTools');
  assert.ok(allowedTools.split(',').includes('Bash'), 'maker --allowedTools 含 Bash');
  // log 在 dossier（worktree 之外），acceptEdits 不放行；靠一条精确到本轮 log 的 Edit(//绝对路径) 规则免审批。
  const logPath = env.dossier(id, 'maker-r1.log.json');
  assert.ok(allowedTools.split(',').includes(`Edit(//${logPath.replace(/^\/+/, '')})`), 'maker --allowedTools 只多放行本轮 log');

  // settings 内容：PreToolUse 只匹配 Bash，hook 命令锚到 maker-git-guard.mjs；
  // Stop 是 check-log（交付契约第五条），与旧纪元「maker 无 Stop 预检」不同。
  const settings = env.readJson(settingsPath);
  const pre = settings.hooks.PreToolUse[0];
  assert.equal(pre.matcher, 'Bash');
  assert.match(pre.hooks[0].command, /maker-git-guard\.mjs/);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /check-log\.mjs/);

  // router（call 0）：只读角色不带 git 护栏，PreToolUse 是写白名单
  const routerSettings = env.readJson(env.dossier(id, 'router-r1.settings.json'));
  assert.match(routerSettings.hooks.PreToolUse[0].matcher, /Write/);
  assert.match(routerSettings.hooks.PreToolUse[0].hooks[0].command, /write-guard\.mjs/);
});
