// 单元：tools/dossier-stats.mjs —— 跨任务聚合的口径不变量。
// 量尺本身错了，后续所有实验对照都失真，所以聚合口径用测试钉死：
// 截断按 raw.subtype 认、续跑按 marker 字段认、committer 有效性按 timeline 文案认、缺文件容错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStats, collectTask, renderMarkdown, parseArgs, selectTask, runCli } from '../../tools/dossier-stats.mjs';

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

// ---- H17：committer 有效性双读——events.jsonl 优先，legacy 回退 timeline grep ----

function writeEvents(root, id, lines) {
  fs.writeFileSync(path.join(root, 'dossier', id, 'events.jsonl'), lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('collectTask（H17）：events.jsonl 有 committer 事件时以事件为准（timeline 矛盾也不看）', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260701-010', {
    timeline: '- committer 提案 a1 有效：fix(x): 旧文案（legacy 干扰项）\n',
  });
  writeEvents(root, 'task-20260701-010', [
    { ts: 't0', type: 'stage', stage: 'VERIFY' },
    { ts: 't1', type: 'committer_attempt', attempt: 1, outcome: 'invalid', invalid_kind: 'malformed' },
    { ts: 't2', type: 'committer_attempt', attempt: 2, outcome: 'valid' },
  ]);
  const rec = collectTask(root, 'done', 'task-20260701-010');
  assert.equal(rec.committer_valid_attempt, 2, '事件流优先：a2 才是有效提案');
  assert.equal(rec.committer_degraded, false);
});

test('collectTask（H17）：events.jsonl 存在但无 committer 事件 → 回退 timeline grep（legacy 口径）', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260701-011', {
    timeline: '- committer 提案 a1 有效：fix(x): y\n',
  });
  writeEvents(root, 'task-20260701-011', [{ ts: 't0', type: 'stage', stage: 'DONE' }]);
  const rec = collectTask(root, 'done', 'task-20260701-011');
  assert.equal(rec.committer_valid_attempt, 1, '无 committer 事件时回退 grep');
});

test('collectTask（H17）：committer_degraded 事件 + 半行截断容错', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260701-012', {});
  const p = path.join(root, 'dossier', 'task-20260701-012', 'events.jsonl');
  fs.writeFileSync(
    p,
    `${JSON.stringify({ ts: 't1', type: 'committer_attempt', attempt: 1, outcome: 'invalid', invalid_kind: 'turns_exhausted' })}\n` +
    `${JSON.stringify({ ts: 't2', type: 'committer_attempt', attempt: 2, outcome: 'invalid', invalid_kind: 'malformed' })}\n` +
    `${JSON.stringify({ ts: 't3', type: 'committer_degraded' })}\n` +
    '{"ts":"t4","type":"stage","stage":"DO', // 进程被杀留下的半行：必须容错忽略
  );
  const rec = collectTask(root, 'done', 'task-20260701-012');
  assert.equal(rec.committer_valid_attempt, null);
  assert.equal(rec.committer_degraded, true, 'degraded 以事件为准');
});

// ---- --task 单任务钻取 ----

function makeTaskDetailRoot(t) {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260702-001', {
    kind: 'bugfix',
    runtime: { stage: 'DONE', spent_usd: 4.25 },
    dossier: {
      'maker-r1.json': { round: 1, mode: 'cold', ok: false, cost_usd: 2, raw: { subtype: 'error_max_turns' } },
      'maker-r2.json': { round: 2, mode: 'resume', ok: true, cost_usd: 1, raw: { subtype: 'success' } },
      'verify-r2.verdict.json': { overall: 'pass' },
      'committer-r1.json': { cost_usd: 0.02, raw: { subtype: 'success' } },
    },
    timeline: '- committer 提案 a1 有效：fix(x): y\n- merged\n',
  });
  writeTaskFixture(root, 'failed', 'task-20260702-002', {
    kind: 'feature',
    runtime: { stage: 'FAILED_BOX', last_failure_type: 'spawn_failed', spent_usd: 0.75 },
  });
  return root;
}

