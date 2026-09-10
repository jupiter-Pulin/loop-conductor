// 集成：新旧共存的最后一层——P3 删掉旧状态机之后，遗留任务只保留**可读性**。
//   AC-027：配置文件里显式给的遗留键各警告一次并被忽略（不进 cfg）；
//   AC-001：queue 里出现遗留 stage 名 → scheduler 打印「未知 stage，跳过」，不抛错、不推进；
//   遗留任务对任何动词都给出清晰错误（legacy task, not operable by this conductor），状态零变化；
//   status / spy 同时容纳新旧任务，不因缺字段而崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv } from '../helpers/env.mjs';
import { newRouterEnv, routerStep } from '../helpers/router-env.mjs';

/** 直接落盘一个旧状态机形态的任务（旧 stage 名 + 旧计数字段）。 */
function writeLegacyTask(env, id, { stage = 'READY', box = 'queue', lastFailureType = null } = {}) {
  const dir = path.join(env.root, 'state', box, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify({
    schema_version: 1, id, kind: 'bugfix', title: '旧任务', repo: 'target',
    targetRepo: env.targetDir, baseBranch: 'main', testCommand: 'node --test',
    created_at: '2026-06-11T00:00:00.000Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'runtime.json'), `${JSON.stringify({
    schema_version: 1, stage, maker_miss_count: 3, verifier_invalid_count: 0,
    spent_usd: 1.5, approval: null, current_round: 2, last_failure_type: lastFailureType,
    updated_at: '2026-06-11T00:00:00.000Z',
  }, null, 2)}\n`);
  return dir;
}

test('AC-027：配置文件里显式给的遗留键各打印一次警告并被忽略；默认值不警告', (t) => {
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

test('AC-027：遗留键被忽略而不是被读进 cfg；models 的遗留角色键不进模型探测清单', async (t) => {
  const env = makeEnv(t, {
    config: { testGateEnabled: true, specMaxAcs: 99, models: { verifier: 'ghost-model', maker: 'claude-opus-5' } },
  });
  const { loadCfg } = await import('../../conductor/conductor.mjs');
  const cfg = loadCfg(env.root);
  assert.equal('testGateEnabled' in cfg, false);
  assert.equal('specMaxAcs' in cfg, false);
  assert.deepEqual(Object.keys(cfg.models).sort(), ['maker', 'reviewer', 'router', 'spec']);
  assert.equal(Object.values(cfg.models).includes('ghost-model'), false);
});

test('AC-027：legacy 标量 maxTurns 警告一次并只落到 maker，其余角色仍用默认值', async (t) => {
  const env = makeEnv(t, { config: { maxTurns: 12 } });
  const r = env.run('status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /legacy config key ignored: maxTurns（标量 12 视为 maker 上限/);

  const { loadCfg } = await import('../../conductor/conductor.mjs');
  const cfg = loadCfg(env.root);
  assert.equal(cfg.maxTurns.maker, 12);
  assert.equal(cfg.maxTurns.router, 4, 'router 不被标量压低');
  assert.equal(cfg.maxTurns.reviewer, 40);
});

test('AC-001：queue 里的遗留 stage 名被跳过并打印警告，不抛错；同一次 run 里新任务照跑', (t) => {
  const { env, id } = newRouterEnv(t);
  const legacyTask = 'task-20260910-900';
  writeLegacyTask(env, legacyTask, { stage: 'READY' });

  env.setScenario([routerStep('human', { summary: '新任务只跑一轮就停在 help 闸' })]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, new RegExp(`\\[${legacyTask}\\] 未知 stage "READY"，跳过`));

  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help', '新任务照常推进');
  const legacy = env.findTask(legacyTask);
  assert.equal(legacy.box, 'queue', '遗留任务不被搬箱');
  assert.equal(legacy.runtime.stage, 'READY', '遗留任务状态零变化');
  assert.equal(env.calls().length, 1, '遗留任务不消耗任何 spawn');
});

test('遗留任务对每个动词都给出清晰错误，状态零变化', (t) => {
  const env = makeEnv(t);
  const queued = 'task-20260910-901';
  const failed = 'task-20260910-902';
  writeLegacyTask(env, queued, { stage: 'AWAIT_SPEC_APPROVAL' });
  fs.mkdirSync(path.join(env.root, 'state', 'failed'), { recursive: true });
  writeLegacyTask(env, failed, { stage: 'FAILED_BOX', box: 'failed', lastFailureType: 'maker_misses_exhausted' });

  for (const [id, argv] of [
    [queued, ['approve', queued]],
    [queued, ['reject', queued, '--notes', 'x']],
    [queued, ['resume', queued]],
    [queued, ['abandon', queued]],
    [failed, ['retry', failed]],
  ]) {
    const before = JSON.stringify(env.findTask(id).runtime);
    const r = env.run(...argv);
    assert.notEqual(r.status, 0, `${argv[0]} 应以非零退出`);
    assert.match(r.stderr, /legacy task, not operable by this conductor/, `${argv[0]} 的错误要点名遗留任务`);
    assert.equal(JSON.stringify(env.findTask(id).runtime), before, `${argv[0]} 不得改动遗留任务状态`);
  }

  // 已删除的旧动词直接落到 usage（未知子命令），同样不碰任务。
  for (const verb of ['approve-setup', 'approve-feasibility', 'reject-feasibility', 'approve-scope', 'reject-scope', 'merge', 'close']) {
    const r = env.run(verb, queued);
    assert.notEqual(r.status, 0, `${verb} 应已删除`);
    assert.match(r.stderr, /用法：conductor <command>/);
  }
  assert.equal(env.findTask(queued).runtime.stage, 'AWAIT_SPEC_APPROVAL');
});

test('status / spy 同时容纳新旧任务，不因缺 awaiting / 多余计数字段而崩', (t) => {
  const { env, id } = newRouterEnv(t);
  const legacyTask = 'task-20260910-903';
  writeLegacyTask(env, legacyTask, { stage: 'READY' });

  const status = env.run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`${id}\\s+ROUTING`));
  assert.match(status.stdout, new RegExp(`${legacyTask}\\s+READY`), '遗留任务照样列出来');

  // spy 认得新角色的 spawn 记录（router / spec / maker / reviewer）。
  env.setScenario([{ hang: true }]);
  const spy = env.run('spy');
  assert.equal(spy.status, 0, spy.stderr);
  assert.match(spy.stdout, new RegExp(id));
  assert.match(spy.stdout, new RegExp(legacyTask));
});
