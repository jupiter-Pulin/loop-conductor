// 单元：router 的可恢复工作记忆（conductor/lib/router-notes.mjs）。
// router 每轮都是冷启动的新会话，跨轮能带走的只有这份文件，所以内核对它只做三件机械的事，
// 每一件坏掉都有明确后果：
//   ①facts 必须带 source —— 没有出处的推测一旦混进 facts，router 下一轮就会把自己的幻觉
//     当成既定事实继续推理（内核不核对出处真假，但「说不清来源」这一条必须拦住）；
//   ②逐轮留快照 —— 被改写、被压缩掉的内容要找得回来，否则记忆是一条单向销毁的通道；
//   ③写坏了还原上一份合格快照，坏的那份另存 r<n>.invalid.json —— 静默丢掉 router 自己的记忆
//     比留下一个不合格文件严重得多，所以坏字节必须原样留在盘上。
// 注意：未完成的委派、未判完的 AC、人的裁决都不靠这份记忆（内核每轮从案卷重渲染），
// 所以记忆不合格只是「这轮更新没生效」，绝不等于 router 失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateNotesText, settleNotes, readNotesForPrompt, NOTES_SCHEMA, NOTES_MAX_BYTES,
} from '../../conductor/lib/router-notes.mjs';

function makeDossier(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, notesPath: path.join(dir, 'router-notes.json'), snapDir: path.join(dir, 'router-notes') };
}

const notes = (over = {}) => ({
  schema: NOTES_SCHEMA,
  objective: '把委派台账接进 router 事实段',
  facts: [{ text: '台账按 key 合并，后一次覆盖前一次', source: 'conductor/lib/dispatch-ledger.mjs:74' }],
  ...over,
});

const text = (obj) => JSON.stringify(obj, null, 2);
const write = (p, body) => fs.writeFileSync(p, typeof body === 'string' ? body : text(body));
const snaps = (snapDir) => fs.readdirSync(snapDir).sort();
const errs = (obj) => validateNotesText(typeof obj === 'string' ? obj : text(obj)).errors.join(' | ');

// ---- validateNotesText ----

test('validateNotesText：schema 钉死版本，顶层字段是闭集（多一个键就不合格）', () => {
  assert.equal(NOTES_SCHEMA, 'router-notes/v1');
  assert.equal(NOTES_MAX_BYTES, 24_000);

  assert.deepEqual(validateNotesText(text(notes())), { ok: true, errors: [] });
  assert.deepEqual(validateNotesText(text({ schema: NOTES_SCHEMA })), { ok: true, errors: [] }, '只有 schema 也合格：其余段都可缺省');

  assert.match(errs(notes({ schema: 'router-notes/v2' })), /schema 必须为 "router-notes\/v1"/);
  assert.match(errs({ objective: 'x' }), /schema 必须为/, 'schema 漏写即不合格');
  // 多出来的顶层键要报名字：router 常把内核该渲染的东西（委派状态、AC 覆盖）抄进记忆，这条拦住它
  assert.match(errs(notes({ assignments: [] })), /未知字段：assignments/);
  assert.match(errs(notes({ memo: 1, todo: 2 })), /未知字段：memo \| 未知字段：todo/);
});

