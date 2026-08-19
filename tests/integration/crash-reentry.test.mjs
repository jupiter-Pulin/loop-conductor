// 集成：崩溃重入——maker 标记有 started 无 done → 判定上次崩溃，转 FAILED_BOX（crashed），
// 不留滞留任务；conductor retry 后可恢复正常推进（契约 §11 READY/FIXING 行）。
// 本文件的用例意图是「重入判定 + 人工 retry 恢复」这条语义，不是恢复策略，所以一律显式关掉
// 自动恢复（crashAutoRecoveryLimit: 0）；有界自动恢复的行为见 crash-auto-recovery.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

/** 伪造上次崩溃残留：写一个只有 started 无 done 的孤儿 maker 标记。 */
function writeOrphanMarker(env, id, round) {
  const p = env.dossier(id, `maker-r${round}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ role: 'maker', round, mode: 'cold', started: '2026-06-11T00:00:00Z' }));
  return p;
}

test('READY 崩溃残留（started 无 done）→ FAILED_BOX，retry 后恢复推进', (t) => {
  const env = makeEnv(t, { config: { crashAutoRecoveryLimit: 0 } });
  const id = 'task-20260611-201';
  env.writeTask(id); // stage READY
  const markerPath = writeOrphanMarker(env, id, 1);
  env.setScenario([]); // 任何 spawn 都会让 fake-claude 报「多余的 spawn」

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /crashed/, '收箱原因必须是 crashed');
  assert.match(run.stderr, new RegExp(`retry ${id}`), '告警应指引人工 retry');

  const after = env.findTask(id);
  assert.equal(after.box, 'failed', '不留滞留任务：直接收箱');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'crashed');
  assert.equal(env.calls().length, 0, '不得 spawn 任何 claude');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /crashed/, 'timeline 记录 crashed 原因');

  // 人工 retry：FAILED_BOX → READY，孤儿标记移入 attempts/，下次 run 重新 spawn 推进到底
  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'READY');
  assert.equal(revived.runtime.last_failure_type, null);
  assert.ok(!fs.existsSync(markerPath), '孤儿标记已腾出轮次命名空间');
  assert.ok(fs.existsSync(env.dossier(id, 'attempts')), '崩溃轮产物保留在 attempts/');

  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 's1', cost: 0.1, result: 'fixed' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', 'retry 后恢复正常推进');
});

test('FIXING 阶段的崩溃残留同样转 FAILED_BOX', (t) => {
  const env = makeEnv(t, { config: { crashAutoRecoveryLimit: 0 } });
  const id = 'task-20260611-202';
  env.writeTask(id, { stage: 'FIXING', miss: 1, sessionId: 'sess-old' });
  writeOrphanMarker(env, id, 2); // round = miss+1 = 2
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /maker-r2 有 started 无 done/);
  assert.match(run.stderr, /crashed/);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'crashed');
  assert.equal(env.calls().length, 0);
});
