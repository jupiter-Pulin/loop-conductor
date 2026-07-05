// dashboard/model.mjs 单测：泳道映射、needsHuman/working 判据、broken 降级、
// feasibility options 透传、CLI 结果→提示转换的纯函数支撑，以及 AC-003/AC-004 静态守卫。
// 风格与 tests/unit/state.test.mjs 一致：fs.mkdtempSync 临时目录自建 fixture。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNewTask } from '../../conductor/lib/state.mjs';
import { validateFeasibilityDoc } from '../../conductor/lib/feasibility-contract.mjs';
import {
  LANE_ORDER, laneForStage, isValidTaskId,
  buildBoard, buildTaskDetail, parseTimeline,
  SYNC_ACTIONS, buildSyncActionArgv, formatCliMessage, parseNewTaskId, buildNewTaskArgv,
} from '../../conductor/dashboard/model.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkroot(prefix = 'dashboard-model-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseCfg(root) {
  return {
    root,
    queueDir: path.join(root, 'state', 'queue'),
    doneDir: path.join(root, 'state', 'done'),
    failedDir: path.join(root, 'state', 'failed'),
    specsDir: path.join(root, 'specs'),
    dossierDir: path.join(root, 'dossier'),
    targetProfilesDir: path.join(root, 'target-profiles'),
    targetRepo: path.join(root, 'target'),
    baseBranch: 'main',
    testCommand: 'node --test',
  };
}

