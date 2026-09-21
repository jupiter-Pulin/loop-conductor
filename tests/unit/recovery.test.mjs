// 单元：runner 退出（含崩溃、被 SIGKILL）之后的重启恢复面。
//
// 恢复只认两样东西：盘上的持久记录，和当下的实际状态（进程还在不在、分支合没合进去）。
// 这份测试盯住其中三条最容易出人命的边界：
//   1. 哪些 spawn 记录算「派出后没收尾」——多认一条会去杀不该杀的，少认一条就会让
//      新旧两个执行者同时改同一个 worktree；
//   2. 收割残留 agent 必须按 **pid + 启动时刻** 认身份：对得上才杀；pid 被复用（启动时刻对不上）
//      时那是别人的进程，绝不能发信号。这条是「内核不会杀掉陌生人进程」的唯一保证；
//   3. merge 崩在「已合并、未归档」之间时，要从 git 事实认出「已经合过了」，
//      而不是再合一次、也不是把任务误判回去重走批准。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  clearMergeIntent, mergeIntentPath, mergedButNotArchived, reapUnfinishedSpawn, unfinishedSpawns,
  writeMergeIntent,
} from '../../conductor/lib/recovery.mjs';
import { isPidAlive, pidStartTime, processState } from '../../conductor/lib/proc.mjs';
import { gitOk, headOf } from '../../conductor/lib/git.mjs';
import { initTargetRepo } from '../helpers/target-fixture.mjs';

const TASK_ID = 'task-20260920-001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCfg(t, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateDir: path.join(root, 'state'),
    dossierDir: path.join(root, 'dossier'),
    worktreesDir: path.join(root, 'worktrees'),
    ...over,
  };
}

/** 往案卷里直接落一个文件（恢复读的是盘，不是内存，所以夹具也只写盘）。 */
function writeDossier(cfg, name, content) {
  const p = path.join(cfg.dossierDir, TASK_ID, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return p;
}

const readDossier = (cfg, name) => JSON.parse(fs.readFileSync(path.join(cfg.dossierDir, TASK_ID, name), 'utf8'));
const hasDossier = (cfg, name) => fs.existsSync(path.join(cfg.dossierDir, TASK_ID, name));

/**
 * 起一个真的活着的分离子进程：`detached` 让它自成进程组组长，与内核派 agent 的形态一致
 * （killProcessGroup 要收的就是整个组）。t.after 无条件兜底收尸，免得用例挂了还留孤儿。
 */
async function spawnLiveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const { pid } = child;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } });
  let started = null;
  for (let i = 0; i < 40 && started == null; i++) {
    started = pidStartTime(pid);
    if (started == null) await sleep(25);
  }
  assert.ok(started, 'ps 取不到启动时刻就没法构造「身份对得上」的记录，这条用例失去意义');
  return { pid, started };
}

/**
 * 一个**确实已经退出并被收尸**的 pid。必须等到 'exit'：僵尸态下 kill(pid, 0) 仍然成功，
 * 不等的话 isPidAlive 会把一个死进程报成活的。
 */
async function spawnDeadChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const { pid } = child;
  const started = pidStartTime(pid);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  return { pid, started };
}

// ---- unfinishedSpawns：谁算「派出后没收尾」 ----

test('unfinishedSpawns：started 而没有 done 才算残留；done / 无 started / 非 spawn 产物一律不算', (t) => {
  const cfg = makeCfg(t);
  writeDossier(cfg, 'maker-r1.json', { role: 'maker', started: '2026-09-20T00:00:00.000Z', done: '2026-09-20T00:01:00.000Z' });
  writeDossier(cfg, 'maker-r2.json', { role: 'maker', started: '2026-09-20T00:02:00.000Z' });
  writeDossier(cfg, 'reviewer-r3.json', { role: 'reviewer', started: '2026-09-20T00:03:00.000Z', done: null });
  writeDossier(cfg, 'router-r4.json', { role: 'router' }); // 记录建到一半就崩了：没 started = 还没派出去
  // 非 spawn 产物：precommit 是内核自己在进程里跑的，没有 agent 进程可收割，绝不能被当成残留。
  writeDossier(cfg, 'precommit-r1.json', { role: 'precommit', started: '2026-09-20T00:04:00.000Z' });
  writeDossier(cfg, 'maker-r2.log.json', { role: 'maker', outcome: 'ok', summary: 's' });
  writeDossier(cfg, 'maker-r2.stream.jsonl', '{"type":"system"}\n');
  writeDossier(cfg, 'timeline.md', '- 起手\n');

  const out = unfinishedSpawns(cfg, TASK_ID);
  assert.deepEqual(out.map((o) => `${o.base}-r${o.round}`), ['maker-r2', 'reviewer-r3']);
  assert.equal(out[0].path, path.join(cfg.dossierDir, TASK_ID, 'maker-r2.json'));
  assert.equal(out[0].record.role, 'maker');
  assert.equal(typeof out[0].round, 'number', 'round 是数字：后面 Math.max 要靠它排序');
});

