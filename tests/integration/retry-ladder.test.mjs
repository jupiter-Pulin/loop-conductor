// 集成：verdict fail×3 走完 1/2/3 重试阶梯进 FAILED_BOX（last_failure_type 由 verdict fail 链）；
// miss==1 用 -r 续原 maker（repair prompt）、miss==2 冷启动带案卷；resume 失败自动降级；retry 复活。
// verifier 每轮返回合法 per-AC verdict（AC-002 fail → overall fail），不消耗 verifier_invalid。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
// verifier 合法 fail：AC-001 pass、AC-002 fail（green gate 已绿，是 AC 验收失败）。
const VFAIL = (round) => verifierStep(round, { 'AC-001': 'pass', 'AC-002': 'fail' });

test('verdict fail×3：1/2/3 阶梯 → FAILED_BOX；retry 复活', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260611-101';
  env.writeTask(id); // bugfix，spec.md 含 AC-001/AC-002
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.10, result: 'r1 修复' }, // 0 maker r1（冷）
    VFAIL(1),                                                                   // 1 verifier r1 → miss 1
    { session_id: 'sess-m1', cost: 0.08, result: 'r2 续会话修复' },            // 2 maker r2（resume）
    VFAIL(2),                                                                   // 3 verifier r2 → miss 2
    { session_id: 'sess-m3', cost: 0.09, result: 'r3 冷启动修复' },            // 4 maker r3（冷+全案卷）
    VFAIL(3),                                                                   // 5 verifier r3 → miss 3 → FAILED_BOX
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed', '任务应进 state/failed/ 收件箱');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.maker_miss_count, 3);
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted', '失败来源是 maker 阶梯耗尽');

  const calls = env.calls();
  assert.equal(calls.length, 6, `应恰好 6 次 spawn，实际 ${calls.length}`);
  // 阶梯第 1 级：resume 原 maker session，repair prompt 内嵌 repair-context JSON，不含叙事
  assert.equal(resumeIdOf(calls[2]), 'sess-m1');
  const repairPrompt = promptOf(calls[2]);
  assert.ok(repairPrompt.includes('repair-context'), 'resume prompt 喂 repair-context（结构化）');
  assert.ok(repairPrompt.includes('AC-002'), 'repair-context 含失败 AC');
  assert.ok(!repairPrompt.includes('verify-r1.md'), 'repair prompt 不含人读叙事文件');
  // 阶梯第 2 级：冷启动（无 -r），带全部案卷（仍是 repair-context JSON）
  assert.equal(resumeIdOf(calls[4]), null);
  assert.ok(promptOf(calls[4]).includes('repair-context'), '冷启动 prompt 带 repair-context');

  // 三轮 verdict 文件齐全（每轮 overall fail）+ repair-context（verifier 源，仅失败 AC）
  for (const n of [1, 2, 3]) {
    const v = env.readJson(env.dossier(id, `verify-r${n}.verdict.json`));
    assert.equal(v.overall, 'fail', `verify-r${n} overall fail`);
    assert.ok(env.readJson(env.dossier(id, `maker-r${n}.json`)).done, `maker-r${n} done 标记`);
    const ctx = env.readJson(env.dossier(id, `repair-context-r${n}.json`));
    assert.equal(ctx.source, 'verifier');
    assert.deepEqual(ctx.failed_criteria.map((c) => c.ac_id), ['AC-002'], '只含失败 AC');
  }
  // verifier_invalid_count 全程为 0（valid fail 不算协议失败）
  assert.equal(after.runtime.verifier_invalid_count, 0);

  // retry 前：三轮 maker/verifier 的 stream-json 留档应已落在 dossier 根目录
  for (const n of [1, 2, 3]) {
    assert.ok(fs.existsSync(env.dossier(id, `maker-r${n}.stream.jsonl`)), `retry 前 maker-r${n}.stream.jsonl 应存在于根目录`);
    assert.ok(fs.existsSync(env.dossier(id, `verifier-r${n}.stream.jsonl`)), `retry 前 verifier-r${n}.stream.jsonl 应存在于根目录`);
  }

  // retry：FAILED_BOX → READY，重置 miss，案卷保留（轮次产物移入 attempts/）
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'READY');
  assert.equal(revived.runtime.maker_miss_count, 0);
  assert.equal(revived.runtime.verifier_invalid_count, 0);
  assert.equal(revived.runtime.last_failure_type, null);
  assert.ok(!fs.existsSync(env.dossier(id, 'maker-r1.json')), '轮次标记已腾出命名空间');
  assert.ok(fs.existsSync(env.dossier(id, 'attempts')), '历史轮次产物保留在 attempts/');
  assert.ok(fs.existsSync(env.dossier(id, 'timeline.md')), 'timeline 保留');

  // AC-001：retry 后 dossier 根目录不残留任何 *.stream.jsonl，全部移入 attempts/<ts>/
  const rootEntries = fs.readdirSync(env.dossier(id));
  assert.ok(!rootEntries.some((n) => n.endsWith('.stream.jsonl')), `dossier 根目录不应残留 stream.jsonl，实际：${rootEntries.join(',')}`);
  const archivedEntries = fs.readdirSync(env.dossier(id, 'attempts'), { recursive: true });
  for (const n of [1, 2, 3]) {
    assert.ok(archivedEntries.some((p) => p.endsWith(`maker-r${n}.stream.jsonl`)), `maker-r${n}.stream.jsonl 应归档到 attempts/`);
    assert.ok(archivedEntries.some((p) => p.endsWith(`verifier-r${n}.stream.jsonl`)), `verifier-r${n}.stream.jsonl 应归档到 attempts/`);
  }
});

// resume 非零退出且无 result 事件（不透明失败）现按疑似瞬态重试（isTransientFailure，AC-001）；
// 重试预算耗尽后仍要保留 cold 逃生口（AC-005）——这里把 spawnRetries 收窄到 1，
// 让 resume 先重试一次、仍不透明失败、耗尽后再降级冷启动，覆盖新契约的完整路径。
// 冷启动兜底成功后多留几份合法 verifier pass 兜底：不同代码路径下 maker 轮次消耗的调用数
// 可能不同，多余的 verdict 不会被消费，也不影响最终裁决（round 字段仅供人读，不参与校验）。
test('resume 不透明失败重试耗尽后仍降级冷启动，阶梯顺延（AC-005）', (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 1, spawnBackoffMs: [0] } });
  const id = 'task-20260611-102';
  env.writeTask(id);
  const PASS2 = verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' });
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.10, result: 'r1 修复' }, // 0 maker r1
    VFAIL(1),                                                                   // 1 verifier r1 → miss 1
    { exitCode: 1, stderr: 'No conversation found with session ID' },          // 2 resume 尝试1：不透明失败
    { exitCode: 1, stderr: 'No conversation found with session ID' },          // 3 resume 尝试2（重试）：仍不透明失败，耗尽
    { session_id: 'sess-m2b', cost: 0.07, result: 'r2 冷启动兜底' },           // 4 降级冷启动
    PASS2,                                                                        // 5 verifier r2 pass
    PASS2,                                                                        // 6 兜底
    PASS2,                                                                        // 7 兜底
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, '降级不额外消耗阶梯');

  const calls = env.calls();
  const resumeCalls = calls.filter((c) => resumeIdOf(c) === 'sess-m1');
  assert.equal(resumeCalls.length, 2, 'resume 应先按 retries 上限重试一次才耗尽，而非一次不透明失败就判死（AC-005 新契约）');
  const marker = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.equal(marker.resume_failed, true);
  assert.equal(marker.mode, 'cold-degraded');
});
