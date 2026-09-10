// 集成：killed / 无 result 的 spawn 的成本估计入账（R5-H20）。契约：
//   1) 默认关 = 旧行为：costUnknown 记 0，timeline 只留 lower-bound 行，无 estimated 字段；
//   2) 开启：按该角色 dossier 历史均价估计入账（spent_usd 增加、estimated_cost_usd 独立累计、
//      timeline 标 estimated），预算闸不再被 killed spawn 放水；路由不受影响。
// 场景：r1 maker 正常（留下历史样本 $0.10）→ r2 maker 的 CLI 死在半路（无 result 事件）
//       → res.costUnknown=true → r3 router 开 help 闸收尾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

function killedMakerScenario(env) {
  env.setScenario([
    routerStep('maker', { cost: 0.01 }),
    makerStep({ cost: 0.1 }),                       // 历史样本：maker $0.10
    routerStep('maker', { cost: 0.01, summary: '上轮已修，再跑一轮' }),
    { exitCode: 3, stderr: 'boom: CLI 半路死了' },   // maker r2：无 result 事件 → costUnknown
    routerStep('human', { cost: 0.01, summary: '停在 help 闸' }),
  ]);
}

test('契约1：默认关——costUnknown 记 0，lower-bound 文案，无 estimated 字段', (t) => {
  const { env, id } = newRouterEnv(t, { config: { spawnRetries: 0 } });
  killedMakerScenario(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.awaiting.kind, 'help', '成本入账不影响路由');
  assert.equal(after.runtime.spent_usd, 0.13, '0.01 + 0.10 + 0.01 + 0（killed 轮）+ 0.01');
  assert.equal(after.runtime.estimated_cost_usd, undefined, '默认关不产生估计字段');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.match(timeline, /maker r2 cost unknown; spent_usd uses lower-bound accounting/);
  assert.ok(!timeline.includes('estimated'), '默认关不得出现 estimated 标记');
});

test('契约2：开启——按角色历史均价估计入账 + estimated 独立累计 + 路由不变', (t) => {
  const { env, id } = newRouterEnv(t, {
    config: { spawnRetries: 0, unknownSpawnCostEstimateEnabled: true },
  });
  killedMakerScenario(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.awaiting.kind, 'help', '估计入账不改变路由');
  assert.equal(after.runtime.spent_usd, 0.23, '0.13 + 估计 0.10（maker 历史均价 n=1）');
  assert.equal(after.runtime.estimated_cost_usd, 0.1, '估计部分独立累计，透明可审');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.match(timeline, /maker r2 cost unknown → 按历史均价 \$0\.1 估计入账（n=1，estimated）/);

  // killed 轮的 spawn 记录保持真实（cost_usd=0 + cost_unknown），估计只进 runtime 账
  const rec = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.equal(rec.cost_usd, 0);
  assert.equal(rec.cost_unknown, true);
});
