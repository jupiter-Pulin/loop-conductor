// 单元：委派台账（conductor/lib/dispatch-ledger.mjs）—— 一次 dispatch 的预写日志。
// 台账是内核在**派出任何 agent 之前**就落盘的事实，runner 崩在任何一步之后，重启都只能靠它
// 判断「哪些已经发生、哪些没发生」。所以这里的每条不变量都对应一种恢复事故：
//   ①读写/列举绝不抛错、坏文件跳过 —— 一个半截 JSON 就让恢复流程整个起不来，任务只能人工捞；
//   ②openLedgers 只留没关账的 —— 漏一个就永远不会被收尾，多一个就可能重复集成；
//   ③latestAssignments 后一次委派覆盖前一次 —— 看错「现状」会让 router 对着上一轮的状态派活；
//   ④resumableSpawn 只认「最后一次 spawn 撞上限 / 被中断且留下 session_id」—— 判错要么续一个
//     不存在的会话，要么把已经做完的工作重做一遍（dispatch 前置就按它校 continue_from）；
//   ⑤渲染出的表是 router 唯一能看见的台账 —— 「可续接」「spec 版本已过期」不显示，router 就不知道
//     该续接、也不知道自己在看一份绑在旧 spec 版本上的结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledgerPath, readLedger, writeLedger, listLedgers, openLedgers, newLedger,
  latestAssignments, resumableSpawn, renderAssignmentTable, TERMINAL_STATES,
} from '../../conductor/lib/dispatch-ledger.mjs';

const ID = 'task-20260920-001';
const BASE = 'a'.repeat(40);
const S1 = 'c'.repeat(64);
const S2 = 'd'.repeat(64);

function makeCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dossierDir: path.join(root, 'dossier') };
}

/** dispatch 落盘时的 assignment 形状（见 stages/actions/dispatch.mjs 的 assignments.map）。 */
const assignment = (over = {}) => ({
  key: 'probe',
  profile: 'read',
  intent: 'investigate',
  title: '查清续接失败的原因',
  placement: 'snapshot',
  state: 'bound',
  spawns: [],
  commit_sha: null,
  integrated_sha: null,
  conflict_files: [],
  changed_files: [],
  out_of_scope_files: [],
  note: null,
  ...over,
});

/** 一次会话在台账里的落点（收尾时由 dispatch.mjs 的 Object.assign 补齐）。 */
const spawn = (over = {}) => ({
  round: 2, resume_of: null, state: 'done', outcome: 'ok',
  truncated: false, interrupted: false, session_id: null, progress: 'changed', ...over,
});

const ledgerOf = (round, assignments, over = {}) => ({
  ...newLedger({ round, baseHead: BASE, specSha: S1, assignments }), ...over,
});

const table = (ledgers, currentSpecSha = null) => renderAssignmentTable(ledgers, { currentSpecSha });

// ---- 落盘与读取 ----

test('ledgerPath / writeLedger / readLedger：台账落在 dossier/<id>/dispatch-r<n>.json，每次写盖 updated_at', (t) => {
  const cfg = makeCfg(t);
  assert.equal(ledgerPath(cfg, ID, 3), path.join(cfg.dossierDir, ID, 'dispatch-r3.json'));

  const l = newLedger({ round: 3, baseHead: BASE, specSha: S1, assignments: [assignment()] });
  assert.equal(l.updated_at, undefined, '没写盘之前不该有 updated_at');

  const returned = writeLedger(cfg, ID, l);
  assert.equal(returned, l, '返回的就是同一个对象：dispatch 全程持有它并反复改写落盘');
  assert.ok(!Number.isNaN(Date.parse(l.updated_at)), 'updated_at 是可解析的时间戳');
  assert.deepEqual(readLedger(cfg, ID, 3), l, '读回来必须与内存里的台账逐字段一致');
  assert.equal(fs.existsSync(ledgerPath(cfg, ID, 3)), true, '目录不存在时也要自己建出来（预写日志不能因为缺目录而丢）');

  // 恢复流程随时可能读到不存在 / 写到一半的台账：只能返回 null，绝不抛错
  assert.equal(readLedger(cfg, ID, 9), null);
  fs.writeFileSync(ledgerPath(cfg, ID, 4), '{ 半个文件');
  assert.equal(readLedger(cfg, ID, 4), null);
});

