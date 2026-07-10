// 集成：killed/无 result spawn 的成本估计入账（R5-H20）。契约：
//   1) 默认关 = 旧行为：costUnknown 记 0，timeline 只留 lower-bound 行，无 estimated 字段；
//   2) 开启：按该角色 dossier 历史均价估计入账（spent_usd 增加、estimated_cost_usd 独立累计、
//      timeline 标 estimated），预算闸不再被 killed spawn 放水；路由不受影响（基建失败仍留 VERIFY）。
// 场景：verifier r1 正常（留下历史样本 $0.02）→ verdict fail 进 FIXING → maker r2 修复 →
//       VERIFY r2 时剧本步耗尽（fake-claude「no step」exit 2，无 result 事件）→ 瞬态重试耗尽
//       → res.costUnknown=true。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

function killedVerifierScenario(env) {
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'fail' }, { cost: 0.02 }), // 历史样本：verifier $0.02
    { session_id: 'sess-m1', cost: 0.05, result: 'r2 修复' },                 // FIXING 轮 maker
    // 第 4 步（verifier r2）故意不给：fake-claude「no step」exit 2、无 result → costUnknown
  ]);
}

test('契约1：默认关——costUnknown 记 0，lower-bound 文案，无 estimated 字段', (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 1, spawnBackoffMs: [10] } });
  const id = 'task-20260708-995';
  env.writeTask(id);
  killedVerifierScenario(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'VERIFY', '基建失败留 VERIFY（路由旧行为）');
  assert.equal(after.runtime.spent_usd, 0.17, '0.1 + 0.02 + 0.05，killed 轮记 0');
  assert.equal(after.runtime.estimated_cost_usd, undefined, '默认关不产生估计字段');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /verifier r2 cost unknown; spent_usd uses lower-bound accounting/);
  assert.ok(!timeline.includes('estimated'), '默认关不得出现 estimated 标记');
});

test('契约2：开启——按角色历史均价估计入账 + estimated 独立累计 + 路由不变', (t) => {
  const env = makeEnv(t, { config: { unknownSpawnCostEstimateEnabled: true, spawnRetries: 1, spawnBackoffMs: [10] } });
  const id = 'task-20260708-996';
  env.writeTask(id);
  killedVerifierScenario(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'VERIFY', '估计入账不改变基建失败路由');
  assert.equal(after.runtime.spent_usd, 0.19, '0.1 + 0.02 + 0.05 + 估计 0.02（verifier 历史均价 n=1）');
  assert.equal(after.runtime.estimated_cost_usd, 0.02, '估计部分独立累计，透明可审');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /verifier r2 cost unknown → 按历史均价 \$0\.02 估计入账（n=1，estimated）/);

  // killed 轮的 spawn 记录保持真实（cost_usd=0 + cost_unknown），估计只进 runtime 账
  const rec = env.readJson(env.dossier(id, 'verifier-r2.json'));
  assert.equal(rec.cost_usd, 0);
  assert.equal(rec.cost_unknown, true);
});
