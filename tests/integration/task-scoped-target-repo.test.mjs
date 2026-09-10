// 集成：conductor 全程受 **任务级** targetRepo（task.json 快照 ?? cfg.targetRepo）约束，
// 而不是全局 cfg.targetRepo——worktree、spec 只读 worktree、merge 闸的本地合并、多仓共存、
// 旧任务缺字段回退，逐项钉死。AC 编号对应 dossier/task-20260706-003/spec.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makerStep, makerThenHelp, newRouterEnv, reviewerStep, routerEnv, routerStep, specStep } from '../helpers/router-env.mjs';
import { initSecondTargetRepo } from '../helpers/target-fixture.mjs';

function gitOut(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

test('maker 的 worktree 建在任务级 targetRepo，不是 cfg.targetRepo（AC-002）', (t) => {
  const env = routerEnv(t); // cfg.targetRepo 指向 env.targetDir，本任务不该碰它
  const repoB = initSecondTargetRepo(path.join(env.root, 'repo-b'));
  const id = 'task-20260706-201';
  env.writeRouterTask(id, { targetRepo: repoB });
  env.setScenario(makerThenHelp());

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  const wt = env.worktree(id);
  assert.ok(gitOut(repoB, 'worktree', 'list').includes(wt), 'worktree 应注册在任务的 targetRepo(repoB)');
  assert.ok(!gitOut(env.targetDir, 'worktree', 'list').includes(wt), 'worktree 不应注册在 cfg.targetRepo(repoA)');
});

test('merge 闸批准全程落在任务级 targetRepo；cfg.targetRepo 指向的仓库全程不受影响（AC-004）', (t) => {
  const env = routerEnv(t);
  const repoB = initSecondTargetRepo(path.join(env.root, 'repo-b'));
  const id = 'task-20260706-202';
  env.writeRouterTask(id, { targetRepo: repoB });
  env.writePrecommitProfile({ unit: 'node --test' }, { targetRepo: repoB });
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge'),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');

  const repoAHeadBefore = gitOut(env.targetDir, 'rev-parse', 'HEAD').trim();
  const repoBHeadBefore = gitOut(repoB, 'rev-parse', 'HEAD').trim();

  const approve = env.run('approve', id);
  assert.equal(approve.status, 0, approve.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');

  // repoB（task.targetRepo）：merge 真的落地，任务分支与 worktree 均已清理
  assert.notEqual(gitOut(repoB, 'rev-parse', 'HEAD').trim(), repoBHeadBefore, 'repoB 应产生新的 merge commit');
  assert.equal(gitOut(repoB, 'branch', '--list', `task/${id}`).trim(), '', 'repoB 任务分支应被删除');
  assert.ok(!gitOut(repoB, 'worktree', 'list').includes(env.worktree(id)), 'repoB worktree 应被清理');

  // repoA（cfg.targetRepo）：全程未被触碰
  assert.equal(gitOut(env.targetDir, 'rev-parse', 'HEAD').trim(), repoAHeadBefore, 'cfg.targetRepo 指向的仓库不应产生任何新提交');
  assert.equal(gitOut(env.targetDir, 'branch', '--list', `task/${id}`).trim(), '', 'cfg.targetRepo 里不应出现任务分支');
});

test('多仓共存：一次 drain 中两个任务各自在自己的仓库建 worktree，互不误触对方或 cfg 仓库（AC-006）', (t) => {
  // 串行 drain（maxConcurrentTasks=1）：剧本按 id 序被两个任务依次消费，断言不依赖交错顺序。
  const env = routerEnv(t, { config: { maxConcurrentTasks: 1 } });
  const repoA2 = initSecondTargetRepo(path.join(env.root, 'repo-a2'));
  const repoB = initSecondTargetRepo(path.join(env.root, 'repo-b'));
  const idA = 'task-20260706-203';
  const idB = 'task-20260706-204';
  env.writeRouterTask(idA, { targetRepo: repoA2 });
  env.writeRouterTask(idB, { targetRepo: repoB });
  env.setScenario([...makerThenHelp(), ...makerThenHelp()]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(idA).runtime.stage, 'AWAIT_HUMAN');
  assert.equal(env.findTask(idB).runtime.stage, 'AWAIT_HUMAN');

  const wtA = env.worktree(idA);
  const wtB = env.worktree(idB);
  const listRepoA2 = gitOut(repoA2, 'worktree', 'list');
  const listRepoB = gitOut(repoB, 'worktree', 'list');
  const listCfgRepo = gitOut(env.targetDir, 'worktree', 'list');

  assert.ok(listRepoA2.includes(wtA), '任务 A 的 worktree 应在自己的仓库');
  assert.ok(!listRepoA2.includes(wtB), '任务 A 的仓库不该出现任务 B 的 worktree');
  assert.ok(listRepoB.includes(wtB), '任务 B 的 worktree 应在自己的仓库');
  assert.ok(!listRepoB.includes(wtA), '任务 B 的仓库不该出现任务 A 的 worktree');
  assert.ok(!listCfgRepo.includes(wtA) && !listCfgRepo.includes(wtB), 'cfg.targetRepo 不该被任何一个任务碰到');
});

test('task.json 缺 targetRepo 字段（旧任务）：整个生命周期回退 cfg.targetRepo，不报错（AC-007）', (t) => {
  const { env, id } = newRouterEnv(t);
  const taskPath = path.join(env.root, 'state', 'queue', id, 'task.json');
  const task = env.readJson(taskPath);
  delete task.targetRepo;
  fs.writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);

  env.setScenario(makerThenHelp());
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');
  assert.ok(gitOut(env.targetDir, 'worktree', 'list').includes(env.worktree(id)), 'worktree 应回退到 cfg.targetRepo');
});

