// 集成：runner 在关键边界崩溃后重启——恢复依据持久记录与实际状态，不重复制造副作用。
//
// 覆盖的验收场景：
//   · runner 在派工 / 落盘 / 集成关键边界崩溃后重启：无重复并发执行、无重复集成、无覆盖案卷，
//     已完成与未知操作被正确区分
//   · 过期任务晚到的结果：保留用于诊断，不并入当前计划
//   · merge 批准崩在「已合并、未归档」之间：认出已合并的事实，不再合一次
// 第一条用的是真进程：真的对 runner 发 SIGKILL，真的留下一个还活着的残留 agent 进程组。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CONDUCTOR, promptOf } from '../helpers/env.mjs';
import {
  approvedSpecEnv, assignment, bigSpec, dispatchStep, ledgerReviewerStep, routerStep, workerStep,
} from '../helpers/router-env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { newLedger, writeLedger } from '../../conductor/lib/dispatch-ledger.mjs';

const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const routerPrompts = (env) => env.calls().filter((c) => /router-r\d+\.log\.json/.test(promptOf(c))).map(promptOf);

async function waitFor(cond, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  assert.fail(`等待超时：${what}`);
}

test('SIGKILL runner 于 worker 执行中：重启后先收割残留 agent 再恢复——无并发执行、工作不丢、案卷不覆盖、成本不当免费', async (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2), config: { unknownSpawnCostEstimateEnabled: false } });
  env.setKeyed({
    'worker-api': [workerStep({
      init: true, session_id: 'sess-orphan', hang: true, // 写完文件与增量 log 之后一直挂着：runner 死后它仍活着
      outcome: 'partial', summary: '写了一半', done: ['half'], remaining: ['other half'],
      files: { 'lib/api/half.mjs': 'export const half = 0.5;\n' },
    })],
  });
  env.appendScenario([dispatchStep([assignment('api')]), stop()]);

  const runner = spawn(process.execPath, [CONDUCTOR, 'run'], { env: env.childEnv(), stdio: 'ignore' });
  let orphanPid = null;
  t.after(() => { if (orphanPid && alive(orphanPid)) { try { process.kill(-orphanPid, 'SIGKILL'); } catch { /* 已退出 */ } } });

  await waitFor(() => env.exists(env.dossier(id, 'worker-api-r2.log.json')) && env.exists(env.worktree(id, 'lib/api/half.mjs')), 'worker 写出文件与增量 log');
  await waitFor(() => Number.isInteger(env.readJson(env.dossier(id, 'worker-api-r2.json')).pid), 'spawn 记录带上 pid 身份');
  const exited = new Promise((resolve) => runner.once('exit', resolve));
  runner.kill('SIGKILL');
  await exited;

  // ---- 崩溃现场：残留 agent 还活着；spawn 记录有 started 无 done；台账没关；成本还没入账 ----
  const before = env.readJson(env.dossier(id, 'worker-api-r2.json'));
  orphanPid = before.pid;
  assert.ok(alive(orphanPid), 'runner 被杀后，它派出的 agent（独立进程组）还活着');
  assert.equal(before.done, undefined);
  assert.match(before.pid_started, /\d{4}/, '记录里有进程启动时刻：pid 被复用时不会误杀别人');
  assert.equal(env.readJson(env.dossier(id, 'dispatch-r2.json')).closed, false);
  const show = env.run('show', id).stdout;
  assert.match(show, /阶段：可恢复中断/);
  assert.match(show, /worker-api r2（进程 alive）/);
  assert.match(show, /继续：conductor run（启动时先收割残留/);
  const dry = env.run('recover', '--dry-run');
  assert.match(dry.stderr, /未收尾的 spawn=worker-api-r2\(alive\)；未关账的 dispatch=r2/);
  assert.ok(alive(orphanPid), 'dry-run 什么都不动');

  // ---- 重启 ----
  const restart = env.run('run');
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stderr, /上一次运行没有正常收尾，接管它的运行账本/);
  await waitFor(() => !alive(orphanPid), '残留 agent 被收割');

  // 无重复并发执行：worker-api 总共只被派出过一次；恢复不自动重派，续不续由 router 定。
  assert.equal(env.calls().filter((c) => c.key === 'worker-api').length, 1);

  // 已知 / 未知被区分开：记录补记为 interrupted + 成本未知；增量 log 的自述照原样保留。
  const rec = env.readJson(env.dossier(id, 'worker-api-r2.json'));
  assert.equal(rec.interrupted, true);
  assert.equal(rec.cost_unknown, true);
  assert.equal(rec.recovered.process, 'killed');
  assert.equal(rec.session_id, 'sess-orphan', '会话 id 从已落盘的原始流里找回，之后可续接');
  assert.equal(env.readRuntime(id).unknown_cost_spawns, 1, '未知费用显式计数，不当成确定免费');

  // 工作不丢、案卷不覆盖：残留改动已提交并集成；台账由恢复流程关账；旧轮次文件都在。
  assert.ok(git(env.targetDir, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/api/half.mjs'));
  const ledger = env.readJson(env.dossier(id, 'dispatch-r2.json'));
  assert.equal(ledger.closed, true);
  assert.equal(ledger.recovered, true);
  assert.equal(ledger.assignments[0].state, 'integrated');
  assert.deepEqual(ledger.assignments[0].spawns.map((s) => [s.round, s.outcome, s.interrupted]), [[2, 'partial', true]]);
  assert.ok(env.exists(env.dossier(id, 'router-r2.log.json')), '崩溃前那一轮的 router 案卷还在');
  assert.ok(env.readRuntime(id).current_round >= 3, '恢复后的 router 用的是新轮次号');
  const recovered = env.events(id).find((e) => e.type === 'recovered');
  assert.deepEqual(recovered.actions.map((a) => a.kind), ['spawn_reaped', 'dispatch_closed']);

  // router 看到的是事实：被中断、做到哪、能不能续。
  const next = routerPrompts(env).at(-1);
  assert.match(next, /r2 worker api .*outcome=partial .*interrupted=yes/);
  assert.match(next, /api .*state=integrated .*interrupted=yes  可续接=continue_from:2/);
  assert.match(next, /成本未知的会话 1 次/);
});