test('newLedger：预写日志的初始形态 —— 未关账、未恢复，并绑死 base_head 与 spec_sha', () => {
  const a = assignment();
  const l = newLedger({ round: 2, baseHead: BASE, specSha: S1, assignments: [a] });
  assert.equal(l.schema_version, 1);
  assert.equal(l.round, 2);
  assert.equal(l.base_head, BASE);
  assert.equal(l.spec_sha, S1, '派出时的 spec 版本绑在台账上：结果回来时版本变了就只能作诊断');
  assert.equal(l.closed, false);
  assert.equal(l.closed_at, null);
  assert.equal(l.recovered, false);
  assert.equal(l.assignments[0], a, 'assignments 直接引用，后续状态改写就地生效');
  assert.ok(!Number.isNaN(Date.parse(l.created_at)));

  const bare = newLedger({ round: 1, assignments: [] });
  assert.equal(bare.base_head, null, '缺省一律落成 null，不留 undefined（JSON 里会整字段消失）');
  assert.equal(bare.spec_sha, null);

  assert.deepEqual([...TERMINAL_STATES], ['integrated', 'conflict', 'stale', 'skipped', 'done']);
});

test('listLedgers：按轮次数值升序，坏文件跳过，目录不存在返回 []', (t) => {
  const cfg = makeCfg(t);
  assert.deepEqual(listLedgers(cfg, ID), [], '还没 dispatch 过：空数组，不抛错');

  for (const round of [10, 1, 2]) writeLedger(cfg, ID, ledgerOf(round, [assignment({ key: `k${round}` })]));
  // 字符串排序下 'dispatch-r10' < 'dispatch-r2'：轮次必须按数值比，否则 latestAssignments 的
  // 「后一次覆盖前一次」会把 r10 的结果反过来被 r2 盖掉
  assert.deepEqual(listLedgers(cfg, ID).map((l) => l.round), [1, 2, 10]);

  fs.writeFileSync(ledgerPath(cfg, ID, 3), '{ 半个文件');
  fs.writeFileSync(path.join(cfg.dossierDir, ID, 'worker-probe-r1.json'), '{}');
  fs.writeFileSync(path.join(cfg.dossierDir, ID, 'dispatch-rX.json'), '{}');
  fs.writeFileSync(path.join(cfg.dossierDir, ID, 'dispatch-r2.json.tmp'), '{}');
  assert.deepEqual(listLedgers(cfg, ID).map((l) => l.round), [1, 2, 10], '坏台账与同目录下的其他产物都不参与');
});

test('openLedgers：只留没关账的（closed !== true）', (t) => {
  const cfg = makeCfg(t);
  writeLedger(cfg, ID, ledgerOf(1, [assignment()], { closed: true, closed_at: new Date().toISOString() }));
  writeLedger(cfg, ID, ledgerOf(2, [assignment()]));
  const l3 = ledgerOf(3, [assignment()]);
  delete l3.closed; // 老版本台账没有这个字段：当作没关账，宁可多收一次尾
  writeLedger(cfg, ID, l3);

  assert.deepEqual(openLedgers(cfg, ID).map((l) => l.round), [2, 3]);
  assert.deepEqual(listLedgers(cfg, ID).map((l) => l.round), [1, 2, 3], '关过账的照样在完整列表里（诊断要看得见）');
});

// ---- latestAssignments ----

test('latestAssignments：同一个 key 后一次委派覆盖前一次，行序按 key 首次出现', () => {
  const l1 = ledgerOf(1, [
    assignment({ key: 'probe', state: 'done' }),
    assignment({ key: 'impl', profile: 'write', state: 'integrated' }),
  ]);
  const l2 = ledgerOf(2, [
    assignment({ key: 'impl', profile: 'write', state: 'conflict' }),
    assignment({ key: 'docs', state: 'done' }),
  ], { closed: true, spec_sha: S2 });

  const rows = latestAssignments([l1, l2]);
  assert.deepEqual(rows.map((a) => a.key), ['probe', 'impl', 'docs'], 'impl 被 r2 更新，但保留它第一次出现的位置');
  const impl = rows.find((a) => a.key === 'impl');
  assert.equal(impl.state, 'conflict', '现状取最后一次委派的状态');
  assert.equal(impl.dispatch_round, 2);
  assert.equal(impl.dispatch_closed, true);
  assert.equal(impl.dispatch_spec_sha, S2, '带出的是这一次委派绑定的 spec 版本，不是当前版本');

  const probe = rows.find((a) => a.key === 'probe');
  assert.equal(probe.dispatch_round, 1, '只在 r1 出现过的 key 仍然停留在 r1');
  assert.equal(probe.dispatch_closed, false);

  assert.deepEqual(latestAssignments([]), []);
  assert.deepEqual(latestAssignments(null), [], 'null 也要当空台账处理：恢复路径上什么都可能缺');
  assert.deepEqual(latestAssignments([ledgerOf(1, undefined)]), [], 'assignments 缺失的台账不算数');
  // 防御：同一份台账里出现重复 key（不该发生，assignment-contract 会拦）也是后者胜出
  assert.deepEqual(
    latestAssignments([ledgerOf(1, [assignment({ key: 'x', state: 'a' }), assignment({ key: 'x', state: 'b' })])]).map((a) => a.state),
    ['b'],
  );
});

