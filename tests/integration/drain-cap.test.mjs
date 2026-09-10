// 集成：单任务 step 上限耗尽必须显式记日志（契约 §12：耗尽记日志，下次 run 续推）。
// router 纪元里一个 step 就是一个 router 轮次；maxStepsPerTask=1 时第一轮跑完即耗尽。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makerThenHelp, newRouterEnv } from '../helpers/router-env.mjs';

test('步数上限耗尽：显式日志 + 状态落盘 + 下次 run 续推', (t) => {
  const { env, id } = newRouterEnv(t, { config: { maxStepsPerTask: 1 } });
  env.setScenario(makerThenHelp()); // 走到 help 闸需要 2 个 router 轮次

  // 第一次 run：只够走 r1（maker），必耗尽且必须留日志
  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  assert.match(run1.stderr, /maxStepsPerTask=1 耗尽/, '耗尽必须显式记日志，不许静默退出');
  assert.match(run1.stderr, /续推/, '日志要说明下次 run 续推');
  const mid = env.findTask(id);
  assert.equal(mid.runtime.stage, 'ROUTING', '已推进的转移不丢（先产物后状态）');
  assert.equal(mid.runtime.current_round, 1, 'r1 已落盘');

  // 第二次 run：从落盘状态续推到人闸
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN', '下次 run 续推成功');
});

test('未耗尽时不打耗尽日志', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario(makerThenHelp());
  const run = env.run('run'); // 默认 maxStepsPerTask=20，2 轮走完后自然 drain 干净
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /maxStepsPerTask/, '正常 drain 完成不应有耗尽日志');
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');
});

test('maxDrainSteps 废弃：告警一次并忽略', (t) => {
  const { env, id } = newRouterEnv(t, { config: { maxDrainSteps: 1 } });
  env.setScenario(makerThenHelp());

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /maxDrainSteps 已废弃/);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN', '废弃键被忽略，不限制 step');
});
