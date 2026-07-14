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
// parseArgs / view.mjs 用动态 import（每条测试内按需加载），避免这两个本期新增的
// export/文件在改动前基线上不存在时，令整个测试文件顶层加载失败、殃及无关的既有用例。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATIC_DIR = path.join(REPO_ROOT, 'conductor', 'dashboard', 'static');

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

test('SYNC_ACTIONS：五个同步动作与 CLI 子命令名逐字一致，retry 已 job 化不再属同步动作集合（P4-AC-014④）', () => {
  assert.deepEqual(SYNC_ACTIONS, ['approve', 'approve-setup', 'approve-feasibility', 'reject', 'reject-feasibility']);
  assert.equal(SYNC_ACTIONS.includes('retry'), false);
});

test('buildSyncActionArgv：body.option/notes → argv 数组，缺省不带多余 flag', () => {
  assert.deepEqual(buildSyncActionArgv('approve', 'task-20260705-001', {}), ['approve', 'task-20260705-001']);
  assert.deepEqual(
    buildSyncActionArgv('approve-feasibility', 'task-20260705-001', { option: 'O-B', notes: '备注' }),
    ['approve-feasibility', 'task-20260705-001', '--option', 'O-B', '--notes', '备注'],
  );
  assert.deepEqual(buildSyncActionArgv('reject', 'task-20260705-001', { notes: '' }), ['reject', 'task-20260705-001']);
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

test('index.html：不引用任何外部 URL 资源，允许同源 /static/ 引用（AC-020）', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'conductor', 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//i, 'index.html 不应引用任何外部 URL');
  assert.doesNotMatch(html, /(?:src|href)=["']\/\//i, 'index.html 不应引用协议相对外部 URL');
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    assert.match(m[1], /^\/static\//, `<script src> 应指向同源 /static/：${m[1]}`);
  }
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) {
    assert.match(m[1], /^\/static\//, `<link href> 应指向同源 /static/：${m[1]}`);
  }
});

// ---- AC-001：tokens.css 逐字落地 design-language.md §1/§2 全部 token ----

test('tokens.css：逐字声明 design-language §1/§2 全部颜色与字体 token（AC-001）', () => {
  const css = fs.readFileSync(path.join(STATIC_DIR, 'tokens.css'), 'utf8').toLowerCase();
  const expectations = [
    ['--paper', '#faf9f5'], ['--surface', '#ffffff'], ['--ink', '#211f1a'],
    ['--ink-2', '#6b675d'], ['--ink-3', '#a6a196'], ['--line', '#e5e2d9'], ['--line-heavy', '#c9c5b8'],
    ['--live', '#1d4ed8'], ['--live-bg', '#eff4fe'], ['--attn', '#b45309'], ['--attn-bg', '#fdf3e7'],
    ['--pass', '#15803d'], ['--pass-bg', '#ecf6ee'], ['--fail', '#b91c1c'], ['--fail-bg', '#fbefed'],
    ['--unknown', '#7c6f9b'], ['--unknown-bg', '#f3f0f9'],
  ];
  for (const [name, value] of expectations) {
    const re = new RegExp(`${name}\\s*:\\s*${value}\\s*;`);
    assert.match(css, re, `tokens.css 应声明 ${name}: ${value}`);
  }
  for (const name of ['--font-ui', '--font-data', '--t-display', '--t-h1', '--t-h2', '--t-body', '--t-data', '--t-caption']) {
    assert.match(css, new RegExp(`${name}\\s*:`), `tokens.css 应声明 ${name}`);
  }
});

// ---- AC-002：index.html 瘦身为入口壳 ----

test('index.html：瘦身为入口壳，无内联样式/脚本正文，head 通过 /static/ link 引入样式（AC-002）', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'conductor', 'dashboard', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<style[^>]*>[\s\S]*?<\/style>/i, 'index.html 不应再含内联 <style> 规则块');
  const scriptTags = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
  assert.ok(scriptTags.length > 0, 'index.html 应至少引入一个 <script>');
  for (const [tag] of scriptTags) {
    assert.match(tag, /\bsrc=/i, `<script> 必须带 src：${tag}`);
    assert.match(tag, /type=["']module["']/i, `<script> 必须 type="module"：${tag}`);
  }
  const head = html.match(/<head[^>]*>[\s\S]*?<\/head>/i)[0];
  assert.match(head, /<link[^>]+href=["']\/static\/tokens\.css["']/i, 'head 应引入 tokens.css');
  assert.match(head, /<link[^>]+href=["']\/static\/[^"']+\.css["']/i, 'head 应通过 link 引入 static 下样式');
});

// ---- AC-006：parseArgs 导出（不监听端口的纯单测） ----

test('parseArgs：默认端口 4400、--port 覆盖、--port 0、--no-auto-run（AC-006）', async () => {
  const { parseArgs } = await import('../../conductor/dashboard/server.mjs');
  assert.equal(parseArgs([]).port, 4400);
  assert.equal(parseArgs([]).autoRun, true);
  assert.equal(parseArgs(['--port', '4600']).port, 4600);
  assert.equal(parseArgs(['--port', '0']).port, 0);
  assert.equal(parseArgs(['--no-auto-run']).autoRun, false);
  assert.equal(parseArgs(['--unknown-flag']).port, 4400, '未知 flag 应被忽略');
});

// ---- AC-010：static/*.css 全站改用 tokens.css 变量，不再出现 v1 旧变量名 ----

test('static/*.css：不再出现 v1 旧变量名或硬编码等宽标题字体族（AC-010）', () => {
  const legacyVars = ['--bg', '--card-bg', '--shell-bg', '--blue', '--blue-dark', '--red', '--orange', '--orange-bg', '--green'];
  const cssFiles = fs.readdirSync(STATIC_DIR).filter((f) => f.endsWith('.css'));
  assert.ok(cssFiles.length > 0, 'static/ 应含 .css 源文件');
  for (const f of cssFiles) {
    const src = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
    for (const legacy of legacyVars) {
      assert.doesNotMatch(src, new RegExp(`${legacy}[^-a-zA-Z0-9]`), `${f} 不应再出现 v1 旧变量 ${legacy}`);
    }
    assert.doesNotMatch(src, /h1[^{]*\{[^}]*font-family:[^;]*mono/i, `${f} 标题不应硬编码等宽字体族`);
  }
});

// ---- AC-004：闲置泳道塌缩时 .lane-header/.lane-row 必须隐藏，不与 .idle-bar 叠显 ----

test('app.css：.lane.idle 分支隐藏 .lane-header 与 .lane-row，避免与 .idle-bar 叠显（AC-004）', () => {
  const css = fs.readFileSync(path.join(STATIC_DIR, 'app.css'), 'utf8');
  const idleRuleMatch = css.match(/\.lane\.idle\s*\{[^}]*\}/);
  assert.ok(idleRuleMatch, 'app.css 应含 .lane.idle 规则块');
  const afterIdleRule = css.slice(idleRuleMatch.index + idleRuleMatch[0].length);
  const hideRuleMatch = afterIdleRule.match(/^\s*([^{]*\.lane\.idle[^{]*)\{([^}]*)\}/);
  assert.ok(hideRuleMatch, 'app.css 应紧跟 .lane.idle 之后声明隐藏 .lane-header/.lane-row 的规则');
  const [, selector, decl] = hideRuleMatch;
  assert.match(selector, /\.lane\.idle\s+\.lane-header/, '隐藏规则选择器应覆盖 .lane.idle .lane-header');
  assert.match(selector, /\.lane\.idle\s+\.lane-row/, '隐藏规则选择器应覆盖 .lane.idle .lane-row');
  assert.match(decl, /display\s*:\s*none/, '隐藏规则应声明 display: none');
});

// ---- AC-001：抽屉宽度自适应 min(1280px, 90vw)，窄屏 ≤768px 全宽 ----

test('app.css：.drawer 宽度为 min(1280px, 90vw)，且 768px media query 内声明全宽（AC-001）', () => {
  const css = fs.readFileSync(path.join(STATIC_DIR, 'app.css'), 'utf8');
  const drawerRuleMatch = css.match(/\.drawer\s*\{[^}]*\}/);
  assert.ok(drawerRuleMatch, 'app.css 应含 .drawer 规则块');
  assert.match(drawerRuleMatch[0], /width\s*:\s*min\(1280px,\s*90vw\)/, '.drawer 宽度应为 min(1280px, 90vw)');
  const mediaMatch = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([^}]*\.drawer[^}]*\{[^}]*\})/);
  assert.ok(mediaMatch, 'app.css 应含 768px media query 内针对 .drawer 的规则');
  assert.match(mediaMatch[1], /width\s*:\s*100vw/, '768px media query 内 .drawer 宽度应为 100vw');
});

// ---- AC-002：抽屉遮罩背景色改为 rgba(33, 31, 26, 0.5) ----

test('app.css：.overlay.open 背景色为 rgba(33, 31, 26, 0.5)（AC-002）', () => {
  const css = fs.readFileSync(path.join(STATIC_DIR, 'app.css'), 'utf8');
  const overlayOpenMatch = css.match(/\.overlay\.open\s*\{[^}]*\}/);
  assert.ok(overlayOpenMatch, 'app.css 应含 .overlay.open 规则块');
  assert.match(overlayOpenMatch[0], /background\s*:\s*rgba\(\s*33\s*,\s*31\s*,\s*26\s*,\s*\.?5\s*\)/, '.overlay.open 背景色应为 rgba(33, 31, 26, 0.5)');
});