test('unfinishedSpawns：角色 / 包号 / worker 键名的命名变体全认得，越界命名一个不收', (t) => {
  const cfg = makeCfg(t);
  const started = { started: '2026-09-20T00:00:00.000Z' };
  for (const n of [
    'router-r1.json', 'spec-plan-r2.json', 'spec-r3.json', 'maker-P-001-r4.json',
    'reviewer-P-012-r5.json', 'digest-r6.json', 'worker-api-r7.json', 'worker-api-auth-r8.json',
  ]) writeDossier(cfg, n, started);
  for (const n of [
    'worker-1api-r9.json', // worker 键必须字母打头
    'worker-API-r10.json', // 大写不是合法键
    'maker-P-1-r11.json', // 包号是三位
    'committer-r12.json', // 不存在的角色
    'maker-rX.json',
  ]) writeDossier(cfg, n, started);

  const bases = unfinishedSpawns(cfg, TASK_ID).map((o) => o.base);
  assert.deepEqual(bases, [
    'router', 'spec-plan', 'spec', 'maker-P-001', 'reviewer-P-012', 'digest', 'worker-api', 'worker-api-auth',
  ], '按轮次升序，且只收闭集内的命名');
  assert.equal(unfinishedSpawns(cfg, TASK_ID).length, 8);
});

test('unfinishedSpawns：坏 JSON 与不存在的案卷目录都只是「没有残留」，不是异常', (t) => {
  const cfg = makeCfg(t);
  writeDossier(cfg, 'maker-r1.json', '{ 半个对象');
  writeDossier(cfg, 'maker-r2.json', { started: '2026-09-20T00:00:00.000Z' });
  const out = unfinishedSpawns(cfg, TASK_ID);
  assert.deepEqual(out.map((o) => o.round), [2], '一条记录坏了不能把整轮恢复带崩');
  assert.deepEqual(unfinishedSpawns(cfg, 'task-20260920-999'), [], '案卷目录不存在 = 没有残留');
});

// ---- reapUnfinishedSpawn：收割残留 agent ----