test('validateNotesText：facts 必须带 source —— 没出处的只能进 hypotheses', () => {
  // 结构上把「有来源的事实」与「模型的推测」分开，是这份记忆唯一的语义保证。
  const noSource = errs(notes({ facts: [{ text: '内核会自动续接' }] }));
  assert.match(noSource, /facts\[0\]\.source 必填：facts 必须带出处（spec 行号 \/ 产物文件 \/ kernel）；没有出处的放 hypotheses/);

  for (const source of ['', '   ', 42, null, 'z'.repeat(301)]) {
    assert.match(errs(notes({ facts: [{ text: 'x', source }] })), /facts\[0\]\.source 必填/, `source=${JSON.stringify(source)} 应拒收`);
  }
  assert.equal(validateNotesText(text(notes({ facts: [{ text: 'x', source: 'z'.repeat(300) }] }))).ok, true, 'source 上限 300 字符');

  assert.match(errs(notes({ facts: [{ source: 'spec.md:1' }] })), /facts\[0\]\.text 必填，≤ 600 字符/);
  assert.match(errs(notes({ facts: [{ text: 'x'.repeat(601), source: 'spec.md:1' }] })), /facts\[0\]\.text 必填，≤ 600 字符/);
  assert.match(errs(notes({ facts: ['一句话'] })), /facts\[0\] 须为对象/);
  assert.match(errs(notes({ facts: '一句话' })), /facts 须为数组/);

  // 同一句话搬进 hypotheses 就合格：没有出处不是死路，只是不许叫事实
  assert.equal(validateNotesText(text({
    schema: NOTES_SCHEMA, facts: [], hypotheses: [{ text: '内核会自动续接' }],
  })).ok, true);
  assert.match(errs({ schema: NOTES_SCHEMA, hypotheses: [{ text: 'x', verify_by: 'y'.repeat(401) }] }), /hypotheses\[0\]\.verify_by 须为 ≤ 400 字符的字符串/);
  assert.match(errs({ schema: NOTES_SCHEMA, hypotheses: [{}] }), /hypotheses\[0\]\.text 必填/);
});

test('validateNotesText：questions / plan / changelog 的枚举闭集与长度上限', () => {
  const q = (status) => ({ schema: NOTES_SCHEMA, questions: [{ text: '要不要拆包？', status }] });
  for (const status of ['open', 'answered', 'escalated']) assert.equal(validateNotesText(text(q(status))).ok, true, status);
  assert.match(errs(q('closed')), /questions\[0\]\.status 取值非法（open \| answered \| escalated）/);
  assert.match(errs(q(undefined)), /questions\[0\]\.status 取值非法/, 'status 不给默认值：状态必须是 router 自己写下的');

  const plan = (over) => ({ schema: NOTES_SCHEMA, plan: [{ key: 'ledger', title: '接台账', status: 'todo', ...over }] });
  for (const status of ['todo', 'active', 'done', 'dropped']) assert.equal(validateNotesText(text(plan({ status }))).ok, true, status);
  assert.match(errs(plan({ status: 'blocked' })), /plan\[0\]\.status 取值非法（todo \| active \| done \| dropped）/);
  assert.match(errs(plan({ key: 'k'.repeat(41) })), /plan\[0\]\.key 必填/);
  assert.match(errs(plan({ title: 't'.repeat(201) })), /plan\[0\]\.title 必填，≤ 200 字符/);
  assert.match(errs(plan({ depends_on: 'ledger' })), /plan\[0\]\.depends_on 须为字符串数组/);
  assert.match(errs(plan({ depends_on: ['a', 3] })), /plan\[0\]\.depends_on 须为字符串数组/);
  assert.equal(validateNotesText(text(plan({ depends_on: [] }))).ok, true);
  assert.match(errs(plan({ note: 'n'.repeat(401) })), /plan\[0\]\.note 须为 ≤ 400 字符的字符串/);

  const cl = (over) => ({ schema: NOTES_SCHEMA, changelog: [{ round: 3, why: '把 P2 挪后', ...over }] });
  assert.equal(validateNotesText(text(cl())).ok, true);
  for (const round of ['3', 3.5, null, undefined]) {
    assert.match(errs(cl({ round })), /changelog\[0\]\.round 须为整数/, `round=${JSON.stringify(round)} 应拒收`);
  }
  assert.match(errs(cl({ why: '' })), /changelog\[0\]\.why 必填，≤ 400 字符/);

  assert.equal(validateNotesText(text(notes({ objective: 'o'.repeat(600) }))).ok, true);
  assert.match(errs(notes({ objective: 'o'.repeat(601) })), /objective 须为 ≤ 600 字符的字符串/);
  assert.match(errs(notes({ objective: '   ' })), /objective 须为 ≤ 600 字符的字符串/);
});

