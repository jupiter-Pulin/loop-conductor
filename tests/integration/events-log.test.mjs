// 集成：结构化事件流（R5-H17）。契约：
//   1) 默认关：全链跑完（含 merge）零 events.jsonl（旧行为，timeline 独存）；
//   2) 开启：stage / verifier_verdict / committer_attempt 事件齐全且字段正确，
//      dossier-stats 从事件流拿到 committer 有效性（不再依赖 timeline 文案）；
//   3) 事件流是观测面：开关开与关的任务路由完全一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { collectTask } from '../../tools/dossier-stats.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const GOOD_PROPOSAL = JSON.stringify({
  subject: 'fix(stats): median 偶数分支取平均',
  body: '事件流集成测试提案。\n\n验证：node --test 全绿。',
});

function readEvents(env, id) {
  try {
    return fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return null; // 文件不存在
  }
}

test('契约1：默认关——全链（run+merge）零 events.jsonl，路由不变', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260708-990';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.01, result: GOOD_PROPOSAL },
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.run('merge', id).status, 0);
  assert.equal(env.findTask(id).box, 'done');
  assert.equal(readEvents(env, id), null, '默认关闭不得产生 events.jsonl');
});

test('契约2+3：开启——事件齐全、字段正确、stats 从事件流拿 committer 有效性', (t) => {
  const env = makeEnv(t, { config: { eventsLogEnabled: true } });
  const id = 'task-20260708-991';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1),
    { cost: 0.01, result: '这不是 JSON 提案（a1 故意 invalid）' }, // a1 malformed
    { cost: 0.01, result: GOOD_PROPOSAL },                          // a2 valid
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', '开关不影响路由');
  assert.equal(env.run('merge', id).status, 0);
  assert.equal(env.findTask(id).box, 'done');

  const events = readEvents(env, id);
  assert.ok(Array.isArray(events) && events.length > 0, 'events.jsonl 应存在且非空');
  for (const ev of events) {
    assert.ok(typeof ev.ts === 'string' && typeof ev.type === 'string', '每条事件都有 ts/type');
  }

  const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.ok(stages.includes('AWAIT_HUMAN_MERGE'), 'stage 事件覆盖 verdict pass 转移');
  assert.ok(stages.includes('DONE'), 'stage 事件覆盖 merge 归档');

  const verdicts = events.filter((e) => e.type === 'verifier_verdict');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].round, 1);
  assert.equal(verdicts[0].overall, 'pass');

  const attempts = events.filter((e) => e.type === 'committer_attempt');
  assert.deepEqual(
    attempts.map((a) => [a.attempt, a.outcome, a.invalid_kind ?? null]),
    [[1, 'invalid', 'malformed'], [2, 'valid', null]],
    'committer 事件逐 attempt 记录归因',
  );
  assert.equal(events.filter((e) => e.type === 'committer_degraded').length, 0);

  // dossier-stats 双读：事件流在场时 committer 有效性来自事件（timeline 只是人读）
  const rec = collectTask(env.root, 'done', id);
  assert.equal(rec.committer_valid_attempt, 2);
  assert.equal(rec.committer_degraded, false);
});
