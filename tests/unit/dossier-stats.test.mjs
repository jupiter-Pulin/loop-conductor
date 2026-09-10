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

// ---- 新旧两纪元混装（AC-029）：router 任务统计 router 轮次 / precommit 各步与 tier / 角色成本 ----

const ROUTER_DOSSIER = {
  'router-r1.json': { role: 'router', round: 1, cost_usd: 0.02 },
  'router-r1.log.json': { role: 'router', outcome: 'ok', action: 'maker', summary: '直接实现' },
  'maker-r1.json': { role: 'maker', round: 1, cost_usd: 1.5, truncated: true },
  'router-r2.json': { role: 'router', round: 2, cost_usd: 0.02 },
  'router-r2.log.json': { role: 'router', outcome: 'ok', action: 'review', summary: '整体冷审' },
  'reviewer-r2.json': { role: 'reviewer', round: 2, cost_usd: 0.4, head_sha: 'a'.repeat(40) },
  'reviewer-r2.log.json': { role: 'reviewer', outcome: 'fail', tier: 'integration', summary: 'AC-001 fail lib/x.mjs:1' },
  'router-r3.json': { role: 'router', round: 3, cost_usd: 0.02 },
  'router-r3.log.json': { role: 'router', outcome: 'ok', action: 'precommit', tier: 'integration', summary: '跑 integration' },
  'precommit-r3.json': {
    role: 'precommit', outcome: 'fail', tier: 'integration', summary: 'build ok；integration 2 fail', cost_usd: 0,
    head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), candidate_sha: 'c'.repeat(40),
    steps: [
      { step: 'build', command: 'npm run build', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 1000, tail: '' },
      { step: 'service', command: null, status: 'skipped', exit_code: null, timed_out: false, duration_ms: 0, tail: '', ready_ms: null, pid: null, stopped: false },
      { step: 'unit', command: 'node --test', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 900, tail: '' },
      { step: 'integration', command: 'npm run it', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 800, tail: 'fail 2' },
      { step: 'e2e', command: null, status: 'not_run', exit_code: null, timed_out: false, duration_ms: 0, tail: '' },
    ],
    skipped_tiers: ['e2e'], conflict_files: [],
  },
  'human-r3.json': {
    schema_version: 1, kind: 'help', requested_by: 'router', summary: '请裁决', refs: [],
    requested_at: '2026-09-10T00:00:00.000Z', decision: 'resumed', notes: '按 A 做',
  },
};