test('validateNotesText：形态与体积 —— 空 / 非法 JSON / 非对象 / 超 24KB，且错误最多 20 条', () => {
  for (const raw of ['', '   ', null, undefined, 42, {}]) {
    assert.deepEqual(validateNotesText(raw), { ok: false, errors: ['工作记忆为空'] }, `${JSON.stringify(raw)} 应判空`);
  }
  const bad = validateNotesText('{ 半个文件');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^工作记忆不是合法 JSON：/);
  for (const raw of ['[]', '3', '"x"', 'null']) {
    assert.deepEqual(validateNotesText(raw), { ok: false, errors: ['工作记忆必须是 JSON 对象'] }, raw);
  }

  // 超限只回一条可执行的指令（压缩它），不再逐字段报错：router 这轮要做的就是把它压小
  const huge = text(notes({
    facts: Array.from({ length: 200 }, (_, i) => ({ text: `${i}`.padEnd(100, 'x'), source: 'spec.md:1' })),
  }));
  assert.ok(Buffer.byteLength(huge, 'utf8') > NOTES_MAX_BYTES);
  assert.deepEqual(validateNotesText(huge), {
    ok: false,
    errors: ['工作记忆超过 24000 字节：压缩它——细节留在产物里，这里只留结论与出处'],
  });

  // 错误清单封顶 20 条：喂回 prompt 的是给人/模型看的指令，不是完整的校验报告
  const many = validateNotesText(text({ schema: NOTES_SCHEMA, facts: Array.from({ length: 30 }, () => ({})) }));
  assert.equal(many.ok, false);
  assert.equal(many.errors.length, 20);
});

// ---- settleNotes ----

test('settleNotes：合格且有变化 → 逐轮快照，历史不被后一轮覆盖', (t) => {
  const { notesPath, snapDir } = makeDossier(t);
  const first = text(notes({ objective: '第一版目标' }));
  write(notesPath, first);

  assert.deepEqual(settleNotes(notesPath, 1), { status: 'saved', errors: [] });
  assert.equal(fs.readFileSync(path.join(snapDir, 'r1.json'), 'utf8'), first, '快照必须是逐字节的原文');
  assert.equal(fs.readFileSync(notesPath, 'utf8'), first, 'settleNotes 不改合格的 notes 本身');

  const second = text(notes({ objective: '第二版目标（第一版被压缩掉了）' }));
  write(notesPath, second);
  assert.equal(settleNotes(notesPath, 2).status, 'saved');
  assert.deepEqual(snaps(snapDir), ['r1.json', 'r2.json']);
  assert.equal(fs.readFileSync(path.join(snapDir, 'r1.json'), 'utf8'), first, '被改写掉的第一版仍然找得回来');
  assert.equal(fs.readFileSync(path.join(snapDir, 'r2.json'), 'utf8'), second);
});

test('settleNotes：内容没变 → unchanged，不再重复留快照', (t) => {
  // router 大多数轮次不会动记忆；每轮都存一份等于把案卷撑满、也让「哪一轮改了什么」不可读。
  const { notesPath, snapDir } = makeDossier(t);
  write(notesPath, notes());
  assert.equal(settleNotes(notesPath, 1).status, 'saved');

  assert.deepEqual(settleNotes(notesPath, 2), { status: 'unchanged', errors: [] });
  assert.deepEqual(snaps(snapDir), ['r1.json'], '没变就不产生 r2.json');
});

test('settleNotes：写坏了 → 还原上一份合格快照，坏文件原样留作 r<n>.invalid.json', (t) => {
  const { notesPath, snapDir } = makeDossier(t);
  const good = text(notes({ objective: '上一轮记下的结论' }));
  write(notesPath, good);
  assert.equal(settleNotes(notesPath, 1).status, 'saved');

  // 典型写坏法：把推测直接塞进 facts（漏了 source），并且顺手多加一个顶层字段
  const broken = text({ schema: NOTES_SCHEMA, facts: [{ text: '我猜内核会自动重试——中文字节要一个不少地留下' }], memo: '随手记' });
  write(notesPath, broken);
  const r = settleNotes(notesPath, 2);

  assert.equal(r.status, 'restored');
  assert.match(r.errors.join(' | '), /facts\[0\]\.source 必填/);
  assert.match(r.errors.join(' | '), /未知字段：memo/);
  assert.equal(fs.readFileSync(notesPath, 'utf8'), good, '记忆回到上一份合格快照，不是被清空');
  assert.equal(readNotesForPrompt(notesPath), good.trim(), '下一轮 prompt 拿到的就是这份还原稿');

  // 坏字节必须原样留在盘上：静默丢掉 router 自己写的东西，比留下一个不合格文件严重得多
  assert.equal(fs.readFileSync(path.join(snapDir, 'r2.invalid.json'), 'utf8'), broken);
  assert.deepEqual(snaps(snapDir), ['r1.json', 'r2.invalid.json'], '不合格的内容绝不进 r<n>.json');

  // 还原之后的下一轮：内容与最新快照一致 → unchanged（不会把还原稿再存一遍）
  assert.deepEqual(settleNotes(notesPath, 3), { status: 'unchanged', errors: [] });
});

