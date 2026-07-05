// 集成：maker spawn 带 --settings 指向逐轮生成的 git 护栏 settings（maker-r<n>.settings.json），
// settings 内容为 PreToolUse(Bash) → maker-git-guard.mjs。护栏判定本身见 tests/unit/hooks.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('maker spawn：--settings 指向 dossier 逐轮 git 护栏 settings，内容锚到 maker-git-guard', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-maker-1',
      cost: 0.10,
      result: '已修复',
    },
    verifierStep(1),
  ]);
  const id = 'task-20260611-001';
  env.writeTask(id, { stage: 'READY' });

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  // maker（call 0）：--settings 指向 dossier 内逐轮 settings 文件
  const makerCall = env.calls()[0];
  const settingsPath = makerCall.argv[makerCall.argv.indexOf('--settings') + 1];
  assert.equal(settingsPath, env.dossier(id, 'maker-r1.settings.json'), '--settings 指向逐轮 git 护栏文件');

  // maker（cold）：headless 无人审批，--allowedTools 须放行 Bash（跑测试/本地 git commit），
  // 且仍不带 --tools（全工具可见，spec §3.3 只对 plan/verifier 等只读角色做硬限制）。
  assert.equal(makerCall.argv.includes('--tools'), false, 'maker 不做 --tools 硬限制');
  const allowedTools = makerCall.argv[makerCall.argv.indexOf('--allowedTools') + 1];
  assert.ok(allowedTools, 'maker cold spawn 带 --allowedTools');
  assert.ok(allowedTools.split(',').includes('Bash'), 'maker --allowedTools 含 Bash');

  // settings 内容：PreToolUse 只匹配 Bash，hook 命令锚到 maker-git-guard.mjs
  const settings = env.readJson(settingsPath);
  const pre = settings.hooks.PreToolUse[0];
  assert.equal(pre.matcher, 'Bash');
  assert.match(pre.hooks[0].command, /maker-git-guard\.mjs/);
  assert.equal(settings.hooks.Stop, undefined, 'maker 无 Stop 预检（交付裁决在 green gate/verifier）');

  // verifier（call 1）：不注入 maker 的 git 护栏 settings
  const verifierCall = env.calls()[1];
  assert.equal(verifierCall.argv.indexOf('--settings'), -1, 'verifier 不带 maker settings');
});
