// state.mjs 单测：任务目录（task.json/runtime.json）读写、列举/排序、坏 JSON、
// 旧布局检测、AC 枚举各分支、保留的 ## 段抽取/追加。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  taskDir, readTaskState, saveRuntime, writeNewTask,
  listTaskStates, listTaskDirNames, findLegacyTaskFiles, transitionState,
  extractAcceptanceCriteria, extractSection, appendToSection,
  writeJson, writeFileEnsured, patrolBoxStageConsistency,
} from '../../conductor/lib/state.mjs';

function mkbox(prefix = 'state-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const baseTask = (id = 'task-20260611-001') => ({
  schema_version: 1,
  id,
  kind: 'bugfix',
  title: 'median 偶数分支返回错误',
  repo: 'target',
  targetRepo: '/abs/target',
  baseBranch: 'main',
  testCommand: 'node --test',
  created_at: '2026-06-11T00:00:00.000Z',
});

const baseRuntime = () => ({
  schema_version: 1,
  stage: 'READY',
  maker_miss_count: 0,
  verifier_invalid_count: 0,
  spent_usd: 0,
  approval: null,
  maker_session_id: null,
  current_round: 0,
  last_failure_type: null,
  updated_at: '2026-06-11T00:00:00.000Z',
});

test('writeNewTask + readTaskState：task.json/runtime.json round-trip', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const task = baseTask();
  const runtime = baseRuntime();
  const dir = writeNewTask(box, task, runtime, { specDraft: '# spec\n' });
  assert.equal(dir, taskDir(box, task.id));
  assert.ok(fs.existsSync(path.join(dir, 'spec.md')));

  const ts = readTaskState(dir, 'queue');
  assert.equal(ts.box, 'queue');
  assert.equal(ts.dir, dir);
  assert.equal(ts.id, task.id);
  assert.deepEqual(ts.task, task); // 不可变字段原样
  assert.deepEqual(ts.runtime, runtime);
});

test('writeNewTask 不写 spec.md（无 specDraft）', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const dir = writeNewTask(box, baseTask(), baseRuntime());
  assert.ok(!fs.existsSync(path.join(dir, 'spec.md')));
});

function tmpFilesUnder(dir) {
  const found = [];
  const walk = (cur) => {
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) walk(p);
      if (e.name.includes('.tmp')) found.push(p);
    }
  };
  walk(dir);
  return found;
}

test('atomic writes：任务/runtime/dossier 写入后无 tmp 残留且内容完整', (t) => {
  const root = mkbox('state-atomic-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const box = path.join(root, 'queue');
  const task = baseTask();
  const runtime = baseRuntime();
  const dir = writeNewTask(box, task, runtime, { specDraft: '# spec\n' });

  const ts = readTaskState(dir, 'queue');
  ts.runtime.stage = 'VERIFY';
  saveRuntime(ts);
  writeJson(path.join(root, 'dossier', task.id, 'record.json'), { ok: true });
  writeFileEnsured(path.join(root, 'dossier', task.id, 'note.md'), '# note\n');

  assert.deepEqual(tmpFilesUnder(root), [], 'atomic tmp 文件应在 rename 后清理干净');
  assert.equal(readTaskState(dir, 'queue').runtime.stage, 'VERIFY');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dossier', task.id, 'record.json'), 'utf8')), { ok: true });

  const source = fs.readFileSync(path.join(process.cwd(), 'conductor', 'lib', 'state.mjs'), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\(path\.join\(dir, 'task\.json'\)/, 'writeNewTask 不应直写最终 task.json');
  assert.doesNotMatch(source, /writeFileSync\(path\.join\(dir, 'runtime\.json'\)/, 'writeNewTask 不应直写最终 runtime.json');
});

test('saveRuntime：刷新 updated_at、task.json byte-for-byte 不变', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const task = baseTask();
  const dir = writeNewTask(box, task, baseRuntime());
  const taskBytesBefore = fs.readFileSync(path.join(dir, 'task.json'));

  const ts = readTaskState(dir, 'queue');
  ts.runtime.stage = 'VERIFY';
  ts.runtime.maker_miss_count = 1;
  saveRuntime(ts);

  const again = readTaskState(dir, 'queue');
  assert.equal(again.runtime.stage, 'VERIFY');
  assert.equal(again.runtime.maker_miss_count, 1);
  assert.notEqual(again.runtime.updated_at, '2026-06-11T00:00:00.000Z'); // 已刷新
  // task.json 不可变
  assert.deepEqual(fs.readFileSync(path.join(dir, 'task.json')), taskBytesBefore);
});

test('listTaskStates：仅取合法目录名、排序、坏目录以 error 标注', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  writeNewTask(box, baseTask('task-20260611-002'), baseRuntime());
  writeNewTask(box, baseTask('task-20260611-001'), baseRuntime());
  // 非法目录名（应被忽略）
  fs.mkdirSync(path.join(box, 'not-a-task'), { recursive: true });
  fs.mkdirSync(path.join(box, 'task-bad'), { recursive: true });
  // 普通文件（应被忽略）
  fs.writeFileSync(path.join(box, 'README.md'), '');
  // 坏 JSON 任务目录
  const badDir = path.join(box, 'task-20260611-003');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'task.json'), '{ not json');
  fs.writeFileSync(path.join(badDir, 'runtime.json'), '{}');

  const states = listTaskStates(box, 'queue');
  assert.deepEqual(states.map((s) => s.id), [
    'task-20260611-001', 'task-20260611-002', 'task-20260611-003',
  ]);
  assert.equal(states[0].error, undefined);
  assert.equal(states[1].error, undefined);
  assert.ok(states[2].error); // 坏目录被标注，不抛
  assert.deepEqual(listTaskStates(path.join(box, 'missing'), 'queue'), []);
});

