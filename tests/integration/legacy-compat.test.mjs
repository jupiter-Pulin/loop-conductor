// 集成：新旧共存（AC-001 的遗留 stage 跳过、AC-027 的遗留配置键警告、旧任务仍走旧路径）。
// P2 的承诺是「新任务走新机器，旧任务照常跑完」；P3 才删旧的那一半。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BUGFIX_SPEC, makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { newRouterEnv, routerStep } from '../helpers/router-env.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const GOOD_PROPOSAL = JSON.stringify({
  subject: 'fix(stats): average the two middle values for even-length median',
  body: 'Legacy compat fixture proposal.\n\nVerified: node --test all green.',
});

test('AC-027：配置文件里显式给的遗留键各打印一次警告；默认值不警告', (t) => {
  const env = makeEnv(t, {
    config: {
      specMaxAcs: 8,
      reviewStage: 'off',
      crashAutoRecoveryLimit: 1,
      feasibilityEnabled: false,
      specChainIsolationEnabled: true,
      testGateEnabled: false,
      verifierEvidenceAnchorsMode: 'observe',
      models: { verifier: 'claude-opus-5' },
    },
  });
  const r = env.run('status');
  assert.equal(r.status, 0, r.stderr);
  for (const key of [
    'specMaxAcs', 'reviewStage', 'crashAutoRecoveryLimit', 'feasibilityEnabled',
    'specChainIsolationEnabled', 'testGateEnabled', 'verifierEvidenceAnchorsMode', 'models.verifier',
  ]) {
    const hits = r.stderr.split('\n').filter((l) => l === `[conductor] legacy config key ignored: ${key}`);
    assert.equal(hits.length, 1, `${key} 应恰好警告一次，实际 ${hits.length} 次`);
  }
  // 没配的遗留键不该被喊：默认值不是「人的配置」。
  assert.doesNotMatch(r.stderr, /legacy config key ignored: autoMergeEnabled/);
});

test('AC-027：legacy 标量 maxTurns 警告一次并落到 maker；旧 stage 仍拿得到那个数字', (t) => {
  const env = makeEnv(t, { config: { maxTurns: 12 } });
  const r = env.run('status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /legacy config key ignored: maxTurns（标量 12 视为 maker 上限/);

  const legacyTask = 'task-20260910-800';
  env.writeTask(legacyTask, { stage: 'READY' });
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.01, result: GOOD_PROPOSAL },
  ]);
  assert.equal(env.run('run').status, 0);
  const makerArgv = env.calls()[0].argv;
  assert.equal(makerArgv[makerArgv.indexOf('--max-turns') + 1], '12', '旧 stage 用 legacy 标量');
  assert.equal(env.findTask(legacyTask).runtime.stage, 'AWAIT_HUMAN_MERGE');
});

test('AC-001：queue 里的遗留 stage 名照常跑，不抛错；新旧任务在同一次 run 里各走各的', (t) => {
  const { env, id } = newRouterEnv(t);
  const legacyTask = 'task-20260910-900';
  env.writeTask(legacyTask, { stage: 'READY', specDraft: DEFAULT_BUGFIX_SPEC });

  // 剧本按 id 排序驱动：新任务（001）先跑，遗留任务（900）随后。
  env.setScenario([
    routerStep('human', { summary: '新任务只跑一轮就停在 help 闸' }),
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.01, result: GOOD_PROPOSAL },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /未知 stage/, '遗留 stage 仍有 handler，不该报未知');

  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
  assert.equal(env.findTask(legacyTask).runtime.stage, 'AWAIT_HUMAN_MERGE');

  // 旧任务的人闸动词照旧（merge），新任务的 approve 不会误伤它。
  assert.equal(env.run('merge', legacyTask).status, 0);
  assert.equal(env.findTask(legacyTask).box, 'done');
});

test('旧任务的 retry 仍走旧路径（回 READY、重置 miss），不被新的 retry 分支截胡', (t) => {
  const env = makeEnv(t);
  const legacyTask = 'task-20260910-901';
  env.writeTask(legacyTask, { stage: 'READY', miss: 3 });

  // 造一个旧形态的收箱任务：stage=FAILED_BOX + 旧的 last_failure_type，目录搬进 failed 箱。
  const dir = path.join(env.root, 'state', 'queue', legacyTask);
  const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  Object.assign(runtime, { stage: 'FAILED_BOX', last_failure_type: 'maker_misses_exhausted' });
  fs.writeFileSync(path.join(dir, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  fs.mkdirSync(path.join(env.root, 'state', 'failed'), { recursive: true });
  fs.renameSync(dir, path.join(env.root, 'state', 'failed', legacyTask));

  const r = env.run('retry', legacyTask);
  assert.equal(r.status, 0, r.stderr);
  const ts = env.findTask(legacyTask);
  assert.equal(ts.box, 'queue');
  assert.equal(ts.runtime.stage, 'READY', '旧任务回 READY，不是 ROUTING');
  assert.equal(ts.runtime.maker_miss_count, 0);
});

test('status / spy 同时容纳新旧任务，不因缺 kind / miss 字段而崩', (t) => {
  const { env, id } = newRouterEnv(t);
  const legacyTask = 'task-20260910-902';
  env.writeTask(legacyTask, { stage: 'READY' });

  const status = env.run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`${id}\\s+.*ROUTING`));
  assert.match(status.stdout, new RegExp(`${legacyTask}\\s+bugfix\\s+READY`));

  // spy 认得新角色的 spawn 记录（router / spec / maker / reviewer）。
  env.setScenario([{ hang: true }]);
  const spy = env.run('spy');
  assert.equal(spy.status, 0, spy.stderr);
  assert.match(spy.stdout, new RegExp(id));
});