function ensureDirs(cfg) {
  for (const d of [cfg.queueDir, cfg.doneDir, cfg.failedDir, cfg.specsDir, cfg.dossierDir, cfg.targetProfilesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function baseTask(id, over = {}) {
  return {
    schema_version: 1,
    id,
    kind: 'bugfix',
    title: `标题 ${id}`,
    repo: 'target',
    targetRepo: '/abs/target',
    baseBranch: 'main',
    testCommand: 'node --test',
    created_at: '2026-07-05T00:00:00.000Z',
    ...over,
  };
}

function baseRuntime(stage, over = {}) {
  return {
    schema_version: 1,
    stage,
    maker_miss_count: 0,
    verifier_invalid_count: 0,
    spent_usd: 1.5,
    approval: null,
    maker_session_id: null,
    current_round: 0,
    last_failure_type: null,
    updated_at: '2026-07-05T00:00:00.000Z',
    ...over,
  };
}

// ---- AC-006：stage → 泳道映射 ----

test('laneForStage：与 wireframes.md 映射表逐项一致（AC-006）', () => {
  const expected = {
    NEEDS_TARGET_SETUP: 'setup',
    AWAIT_SETUP_APPROVAL: 'setup',
    NEEDS_FEASIBILITY: 'feasibility',
    AWAIT_FEASIBILITY_APPROVAL: 'feasibility',
    NEEDS_SPEC: 'spec',
    SPEC_VERIFY: 'spec',
    SPEC_FIXING: 'spec',
    AWAIT_SPEC_APPROVAL: 'spec',
    READY: 'maker',
    FIXING: 'maker',
    VERIFY: 'verify',
    AWAIT_HUMAN_MERGE: 'merge',
  };
  for (const [stage, lane] of Object.entries(expected)) {
    assert.equal(laneForStage(stage), lane, stage);
  }
  assert.equal(laneForStage('DONE'), null);
  assert.equal(laneForStage('FAILED_BOX'), null);
  assert.equal(laneForStage('SOME_UNKNOWN_STAGE'), null);
  assert.deepEqual(LANE_ORDER, ['setup', 'feasibility', 'spec', 'maker', 'verify', 'merge']);
});

// ---- AC-007：needsHuman / working 判据 ----

test('buildBoard：needsHuman 仅人审 stage 为 true，working 仅非人审推进 stage 为 true（AC-007）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  writeNewTask(cfg.queueDir, baseTask('task-20260705-001'), baseRuntime('AWAIT_SPEC_APPROVAL'));
  writeNewTask(cfg.queueDir, baseTask('task-20260705-002'), baseRuntime('READY'));
  writeNewTask(cfg.queueDir, baseTask('task-20260705-003'), baseRuntime('AWAIT_HUMAN_MERGE'));
  writeNewTask(cfg.queueDir, baseTask('task-20260705-004'), baseRuntime('VERIFY'));
  writeNewTask(cfg.doneDir, baseTask('task-20260705-005'), baseRuntime('DONE'));
  writeNewTask(cfg.failedDir, baseTask('task-20260705-006'), baseRuntime('FAILED_BOX', { last_failure_type: 'crashed' }));

  const board = buildBoard(cfg);
  const findIn = (lane, id) => board.lanes.find((l) => l.lane === lane).tasks.find((e) => e.id === id);

  const spec = findIn('spec', 'task-20260705-001');
  assert.equal(spec.needsHuman, true);
  assert.equal(spec.working, false);
  assert.equal(spec.spentUsd, 1.5);

  const maker = findIn('maker', 'task-20260705-002');
  assert.equal(maker.needsHuman, false);
  assert.equal(maker.working, true);

  const merge = findIn('merge', 'task-20260705-003');
  assert.equal(merge.needsHuman, true);
  assert.equal(merge.working, false);

  const verify = findIn('verify', 'task-20260705-004');
  assert.equal(verify.needsHuman, false);
  assert.equal(verify.working, true);

  assert.equal(board.done[0].needsHuman, false);
  assert.equal(board.done[0].working, false);
  assert.equal(board.failed[0].needsHuman, false);
  assert.equal(board.failed[0].working, false);

  // 契约字段齐全（AC-005）
  assert.deepEqual(Object.keys(spec).sort(), ['box', 'id', 'kind', 'lane', 'needsHuman', 'spentUsd', 'stage', 'title', 'working'].sort());
});

// ---- 详情抽屉误显示 working 回归守卫：GET /api/task/<id> 载荷与看板同口径 ----

test('buildTaskDetail：working/needsHuman 与 buildBoard 同口径——done/failed 恒 false，queue 人审 stage 只 needsHuman，queue 推进 stage 只 working', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  writeNewTask(cfg.queueDir, baseTask('task-20260705-201'), baseRuntime('AWAIT_SPEC_APPROVAL'));
  writeNewTask(cfg.queueDir, baseTask('task-20260705-202'), baseRuntime('READY'));
  writeNewTask(cfg.doneDir, baseTask('task-20260705-203'), baseRuntime('DONE'));
  writeNewTask(cfg.failedDir, baseTask('task-20260705-204'), baseRuntime('FAILED_BOX', { last_failure_type: 'crashed' }));

  const humanStage = buildTaskDetail(cfg, 'task-20260705-201');
  assert.equal(humanStage.needsHuman, true);
  assert.equal(humanStage.working, false);

  const advancingStage = buildTaskDetail(cfg, 'task-20260705-202');
  assert.equal(advancingStage.needsHuman, false);
  assert.equal(advancingStage.working, true);

  const done = buildTaskDetail(cfg, 'task-20260705-203');
  assert.equal(done.needsHuman, false);
  assert.equal(done.working, false);

  const failed = buildTaskDetail(cfg, 'task-20260705-204');
  assert.equal(failed.needsHuman, false);
  assert.equal(failed.working, false);
});

// ---- AC-008：坏任务目录降级 ----

test('buildBoard：坏任务目录不抛错，降级进 broken；queue 中 lane 不可判定的残留任务同样进 broken（AC-008）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  writeNewTask(cfg.queueDir, baseTask('task-20260705-010'), baseRuntime('READY'));
  writeNewTask(cfg.queueDir, baseTask('task-20260705-020'), baseRuntime('DONE')); // 崩溃巡检未跑前的残留

  const badDir = path.join(cfg.queueDir, 'task-20260705-011');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'task.json'), '{ not json');
  fs.writeFileSync(path.join(badDir, 'runtime.json'), '{}');

  assert.doesNotThrow(() => buildBoard(cfg));
  const board = buildBoard(cfg);

  const brokenIds = board.broken.map((b) => b.id);
  assert.ok(brokenIds.includes('task-20260705-011'));
  assert.ok(brokenIds.includes('task-20260705-020'));
  assert.ok(board.broken.find((b) => b.id === 'task-20260705-011').error);

  const makerLane = board.lanes.find((l) => l.lane === 'maker').tasks;
  assert.ok(makerLane.some((e) => e.id === 'task-20260705-010'));
  assert.ok(!board.lanes.some((l) => l.tasks.some((e) => e.id === 'task-20260705-020')));
});

// ---- AC-011：feasibility review options 透传 ----

const FEASIBILITY_MD = [
  '# Feasibility Study: dashboard',
  '',
  '## 选项对比',
  '',
  '| 选项 | 描述 |',
  '| --- | --- |',
  '| O-A: 零依赖 http server | 直读磁盘 |',
  '| O-B: 引入 express | 更多依赖 |',
  '',
  '## 推荐',
  '',
  '推荐 O-A：零依赖更贴合 Non-goals。',
  '',
  '## 开放问题',
  '',
  '（无）',
  '',
].join('\n');

