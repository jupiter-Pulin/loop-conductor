// 集成：precommit 在真 git 仓上建合并候选并跑三步（AC-011 / 017 / 018 / 048 / 051）。
// 三条路径：正常 ok、build 失败、候选与 base 冲突。共同的红线是——无论走哪条，
// 候选 worktree 结束时必须不存在，记录必须过 log-contract 的同构校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPrecommit } from '../../conductor/lib/precommit.mjs';
import { validateLog } from '../../conductor/lib/log-contract.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { makePrecommitEnv, UNIT_CHECKS_FIX, CMD_OK, CMD_FAIL } from '../helpers/precommit-env.mjs';

test('正常路径：候选 = base + 任务分支，build 与 unit 全绿 → outcome ok', async (t) => {
  const env = makePrecommitEnv(t);
  const headSha = env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  env.writeSetupProfile({ build: CMD_OK, unit: UNIT_CHECKS_FIX });

  const record = await runPrecommit({ cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit' });

  assert.equal(record.outcome, 'ok');
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.deepEqual(env.statusMap(record), { build: 'ok', service: 'skipped', unit: 'ok' });
  assert.equal(record.head_sha, headSha);
  assert.equal(record.base_sha, env.sha('main'));
  assert.ok(record.candidate_sha, '候选必须有自己的 sha');
  assert.notEqual(record.candidate_sha, headSha, '候选是 merge --no-ff 的结果，不是任务分支本身');
  assert.notEqual(record.candidate_sha, record.base_sha);
  assert.deepEqual(record.conflict_files, []);
  assert.deepEqual(record.skipped_tiers, []);
  assert.equal(record.cost_usd, 0);
  assert.match(record.summary, /^build ok .*；service skipped；unit ok /);

  // 落盘的就是返回的那一份
  assert.deepEqual(env.record(1), record);
  // 候选 worktree 结束时必须不存在（AC-017）
  assert.equal(fs.existsSync(env.candidateWorktree), false);
  assert.equal(env.worktrees().some((l) => l.includes(`${env.id}.precommit`)), false);
});

test('unit 缺省回落 task.testCommand，且真的在候选里跑（base 上会红）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  env.writeSetupProfile({}); // precommit 段没有 unit

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task({ testCommand: UNIT_CHECKS_FIX }), round: 1, tier: 'unit',
  });

  assert.equal(record.outcome, 'ok');
  assert.equal(env.stepOf(record, 'unit').command, UNIT_CHECKS_FIX);
  assert.equal(env.stepOf(record, 'build').status, 'skipped');
});

test('任务分支没修好：候选里 unit 红 → outcome fail（证明跑的是候选而不是别处）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'README.md': '# demo-target\n\n只改了文档，没动 bug\n' }, 'docs only');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    profile: { build: null, service: null, unit: UNIT_CHECKS_FIX, integration: null, e2e: null },
  });

  assert.equal(record.outcome, 'fail');
  assert.equal(env.stepOf(record, 'unit').status, 'fail');
  assert.equal(env.stepOf(record, 'unit').exit_code, 1);
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});

test('build 失败：service 与测试步 not_run，tail 带原因（AC-048）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 2, tier: 'integration',
    profile: {
      build: CMD_FAIL,
      // 配了服务：build 红在它前面，它必须是 not_run（而不是被启动一下再停）
      service: { start: 'node -e "setInterval(()=>{},1000)"', ready: { command: CMD_OK } },
      unit: UNIT_CHECKS_FIX,
      integration: CMD_OK,
      e2e: null,
    },
  });

  assert.equal(record.outcome, 'fail');
  assert.deepEqual(env.statusMap(record), {
    build: 'fail', service: 'not_run', unit: 'not_run', integration: 'not_run',
  });
  assert.equal(env.stepOf(record, 'service').pid, null, 'not_run 的服务步没有起过进程');
  const build = env.stepOf(record, 'build');
  assert.equal(build.exit_code, 2);
  assert.equal(build.timed_out, false);
  assert.ok(build.duration_ms >= 0);
  assert.match(build.tail, /boom: 构建挂了/);
  assert.match(record.summary, /^build fail: boom: 构建挂了；service not_run；unit not_run；integration not_run$/);
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.ok(env.record(2), '记录按轮次落盘');
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});