test('恢复是幂等的：崩在「已落盘、未提交 / 未集成」→ 补做一次；崩在「已集成、未关账」→ 不再合一次；再跑一遍什么都不发生', async (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  env.setKeyed({ 'worker-base': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })] });
  env.appendScenario([dispatchStep([assignment('base')]), stop()]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.run('resume', id).status, 0);

  // 手工造一个「并行 write 委派跑完了、runner 崩在提交之前」的现场：分支 + worktree 里有未提交的改动，
  // 台账停在 running，spawn 记录有 started 无 done（pid 已死）。
  const repo = env.targetDir;
  const head = git(repo, 'rev-parse', `task/${id}`);
  const wt = path.join(env.root, 'worktrees', `${id}--web`);
  git(repo, 'worktree', 'add', '-b', `task/${id}--web`, wt, head);
  fs.mkdirSync(path.join(wt, 'lib/web'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'lib/web/page.mjs'), 'export const page = 1;\n');
  const cfg = { dossierDir: path.join(env.root, 'dossier') };
  const spec = env.readRuntime(id).spec_sha256;
  const round = env.readRuntime(id).current_round + 1;
  writeLedger(cfg, id, newLedger({
    round, baseHead: head, specSha: spec,
    assignments: [{
      ...assignment('web', 'write', { paths: ['lib/web/**'] }), placement: 'isolated', branch: `task/${id}--web`, worktree: wt,
      state: 'running', spawns: [{ round, resume_of: null, state: 'running' }],
      commit_sha: null, integrated_sha: null, conflict_files: [], changed_files: [], out_of_scope_files: [], note: null,
    }],
  }));
  fs.writeFileSync(env.dossier(id, `worker-web-r${round}.json`), JSON.stringify({ role: 'worker', key: 'web', profile: 'write', round, started: new Date().toISOString(), pid: 999999, pid_started: 'Thu Jan  1 00:00:00 1970' }));
  const rt = env.readRuntime(id);
  fs.writeFileSync(path.join(env.findTask(id).dir, 'runtime.json'), JSON.stringify({ ...rt, current_round: round }));

  const first = env.run('recover');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /spawn_reaped worker-web r\d+ 进程=dead/);
  assert.match(first.stderr, /dispatch_closed web=integrated/);
  const after = git(repo, 'rev-parse', `task/${id}`);
  assert.notEqual(after, head);
  assert.ok(git(repo, 'ls-tree', '-r', '--name-only', `task/${id}`).includes('lib/web/page.mjs'), '未提交的残留被提交并集成');
  const integrations = () => git(repo, 'log', '--oneline', `task/${id}`).split('\n').filter((l) => /integrate web/.test(l)).length;
  assert.equal(integrations(), 1);

  // 把台账改回「未关账」（模拟崩在集成之后、关账之前）：再恢复一次，不得重复集成。
  const ledgerPath = env.dossier(id, `dispatch-r${round}.json`);
  const reopened = env.readJson(ledgerPath);
  reopened.closed = false;
  reopened.assignments[0].state = 'committed';
  fs.writeFileSync(ledgerPath, JSON.stringify(reopened));
  assert.equal(env.run('recover').status, 0);
  assert.equal(git(repo, 'rev-parse', `task/${id}`), after, '任务分支 HEAD 原样：没有第二次集成');
  assert.equal(integrations(), 1);
  assert.equal(env.readJson(ledgerPath).closed, true);

  // 第三次：没有任何残留。
  assert.match(env.run('recover').stderr, /没有需要恢复的残留/);
});