test('buildTaskDetail：AWAIT_FEASIBILITY_APPROVAL 的 review.options 与 validateFeasibilityDoc(md).options 深等（AC-011）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260705-030';
  const dir = writeNewTask(cfg.queueDir, baseTask(id, { kind: 'feature' }), baseRuntime('AWAIT_FEASIBILITY_APPROVAL'));
  fs.writeFileSync(path.join(dir, 'feasibility-study.md'), FEASIBILITY_MD);

  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.review.kind, 'feasibility');
  assert.equal(detail.review.markdown, FEASIBILITY_MD);
  assert.deepEqual(detail.review.options, validateFeasibilityDoc(FEASIBILITY_MD).options);
  assert.deepEqual(detail.review.options.map((o) => o.option_id), ['O-A', 'O-B']);
});

test('buildTaskDetail：feasibility-study.md 缺失时 review 给出缺失提示，不抛错（AC-010 同型缺失处理）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260705-031';
  writeNewTask(cfg.queueDir, baseTask(id, { kind: 'feature' }), baseRuntime('AWAIT_FEASIBILITY_APPROVAL'));

  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.review.missing, true);
  assert.deepEqual(detail.review.options, []);
});

test('buildTaskDetail：id 不存在返回 null（供 server 404）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  assert.equal(buildTaskDetail(cfg, 'task-20260705-999'), null);
});

// ---- parseTimeline：timeline 原文 → 结构化条目（AC-001） ----

test('parseTimeline：合法行解析出 ts 与正文', () => {
  const text = [
    '- 2026-07-05T00:00:00.000Z stage → READY',
    '- 2026-07-05T01:23:45.678Z stage → VERIFY (第 1 轮)',
  ].join('\n');
  assert.deepEqual(parseTimeline(text), [
    { ts: '2026-07-05T00:00:00.000Z', text: 'stage → READY' },
    { ts: '2026-07-05T01:23:45.678Z', text: 'stage → VERIFY (第 1 轮)' },
  ]);
});

test('parseTimeline：非法行不丢弃、不抛错，以 ts:null + 原文形态保留', () => {
  const text = [
    '- 2026-07-05T00:00:00.000Z stage → READY',
    '不是 timeline 格式的一行',
    '- 不是有效ISO时间戳 正文',
  ].join('\n');
  assert.deepEqual(parseTimeline(text), [
    { ts: '2026-07-05T00:00:00.000Z', text: 'stage → READY' },
    { ts: null, text: '不是 timeline 格式的一行' },
    { ts: null, text: '- 不是有效ISO时间戳 正文' },
  ]);
});

test('parseTimeline：空串/缺失输入返回空数组', () => {
  assert.deepEqual(parseTimeline(''), []);
  assert.deepEqual(parseTimeline(null), []);
  assert.deepEqual(parseTimeline(undefined), []);
});

// ---- buildTaskDetail：timelineEntries 字段（AC-002） ----

test('buildTaskDetail：timelineEntries 与 timeline 原文字段并存，timelineEntries 为 parseTimeline(timeline) 结构', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260705-040';
  writeNewTask(cfg.queueDir, baseTask(id), baseRuntime('READY'));
  const dossierDir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dossierDir, { recursive: true });
  const timelineText = '- 2026-07-05T00:00:00.000Z stage → READY\n非法行\n';
  fs.writeFileSync(path.join(dossierDir, 'timeline.md'), timelineText);

  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.timeline, timelineText);
  assert.deepEqual(detail.timelineEntries, parseTimeline(timelineText));
  assert.deepEqual(detail.timelineEntries, [
    { ts: '2026-07-05T00:00:00.000Z', text: 'stage → READY' },
    { ts: null, text: '非法行' },
  ]);
});

// ---- isValidTaskId（AC-018 支撑） ----

test('isValidTaskId：仅接受 task-YYYYMMDD-NNN，拒绝路径穿越等非法输入', () => {
  assert.equal(isValidTaskId('task-20260705-001'), true);
  assert.equal(isValidTaskId('task-2026070-5001'), false);
  assert.equal(isValidTaskId('../../etc/passwd'), false);
  assert.equal(isValidTaskId(''), false);
  assert.equal(isValidTaskId(null), false);
  assert.equal(isValidTaskId(undefined), false);
});