// ---- AC-020：static/*.mjs 仅相对导入（不要求至少一条 import） ----

test('conductor/dashboard/static/*.mjs：仅相对导入，无 npm/外链 specifier（AC-020）', () => {
  if (!fs.existsSync(STATIC_DIR)) return; // 本期新增目录，改动前基线上不存在，视为不适用
  const files = fs.readdirSync(STATIC_DIR).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'static/ 应含 .mjs 源文件');
  for (const f of files) {
    const src = fs.readFileSync(path.join(STATIC_DIR, f), 'utf8');
    const specifiers = [...src.matchAll(/^import[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(spec.startsWith('.'), `${f} 引入了非相对路径依赖：${spec}`);
      assert.ok(!spec.startsWith('node:'), `${f} 是浏览器安全模块，不应 import node: 内置模块：${spec}`);
    }
  }
});

// ---- AC-019：前端轮询周期恒 1.5s ----

test('static/ 入口模块：以 1500ms 周期调用看板刷新（AC-019）', () => {
  const entryPath = path.join(STATIC_DIR, 'app.mjs');
  if (!fs.existsSync(entryPath)) return; // 本期新增文件，改动前基线上不存在，视为不适用
  const src = fs.readFileSync(entryPath, 'utf8');
  assert.match(src, /setInterval\(\s*loadBoard\s*,\s*1500\s*\)/, '入口模块应以 1500ms 周期调用看板刷新');
});

// ---- AC-012：view.mjs 浏览器安全纯模块 ----

test('view.mjs：GAUGE_LANES 与 model.LANE_ORDER 深等，且自身不 import node:/model.mjs（AC-012）', async () => {
  const { GAUGE_LANES } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(GAUGE_LANES, LANE_ORDER);
  const src = fs.readFileSync(path.join(STATIC_DIR, 'view.mjs'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:/, 'view.mjs 不应 import node: 内置模块');
  assert.doesNotMatch(src, /from\s+['"][^'"]*model\.mjs['"]/, 'view.mjs 不应 import model.mjs');
});

test('summarizeBoard：queue 为各泳道任务数之和，done/failed 为数组长度，doneSpentUsd 为 done 项 spentUsd 之和（AC-012）', async () => {
  const { summarizeBoard } = await import('../../conductor/dashboard/static/view.mjs');
  const board = {
    lanes: [
      { lane: 'setup', tasks: [{ id: 'a' }] },
      { lane: 'maker', tasks: [{ id: 'b' }, { id: 'c' }] },
    ],
    done: [{ id: 'd1', spentUsd: 1.5 }, { id: 'd2', spentUsd: 2.25 }],
    failed: [{ id: 'f1' }],
  };
  assert.deepEqual(summarizeBoard(board), { queue: 3, done: 2, failed: 1, doneSpentUsd: 3.75 });
});

test('summarizeBoard：空 board 各项为 0（AC-012）', async () => {
  const { summarizeBoard } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(
    summarizeBoard({ lanes: LANE_ORDER.map((lane) => ({ lane, tasks: [] })), done: [], failed: [] }),
    { queue: 0, done: 0, failed: 0, doneSpentUsd: 0 },
  );
});

// ---- AC-014：gaugeSegments 六段状态数组 ----

test('gaugeSegments：done 全 pass，failed 全 fail（AC-014）', async () => {
  const { gaugeSegments } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(gaugeSegments({ box: 'done', lane: null, needsHuman: false }), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(gaugeSegments({ box: 'failed', lane: null, needsHuman: false }), ['fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
});

test('gaugeSegments：queue 按序位划分 passed/current(live|attn)/future（AC-014）', async () => {
  const { gaugeSegments } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(
    gaugeSegments({ box: 'queue', lane: 'maker', needsHuman: false }),
    ['passed', 'passed', 'passed', 'live', 'future', 'future'],
  );
  assert.deepEqual(
    gaugeSegments({ box: 'queue', lane: 'spec', needsHuman: true }),
    ['passed', 'passed', 'attn', 'future', 'future', 'future'],
  );
  assert.deepEqual(
    gaugeSegments({ box: 'queue', lane: 'setup', needsHuman: false }),
    ['live', 'future', 'future', 'future', 'future', 'future'],
  );
});

test('gaugeSegments：queue 且 lane===null（残留项）六段全 future，不抛错（AC-014）', async () => {
  const { gaugeSegments } = await import('../../conductor/dashboard/static/view.mjs');
  assert.doesNotThrow(() => gaugeSegments({ box: 'queue', lane: null, needsHuman: false }));
  assert.deepEqual(
    gaugeSegments({ box: 'queue', lane: null, needsHuman: false }),
    ['future', 'future', 'future', 'future', 'future', 'future'],
  );
});

// ==== P2：人审信息密度 ====================================================

// ---- AC-004：view.mjs escapeHtml 纯函数 ----

test('escapeHtml：转义 <>&"\' 五个 HTML 敏感字符，<script> 不产生裸标签（AC-004）', async () => {
  const { escapeHtml } = await import('../../conductor/dashboard/static/view.mjs');
  assert.equal(escapeHtml(`<script>alert('x&y')</script>`), '&lt;script&gt;alert(&#39;x&amp;y&#39;)&lt;/script&gt;');
  assert.equal(escapeHtml('a "quoted" & <tag>'), 'a &quot;quoted&quot; &amp; &lt;tag&gt;');
  assert.doesNotMatch(escapeHtml('<script>evil()</script>'), /<script>/);
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

// ---- AC-006：view.mjs verdictChip 纯函数 ----

test('verdictChip：pass/fail/unknown 分别产出符号 + 状态类名 + 文字标签（AC-006）', async () => {
  const { verdictChip } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(verdictChip('pass'), { symbol: '✓', className: 'chip-pass', label: 'pass' });
  assert.deepEqual(verdictChip('fail'), { symbol: '✗', className: 'chip-fail', label: 'fail' });
  assert.deepEqual(verdictChip('unknown'), { symbol: '?', className: 'chip-unknown', label: 'unknown' });
  for (const status of ['pass', 'fail', 'unknown']) {
    const chip = verdictChip(status);
    assert.ok(chip.symbol && chip.className && chip.label, `${status} chip 应同时携带符号/类名/文字标签`);
  }
});

// ---- AC-005/007/009：merge review.verdict —— 最新轮 = 最大 N，逐条对应磁盘 criteria_results ----

function writeVerdict(dossierDir, round, overallAndCriteria) {
  fs.mkdirSync(dossierDir, { recursive: true });
  fs.writeFileSync(
    path.join(dossierDir, `verify-r${round}.verdict.json`),
    JSON.stringify({ schema_version: 1, round, ...overallAndCriteria }),
  );
}

function writeVerifyReport(dossierDir, round, text) {
  fs.writeFileSync(path.join(dossierDir, `verify-r${round}.md`), text);
}

test('buildTaskDetail：AWAIT_HUMAN_MERGE 的 review.verdict 取最新轮（最大 N），逐条对应磁盘 criteria_results（AC-005）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260705-050';
  writeNewTask(cfg.queueDir, baseTask(id), baseRuntime('AWAIT_HUMAN_MERGE'));

  const dossierDir = path.join(cfg.dossierDir, id);
  const criteriaR1 = [{ ac_id: 'AC-001', status: 'fail', reason: 'r1 失败', evidence: [{ type: 'code', file: 'lib/a.mjs', summary: 'r1 依据', start_line: 1, end_line: 2 }] }];
  const criteriaR2 = [{ ac_id: 'AC-001', status: 'pass', reason: 'r2 通过', evidence: [{ type: 'code', file: 'lib/a.mjs', summary: 'r2 依据', start_line: 3, end_line: 4 }] }];
  writeVerdict(dossierDir, 1, { overall: 'fail', criteria_results: criteriaR1, non_ac_findings: [] });
  writeVerifyReport(dossierDir, 1, '# verify r1 报告\n');
  writeVerdict(dossierDir, 2, { overall: 'pass', criteria_results: criteriaR2, non_ac_findings: [] });
  writeVerifyReport(dossierDir, 2, '# verify r2 报告\n');

  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.review.kind, 'merge');
  assert.equal(detail.review.verdict.round, 2);
  assert.equal(detail.review.verdict.overall, 'pass');
  assert.deepEqual(detail.review.verdict.criteria, [
    { ac_id: 'AC-001', status: 'pass', reason: 'r2 通过', evidence: [{ file: 'lib/a.mjs', start_line: 3, end_line: 4, type: 'code', summary: 'r2 依据' }] },
  ]);
  assert.equal(detail.review.verdict.reportMarkdown, '# verify r2 报告\n');
});

test('buildTaskDetail：verify verdict 文件缺失 → { missing:true }；JSON 损坏 → { corrupt:true }，均不抛错、详情正常返回（AC-007）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  const missingId = 'task-20260705-051';
  writeNewTask(cfg.queueDir, baseTask(missingId), baseRuntime('AWAIT_HUMAN_MERGE'));
  const missingDetail = buildTaskDetail(cfg, missingId);
  assert.deepEqual(missingDetail.review.verdict, { missing: true });

  const corruptId = 'task-20260705-052';
  writeNewTask(cfg.queueDir, baseTask(corruptId), baseRuntime('AWAIT_HUMAN_MERGE'));
  const dossierDir = path.join(cfg.dossierDir, corruptId);
  fs.mkdirSync(dossierDir, { recursive: true });
  fs.writeFileSync(path.join(dossierDir, 'verify-r1.verdict.json'), '{not json');
  assert.doesNotThrow(() => buildTaskDetail(cfg, corruptId));
  const corruptDetail = buildTaskDetail(cfg, corruptId);
  assert.deepEqual(corruptDetail.review.verdict, { corrupt: true });
  assert.ok(corruptDetail.review.kind, 'corrupt verdict 不应使整个详情为空');
});

// ---- AC-008：spec review.specVerify —— 最新轮 spec-verify-r<N>.verdict.json，缺失时 markdown 仍保留 ----

test('buildTaskDetail：AWAIT_SPEC_APPROVAL 的 review.specVerify 对应最新轮 spec-verify-r<N>.verdict.json（AC-008）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);
  const id = 'task-20260705-053';
  writeNewTask(cfg.queueDir, baseTask(id, { kind: 'feature' }), baseRuntime('AWAIT_SPEC_APPROVAL'));
  fs.mkdirSync(cfg.specsDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.specsDir, `${id}.md`), '# spec 草稿\n\n## 验收标准\n\n- AC-001 …\n');

  const dossierDir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dossierDir, { recursive: true });
  fs.writeFileSync(path.join(dossierDir, 'spec-verify-r1.verdict.json'), JSON.stringify({
    schema_version: 1, round: 1, overall: 'fail', summary: 'r1 摘要',
    human_report: 'r1 人读', spec_agent_feedback: 'r1 spec-agent 反馈',
    findings: [{ severity: 'major', audience: 'both', issue: 'AC 太模糊', recommendation: '改写为可测量的表述' }],
  }));
  fs.writeFileSync(path.join(dossierDir, 'spec-verify-r1.md'), '# spec-verify r1 报告\n');
  fs.writeFileSync(path.join(dossierDir, 'spec-verify-r2.verdict.json'), JSON.stringify({
    schema_version: 1, round: 2, overall: 'pass', summary: 'r2 摘要',
    human_report: 'r2 人读', spec_agent_feedback: 'r2 spec-agent 反馈', findings: [],
  }));
  fs.writeFileSync(path.join(dossierDir, 'spec-verify-r2.md'), '# spec-verify r2 报告\n');

  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.review.kind, 'spec');
  assert.match(detail.review.markdown, /AC-001/, 'spec 原文 markdown 仍保留');
  assert.equal(detail.review.specVerify.round, 2);
  assert.equal(detail.review.specVerify.overall, 'pass');
  assert.deepEqual(detail.review.specVerify.findings, []);
  assert.equal(detail.review.specVerify.reportMarkdown, '# spec-verify r2 报告\n');

  const missingId = 'task-20260705-054';
  writeNewTask(cfg.queueDir, baseTask(missingId, { kind: 'feature' }), baseRuntime('AWAIT_SPEC_APPROVAL'));
  fs.writeFileSync(path.join(cfg.specsDir, `${missingId}.md`), '# spec 草稿（无机器审）\n');
  const missingDetail = buildTaskDetail(cfg, missingId);
  assert.deepEqual(missingDetail.review.specVerify, { missing: true });
  assert.match(missingDetail.review.markdown, /无机器审/);
});