test('reapUnfinishedSpawn：身份对得上的活进程被真杀掉，记录补成 interrupted + 成本未知', async (t) => {
  const cfg = makeCfg(t);
  const { pid, started } = await spawnLiveChild(t);
  writeDossier(cfg, 'maker-r3.json', {
    role: 'maker', round: 3, started: '2026-09-20T00:00:00.000Z',
    pid, pid_started: started, cwd: path.join(cfg.worktreesDir, TASK_ID),
  });

  const seen = [];
  const [item] = unfinishedSpawns(cfg, TASK_ID);
  const r = await reapUnfinishedSpawn(cfg, TASK_ID, item, {
    accountUnknown: (base, round, rec) => seen.push({ base, round, path: rec.path, interrupted: rec.record.interrupted }),
    graceMs: 3000,
  });

  assert.deepEqual({ base: r.base, round: r.round, process: r.process, killed_ok: r.killed_ok },
    { base: 'maker', round: 3, process: 'killed', killed_ok: true });
  assert.equal(isPidAlive(pid), false, '残留执行者必须真的没了：不然它和新执行者会同时改同一个 worktree');

  const rec = readDossier(cfg, 'maker-r3.json');
  assert.ok(rec.done, '补记 done：否则下一次恢复又把它当成残留再收割一遍');
  assert.equal(rec.ok, false);
  assert.equal(rec.interrupted, true);
  assert.equal(rec.killed, 'runner_crashed');
  assert.equal(rec.error, 'runner_crashed');
  assert.equal(rec.cost_usd, 0);
  assert.equal(rec.cost_unknown, true, '不知道花了多少就记 unknown，绝不猜一个数进账');
  assert.equal(rec.session_id, null, '流里没有 session_id 就是 null，不能编');
  assert.equal(rec.recovered.process, 'killed');
  assert.equal(rec.recovered.killed_ok, true);
  assert.ok(rec.recovered.at);

  // 没有合格 log → 必须留一份 salvage：内核只陈述观察到的，并明确列出不知道的。
  const salvage = readDossier(cfg, 'maker-r3.salvage.json');
  assert.equal(salvage.reason, 'runner_crashed');
  assert.equal(salvage.role, 'maker');
  assert.equal(salvage.round, 3);
  assert.equal(salvage.written_by, 'kernel');
  assert.equal(salvage.observed, null, '连 stream 都没有：观察面是空的，如实写 null');
  assert.equal(salvage.known.process_at_recovery, 'killed');
  assert.equal(salvage.known.cwd, path.join(cfg.worktreesDir, TASK_ID));
  assert.ok(salvage.unknown.some((u) => u.includes('outcome 未知')), '没有 log 就不许有 outcome');
  assert.ok(salvage.unknown.some((u) => u.includes('原始流缺失')));

  assert.deepEqual(seen, [{ base: 'maker', round: 3, path: item.path, interrupted: true }],
    'unknown 成本策略由调用方注入，且必须拿到已经补记好的那条记录');
  const timeline = fs.readFileSync(path.join(cfg.dossierDir, TASK_ID, 'timeline.md'), 'utf8');
  assert.match(timeline, /maker r3/);
  assert.match(timeline, /残留进程=killed/);
});

test('reapUnfinishedSpawn：pid 被复用（启动时刻对不上）→ 绝不杀掉别人的进程', async (t) => {
  const cfg = makeCfg(t);
  const { pid, started } = await spawnLiveChild(t);
  // 记录里的启动时刻是「上一个 runner 那会儿」的：pid 还活着，但早已不是同一个进程。
  writeDossier(cfg, 'worker-api-r2.json', {
    role: 'worker', key: 'api', round: 2, started: '2026-09-20T00:00:00.000Z',
    pid, pid_started: 'Mon Jan  1 00:00:00 2001',
  });

  const [item] = unfinishedSpawns(cfg, TASK_ID);
  const r = await reapUnfinishedSpawn(cfg, TASK_ID, item, { graceMs: 3000 });

  assert.equal(r.process, 'reused');
  assert.equal(r.killed_ok, null, '压根没发过信号，就没有「杀没杀成」这回事');
  assert.equal(isPidAlive(pid), true, '核心不变量：pid 被复用时那是陌生人的进程，内核一根手指都不许动');
  assert.equal(processState({ pid, pid_started: started }), 'alive', '而且还是同一个进程，没被 SIGTERM 打断');

  // 不杀不等于不收尾：记录照样补成 interrupted + 成本未知，否则它会一直被当成残留反复处理。
  const rec = readDossier(cfg, 'worker-api-r2.json');
  assert.equal(rec.interrupted, true);
  assert.equal(rec.cost_unknown, true);
  assert.equal(rec.recovered.process, 'reused');
  assert.equal(rec.recovered.killed_ok, null);
  const salvage = readDossier(cfg, 'worker-api-r2.salvage.json');
  assert.equal(salvage.known.process_at_recovery, 'reused');
  assert.equal(salvage.key, 'api', 'worker 的 key 要带进 salvage，人才知道是哪条委派');

  process.kill(pid, 'SIGKILL'); // 这个「陌生人」是本用例自己起的，用例自己收尾
});

