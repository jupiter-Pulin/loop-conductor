// 集成测试助手：新状态机（router conductor）的剧本片段与环境搭建。
// 每个 step 就是 fake-claude 的一次调用：router 只写一份 log，maker 顺带改 target 仓的文件。
// log 的绝对路径由内核注入 prompt，fake-claude 的 writeLog 从 prompt 里取——路径漏注入时当场红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv } from './env.mjs';
import { FIXED_STATS } from './target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

export function routerStep(action, over = {}) {
  const { tier, summary, cost = 0.01, ...rest } = over;
  return {
    cost,
    actions: [{
      type: 'writeLog',
      content: {
        role: 'router',
        outcome: 'ok',
        action,
        ...(tier ? { tier } : {}),
        summary: summary ?? `router 选择 ${action}`,
      },
    }],
    result: 'ok',
    ...rest,
  };
}

export function makerStep(over = {}) {
  const { actions = [FIX], outcome = 'ok', summary = 'AC-001 done；node --test 全绿', cost = 0.1, ...rest } = over;
  return {
    cost,
    actions: [...actions, { type: 'writeLog', content: { role: 'maker', outcome, summary } }],
    result: 'ok',
    ...rest,
  };
}

export function reviewerStep(over = {}) {
  const { outcome = 'ok', tier = 'unit', summary = 'B-001 pass', cost = 0.05, ...rest } = over;
  return {
    cost,
    actions: [{ type: 'writeLog', content: { role: 'reviewer', outcome, tier, summary } }],
    result: 'ok',
    ...rest,
  };
}

export function specStep(specBody, over = {}) {
  const { outcome = 'ok', summary = 'AC×2；触及 lib/stats.mjs；工作包 0；待决 0', cost = 0.05, specPath, ...rest } = over;
  return {
    cost,
    actions: [
      { type: 'writeFile', path: specPath, content: specBody },
      { type: 'writeLog', content: { role: 'spec', outcome, summary } },
    ],
    result: 'ok',
    ...rest,
  };
}

/** 建一个「目标仓已配好 precommit 段」的环境，并用新 CLI 建一个任务，返回 { env, id }。 */
export function newRouterEnv(t, { config = {}, precommit = { unit: 'node --test' }, brief } = {}) {
  // spawnBackoffMs 压到毫秒级：剧本步数写错时，代价是测试立刻红，而不是五分钟退避阶梯。
  const env = makeEnv(t, { config: { eventsLogEnabled: true, spawnBackoffMs: [5, 5, 5], ...config } });
  env.writePrecommitProfile(precommit);
  const briefPath = env.writeBrief(brief ?? 'median 的偶数分支应取中间两数平均；补一条在旧代码上会失败的测试。\n');
  const created = env.run('new', '--title', 'median 偶数分支返回错误', '--brief', briefPath);
  assert.equal(created.status, 0, created.stderr);
  const id = /id: (task-\d{8}-\d{3})/.exec(created.stdout)?.[1];
  assert.ok(id, `new 应打印 id，实际 stdout=${created.stdout}`);
  return { env, id };
}


// ---- 造「人在 worktree 里动过手」与「base 往前走了一步」的场景 ----

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** 在任务 worktree 里落一次提交（模拟人在 help 闸期间自己动手），返回新的 H。 */
export function commitInTaskWorktree(env, id, files, message = 'human fix during help gate') {
  const wt = env.worktree(id);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(wt, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', message);
  return git(wt, 'rev-parse', 'HEAD').trim();
}

/** base 分支自己往前走一步（precommit 基线过期的场景），返回新的 B。 */
export function commitOnBase(env, files, message = 'base moved') {
  const repo = env.targetDir;
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/** 目标仓的 rev-parse（断言 H / B 用）。 */
export function sha(env, ref) {
  return git(env.targetDir, 'rev-parse', ref).trim();
}