// ---- AC-009：done/failed 的 review 携带最新轮 verify verdict 面板，无 verifier 轮（probe）时 missing ----

test('buildTaskDetail：done/failed 任务 review.verdict 携带最新轮 verify verdict；无 verifier 轮时 missing（AC-009）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  const doneId = 'task-20260705-055';
  writeNewTask(cfg.doneDir, baseTask(doneId), baseRuntime('DONE'));
  const doneDossier = path.join(cfg.dossierDir, doneId);
  writeVerdict(doneDossier, 1, {
    overall: 'pass',
    criteria_results: [{ ac_id: 'AC-001', status: 'pass', reason: '通过', evidence: [{ type: 'code', file: 'lib/a.mjs', summary: '依据', start_line: 1, end_line: 1 }] }],
    non_ac_findings: [],
  });
  writeVerifyReport(doneDossier, 1, '# done 任务 verify 报告\n');
  const doneDetail = buildTaskDetail(cfg, doneId);
  assert.equal(doneDetail.review.kind, 'done');
  assert.equal(doneDetail.review.verdict.round, 1);
  assert.equal(doneDetail.review.verdict.overall, 'pass');

  const failedId = 'task-20260705-056';
  writeNewTask(cfg.failedDir, baseTask(failedId), baseRuntime('FAILED_BOX', { last_failure_type: 'verifier_invalid_exhausted' }));
  const failedDossier = path.join(cfg.dossierDir, failedId);
  writeVerdict(failedDossier, 1, {
    overall: 'fail',
    criteria_results: [{ ac_id: 'AC-001', status: 'fail', reason: '未通过', evidence: [{ type: 'code', file: 'lib/a.mjs', summary: '依据', start_line: 1, end_line: 1 }] }],
    non_ac_findings: [],
  });
  const failedDetail = buildTaskDetail(cfg, failedId);
  assert.equal(failedDetail.review.kind, 'failed');
  assert.equal(failedDetail.review.lastFailureType, 'verifier_invalid_exhausted');
  assert.equal(failedDetail.review.verdict.overall, 'fail');

  // probe 任务：无任何 verify-r<n>.verdict.json → missing，不抛错。
  const probeId = 'task-20260705-057';
  writeNewTask(cfg.doneDir, baseTask(probeId), baseRuntime('DONE'));
  const probeDetail = buildTaskDetail(cfg, probeId);
  assert.deepEqual(probeDetail.review.verdict, { missing: true });
});

