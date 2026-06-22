// 集成：drain 步数上限耗尽必须显式记日志（契约 §12：耗尽记日志，下次 run 续推）。
// 用 maxDrainSteps=1 制造耗尽：bugfix 需要 2 个变化步（READY→VERIFY，VERIFY→AWAIT_HUMAN_MERGE）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('步数上限耗尽：显式日志 + 状态落盘 + 下次 run 续推', (t) => {
  const env = makeEnv(t, { config: { maxDrainSteps: 1 } });
  const id = 'task-20260611-501';
  env.writeTask(id); // READY；走完需要 2 个变化步
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 's1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  // 第一次 run：只够走 READY→VERIFY，必耗尽且必须留日志
  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  assert.match(run1.stderr, /步数上限 1 耗尽/, '耗尽必须显式记日志，不许静默退出');
  assert.match(run1.stderr, /续推/, '日志要说明下次 run 续推');
  assert.equal(env.findTask(id).runtime.stage, 'VERIFY', '已推进的转移不丢（先产物后状态）');

  // 第二次 run：从落盘状态续推到人类闸门
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', '下次 run 续推成功');
});

test('未耗尽时不打耗尽日志', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-502';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 's1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run = env.run('run'); // 默认 maxDrainSteps=20，2 步走完后自然 drain 干净
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /步数上限/, '正常 drain 完成不应有耗尽日志');
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
});