test('没配的步在失败之后仍记 skipped，不是 not_run（「没有这一步」≠「没轮到这一步」）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'integration',
    profile: { build: CMD_FAIL, service: null, unit: UNIT_CHECKS_FIX, integration: null, e2e: null },
  });

  assert.deepEqual(env.statusMap(record), {
    build: 'fail', service: 'skipped', unit: 'not_run', integration: 'skipped',
  });
  assert.deepEqual(record.skipped_tiers, ['integration'], '没配的层照样进 skipped_tiers');
});

test('候选与 base 冲突：记 conflict_files、三步全部 not_run，候选被 abort 且移除（AC-017）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'README.md': '# demo-target\n\n任务分支这样写\n' }, 'task branch edits README');
  env.commitOnBase({ 'README.md': '# demo-target\n\nbase 分支那样写\n' }, 'base edits README');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'e2e',
    profile: { build: CMD_OK, service: null, unit: CMD_OK, integration: CMD_OK, e2e: CMD_OK },
  });

  assert.equal(record.outcome, 'fail');
  assert.deepEqual(record.conflict_files, ['README.md']);
  assert.equal(record.candidate_sha, null);
  assert.deepEqual(env.statusMap(record), {
    build: 'not_run', service: 'not_run', unit: 'not_run', integration: 'not_run', e2e: 'not_run',
  });
  assert.match(record.summary, /^合并候选与 base 冲突：README\.md；build not_run/);
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(fs.existsSync(env.candidateWorktree), false, '冲突路径同样必须清干净');
  assert.equal(env.worktrees().some((l) => l.includes(`${env.id}.precommit`)), false);
  // base 分支与任务分支都没被动过
  assert.equal(record.base_sha, env.sha('main'));
  assert.equal(record.head_sha, env.sha(env.taskBranch));
});

test('base 前进但不冲突：候选带上 base 的新提交（被合并的 == 被测过的）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  const newBase = env.commitOnBase({ 'lib/extra.mjs': 'export const marker = 42;\n' }, 'base adds extra.mjs');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    // 候选里必须同时看得见 base 的新文件与任务分支的修复
    profile: {
      build: null,
      service: null,
      unit: `node -e 'import("./lib/extra.mjs").then(e => import("./lib/stats.mjs").then(m => process.exit(e.marker === 42 && m.median([1,2,3,4]) === 2.5 ? 0 : 1)))'`,
      integration: null,
      e2e: null,
    },
  });

  assert.equal(record.outcome, 'ok');
  assert.equal(record.base_sha, newBase);
});

test('id 可以从 task 快照里来（调用方手上通常只有一份 task）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');

  const record = await runPrecommit({
    cfg: env.cfg, task: env.task({ id: env.id }), round: 1, tier: 'unit',
    profile: { build: null, service: null, unit: UNIT_CHECKS_FIX, integration: null, e2e: null },
  });

  assert.equal(record.outcome, 'ok');
  assert.deepEqual(env.record(1), record, '记录仍落在 dossier/<id>/ 下');
});

test('分支不存在：写一条 fail 记录而不是抛错', async (t) => {
  const env = makePrecommitEnv(t);
  const record = await runPrecommit({ cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit' });
  assert.equal(record.outcome, 'fail');
  assert.match(record.summary, /分支不存在：task\//);
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
});

test('内部意外不抛给内核：写一条 fail 记录，候选与锁照样清干净', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    profile: { build: null, service: null, unit: CMD_OK, integration: null, e2e: null },
    runCommand: async () => { throw new Error('执行器炸了'); },
  });

  assert.equal(record.outcome, 'fail');
  assert.match(record.summary, /precommit 内部错误：执行器炸了/);
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  assert.equal(fs.existsSync(env.candidateWorktree), false);
  assert.equal(fs.existsSync(`${env.cfg.stateDir}/.precommit.lock`), false, '锁必须还回去');
});

test('候选目录有上次崩溃的残留：照样建得起来（run 启动清理之外的自愈）', async (t) => {
  const env = makePrecommitEnv(t);
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  fs.mkdirSync(env.candidateWorktree, { recursive: true });
  fs.writeFileSync(`${env.candidateWorktree}/leftover.txt`, '上一次被 kill 掉的候选\n');

  const record = await runPrecommit({
    cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit',
    profile: { build: null, service: null, unit: UNIT_CHECKS_FIX, integration: null, e2e: null },
  });

  assert.equal(record.outcome, 'ok');
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});
