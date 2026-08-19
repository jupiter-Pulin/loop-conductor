// 集成：崩溃孤儿腿的有界自动恢复（事故 task-20260802-006/007）。契约：
//   1) 默认额度（crashAutoRecoveryLimit=1）：孤儿产物进 attempts/、原地重 spawn maker，
//      crash_recovery_count=1，timeline/events 留痕，任务照常推进到人闸；
//   2) 额度用尽：仍是 FAILED_BOX(crashed)，收箱文案标注已用尽次数（旧行为兜底）；
//   3) crashAutoRecoveryLimit=0：直接收箱，零 spawn（逐字退回旧行为）；
//   4) FIXING 与 READY 同一裁决；
//   5) 人工 retry（failed 全量重置 / queue 残留清理）都复位额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

/** 伪造上次崩溃残留：该轮三件孤儿产物（marker 只有 started 无 done）。 */
function writeOrphanRound(env, id, round) {
  const marker = env.dossier(id, `maker-r${round}.json`);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ role: 'maker', round, mode: 'cold', started: '2026-08-02T00:00:00Z' }));
  fs.writeFileSync(env.dossier(id, `maker-r${round}.settings.json`), '{"hooks":{}}\n');
  fs.writeFileSync(env.dossier(id, `maker-r${round}.stream.jsonl`), '{"type":"system"}\n');
  return marker;
}

/** 直接改 runtime.json（构造「额度已用掉 n 次」的前置状态；env.writeTask 不带该字段）。 */
function patchRuntime(env, id, patch) {
  const ts = env.findTask(id);
  fs.writeFileSync(path.join(ts.dir, 'runtime.json'), `${JSON.stringify({ ...ts.runtime, ...patch }, null, 2)}\n`);
}

/** attempts/<stamp>/ 下的全部文件名（跨所有 stamp 目录聚合）。 */
function attemptFiles(env, id) {
  const root = env.dossier(id, 'attempts');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((stamp) => fs.readdirSync(path.join(root, stamp)));
}

function readEvents(env, id) {
  try {
    return fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test('契约1：READY 孤儿腿 + 默认额度 → 归档 + 重 spawn，一次 run 推进到人闸', (t) => {
  const env = makeEnv(t, { config: { eventsLogEnabled: true } });
  const id = 'task-20260802-701';
  env.writeTask(id); // stage READY，crashAutoRecoveryLimit 用 conductor 默认值 1
  writeOrphanRound(env, id, 1);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-maker-recovered', cost: 0.1, result: '重跑修好了' },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'queue', '自动恢复不收箱');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '恢复后照常推进到人闸');
  assert.equal(after.runtime.last_failure_type, null);
  assert.equal(after.runtime.crash_recovery_count, 1, '用掉一次自动恢复额度');

  // 孤儿产物三件全部腾进 attempts/（案卷保留），当前命名空间是本次重 spawn 的新产物
  assert.deepEqual(
    attemptFiles(env, id).sort(),
    ['maker-r1.json', 'maker-r1.settings.json', 'maker-r1.stream.jsonl'],
  );
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.ok(marker.started && marker.done, '重 spawn 的 maker-r1 双标记齐全');
  assert.equal(marker.session_id, 'sess-maker-recovered');

  const calls = env.calls();
  assert.equal(calls.length, 2, 'maker 重 spawn + verifier');

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /crashed 自动恢复 #1：maker-r1 孤儿腿归档/);
  assert.match(timeline, /重新 spawn/);

  const recoveries = readEvents(env, id).filter((e) => e.type === 'crash_auto_recovery');
  assert.deepEqual(recoveries.map((e) => [e.round, e.attempt]), [[1, 1]]);
});

test('契约2+5：额度用尽 → FAILED_BOX(crashed) 带用尽文案；retry 复位额度', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260802-702';
  env.writeTask(id);
  patchRuntime(env, id, { crash_recovery_count: 1 }); // 上一次 run 已用掉默认额度
  writeOrphanRound(env, id, 1);
  env.setScenario([]); // 任何 spawn 都会让 fake-claude 报「多余的 spawn」

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /crashed/);
  assert.match(run.stderr, /自动恢复已用尽：1 次/);
  assert.match(run.stderr, new RegExp(`retry ${id}`), '仍指引人工 retry');

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'crashed');
  assert.equal(after.runtime.crash_recovery_count, 1, '收箱不吞额度计数，供人排查');
  assert.equal(env.calls().length, 0, '额度用尽后不得再 spawn');

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const revived = env.findTask(id);
  assert.equal(revived.box, 'queue');
  assert.equal(revived.runtime.stage, 'READY');
  assert.equal(revived.runtime.crash_recovery_count, 0, '人工 retry 后重新享有自动恢复额度');
});

test('契约3：crashAutoRecoveryLimit=0 → 直接收箱、零 spawn、无用尽文案（旧行为）', (t) => {
  const env = makeEnv(t, { config: { crashAutoRecoveryLimit: 0 } });
  const id = 'task-20260802-703';
  env.writeTask(id);
  writeOrphanRound(env, id, 1);
  env.setScenario([]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /crashed: maker-r1 有 started 无 done/);
  assert.equal(/自动恢复已用尽/.test(run.stderr), false, '从未自动恢复过就不该有用尽文案');

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'crashed');
  assert.equal(env.calls().length, 0);
  assert.deepEqual(attemptFiles(env, id), [], '关闭时不动孤儿产物');
  assert.ok(fs.existsSync(env.dossier(id, 'maker-r1.json')), '孤儿标记原样留在案卷根');
});

test('契约4：FIXING 孤儿腿同样自动恢复（round=miss+1）', (t) => {
  const env = makeEnv(t, { config: { eventsLogEnabled: true } });
  const id = 'task-20260802-704';
  env.writeTask(id, { stage: 'FIXING', miss: 1 }); // 无 session → 冷启动重 spawn
  writeOrphanRound(env, id, 2);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-maker-r2', cost: 0.1, result: 'r2 重跑修好了' },
    verifierStep(2),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.crash_recovery_count, 1);
  assert.equal(after.runtime.maker_miss_count, 1, '自动恢复不动 miss 阶梯');
  assert.deepEqual(
    attemptFiles(env, id).sort(),
    ['maker-r2.json', 'maker-r2.settings.json', 'maker-r2.stream.jsonl'],
  );
  const marker = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.ok(marker.started && marker.done);
  assert.deepEqual(
    readEvents(env, id).filter((e) => e.type === 'crash_auto_recovery').map((e) => e.round),
    [2],
  );
});

test('契约5：queue 中的人工 retry 清理路径同样复位额度', (t) => {
  const env = makeEnv(t, { config: { crashAutoRecoveryLimit: 0 } });
  const id = 'task-20260802-705';
  env.writeTask(id, { stage: 'FIXING', miss: 1 });
  patchRuntime(env, id, { crash_recovery_count: 1 });
  const markerPath = writeOrphanRound(env, id, 2);

  const retry = env.run('retry', id); // 任务仍在 queue：走崩溃残留清理分支
  assert.equal(retry.status, 0, retry.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'FIXING', 'queue 清理路径不改 stage');
  assert.equal(after.runtime.crash_recovery_count, 0);
  assert.ok(!fs.existsSync(markerPath), '孤儿标记已腾出轮次命名空间');
});
