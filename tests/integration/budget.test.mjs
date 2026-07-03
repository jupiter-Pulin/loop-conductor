// 集成：预算闸——spent_usd 超 budgetUsd 拒绝 spawn，直接 FAILED_BOX，零 claude 调用。
// 新布局：任务目录 + runtime.json 字段；last_failure_type='budget_exceeded'（AC-018）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('READY 超预算 → FAILED_BOX，不 spawn', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-301';
  env.writeTask(id, { spent: 9.99 }); // budgetUsd=5
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'budget_exceeded');
  assert.equal(env.calls().length, 0, '预算闸必须拦在 spawn 之前');
  assert.match(run.stderr, /budget exceeded/);
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /FAILED_BOX/);
});

test('FIXING 超预算同样拒绝 spawn', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-302';
  env.writeTask(id, { stage: 'FIXING', miss: 1, sessionId: 'sess-x', spent: 5 }); // 恰好达上限
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'budget_exceeded');
  assert.equal(env.calls().length, 0);
});

test('跨 spawn 累计：maker 花费推满预算后 verifier 被拒', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-303';
  env.writeTask(id, { spent: 4.5 }); // 还差 0.5 到上限
  env.setScenario([
    { // maker 成功修复（green gate 会绿），但成本把任务推过预算
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1', cost: 0.6, result: 'fixed',
    },
    // 不提供 verifier 步骤：若被 spawn，fake-claude 会报错使测试失败
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed', 'VERIFY 阶段预算闸生效');
  assert.equal(after.runtime.last_failure_type, 'budget_exceeded');
  assert.ok(after.runtime.spent_usd >= 5, `spent_usd=${after.runtime.spent_usd} 应已累计 maker 成本`);
  assert.equal(env.calls().length, 1, '只有 maker 一次 spawn');
});

test('runBudgetUsd 达到上限后停止新 spawn，但不按 per-task budget 收箱', (t) => {
  const env = makeEnv(t, { config: { runBudgetUsd: 0.1 } });
  const id = 'task-20260611-304';
  env.writeTask(id);
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1',
      cost: 0.1,
      result: 'fixed',
    },
    // 不提供 verifier：runBudget 达上限后不得发起第二个 spawn
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /runBudgetUsd=\$0.1 已达到/);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'VERIFY', 'run budget 只暂停新 spawn，任务保留当前 stage');
  assert.equal(after.runtime.last_failure_type, null);
  assert.equal(env.calls().length, 1);
});