// ---- resumableSpawn ----

test('resumableSpawn：只有「最后一次 spawn 撞上限 / 被中断且留下 session_id」才可续接', () => {
  assert.equal(resumableSpawn(assignment()), null, '一次都没派出过');
  assert.equal(resumableSpawn(assignment({ spawns: undefined })), null);
  assert.equal(resumableSpawn(assignment({ spawns: 'nope' })), null, 'spawns 不是数组也不能抛错');

  assert.equal(resumableSpawn(assignment({ spawns: [spawn({ session_id: 'sess-1' })] })), null, '正常收尾的会话不是「可续接」');
  assert.equal(resumableSpawn(assignment({ spawns: [spawn({ truncated: true })] })), null, '没有 session_id 就续不了');
  assert.equal(resumableSpawn(assignment({ spawns: [spawn({ interrupted: true, session_id: null })] })), null);

  const cut = spawn({ round: 4, truncated: true, outcome: 'partial', session_id: 'sess-cut' });
  assert.equal(resumableSpawn(assignment({ spawns: [cut] })), cut, '撞轮次上限 + 没做完 + 有 session → 返回那次 spawn 本身');
  const killed = spawn({ round: 5, interrupted: true, outcome: null, session_id: 'sess-killed' });
  assert.equal(resumableSpawn(assignment({ spawns: [killed] })), killed, '没有合格 log（outcome 未知）的中断同样可续');
  // 写下 ok 之后才撞上限：已经做完了，台账不该再提示「可续接」（真实 CLI 验收里出现过这种误导）。
  const doneThenCut = spawn({ round: 8, truncated: true, outcome: 'ok', session_id: 'sess-done' });
  assert.equal(resumableSpawn(assignment({ spawns: [doneThenCut] })), null);

  // 只看最后一次：上一次被截断、这一次正常跑完，就没有会话需要续了
  assert.equal(resumableSpawn(assignment({ spawns: [cut, spawn({ round: 6, session_id: 'sess-ok' })] })), null);
  // 反过来，最后一次被截断就算数，哪怕前面有过正常收尾的会话
  assert.equal(resumableSpawn(assignment({ spawns: [spawn({ round: 6, session_id: 'sess-ok' }), cut] })), cut);
});

test('与恢复流程的契约：崩溃后被补记为 interrupted 的 spawn，台账里立刻是可续接的', () => {
  // lib/recovery.mjs 对 state==='running' 的 spawn 就地写这几个字段（interrupted=true + session_id）。
  // 这里钉住两边的对接：补记完 router 下一轮才能看到「可续接」，否则崩溃过的委派只能从头重做。
  const a = assignment({ key: 'impl', profile: 'write', state: 'finished', spawns: [{ round: 7, state: 'running' }] });
  Object.assign(a.spawns[0], {
    state: 'done', outcome: null, interrupted: true, truncated: false,
    session_id: 'sess-recovered', progress: null, finished_at: new Date().toISOString(),
  });

  assert.equal(resumableSpawn(a).round, 7);
  const line = table([ledgerOf(9, [a])]);
  assert.ok(line.includes('interrupted=yes'), '事实要写明是被中断的');
  assert.ok(line.includes('outcome=未知(无合格 log)'), '没有合格 log 时不许把 outcome 猜成任何值');
  assert.ok(line.includes('可续接=continue_from:7'));
});

// ---- renderAssignmentTable ----

test('renderAssignmentTable：一行一个 key，字段逐项对齐 router 事实段的读法', () => {
  assert.equal(table([]), '', '没有台账就不渲染这一段');
  assert.equal(table(null), '');
  assert.equal(table([ledgerOf(1, [])]), '', '台账里没有委派也一样');

  assert.equal(
    table([ledgerOf(1, [assignment({ state: 'done' })])]),
    'probe  「查清续接失败的原因」  profile=read  intent=investigate  state=done  dispatched=r1',
  );

  // 派出过会话就补上「最后一次是哪轮、结果如何」
  assert.equal(
    table([ledgerOf(1, [assignment({ state: 'done', spawns: [spawn({ round: 2, outcome: 'partial' })] })])]),
    'probe  「查清续接失败的原因」  profile=read  intent=investigate  state=done  dispatched=r1  last=r2  outcome=partial',
  );

  const two = table([ledgerOf(1, [assignment({ key: 'a' }), assignment({ key: 'b' })])]).split('\n');
  assert.equal(two.length, 2, '一行一个 key');
  assert.ok(two[0].startsWith('a  '));
  assert.ok(two[1].startsWith('b  '));
});