test('readTaskState：缺 task.json / 缺 runtime.json / 坏 JSON 抛错', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  // 缺两文件
  const empty = path.join(box, 'task-20260611-010');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => readTaskState(empty, 'queue'), /task\.json/);
  // 有 task.json 缺 runtime.json
  fs.writeFileSync(path.join(empty, 'task.json'), JSON.stringify(baseTask()));
  assert.throws(() => readTaskState(empty, 'queue'), /runtime\.json/);
  // 坏 task.json
  const bad = path.join(box, 'task-20260611-011');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'task.json'), 'oops');
  fs.writeFileSync(path.join(bad, 'runtime.json'), '{}');
  assert.throws(() => readTaskState(bad, 'queue'), /task\.json/);
});

test('listTaskDirNames：仅合法任务目录名（排序）', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  fs.mkdirSync(path.join(box, 'task-20260611-002'));
  fs.mkdirSync(path.join(box, 'task-20260611-001'));
  fs.mkdirSync(path.join(box, 'task-202606-001')); // 非法
  fs.writeFileSync(path.join(box, 'task-20260611-003.md'), ''); // 文件非目录
  assert.deepEqual(listTaskDirNames(box), ['task-20260611-001', 'task-20260611-002']);
  assert.deepEqual(listTaskDirNames(path.join(box, 'missing')), []);
});

test('findLegacyTaskFiles：旧布局 task-*.md 路径', (t) => {
  const box = mkbox();
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  fs.writeFileSync(path.join(box, 'task-20260611-002.md'), '');
  fs.writeFileSync(path.join(box, 'task-20260611-001.md'), '');
  fs.writeFileSync(path.join(box, 'notes.txt'), '');
  fs.mkdirSync(path.join(box, 'task-20260611-003')); // 新布局目录，不算
  const found = findLegacyTaskFiles(box).map((p) => path.basename(p));
  assert.deepEqual(found, ['task-20260611-001.md', 'task-20260611-002.md']);
  assert.deepEqual(findLegacyTaskFiles(path.join(box, 'missing')), []);
});