// ---- P3-AC-001：看板卡片/箱行键盘可达 + openDrawer 用 currentTarget（而非 document.activeElement）记焦点 ----

test('app.mjs：卡片与箱行可键盘聚焦并用 Enter 打开抽屉，openDrawer 用 currentTarget 记触发元素（AC-001）', () => {
  const src = fs.readFileSync(path.join(STATIC_DIR, 'app.mjs'), 'utf8');

  const cardFn = src.match(/function buildCardNode\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(cardFn, 'app.mjs 应含 buildCardNode 函数');
  assert.match(cardFn[0], /tabindex:\s*['"]0['"]/, 'card 应带 tabindex，可获得键盘焦点');
  assert.match(cardFn[0], /onkeydown:[\s\S]*?e\.key\s*(===|!==)\s*['"]Enter['"][\s\S]*?openDrawer\(/, 'card 应在 keydown Enter 时打开抽屉');
  assert.match(cardFn[0], /onclick:\s*\(e\)\s*=>\s*openDrawer\(entry\.id,\s*e\.currentTarget\)/, 'card 点击应把 e.currentTarget 传给 openDrawer');

  const boxRowFn = src.match(/function renderBoxList\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(boxRowFn, 'app.mjs 应含 renderBoxList 函数');
  assert.match(boxRowFn[0], /tabindex:\s*['"]0['"]/, 'box-row 应带 tabindex，可获得键盘焦点');
  assert.match(boxRowFn[0], /onkeydown:[\s\S]*?e\.key\s*(===|!==)\s*['"]Enter['"][\s\S]*?openDrawer\(/, 'box-row 应在 keydown Enter 时打开抽屉');
  assert.match(boxRowFn[0], /onclick:\s*\(e\)\s*=>\s*openDrawer\(entry\.id,\s*e\.currentTarget\)/, 'box-row 点击应把 e.currentTarget 传给 openDrawer');

  assert.doesNotMatch(src, /document\.activeElement/, 'openDrawer 不应再依据 document.activeElement 记录触发元素');
  const openDrawerFn = src.match(/async function openDrawer\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(openDrawerFn, 'app.mjs 应含 openDrawer 函数');
  assert.match(openDrawerFn[0], /async function openDrawer\s*\(id,\s*triggerEl\)/, 'openDrawer 应接收调用方传入的触发元素参数');
  assert.match(openDrawerFn[0], /drawerTriggerEl\s*=\s*triggerEl/, 'openDrawer 应把入参 triggerEl 记为 drawerTriggerEl');

  assert.match(src, /drawerTriggerEl\.focus\(\)/, '关闭抽屉时应把焦点还原到 drawerTriggerEl');
});

// ---- P3-AC-003：refreshDrawer 里 lastDetail 的写入带 drawerTaskId===id 一致性守卫 ----

test('app.mjs：refreshDrawer 中 lastDetail 写入受 drawerTaskId===id 守卫，与 lastDiff/渲染同口径（AC-003）', () => {
  const src = fs.readFileSync(path.join(STATIC_DIR, 'app.mjs'), 'utf8');
  const fnMatch = src.match(/async function refreshDrawer\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'app.mjs 应含 refreshDrawer 函数');
  const body = fnMatch[0];

  const guardedAssign = /if\s*\(\s*drawerTaskId\s*!==\s*id\s*\)\s*return;\s*\n\s*lastDetail\s*=/.test(body)
    || /if\s*\(\s*drawerTaskId\s*===\s*id\s*\)\s*\{\s*\n?\s*lastDetail\s*=/.test(body);
  assert.ok(guardedAssign, 'lastDetail 的写入应处于 drawerTaskId===id 一致性守卫之下（旧任务的迟到响应不应覆盖新任务详情）');
  assert.match(body, /if\s*\(\s*drawerTaskId\s*===\s*id\s*\)\s*lastDiff\s*=/, 'lastDiff 写入应保留既有 drawerTaskId===id 守卫');
  assert.match(body, /if\s*\(\s*drawerTaskId\s*===\s*id\s*\)\s*renderDrawerFromCache\(\)/, '渲染调用应保留既有 drawerTaskId===id 守卫');
});

// ==== P3：轮次证据链——view.mjs 纯计算 helper ================================

// ---- AC-009：timeline 按轮次分组 ----

test('groupTimelineByRound：以「maker r<N> spawn 」文本行为轮次边界分组，组头为轮号（AC-009）', async () => {
  const { groupTimelineByRound } = await import('../../conductor/dashboard/static/view.mjs');
  const entries = [
    { ts: '2026-07-13T00:00:00.000Z', text: 'stage → READY' },
    { ts: '2026-07-13T00:01:00.000Z', text: 'maker r1 spawn (cold)' },
    { ts: '2026-07-13T00:02:00.000Z', text: 'green gate r1: exit 1' },
    { ts: '2026-07-13T00:03:00.000Z', text: 'maker r2 spawn (fix)' },
    { ts: '2026-07-13T00:04:00.000Z', text: 'green gate r2: exit 0' },
  ];
  const groups = groupTimelineByRound(entries);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].round, null);
  assert.deepEqual(groups[0].entries, [entries[0]]);
  assert.equal(groups[1].round, 1);
  assert.deepEqual(groups[1].entries, [entries[1], entries[2]]);
  assert.equal(groups[2].round, 2);
  assert.deepEqual(groups[2].entries, [entries[3], entries[4]]);
});

test('groupTimelineByRound：空输入返回空数组，无轮次标记时整体归入 round:null 一组（AC-009）', async () => {
  const { groupTimelineByRound } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(groupTimelineByRound([]), []);
  assert.deepEqual(groupTimelineByRound(undefined), []);
  const noMarker = [{ ts: null, text: '不含轮次标记' }];
  const groups = groupTimelineByRound(noMarker);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].round, null);
  assert.deepEqual(groups[0].entries, noMarker);
});

// ---- AC-010：回路刻度轮次刻度三态 ----

function okVerifier(overall) { return { status: 'ok', overall }; }
function okTestGate(verdict) { return { status: 'ok', verdict }; }

test('roundGaugeTicks：verifier pass/fail 与 testGate vacuous 三态映射（AC-010）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  const passRound = [{ round: 1, verifier: okVerifier('pass'), testGate: { status: 'absent' } }];
  assert.deepEqual(roundGaugeTicks(passRound, 'done'), [{ round: 1, state: 'pass' }]);

  const failRound = [{ round: 1, verifier: okVerifier('fail'), testGate: { status: 'absent' } }];
  assert.deepEqual(roundGaugeTicks(failRound, 'active'), [{ round: 1, state: 'fail' }]);

  const vacuousRound = [{ round: 1, verifier: { status: 'absent' }, testGate: okTestGate('vacuous') }];
  assert.deepEqual(roundGaugeTicks(vacuousRound, 'active'), [{ round: 1, state: 'fail' }]);
});

test('roundGaugeTicks：边界条——box=failed 且最后一轮无 verifier → fail；box=active 且最新轮无终局门结果 → pending（AC-010）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  const noFinalGate = [{ round: 1, verifier: { status: 'absent' }, testGate: { status: 'absent' } }];

  assert.deepEqual(roundGaugeTicks(noFinalGate, 'failed'), [{ round: 1, state: 'fail' }]);
  assert.deepEqual(roundGaugeTicks(noFinalGate, 'active'), [{ round: 1, state: 'pending' }]);
});

test('roundGaugeTicks：空 rounds 返回空数组（AC-010）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  assert.deepEqual(roundGaugeTicks([], 'active'), []);
});

// ---- P4-AC-012：fail/unknown 语义修正——非确定打回证据一律 unknown，仅失败末轮优先判 fail ----

test('roundGaugeTicks：失败末轮即便门数据损坏，仍优先命中子句④判 fail，不落 unknown（P4-AC-012）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  const corruptLastRound = [{ round: 1, verifier: { status: 'corrupt' }, testGate: { status: 'corrupt' } }];
  assert.deepEqual(roundGaugeTicks(corruptLastRound, 'failed'), [{ round: 1, state: 'fail' }]);
});

test('roundGaugeTicks：非失败末轮的门数据损坏归 unknown（P4-AC-012）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  const corruptDoneRound = [{ round: 1, verifier: { status: 'corrupt' }, testGate: { status: 'corrupt' } }];
  assert.deepEqual(roundGaugeTicks(corruptDoneRound, 'done'), [{ round: 1, state: 'unknown' }]);

  const corruptActiveNonLast = [
    { round: 1, verifier: { status: 'corrupt' }, testGate: { status: 'absent' } },
    { round: 2, verifier: okVerifier('pass'), testGate: { status: 'absent' } },
  ];
  assert.deepEqual(
    roundGaugeTicks(corruptActiveNonLast, 'active'),
    [{ round: 1, state: 'unknown' }, { round: 2, state: 'pass' }],
  );
});

test('roundGaugeTicks：非末轮门数据缺失、done 末轮门数据缺失均归 unknown（P4-AC-012）', async () => {
  const { roundGaugeTicks } = await import('../../conductor/dashboard/static/view.mjs');
  const missingNonLast = [
    { round: 1, verifier: { status: 'absent' }, testGate: { status: 'absent' } },
    { round: 2, verifier: okVerifier('pass'), testGate: { status: 'absent' } },
  ];
  assert.deepEqual(
    roundGaugeTicks(missingNonLast, 'active'),
    [{ round: 1, state: 'unknown' }, { round: 2, state: 'pass' }],
  );

  const missingDoneLast = [{ round: 1, verifier: { status: 'absent' }, testGate: { status: 'absent' } }];
  assert.deepEqual(roundGaugeTicks(missingDoneLast, 'done'), [{ round: 1, state: 'unknown' }]);
});

// ---- AC-011：closeDrawer 焦点回退决策表 ----

test('resolveDrawerFocusTarget：在文档→触发元素；脱离且查得卡片→卡片；均无→容器，恒非 null（AC-011）', async () => {
  const { resolveDrawerFocusTarget } = await import('../../conductor/dashboard/static/view.mjs');
  const trigger = { tag: 'trigger' };
  const card = { tag: 'card' };
  const container = { tag: 'container' };

  assert.equal(resolveDrawerFocusTarget(true, trigger, card, container), trigger);
  assert.equal(resolveDrawerFocusTarget(true, trigger, null, container), trigger);
  assert.equal(resolveDrawerFocusTarget(false, trigger, card, container), card);
  const fallback = resolveDrawerFocusTarget(false, trigger, null, container);
  assert.equal(fallback, container);
  assert.notEqual(fallback, null);
});

// ---- AC-011：app.mjs closeDrawer 接线——脱离文档时走 resolveDrawerFocusTarget 回退，不静默丢焦点到 body ----

test('app.mjs：closeDrawer 对脱离文档的触发元素用 resolveDrawerFocusTarget 回退（AC-011）', () => {
  const src = fs.readFileSync(path.join(STATIC_DIR, 'app.mjs'), 'utf8');
  assert.match(src, /from\s+['"]\.\/view\.mjs['"][\s\S]*?resolveDrawerFocusTarget/, 'app.mjs 应从 view.mjs 引入 resolveDrawerFocusTarget');
  const closeDrawerFn = src.match(/function closeDrawer\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(closeDrawerFn, 'app.mjs 应含 closeDrawer 函数');
  assert.match(closeDrawerFn[0], /document\.contains\(drawerTriggerEl\)/, 'closeDrawer 应检测触发元素是否仍在文档中');
  assert.match(closeDrawerFn[0], /resolveDrawerFocusTarget\(/, 'closeDrawer 脱离文档分支应调用 resolveDrawerFocusTarget');
  assert.match(closeDrawerFn[0], /drawerTriggerEl\.focus\(\)/, '在文档分支仍应保留 drawerTriggerEl.focus() 直接聚焦');
});

// ---- AC-012：buildTaskDiff 的三处 git diff 显式携带 -M，rename 检测不依赖仓库 diff.renames 默认值 ----

test('buildTaskDiff：diff.renames=false 的仓库中 rename 仍被识别为 R（AC-012）', async (t) => {
  const { buildTaskDiff } = await import('../../conductor/dashboard/model.mjs');
  const { execFileSync } = await import('node:child_process');

  const root = mkroot('dashboard-diff-rename-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  const targetRepo = cfg.targetRepo;
  fs.mkdirSync(targetRepo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', targetRepo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'diff.renames', 'false');
  const original = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
  fs.writeFileSync(path.join(targetRepo, 'orig.txt'), `${original}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const id = 'task-20260713-910';
  git('checkout', '-q', '-b', `task/${id}`);
  git('mv', 'orig.txt', 'renamed.txt');
  fs.appendFileSync(path.join(targetRepo, 'renamed.txt'), 'one more line\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'rename');
  git('checkout', '-q', 'main');

  writeNewTask(cfg.queueDir, baseTask(id, { targetRepo, baseBranch: 'main' }), baseRuntime('AWAIT_HUMAN_MERGE'));

  const diff = buildTaskDiff(cfg, id);
  assert.equal(diff.cleaned, false);
  const renamed = diff.files.find((f) => f.path === 'renamed.txt');
  assert.ok(renamed, 'renamed.txt 应出现在 files 中');
  assert.match(renamed.status, /^R/, 'diff.renames=false 时仍应因显式 -M 识别为 rename');
  assert.match(renamed.patch, /rename from orig\.txt/);
  assert.match(renamed.patch, /rename to renamed\.txt/);
});

// ==== P4-AC-004：实时活动面——model 层活跃 agent 扫描 ============================

test('listActiveSpawns：按 stream.jsonl mtime 新鲜度判活跃，超阈值/已 done/dossier 缺失/记录损坏均不产出条目（P4-AC-004）', async (t) => {
  const { listActiveSpawns, ACTIVITY_FRESHNESS_MS } = await import('../../conductor/dashboard/model.mjs');
  const root = mkroot('dashboard-activity-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  ensureDirs(cfg);

  function spawnFixture(id, { started = '2026-07-13T00:00:00.000Z', done = false, mtimeAgoMs, writeStream = true, corrupt = false } = {}) {
    writeNewTask(cfg.queueDir, baseTask(id), baseRuntime('READY'));
    const dir = path.join(cfg.dossierDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'maker-r1.json'),
      corrupt ? '{not json' : JSON.stringify({ role: 'maker', round: 1, started, done }),
    );
    if (writeStream) {
      const streamPath = path.join(dir, 'maker-r1.stream.jsonl');
      fs.writeFileSync(streamPath, '{}\n');
      if (mtimeAgoMs != null) {
        const t2 = (Date.now() - mtimeAgoMs) / 1000;
        fs.utimesSync(streamPath, t2, t2);
      }
    }
  }

  spawnFixture('task-20260713-701', { mtimeAgoMs: 1000 }); // 活跃：阈值内
  spawnFixture('task-20260713-702', { mtimeAgoMs: ACTIVITY_FRESHNESS_MS + 5000 }); // 超阈值
  spawnFixture('task-20260713-703', { done: true, mtimeAgoMs: 1000 }); // 已 done：不算活跃
  writeNewTask(cfg.queueDir, baseTask('task-20260713-704'), baseRuntime('READY')); // dossier 缺失
  spawnFixture('task-20260713-705', { corrupt: true, mtimeAgoMs: 1000 }); // 记录损坏
  spawnFixture('task-20260713-706', { mtimeAgoMs: 1000, writeStream: false }); // stream 文件缺失

  const active = listActiveSpawns(cfg);
  assert.deepEqual(active.map((a) => a.taskId), ['task-20260713-701']);
  const entry = active[0];
  assert.equal(entry.role, 'maker');
  assert.equal(entry.round, 1);
  assert.equal(new Date(entry.lastActivity).toISOString(), entry.lastActivity, 'lastActivity 应为 ISO 字符串');
});

// ==== P4-AC-006/007：stream tail 定长尾窗只读 + rename 重开语义 ============================

test('readStreamTail：只读尾部窗口丢弃窗口外内容，覆盖 assistant 文本增量与工具调用名两类（P4-AC-006）', async (t) => {
  const { readStreamTail, STREAM_TAIL_MAX_BYTES } = await import('../../conductor/dashboard/model.mjs');
  const root = mkroot('dashboard-streamtail-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'maker-r1.stream.jsonl');

  const oldLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '这是窗口外的旧内容标记ZZZ' }] } });
  const padding = 'x'.repeat(STREAM_TAIL_MAX_BYTES + 4096);
  const paddingLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: padding }] } });
  const textLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '窗口内的文本增量' }] } });
  const toolLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
  fs.writeFileSync(filePath, `${[oldLine, paddingLine, textLine, toolLine].join('\n')}\n`);

  const lines = readStreamTail(filePath);
  assert.ok(!lines.some((l) => l.includes('ZZZ')), '窗口外内容不应出现在尾窗解析结果中');
  assert.ok(lines.includes('窗口内的文本增量'), '应覆盖 assistant 文本增量');
  assert.ok(lines.includes('[tool] Bash'), '应覆盖工具调用名');
});

test('readStreamTail：文件缺失/为空均返回空数组，不抛错（P4-AC-006）', async (t) => {
  const { readStreamTail } = await import('../../conductor/dashboard/model.mjs');
  assert.deepEqual(readStreamTail('/no/such/dir/none.stream.jsonl'), []);
  const root = mkroot('dashboard-streamtail-empty-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'empty.stream.jsonl');
  fs.writeFileSync(filePath, '');
  assert.deepEqual(readStreamTail(filePath), []);
});

test('readStreamTail：原子 rename 替换后按路径重开读到新文件内容，不因旧句柄读到过期内容（P4-AC-007）', async (t) => {
  const { readStreamTail } = await import('../../conductor/dashboard/model.mjs');
  const root = mkroot('dashboard-streamtail-rename-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'maker-r1.stream.jsonl');
  const tmpPath = path.join(root, 'maker-r1.stream.jsonl.tmp');

  const oldLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '旧文件内容' }] } });
  fs.writeFileSync(filePath, `${oldLine}\n`);
  assert.ok(readStreamTail(filePath).includes('旧文件内容'));

  const newLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '新文件内容' }] } });
  fs.writeFileSync(tmpPath, `${newLine}\n`);
  fs.renameSync(tmpPath, filePath);

  const lines = readStreamTail(filePath);
  assert.ok(lines.includes('新文件内容'), 'rename 后应读到新文件内容');
  assert.ok(!lines.includes('旧文件内容'), 'rename 后不应因持有旧 inode/句柄读到过期内容');
});