test('renderAssignmentTable：可续接的会话标 可续接=continue_from:<round>（router 照着填就能续）', () => {
  // dispatch 前置（stages/actions/dispatch.mjs::dispatchPrecondition）就拿 continue_from 与这里
  // 同一个 resumableSpawn 对照：表里不写轮次号，router 只能瞎猜，前置必然打回。
  const cut = table([ledgerOf(3, [assignment({
    key: 'impl', profile: 'write', intent: 'implement', state: 'finished',
    spawns: [spawn({ round: 4, outcome: 'partial', truncated: true, session_id: 'sess-cut' })],
  })])]);
  assert.ok(cut.includes('last=r4'));
  assert.ok(cut.includes('truncated=yes'));
  assert.ok(cut.includes('可续接=continue_from:4'));

  const clean = table([ledgerOf(3, [assignment({ spawns: [spawn({ round: 4, session_id: 'sess-ok' })] })])]);
  assert.equal(clean.includes('可续接'), false, '正常收尾的会话不得诱导 router 去续接');
  assert.equal(clean.includes('truncated=yes'), false);
});

test('renderAssignmentTable：派出时绑定的 spec 版本 ≠ 当前 → 标「spec 版本已过期」', () => {
  // 过期的结果不会被集成（finalizeAssignment 标 stale），router 必须一眼看出这行不是当前版本的依据。
  const ledgers = [ledgerOf(1, [assignment({ key: 'impl', profile: 'write', state: 'stale' })], { spec_sha: S1 })];
  assert.ok(table(ledgers, S2).includes('spec 版本已过期'));
  assert.equal(table(ledgers, S1).includes('spec 版本已过期'), false, '同一版本不标');
  assert.equal(table(ledgers, null).includes('spec 版本已过期'), false, '当前无获批 spec 时无从比较');

  // 当前行为：派出时还没有 spec（spec_sha=null）、之后才批了一版 —— 表里不标过期。
  // 注意 finalizeAssignment 对 (null !== 当前 sha) 同样判 stale，两边口径并不一致。
  const noSpecAtDispatch = [ledgerOf(1, [assignment()], { spec_sha: null })];
  assert.equal(table(noSpecAtDispatch, S2).includes('spec 版本已过期'), false);
});

test('renderAssignmentTable：集成结果、冲突、越界改动与 note 逐项落到同一行', () => {
  const a = assignment({
    key: 'impl', profile: 'write', intent: 'implement', state: 'integrated',
    spawns: [spawn({ round: 2, outcome: 'ok' })],
    integrated_sha: 'e'.repeat(40),
    out_of_scope_files: Array.from({ length: 10 }, (_, i) => `src/x${i}.mjs`),
    note: '越界改动已请 router 复核',
  });
  const line = table([ledgerOf(1, [a])]);
  assert.ok(line.includes(`integrated@${'e'.repeat(6)}`), '集成落点只给短 sha，够核对就行');
  assert.ok(line.includes('声明 paths 之外的改动=src/x0.mjs,src/x1.mjs,src/x2.mjs,src/x3.mjs,src/x4.mjs,src/x5.mjs,src/x6.mjs,src/x7.mjs'));
  assert.equal(line.includes('src/x8.mjs'), false, '越界文件最多列 8 个，剩下的看案卷');
  assert.ok(line.endsWith('note=越界改动已请 router 复核'), 'note 收尾');

  const conflict = table([ledgerOf(1, [assignment({
    key: 'impl', profile: 'write', state: 'conflict', conflict_files: ['src/a.mjs', 'src/b.mjs'],
  })])]);
  assert.ok(conflict.includes('conflict_files=src/a.mjs,src/b.mjs'));
  assert.equal(conflict.includes('integrated@'), false, '没集成就不许出现集成落点');

  // 空数组不渲染：每行只说发生过的事
  const plain = table([ledgerOf(1, [assignment({ state: 'done' })])]);
  for (const noise of ['conflict_files=', '声明 paths 之外的改动=', 'integrated@', 'note=']) {
    assert.equal(plain.includes(noise), false, `${noise} 不该出现在干净的一行里`);
  }
});