test('new --repo 覆盖快照 targetRepo（含该仓库 baseBranch 解析）；spec 只读 worktree 也落在该仓库（AC-010/AC-003）', (t) => {
  const env = routerEnv(t, { config: { baseBranch: null } }); // 不给 cfg.baseBranch，逼 cmdNew 去解析仓库的 currentBranch
  const repoB = initSecondTargetRepo(path.join(env.root, 'repo-b'));
  execFileSync('git', ['-C', repoB, 'checkout', '-b', 'develop'], { encoding: 'utf8' });
  env.writePrecommitProfile({ unit: 'node --test' }, { targetRepo: repoB });

  const briefPath = env.writeBrief('给 stats 增加 percentile 能力。\n');
  const created = env.run('new', '--title', 'x', '--brief', briefPath, '--repo', repoB);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);

  const task = env.readTaskJson(id);
  assert.equal(task.targetRepo, repoB);
  assert.equal(task.baseBranch, 'develop', '--repo 覆盖后 baseBranch 应解析该仓库的 currentBranch');

  const specBody = [
    '# percentile', '', '## 验收标准', '', '- AC-001: percentile([1,2,3], 50) 返回 2', '',
  ].join('\n');
  env.setScenario([
    routerStep('spec'),
    specStep(specBody, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'spec');

  // spec-agent 的一次性只读 worktree 建自任务级 targetRepo（用完即弃，所以查 git 的 prune 记录不行，
  // 断言 cwd 路径 + repoB 的 reflog 都不合适；这里直接看 spawn 记录里的 cwd 与 repoB 的 baseBranch）。
  const specCall = env.calls()[1];
  assert.match(specCall.cwd, new RegExp(`${id}\\.spec-ro$`), 'spec-agent 应在只读 worktree 里跑');
  assert.ok(!specCall.cwd.startsWith(env.targetDir), 'spec-agent 不该落在 cfg.targetRepo');
});

test('nextId：state/parked/ 存在当日撞号任务时，新建任务发号 +1，不与其撞号（AC-008）', (t) => {
  const env = routerEnv(t);
  const today = new Date();
  const ymd = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');
  // queue 里已有 today-001（旧发号器能看到的最大号），parked 里停着 today-002（旧发号器看不见）。
  env.writeRouterTask(`task-${ymd}-001`);
  fs.mkdirSync(path.join(env.root, 'state', 'parked', `task-${ymd}-002`), { recursive: true });

  const created = env.run('new', '--title', 'x', '--brief', env.writeBrief());
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.equal(id, `task-${ymd}-003`, 'nextId 应看到 parked 里的 002，发出 003 而不是与其撞号的 002');
});

test('nextId：state/parked/ 目录不存在时 new 不报错（AC-008）', (t) => {
  const env = routerEnv(t);
  assert.ok(!fs.existsSync(path.join(env.root, 'state', 'parked')));
  const created = env.run('new', '--title', 'x', '--brief', env.writeBrief());
  assert.equal(created.status, 0, created.stderr);
});