test('reapUnfinishedSpawn：进程早已退出 / 记录里根本没有 pid → 不发信号，照样补记收尾', async (t) => {
  const cfg = makeCfg(t);
  const { pid, started } = await spawnDeadChild();
  writeDossier(cfg, 'maker-r1.json', { role: 'maker', round: 1, started: '2026-09-20T00:00:00.000Z', pid, pid_started: started });
  // onSpawn 还没来得及回填 pid 就崩了：没 pid 直接按 dead 处理，绝不去猜一个 pid 来杀。
  writeDossier(cfg, 'reviewer-r2.json', { role: 'reviewer', round: 2, started: '2026-09-20T00:00:10.000Z' });

  const items = unfinishedSpawns(cfg, TASK_ID);
  const results = [];
  for (const item of items) results.push(await reapUnfinishedSpawn(cfg, TASK_ID, item, { graceMs: 3000 }));

  assert.deepEqual(results.map((r) => [r.base, r.process, r.killed_ok]), [['maker', 'dead', null], ['reviewer', 'dead', null]]);
  for (const name of ['maker-r1.json', 'reviewer-r2.json']) {
    const rec = readDossier(cfg, name);
    assert.equal(rec.interrupted, true);
    assert.equal(rec.cost_unknown, true);
    assert.equal(rec.recovered.process, 'dead');
  }
  assert.equal(unfinishedSpawns(cfg, TASK_ID).length, 0, '收割过的记录不得再被认成残留（恢复必须幂等）');
});

test('reapUnfinishedSpawn：旧格式记录没有启动时刻 → 认不出身份就不动手（process=unknown）', async (t) => {
  const cfg = makeCfg(t);
  const { pid, started } = await spawnLiveChild(t);
  // 旧格式（onSpawn 回填 pid_started 之前留下的）记录：pid 活着，但无从确认它是不是当初那个。
  // 按 proc.mjs 的口径，认不出身份就不发信号——宁可漏收一个残留，也绝不误杀一个陌生人。
  writeDossier(cfg, 'reviewer-r7.json', { role: 'reviewer', round: 7, started: '2026-09-20T00:00:00.000Z', pid });

  const [item] = unfinishedSpawns(cfg, TASK_ID);
  const r = await reapUnfinishedSpawn(cfg, TASK_ID, item, { graceMs: 3000 });

  assert.equal(r.process, 'unknown');
  assert.equal(r.killed_ok, null);
  assert.equal(isPidAlive(pid), true);
  assert.equal(processState({ pid, pid_started: started }), 'alive', '没被 SIGTERM 碰过');
  const rec = readDossier(cfg, 'reviewer-r7.json');
  assert.equal(rec.recovered.process, 'unknown');
  assert.equal(rec.interrupted, true);
  // 「没杀成」这件事必须落在盘上：人得知道可能还有一个执行者在同一个 worktree 里活着。
  assert.equal(readDossier(cfg, 'reviewer-r7.salvage.json').known.process_at_recovery, 'unknown');

  process.kill(pid, 'SIGKILL');
});

test('reapUnfinishedSpawn：已有合格 log 就不写 salvage；stream_file 按 cfg.root 解析并带出 session_id', async (t) => {
  const cfg = makeCfg(t);
  const streamRel = path.join('dossier', TASK_ID, 'maker-r4.stream.jsonl');
  writeDossier(cfg, 'maker-r4.stream.jsonl', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc',
      message: { usage: { input_tokens: 10, output_tokens: 3 }, content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/wt/lib/stats.mjs' } }] },
    }),
    '',
  ].join('\n'));
  writeDossier(cfg, 'maker-r4.log.json', { role: 'maker', outcome: 'ok', summary: 'AC-001 done' });
  writeDossier(cfg, 'maker-r4.json', {
    role: 'maker', round: 4, started: '2026-09-20T00:00:00.000Z', stream_file: streamRel,
  });

  const [item] = unfinishedSpawns(cfg, TASK_ID);
  const r = await reapUnfinishedSpawn(cfg, TASK_ID, item, { graceMs: 3000 });
  assert.equal(r.process, 'dead');

  const rec = readDossier(cfg, 'maker-r4.json');
  assert.equal(rec.session_id, 'sess-abc', 'stream_file 是相对 cfg.root 的：解析错了就读不到会话 id');
  assert.equal(
    hasDossier(cfg, 'maker-r4.salvage.json'), false,
    'log 已经落盘 = agent 的交代还在，不必再造一份 salvage 去猜它说了什么',
  );
  // log 在不代表这一轮算数：runner 崩在收尾之前，成本仍然未知、这一轮仍然是被打断的。
  assert.equal(rec.interrupted, true);
  assert.equal(rec.cost_unknown, true);
  assert.equal(rec.ok, false);
});