// ---- CLI 结果 → 用户提示转换（AC-013/AC-017 纯函数支撑） ----

test('SYNC_ACTIONS：六个同步动作与 CLI 子命令名逐字一致', () => {
  assert.deepEqual(SYNC_ACTIONS, ['approve', 'approve-setup', 'approve-feasibility', 'reject', 'reject-feasibility', 'retry']);
});

test('buildSyncActionArgv：body.option/notes → argv 数组，缺省不带多余 flag', () => {
  assert.deepEqual(buildSyncActionArgv('approve', 'task-20260705-001', {}), ['approve', 'task-20260705-001']);
  assert.deepEqual(
    buildSyncActionArgv('approve-feasibility', 'task-20260705-001', { option: 'O-B', notes: '备注' }),
    ['approve-feasibility', 'task-20260705-001', '--option', 'O-B', '--notes', '备注'],
  );
  assert.deepEqual(buildSyncActionArgv('reject', 'task-20260705-001', { notes: '' }), ['reject', 'task-20260705-001']);
  assert.deepEqual(buildSyncActionArgv('retry', 'task-20260705-001', undefined), ['retry', 'task-20260705-001']);
});

test('formatCliMessage：成功取 stdout、失败取 stderr，双缺兜底 (no output)', () => {
  assert.equal(formatCliMessage({ exitCode: 0, stdout: '  ok  ', stderr: '' }), 'ok');
  assert.equal(formatCliMessage({ exitCode: 1, stdout: '', stderr: '  boom  ' }), 'boom');
  assert.equal(formatCliMessage({ exitCode: 1, stdout: 'fallback stdout', stderr: '' }), 'fallback stdout');
  assert.equal(formatCliMessage({ exitCode: 0, stdout: '', stderr: '' }), '(no output)');
});

test('parseNewTaskId：解析 conductor new stdout 的 `id: ` 行，无匹配返回 null', () => {
  assert.equal(
    parseNewTaskId('已创建 state/queue/task-20260705-099/（kind=bugfix, stage=READY）\nid: task-20260705-099\n'),
    'task-20260705-099',
  );
  assert.equal(parseNewTaskId('没有 id 行的 stdout'), null);
  assert.equal(parseNewTaskId(undefined), null);
});

test('buildNewTaskArgv：kind=feature 显式传 --feasibility 布尔；bugfix 不传（AC-017）', () => {
  assert.deepEqual(
    buildNewTaskArgv({ kind: 'bugfix', title: 't', briefPath: null, feasibility: undefined }),
    ['new', '--kind', 'bugfix', '--title', 't'],
  );
  assert.deepEqual(
    buildNewTaskArgv({ kind: 'bugfix', title: 't', briefPath: '/tmp/brief.md', feasibility: undefined }),
    ['new', '--kind', 'bugfix', '--title', 't', '--brief', '/tmp/brief.md'],
  );
  assert.deepEqual(
    buildNewTaskArgv({ kind: 'feature', title: 't', briefPath: null, feasibility: true }),
    ['new', '--kind', 'feature', '--title', 't', '--feasibility'],
  );
  assert.deepEqual(
    buildNewTaskArgv({ kind: 'feature', title: 't', briefPath: '/tmp/brief.md', feasibility: false }),
    ['new', '--kind', 'feature', '--title', 't', '--brief', '/tmp/brief.md', '--feasibility', 'false'],
  );
});

// ---- AC-003/AC-004 静态守卫 ----

test('package.json：无 dependencies/devDependencies 字段，dashboard script 就位（AC-003）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal('dependencies' in pkg, false);
  assert.equal('devDependencies' in pkg, false);
  assert.equal(pkg.scripts.dashboard, 'node conductor/dashboard/server.mjs');
});

test('conductor/dashboard/ 全部代码只 import node: 内置模块与本仓库既有模块（AC-003）', () => {
  const dir = path.join(REPO_ROOT, 'conductor', 'dashboard');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'conductor/dashboard/ 应含 .mjs 源文件');
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const specifiers = [...src.matchAll(/^import[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, `${f} 应至少有一条 import`);
    for (const spec of specifiers) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('.'),
        `${f} 引入了非 node:/相对路径依赖：${spec}`,
      );
    }
  }
});

test('index.html：不引用任何外部 URL 资源（AC-004）', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'conductor', 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//i, 'index.html 不应引用任何外部 URL');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'index.html 不应引入外部 script');
  assert.doesNotMatch(html, /<link[^>]+href=/i, 'index.html 不应引入外部 stylesheet/font');
});
