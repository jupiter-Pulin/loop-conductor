// 单元：tools/dossier-stats.mjs —— 跨任务聚合的口径不变量。
// 量尺本身错了，后续所有实验对照都失真，所以聚合口径用测试钉死：
// 截断按 raw.subtype 认、续跑按 marker 字段认、committer 有效性按 timeline 文案认、缺文件容错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStats, collectTask, renderMarkdown } from '../../tools/dossier-stats.mjs';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-stats-'));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'dossier']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTaskFixture(root, box, id, { kind = 'bugfix', runtime = {}, dossier = {}, timeline = null } = {}) {
  const stateDir = path.join(root, 'state', box, id);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task.json'), JSON.stringify({ id, kind }));
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ stage: 'DONE', maker_miss_count: 0, spent_usd: 0, ...runtime }));
  const dDir = path.join(root, 'dossier', id);
  fs.mkdirSync(dDir, { recursive: true });
  for (const [name, content] of Object.entries(dossier)) {
    fs.writeFileSync(path.join(dDir, name), JSON.stringify(content));
  }
  if (timeline) fs.writeFileSync(path.join(dDir, 'timeline.md'), timeline);
}

test('collectStats：截断/续跑/committer/失败类型的聚合口径', (t) => {
  const root = makeRoot(t);

  // done 任务：r1 截断（带 1 次续跑）+ r2 成功；committer a1 有效；verifier 1 轮 pass
  writeTaskFixture(root, 'done', 'task-20260701-001', {
    runtime: { stage: 'DONE', spent_usd: 3.5 },
    dossier: {
      'maker-r1.json': { round: 1, mode: 'cold', ok: false, cost_usd: 2, max_turns_continuations: 1, raw: { subtype: 'error_max_turns' } },
      'maker-r2.json': { round: 2, mode: 'resume', ok: true, cost_usd: 1, raw: { subtype: 'success' } },
      'verify-r2.verdict.json': { overall: 'pass' },
      'test-gate-r2.json': { mode: 'per-ac', verdict: 'falsifies' },
      'committer-r1.json': { cost_usd: 0.02, raw: { subtype: 'success' } },
    },
    timeline: '- committer 提案 a1 有效：fix(x): y\n- merged\n',
  });

  // failed 任务：spawn_failed 归因；committer 双 invalid 降级
  writeTaskFixture(root, 'failed', 'task-20260701-002', {
    runtime: { stage: 'FAILED_BOX', last_failure_type: 'spawn_failed', spent_usd: 0.5 },
    dossier: {
      'maker-r1.json': { round: 1, mode: 'cold', ok: false, cost_usd: 0.5, raw: null },
      'verify-r1.invalid-a1.json': { reason: 'x' },
    },
    timeline: '- committer 提案 a1 invalid：轮次耗尽未输出提案\n- committer 提案两次 invalid，merge 降级机器文案\n',
  });

  // queue 任务：dossier 缺 timeline / 无 committer —— 容错路径
  writeTaskFixture(root, 'queue', 'task-20260701-003', {
    kind: 'feature',
    runtime: { stage: 'AWAIT_SPEC_APPROVAL', spent_usd: 1 },
  });

  const { tasks, summary } = collectStats(root);
  assert.equal(summary.tasks_total, 3);
  assert.deepEqual(summary.tasks_by_box, { queue: 1, done: 1, failed: 1 });

  // maker 口径
  assert.equal(summary.maker.rounds_total, 3);
  assert.equal(summary.maker.r1_total, 2);
  assert.equal(summary.maker.r1_max_turns_cutoff, 1, '截断只认 raw.subtype=error_max_turns');
  assert.equal(summary.maker.rounds_with_continuation, 1);
  assert.equal(summary.maker.tasks_needing_r2plus, 1);
  assert.equal(summary.maker.cost_usd, 3.5);

  // verifier / test gate / committer / 失败类型
  assert.equal(summary.verifier.rounds_total, 1);
  assert.equal(summary.verifier.invalid_files, 1);
  assert.equal(summary.test_gate.per_ac_rounds, 1);
  assert.equal(summary.committer.merges_with_proposal, 2, '有 committer-r*.json 或 timeline 有效标记的都算');
  assert.equal(summary.committer.valid_a1, 1);
  assert.equal(summary.committer.degraded, 1);
  assert.deepEqual(summary.failure_types, { spawn_failed: 1 });
  assert.equal(summary.spent_usd_total, 5);

  // 逐任务：queue 任务缺 dossier 文件不抛错
  const queueTask = tasks.find((x) => x.id === 'task-20260701-003');
  assert.equal(queueTask.maker_rounds.length, 0);
  assert.equal(queueTask.committer_valid_attempt, null);

  // 渲染冒烟：含关键比率行与逐任务表
  const md = renderMarkdown({ tasks, summary });
  assert.ok(md.includes('maker r1 max-turns 截断率：1/2'));
  assert.ok(md.includes('| task-20260701-002 | failed |'));
});

test('collectTask：完全空目录（无 state 文件、无 dossier）返回容错骨架', (t) => {
  const root = makeRoot(t);
  fs.mkdirSync(path.join(root, 'state', 'queue', 'task-20260701-009'), { recursive: true });
  const rec = collectTask(root, 'queue', 'task-20260701-009');
  assert.equal(rec.id, 'task-20260701-009');
  assert.equal(rec.kind, null);
  assert.deepEqual(rec.maker_rounds, []);
  assert.equal(rec.committer_degraded, false);
});