test('AC-001/AC-002：--task 输出单任务详情块，含关键字段且不含其他任务 id', (t) => {
  const root = makeTaskDetailRoot(t);
  const res = runCli(['--task', 'task-20260702-001', root]);
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('id: task-20260702-001'));
  assert.ok(res.stdout.includes('box: done'));
  assert.ok(res.stdout.includes('kind: bugfix'));
  assert.ok(res.stdout.includes('成本(spent_usd): 4.25'));
  assert.ok(!res.stdout.includes('task-20260702-002'), '不应包含其他任务 id');

  for (const field of ['id', 'box', 'kind', 'maker 轮次数', '截断腿数', 'verifier', 'committer', '成本(spent_usd)', '失败类型']) {
    assert.ok(res.stdout.includes(`${field}: `), `详情块缺字段 ${field}`);
  }
  assert.ok(res.stdout.includes('失败类型: -'), 'last_failure_type 为空回退 -');
});

test('AC-003：--task 未知 id 非零退出，stderr 说明三箱均未找到，stdout 不含全量输出', (t) => {
  const root = makeTaskDetailRoot(t);
  const res = runCli(['--task', 'task-20260702-999', root]);
  assert.notEqual(res.code, 0);
  assert.ok(res.stderr.includes('queue/done/failed'));
  assert.equal(res.stdout, '');
});

test('AC-004/AC-010：--task --json 输出单个对象，与 collectStats 中同 id 条目字段/键集合一致', (t) => {
  const root = makeTaskDetailRoot(t);
  const res = runCli(['--task', 'task-20260702-001', '--json', root]);
  assert.equal(res.code, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(!Array.isArray(parsed));

  const { tasks } = collectStats(root);
  const fromStats = tasks.find((tk) => tk.id === 'task-20260702-001');
  assert.deepEqual(parsed, fromStats);

  const direct = collectTask(root, 'done', 'task-20260702-001');
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(direct).sort());
});

test('AC-005：--task 未知 id --json 非零退出，stdout 不输出任何 JSON', (t) => {
  const root = makeTaskDetailRoot(t);
  const res = runCli(['--task', 'task-20260702-999', '--json', root]);
  assert.notEqual(res.code, 0);
  assert.ok(res.stderr.length > 0);
  assert.equal(res.stdout, '');
});

test('AC-008：--task 缺失 id 值（末位参数 / 紧跟 -- flag）非零退出', () => {
  const res1 = runCli(['--task']);
  assert.notEqual(res1.code, 0);
  assert.ok(res1.stderr.length > 0);
  assert.equal(res1.stdout, '');

  const res2 = runCli(['--task', '--json']);
  assert.notEqual(res2.code, 0);
  assert.ok(res2.stderr.length > 0);
  assert.equal(res2.stdout, '');
});

test('AC-009：--task <id> 不传 root 时用 CONDUCTOR_ROOT 默认 root 命中，id 不被误当 root', (t) => {
  const root = makeTaskDetailRoot(t);
  const prevRoot = process.env.CONDUCTOR_ROOT;
  process.env.CONDUCTOR_ROOT = root;
  t.after(() => {
    if (prevRoot === undefined) delete process.env.CONDUCTOR_ROOT;
    else process.env.CONDUCTOR_ROOT = prevRoot;
  });

  const parsedNoRoot = parseArgs(['--task', 'task-20260702-001']);
  assert.equal(parsedNoRoot.taskId, 'task-20260702-001');
  assert.equal(parsedNoRoot.root, path.resolve(root));

  const res = runCli(['--task', 'task-20260702-001']);
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('id: task-20260702-001'));

  const otherRoot = makeRoot(t);
  writeTaskFixture(otherRoot, 'done', 'task-20260702-001', { runtime: { spent_usd: 9 } });
  const parsedWithRoot = parseArgs(['--task', 'task-20260702-001', otherRoot]);
  assert.equal(parsedWithRoot.root, path.resolve(otherRoot));
  assert.equal(selectTask(parsedWithRoot.root, 'task-20260702-001').spent_usd, 9);
});
