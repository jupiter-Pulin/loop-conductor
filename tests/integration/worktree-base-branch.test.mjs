// 集成：F18/E29 —— 任务 worktree 必须建自 task.baseBranch，不吃活体仓瞬时 HEAD。
// 真实事故（task-20260710-001）：baseBranch=feat/<product-branch> 而活体仓停在 main，
// `git worktree add -b` 无起点参数默认 HEAD → maker 在错误基线上重造大量已有代码，
// 冷读 diff 的审核对着被无关提交污染的 diff 照样全 pass（假绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makerThenHelp, routerEnv } from '../helpers/router-env.mjs';

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

test('HEAD ≠ baseBranch 时 worktree 建自 baseBranch（F18 回归钉死）', (t) => {
  const env = routerEnv(t);
  const id = 'task-20260710-901';

  // 造出分叉：feat/base 上有独有 marker 文件；随后活体仓切去另一个分支（HEAD ≠ baseBranch）
  g(env.targetDir, 'checkout', '-b', 'feat/base');
  fs.writeFileSync(path.join(env.targetDir, 'BASE_MARKER.md'), 'only on feat/base\n');
  g(env.targetDir, 'add', '-A');
  g(env.targetDir, 'commit', '-m', 'marker: feat/base only');
  const baseTip = g(env.targetDir, 'rev-parse', 'feat/base');
  g(env.targetDir, 'checkout', 'main');
  g(env.targetDir, 'checkout', '-b', 'unrelated-work'); // 活体 HEAD 停在别处

  env.writeRouterTask(id, { baseBranch: 'feat/base' });
  env.setScenario(makerThenHelp());
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  const wt = env.worktree(id);
  // 核心断言：任务分支的第一个 commit 的父 == feat/base 头（不是 HEAD 所在的 unrelated-work/main）
  const makerParent = g(wt, 'rev-parse', 'HEAD^');
  assert.equal(makerParent, baseTip, `任务分支应从 feat/base(${baseTip.slice(0, 8)}) 分叉，实际父=${makerParent.slice(0, 8)}`);
  // 佐证：baseBranch 独有的 marker 文件必须出现在 worktree（HEAD 基线不会有）
  assert.ok(fs.existsSync(path.join(wt, 'BASE_MARKER.md')), 'worktree 应含 feat/base 独有文件');
  // 活体仓 HEAD 未被动过
  assert.equal(g(env.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'unrelated-work');
});