test('过期结果不并入当前计划：派出后获批 spec 版本变了 → 晚到的结果标 stale，分支保留作诊断，任务分支不动', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  env.setKeyed({ 'worker-base': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })] });
  env.appendScenario([dispatchStep([assignment('base')]), stop()]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.run('resume', id).status, 0);

  const repo = env.targetDir;
  const head = git(repo, 'rev-parse', `task/${id}`);
  const wt = path.join(env.root, 'worktrees', `${id}--late`);
  git(repo, 'worktree', 'add', '-b', `task/${id}--late`, wt, head);
  fs.writeFileSync(path.join(wt, 'late.mjs'), 'export const late = 1;\n');
  const round = env.readRuntime(id).current_round + 1;
  writeLedger({ dossierDir: path.join(env.root, 'dossier') }, id, newLedger({
    round, baseHead: head, specSha: 'a'.repeat(64), // 派出时绑定的是另一个（已过期的）spec 版本
    assignments: [{
      ...assignment('late', 'write', { paths: ['late.mjs'] }), placement: 'isolated', branch: `task/${id}--late`, worktree: wt,
      state: 'finished', spawns: [{ round, state: 'done', outcome: 'ok' }],
      commit_sha: null, integrated_sha: null, conflict_files: [], changed_files: [], out_of_scope_files: [], note: null,
    }],
  }));
  assert.equal(env.run('recover').status, 0);
  const ledger = env.readJson(env.dossier(id, `dispatch-r${round}.json`));
  assert.equal(ledger.assignments[0].state, 'stale');
  assert.match(ledger.assignments[0].note, /已不是当前获批版本，结果未集成/);
  assert.equal(git(repo, 'rev-parse', `task/${id}`), head, '任务分支不动');
  assert.ok(git(repo, 'log', '--oneline', `task/${id}--late`).includes('stale, not integrated'), '结果留在自己的分支上供诊断');
});

test('merge 批准崩在「已合并、未归档」之间：重启认出已合并的事实，只补完归档——不再合一次，也不误判回 ROUTING', (t) => {
  const { env, id } = approvedSpecEnv(t, { specBody: bigSpec(2) });
  env.setKeyed({ 'worker-a': [workerStep({ files: { 'lib/stats.mjs': FIXED_STATS } })] });
  env.appendScenario([
    dispatchStep([assignment('a')]),
    routerStep('review'), ledgerReviewerStep({ 'AC-001': 'pass', 'AC-002': 'pass' }),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '可以合并' }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');

  // 模拟 approve 的前半截：预写意图 + 真的合并了，然后进程死了（没写裁决、没清产物、没转 DONE）。
  const repo = env.targetDir;
  const headSha = git(repo, 'rev-parse', `task/${id}`);
  const baseSha = git(repo, 'rev-parse', 'main');
  fs.writeFileSync(env.dossier(id, 'merge-intent.json'), JSON.stringify({
    schema_version: 1, head_sha: headSha, base_sha: baseSha, branch: `task/${id}`, message: `task ${id}: merged`, notes: null,
  }));
  git(repo, 'merge', '--no-ff', `task/${id}`, '-m', `task ${id}: merged`);
  const mergedMain = git(repo, 'rev-parse', 'main');

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /merge 已完成但未归档/);
  const done = env.findTask(id);
  assert.equal(done.box, 'done');
  assert.equal(done.runtime.stage, 'DONE');
  assert.equal(git(repo, 'rev-parse', 'main'), mergedMain, 'base 分支没有被再合一次');
  assert.equal(env.exists(env.dossier(id, 'merge-intent.json')), false);
  assert.equal(env.events(id).filter((e) => e.type === 'merged').length, 1);
  assert.equal(env.exists(env.worktree(id)), false, '归档时照常清理 worktree');
});
