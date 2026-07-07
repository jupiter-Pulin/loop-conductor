// 集成：resume 首次遇到「不透明退出失败」（CLI 非零退出 + 无 result 事件，isTransientFailure
// 现按疑似瞬态判定，见 lib/claude.mjs）后，在同一轮 runClaudeWithRetry 内重试即恢复——
// 不应降级冷启动，也不应额外多计一次 maker miss（AC-004/AC-007）。
// 对照修复前行为：旧分类下这类失败被判非瞬态，resume 立刻降级冷启动、整轮作废（见
// dossier/task-20260706-003 真实案卷）；resume-degrade 的对照测试见 retry-ladder.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const VFAIL = (round) => verifierStep(round, { 'AC-001': 'pass', 'AC-002': 'fail' });

test('AC-004/AC-007: resume 首次不透明失败、重试后成功 → 本轮以 resume 完成，不降级冷启动，不多计 miss', (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 1, spawnBackoffMs: [0] } });
  const id = 'task-20260707-701';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.10, result: 'r1 修复' }, // 0 maker r1
    VFAIL(1),                                                                   // 1 verifier r1 → miss 1
    { exitCode: 1, stderr: 'transient blip' },                                 // 2 resume 尝试1：不透明退出失败
    { session_id: 'sess-m1', cost: 0.05, result: 'r2 续会话修复（重试后恢复）' }, // 3 resume 尝试2（重试）：成功
    verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' }),                    // 4 verifier r2 pass
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, 'resume 重试恢复不应额外多计一次 miss（AC-007）');

  const calls = env.calls();
  assert.equal(calls.length, 5, '本轮 resume 重试在同一次 spawn 内完成，不应触发额外的冷启动 spawn');
  assert.equal(resumeIdOf(calls[2]), 'sess-m1', '首次尝试是 resume');
  assert.equal(resumeIdOf(calls[3]), 'sess-m1', '重试仍是 resume，未降级冷启动（AC-004）');

  const marker = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.equal(marker.mode, 'resume', 'mode 应保持 resume，不发生 cold-degraded');
  assert.equal(marker.resume_failed, undefined, '不应标记 resume_failed');
  assert.equal(marker.attempts.length, 2, '本轮 resume attempts 应记录 1 次失败 + 1 次成功');
  assert.equal(marker.attempts[0].transient, true);
  assert.equal(marker.attempts[1].transient, false);
});