test('transitionState：普通转移只改 runtime；FAILED_BOX rename 目录', (t) => {
  const root = mkbox('state-transition-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queueDir = path.join(root, 'state', 'queue');
  const failedDir = path.join(root, 'state', 'failed');
  fs.mkdirSync(queueDir, { recursive: true });
  const cfg = { failedDir, dossierDir: path.join(root, 'dossier') };

  const dir = writeNewTask(queueDir, baseTask(), baseRuntime());
  const ts = readTaskState(dir, 'queue');

  // 普通转移：目录不动
  transitionState(ts, cfg, 'VERIFY', 'green gate pass', { current_round: 1 });
  assert.equal(ts.runtime.stage, 'VERIFY');
  assert.equal(ts.runtime.current_round, 1);
  assert.equal(ts.box, 'queue');
  assert.equal(ts.dir, dir);

  // FAILED_BOX：rename 到 failedDir，更新 ts.dir/ts.box，写 last_failure_type
  transitionState(ts, cfg, 'FAILED_BOX', 'crashed', { last_failure_type: 'crashed' });
  assert.equal(ts.box, 'failed');
  assert.equal(ts.dir, taskDir(failedDir, ts.id));
  assert.ok(fs.existsSync(path.join(failedDir, ts.id, 'runtime.json')));
  assert.ok(!fs.existsSync(dir));
  const moved = readTaskState(ts.dir, 'failed');
  assert.equal(moved.runtime.stage, 'FAILED_BOX');
  assert.equal(moved.runtime.last_failure_type, 'crashed');
  // timeline 落在 dossier
  assert.ok(fs.existsSync(path.join(cfg.dossierDir, ts.id, 'timeline.md')));
});

test('patrolBoxStageConsistency：queue 中 FAILED_BOX/DONE 僵尸补搬到对应 box', (t) => {
  const root = mkbox('state-patrol-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = {
    root,
    queueDir: path.join(root, 'state', 'queue'),
    failedDir: path.join(root, 'state', 'failed'),
    doneDir: path.join(root, 'state', 'done'),
    dossierDir: path.join(root, 'dossier'),
  };
  fs.mkdirSync(cfg.queueDir, { recursive: true });
  writeNewTask(cfg.queueDir, baseTask('task-20260611-021'), { ...baseRuntime(), stage: 'FAILED_BOX' });
  writeNewTask(cfg.queueDir, baseTask('task-20260611-022'), { ...baseRuntime(), stage: 'DONE' });

  const repaired = patrolBoxStageConsistency(cfg);
  assert.deepEqual(repaired.map((r) => [r.id, r.to]), [
    ['task-20260611-021', 'failed'],
    ['task-20260611-022', 'done'],
  ]);
  assert.ok(fs.existsSync(path.join(cfg.failedDir, 'task-20260611-021', 'runtime.json')));
  assert.ok(fs.existsSync(path.join(cfg.doneDir, 'task-20260611-022', 'runtime.json')));
  assert.ok(!fs.existsSync(path.join(cfg.queueDir, 'task-20260611-021')));
});

test('extractAcceptanceCriteria：AC-### 归一、复选框、位置赋号', () => {
  const spec = [
    '# 标题', '',
    '## 验收标准', '',
    '- [ ] AC-1: median 偶数取平均',
    '- [x] AC-002 空数组返回 null',
    '- 普通条目没有 AC 标记',
    '',
    '## 其它', '',
  ].join('\n');
  const acs = extractAcceptanceCriteria(spec);
  assert.deepEqual(acs, [
    { ac_id: 'AC-001', text: 'AC-1: median 偶数取平均' },
    { ac_id: 'AC-002', text: 'AC-002 空数组返回 null' },
    { ac_id: 'AC-003', text: '普通条目没有 AC 标记' }, // 无 AC 标记 → 按位置赋号
  ]);
});

test('extractAcceptanceCriteria：全位置赋号（无 AC 标记）', () => {
  const spec = '## 验收标准\n\n- 第一条\n- 第二条\n';
  assert.deepEqual(extractAcceptanceCriteria(spec), [
    { ac_id: 'AC-001', text: '第一条' },
    { ac_id: 'AC-002', text: '第二条' },
  ]);
});

test('extractAcceptanceCriteria：无段/无条目 → 兜底单条', () => {
  const fallback = [{ ac_id: 'AC-001', text: '满足 spec.md 全部要求且 testCommand 全绿' }];
  assert.deepEqual(extractAcceptanceCriteria('# 没有验收标准段\n\n正文'), fallback);
  assert.deepEqual(extractAcceptanceCriteria('## 验收标准\n\n（空段，无列表项）'), fallback);
  assert.deepEqual(extractAcceptanceCriteria(''), fallback);
  assert.deepEqual(extractAcceptanceCriteria(null), fallback);
});

test('extractSection / appendToSection（保留）', () => {
  const body = '## 标题与证据\n\nbug 描述\n\n## 验收标准\n\n- 全绿\n- 不许 skip\n\n## reject_notes\n';
  assert.equal(extractSection(body, '验收标准'), '- 全绿\n- 不许 skip');
  assert.equal(extractSection(body, '标题与证据'), 'bug 描述');
  assert.equal(extractSection(body, '不存在'), null);

  const appended = appendToSection(body, 'reject_notes', '- 2026-06-11: spec 太含糊');
  assert.match(appended, /## reject_notes\n\n- 2026-06-11: spec 太含糊/);
  const created = appendToSection('## 只有这段\n\nx', '新段', 'hello');
  assert.match(created, /## 新段\n\nhello/);
  const mid = appendToSection(body, '验收标准', '- 追加项');
  assert.match(mid, /- 不许 skip\n\n- 追加项\n\n## reject_notes/);
});