test('collectStats：含新旧两类 dossier 的仓库运行成功，router 纪元单独统计且不污染旧口径（AC-029）', (t) => {
  const root = makeRoot(t);

  // 旧任务（legacy 五闸）
  writeTaskFixture(root, 'done', 'task-20260701-010', {
    runtime: { stage: 'DONE', spent_usd: 3 },
    dossier: {
      'maker-r1.json': { round: 1, mode: 'cold', ok: true, cost_usd: 2, raw: { subtype: 'success' } },
      'verify-r1.verdict.json': { overall: 'pass' },
      'test-gate-r1.json': { mode: 'per-ac', verdict: 'falsifies' },
    },
  });
  // 新任务（router）
  writeTaskFixture(root, 'queue', 'task-20260910-400', {
    runtime: { stage: 'ROUTING', spent_usd: 1.96 },
    dossier: ROUTER_DOSSIER,
  });

  const { tasks, summary } = collectStats(root);
  assert.equal(summary.tasks_total, 2);

  // 旧口径只看旧任务：新任务的 maker-r1.json 是 spawn 记录，不进 maker 门统计
  assert.equal(summary.maker.rounds_total, 1);
  assert.equal(summary.verifier.rounds_total, 1);
  assert.equal(summary.test_gate.per_ac_rounds, 1);

  const r = summary.router;
  assert.equal(r.tasks, 1);
  assert.equal(r.rounds_total, 3);
  assert.deepEqual(r.actions, { maker: 1, review: 1, precommit: 1 });
  assert.equal(r.maker_product_not_ok, 1, 'maker 没写 log → product=missing');
  assert.equal(r.maker_truncated, 1);
  assert.equal(r.reviewer_rounds, 1);
  assert.equal(r.reviewer_fails, 1);
  assert.equal(r.precommit.runs, 1);
  assert.equal(r.precommit.fail, 1);
  assert.deepEqual(r.precommit.by_tier, { unit: 0, integration: 1, e2e: 0 });
  assert.deepEqual(r.precommit.by_step.build, { ok: 1, fail: 0, skipped: 0, not_run: 0 });
  assert.deepEqual(r.precommit.by_step.service, { ok: 0, fail: 0, skipped: 1, not_run: 0 });
  assert.deepEqual(r.precommit.by_step.integration, { ok: 0, fail: 1, skipped: 0, not_run: 0 });
  assert.deepEqual(r.precommit.by_step.e2e, { ok: 0, fail: 0, skipped: 0, not_run: 1 });
  assert.deepEqual(r.human_gates, { spec: 0, merge: 0, help: 1 });
  assert.equal(r.role_cost_usd.router, 0.06);
  assert.equal(r.role_cost_usd.maker, 1.5);
  assert.equal(r.role_cost_usd.reviewer, 0.4);
  // P2b 预留列：本阶段恒 0
  assert.deepEqual(
    [r.packages_total, r.parallel_rounds, r.plan_runs],
    [0, 0, 0],
  );

  // 逐任务：新任务带 router 证据，旧任务带旧证据，互不串台
  const routerTask = tasks.find((x) => x.id === 'task-20260910-400');
  assert.equal(routerTask.is_router, true);
  assert.equal(routerTask.maker_rounds.length, 0);
  assert.equal(routerTask.router_rounds.length, 3);
  const legacyTask = tasks.find((x) => x.id === 'task-20260701-010');
  assert.equal(legacyTask.is_router, false);
  assert.deepEqual(legacyTask.router_rounds, []);

  const md = renderMarkdown({ tasks, summary });
  assert.ok(md.includes('## 新状态机（router）'));
  assert.ok(md.includes('router 轮次：3'));
  assert.ok(md.includes('tier 分布：unit×0，integration×1，e2e×0'));
  assert.ok(md.includes('包数 0；并行轮数 0；plan 次数 0'));
  assert.ok(md.includes('| task-20260910-400 | queue |'));
});

test('runCli：--task 与 --json 两种模式在 router 任务上都工作（AC-029）', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'queue', 'task-20260910-401', {
    runtime: { stage: 'ROUTING', spent_usd: 1.96 },
    dossier: ROUTER_DOSSIER,
  });

  const detail = runCli(['--task', 'task-20260910-401', root]);
  assert.equal(detail.code, 0, detail.stderr);
  assert.ok(detail.stdout.includes('纪元: router'));
  assert.ok(detail.stdout.includes('router 轮次数: 3'));
  assert.ok(detail.stdout.includes('router 动作: maker,review,precommit'));
  assert.ok(detail.stdout.includes('precommit 各步: build:ok,service:skipped,unit:ok,integration:fail,e2e:not_run'));
  assert.ok(detail.stdout.includes('人闸: help:resumed'));
  assert.ok(detail.stdout.includes('工作包(P2b 预留): 包数 0 / 并行轮数 0 / plan 次数 0'));

  const json = runCli(['--task', 'task-20260910-401', '--json', root]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.is_router, true);
  assert.equal(parsed.router_rounds.length, 3);
  assert.equal(parsed.precommit_rounds[0].tier, 'integration');

  const full = runCli(['--json', root]);
  assert.equal(full.code, 0, full.stderr);
  assert.equal(JSON.parse(full.stdout).summary.router.tasks, 1);
});

test('collectStats：只有旧任务的仓库里 router 小节为空结构，渲染不报错（AC-029）', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260701-011', {
    dossier: { 'maker-r1.json': { round: 1, ok: true, cost_usd: 1 } },
  });
  const stats = collectStats(root);
  assert.equal(stats.summary.router.tasks, 0);
  assert.equal(stats.summary.router.rounds_total, 0);
  const md = renderMarkdown(stats);
  assert.ok(md.includes('（本库没有 router 纪元的任务）'));
});
