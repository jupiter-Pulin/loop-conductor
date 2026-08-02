// 集成：maker max-turns 截断的同会话续跑（makerMaxTurnsContinuations）。
// dossier 证据（2026-07-07 挖掘）：11 个 maker r1 中 8 个以 error_max_turns 截断，半成品被送进
// green gate 必红，白付一轮 gate+repair；resume 轮截断还会被误判 resume 失败 → cold-degraded
// 全量重启（task-20260705-003 r2/r3）。本测试钉住新行为：
//   1) 截断 → 同会话续跑（-r 同 session），完成后照常进 gate，不计 miss；
//   2) 续跑额度耗尽仍截断 → 回到旧行为（进 green gate 实测，红了计 miss）；
//   3) FIXING resume 轮截断 → 续跑，不降级 cold-degraded；
//   4) makerMaxTurnsContinuations: 0 → 完全旧行为（截断直接进 gate，无续跑 spawn）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

/** 一步 max-turns 截断：先发 subtype=error_max_turns 的 result 事件再 exit 1（真实 CLI 形态）。 */
function cutoffStep(over = {}) {
  return {
    cost: 0.1,
    result: '',
    extra: { subtype: 'error_max_turns', is_error: true, num_turns: 31 },
    exitCodeAfterResult: 1,
    ...over,
  };
}

test('r1 截断 → 同会话续跑完成 → 绿门过 → VERIFY，miss 不增', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-910';
  env.writeTask(id);
  env.setScenario([
    cutoffStep({ session_id: 'sess-m1' }), // maker r1 第一腿：截断，未完成修复
    { // 续跑腿：同会话补完
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1',
      cost: 0.2,
      result: '续跑完成修复',
    },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(ts.runtime.maker_miss_count, 0, '续跑消化截断，不得计 miss');

  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker 腿1 + 续跑腿 + verifier');
  assert.equal(resumeIdOf(calls[1]), 'sess-m1', '续跑必须 -r 同一会话');
  assert.ok(promptOf(calls[1]).includes('因轮次上限被截断'), '续跑 prompt 说明截断上下文');

  // 留档：marker 记续跑次数；续跑腿 stream 单独落盘（不跨腿混流）
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.max_turns_continuations, 1);
  assert.ok(env.exists(env.dossier(id, 'maker-r1.cont-1.stream.jsonl')), '续跑腿 stream 独立留档');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(timeline.includes('max-turns 截断 → 同会话续跑 1/1'), 'timeline 留续跑痕迹');

  // 成本：两腿都入账，不重复计费（0.1 + 0.2 + verifier 0.02）
  const spent = ts.runtime.spent_usd;
  assert.ok(Math.abs(spent - 0.32) < 1e-9, `两腿成本各计一次：expected 0.32, got ${spent}`);
  // spawn 记录 cost_usd = 全部腿总成本（真实事故 task-20260801-003：只记末腿导致
  // dossier-stats 把 maker 续跑轮成本低估近半）；断腿部分同时以 prior_legs_cost_usd 透明留痕
  assert.ok(Math.abs(marker.cost_usd - 0.3) < 1e-9, `记录 cost_usd 应为两腿之和：got ${marker.cost_usd}`);
  assert.ok(Math.abs(marker.prior_legs_cost_usd - 0.1) < 1e-9, '断腿成本单独留痕');
});

test('续跑额度耗尽仍截断 → 旧行为：进 green gate，红了计 miss 转 FIXING 修复', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-911';
  env.writeTask(id);
  env.setScenario([
    cutoffStep({ session_id: 'sess-m1' }),                 // r1 腿1：截断，什么都没写
    cutoffStep({ session_id: 'sess-m1', cost: 0.05 }),      // 续跑腿：再次截断（额度 1 耗尽）
    { // FIXING r2（resume）：正常修复收尾
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1',
      cost: 0.2,
      result: 'r2 修复',
    },
    verifierStep(2),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(ts.runtime.maker_miss_count, 1, '额度耗尽回到旧行为：绿门红计一次 miss');
  assert.equal(env.calls().length, 4, 'r1 两腿 + r2 + verifier，额度耗尽后不得三腿');
  assert.ok(env.exists(env.dossier(id, 'green-gate-r1.json')), '绿门照常实测留档');
  assert.ok(env.exists(env.dossier(id, 'repair-context-r1.json')), 'repair context 照常生成');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.max_turns_continuations, 1, '额度只用了 1 次');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  const contMentions = timeline.split('\n').filter((l) => l.includes('同会话续跑')).length;
  assert.equal(contMentions, 1, '第二次截断不得再触发续跑');
});

test('FIXING resume 轮截断 → 同会话续跑，不降级 cold-degraded', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-912';
  env.writeTask(id);
  env.setScenario([
    { session_id: 'sess-m1', cost: 0.1, result: 'r1 自称完成但没改文件' }, // r1：绿门必红 → FIXING
    cutoffStep({ session_id: 'sess-m1', cost: 0.1 }),                      // r2 resume：截断
    { // r2 续跑腿：补完
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1',
      cost: 0.2,
      result: 'r2 续跑完成修复',
    },
    verifierStep(2),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const ts = env.findTask(id);
  assert.equal(ts.runtime.stage, 'AWAIT_HUMAN_MERGE');

  const marker = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.equal(marker.mode, 'resume', '截断不算 resume 失败，不得降级 cold-degraded');
  assert.ok(!marker.resume_failed, '不得标记 resume_failed');
  assert.equal(marker.max_turns_continuations, 1);

  const calls = env.calls();
  assert.equal(calls.length, 4, 'r1 + r2 腿1 + r2 续跑腿 + verifier');
  assert.equal(resumeIdOf(calls[2]), 'sess-m1', 'r2 续跑仍是同一会话');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(!timeline.includes('降级冷启动'), 'timeline 不得出现 cold-degraded 痕迹');
});

test('makerMaxTurnsContinuations: 0 → 关闭续跑，截断直接进 gate（旧行为开关）', (t) => {
  const env = makeEnv(t, { config: { makerMaxTurnsContinuations: 0 } });
  const id = 'task-20260707-913';
  env.writeTask(id);
  env.setScenario([
    // r1 截断但恰好已写完修复：旧行为下直接进绿门（绿）→ test gate（suite 基线红 = falsifies）→ VERIFY
    cutoffStep({
      session_id: 'sess-m1',
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
    }),
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.calls().length, 2, '关闭续跑：截断后不得追加 spawn');
  assert.ok(!env.exists(env.dossier(id, 'maker-r1.cont-1.stream.jsonl')), '无续跑腿留档');
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(!timeline.includes('同会话续跑'), 'timeline 无续跑痕迹');
});