test('settleNotes：第一轮就写坏且无快照可还原 → notes 被移走（绝不把不合格记忆喂回 prompt）', (t) => {
  const { notesPath, snapDir } = makeDossier(t);
  const broken = '{ 这不是 JSON';
  write(notesPath, broken);

  const r = settleNotes(notesPath, 1);
  assert.equal(r.status, 'restored');
  assert.match(r.errors[0], /^工作记忆不是合法 JSON：/);
  assert.equal(fs.existsSync(notesPath), false, '没有可还原的版本时宁可没有记忆，也不留一份坏的');
  assert.equal(readNotesForPrompt(notesPath), '');
  assert.equal(fs.readFileSync(path.join(snapDir, 'r1.invalid.json'), 'utf8'), broken, '坏内容照样留作诊断');

  // 文件已被移走：下一轮就是「router 这轮没写记忆」，不是失效
  assert.deepEqual(settleNotes(notesPath, 2), { status: 'absent', errors: [] });
});

test('settleNotes：notes 根本不存在 → absent，连快照目录都不建', (t) => {
  const { notesPath, snapDir } = makeDossier(t);
  assert.deepEqual(settleNotes(notesPath, 1), { status: 'absent', errors: [] });
  assert.equal(fs.existsSync(snapDir), false, 'router 没写记忆是常态，不该留下任何痕迹');
});

test('settleNotes：还原取轮次号最大的那份合格快照（按数值比，.invalid.json 不参与）', (t) => {
  const { notesPath, snapDir } = makeDossier(t);
  fs.mkdirSync(snapDir, { recursive: true });
  const r2 = text(notes({ objective: 'r2 的记忆' }));
  const r10 = text(notes({ objective: 'r10 的记忆（最新的合格版）' }));
  fs.writeFileSync(path.join(snapDir, 'r2.json'), r2);
  fs.writeFileSync(path.join(snapDir, 'r10.json'), r10);
  fs.writeFileSync(path.join(snapDir, 'r9.invalid.json'), '{ 坏的');
  fs.writeFileSync(path.join(snapDir, 'notes.json'), '{}'); // 不合命名的文件一律不参与

  write(notesPath, '{ 这轮又写坏了');
  assert.equal(settleNotes(notesPath, 11).status, 'restored');
  // 字符串排序下 'r9' > 'r2' > 'r10'：轮次号必须按数值比，否则会把旧记忆当成最新的还原回去
  assert.equal(fs.readFileSync(notesPath, 'utf8'), r10);
});

// ---- readNotesForPrompt ----

test('readNotesForPrompt：只喂合格的原文（trim 过），不合格或缺失一律空串', (t) => {
  const { notesPath } = makeDossier(t);
  assert.equal(readNotesForPrompt(notesPath), '', '文件不存在 → 空串，不抛错');

  const body = text(notes());
  write(notesPath, `\n\n${body}\n\n`);
  assert.equal(readNotesForPrompt(notesPath), body, '原文照给（prompt 段落自己声明「未经内核验证」）');

  // 不合格的内容不进 prompt：settleNotes 已经把它还原掉了，这里是兜底的第二道
  write(notesPath, text({ schema: NOTES_SCHEMA, facts: [{ text: '没有出处' }] }));
  assert.equal(readNotesForPrompt(notesPath), '');
  write(notesPath, '{ 半个文件');
  assert.equal(readNotesForPrompt(notesPath), '');
  write(notesPath, '');
  assert.equal(readNotesForPrompt(notesPath), '');
});