// ---- mergedButNotArchived：merge 崩在「已合并、未归档」之间 ----

/** 真的 git 仓库：合没合进去是 git 的事实，不能靠夹具假装。 */
function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return initTargetRepo(dir);
}

function commitOnTaskBranch(repo, branch) {
  gitOk(['checkout', '-b', branch], repo);
  fs.writeFileSync(path.join(repo, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  gitOk(['add', '-A'], repo);
  gitOk(['commit', '-m', 'task work'], repo);
  const head = headOf(repo, `refs/heads/${branch}`);
  gitOk(['checkout', 'main'], repo);
  return head;
}

test('writeMergeIntent / mergedButNotArchived：已合并未归档 → 认出事实，交调用方补完归档', (t) => {
  const cfg = makeCfg(t);
  const repo = makeRepo(t);
  const baseSha = headOf(repo, 'refs/heads/main');
  const headSha = commitOnTaskBranch(repo, 'task/recovery');

  writeMergeIntent(cfg, TASK_ID, { head_sha: headSha, base_sha: baseSha, branch: 'task/recovery', message: 'merge task' });
  const intentOnDisk = readDossier(cfg, 'merge-intent.json');
  assert.equal(intentOnDisk.schema_version, 1);
  assert.ok(intentOnDisk.started_at, '意图要带时刻：人得看得出崩在批准的哪一步');
  assert.equal(mergeIntentPath(cfg, TASK_ID), path.join(cfg.dossierDir, TASK_ID, 'merge-intent.json'));

  // 崩在「写了意图、还没合」：base 没动，必须判为「没合过」，照常重走批准。
  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'main'), null);

  gitOk(['merge', '--no-ff', 'task/recovery', '-m', 'merge task/recovery'], repo);

  // 崩在「已合并、还没归档」：必须认出来，否则要么重合一次，要么把任务误判回去重跑。
  const intent = mergedButNotArchived(cfg, TASK_ID, repo, 'main');
  assert.ok(intent, '任务 HEAD 已是 base 的祖先 = 这次合并确实发生过');
  assert.equal(intent.head_sha, headSha);
  assert.equal(intent.base_sha, baseSha);
  assert.equal(intent.branch, 'task/recovery');

  clearMergeIntent(cfg, TASK_ID);
  assert.equal(hasDossier(cfg, 'merge-intent.json'), false);
  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'main'), null, '归档完就没有「未归档的合并」了');
  clearMergeIntent(cfg, TASK_ID); // 幂等：清第二次不抛
});

test('mergedButNotArchived：没意图 / 缺 head_sha / base 没动过 / base 分支不存在 → 一律 null', (t) => {
  const cfg = makeCfg(t);
  const repo = makeRepo(t);
  const baseSha = headOf(repo, 'refs/heads/main');

  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'main'), null, '没写过意图 = 没有崩在批准中途');

  writeMergeIntent(cfg, TASK_ID, { base_sha: baseSha, branch: 'task/x' });
  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'main'), null, '缺 head_sha 的意图无法判断合没合，不许猜');

  // head_sha 本来就是 base（任务分支没有任何新提交）：isAncestor 恒真，但 base 一步没动过，
  // 说明什么都没合进去。少了 base_sha 这道比较，这里就会被误判成「已合并」而直接归档。
  writeMergeIntent(cfg, TASK_ID, { head_sha: baseSha, base_sha: baseSha, branch: 'task/x' });
  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'main'), null);

  // 真的合进去之后，base 分支名给错 → 取不到 base 的 HEAD，只能判 null，绝不拿别的分支顶替。
  const headSha = commitOnTaskBranch(repo, 'task/x');
  writeMergeIntent(cfg, TASK_ID, { head_sha: headSha, base_sha: baseSha, branch: 'task/x' });
  gitOk(['merge', '--no-ff', 'task/x', '-m', 'merge task/x'], repo);
  assert.ok(mergedButNotArchived(cfg, TASK_ID, repo, 'main'));
  assert.equal(mergedButNotArchived(cfg, TASK_ID, repo, 'no-such-base'), null);
});
