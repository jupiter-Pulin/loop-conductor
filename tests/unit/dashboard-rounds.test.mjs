// dashboard/rounds.mjs 单测（P3 AC-001~006）：轮次聚合纯读 dossier、容错解析、attempts 归档组、
// spec 轮组独立、maker.ok 与轮次成败解耦、三轮证据链升序排列。
// 夹具事实源：spec.md 背景章节内联记录的 maker-r<N>.json / test-gate-r<N>.json / green-gate-r<N>.json /
// verify-r<N>.verdict.json / repair-context-r<N>.json 形态，测试内自构造，不读真实 dossier/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRoundsView, groupRecordsByRound } from '../../conductor/dashboard/rounds.mjs';

function mkroot(prefix = 'dashboard-rounds-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseCfg(root) {
  return { dossierDir: path.join(root, 'dossier') };
}

function dossierDirFor(cfg, id) {
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
}

function makerRecord(round, over = {}) {
  return { role: 'maker', round, ok: true, cost_usd: 1.23, raw: { num_turns: 42 }, ...over };
}

function testGateRecord(round, verdict, over = {}) {
  return { schema_version: 1, round, command: 'node --test', verdict, mode: 'suite', exit_code: 0, mapping_status: 'valid', stdout_tail: '', ...over };
}

function greenGateRecord(round, exitCode, over = {}) {
  return { schema_version: 1, round, command: 'node --test', cwd: 'worktrees/x', exit_code: exitCode, stdout_tail: 'ok\nlast line\n', stderr_tail: '', ...over };
}

function verdictRecord(round, overall, criteriaResults, over = {}) {
  return { schema_version: 1, round, overall, criteria_results: criteriaResults, non_ac_findings: [], ...over };
}

function repairContextRecord(round, over = {}) {
  return { schema_version: 1, round, source: 'verifier', overall: 'fail', failed_criteria: [{ ac_id: 'AC-001' }], instruction: 'fix AC-001', ...over };
}

// ---- AC-001：齐全轮，四门 + repairContext 均填充；committed 代理 green-gate 是否存在 ----

test('buildRoundsView：齐全轮四门 + repairContext 均按夹具字段填充（AC-001）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-900';
  const dir = dossierDirFor(cfg, id);

  writeJson(dir, 'maker-r1.json', makerRecord(1, { cost_usd: 2.5, raw: { num_turns: 17 } }));
  writeJson(dir, 'test-gate-r1.json', testGateRecord(1, 'falsifies'));
  writeJson(dir, 'green-gate-r1.json', greenGateRecord(1, 0));
  const criteria = [
    { ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] },
    { ac_id: 'AC-002', status: 'fail', reason: 'no', evidence: [] },
    { ac_id: 'AC-003', status: 'pass', reason: 'ok', evidence: [] },
  ];
  writeJson(dir, 'verify-r1.verdict.json', verdictRecord(1, 'fail', criteria));
  writeJson(dir, 'repair-context-r1.json', repairContextRecord(1, { instruction: '修 AC-002' }));

  const view = buildRoundsView(cfg, id);
  assert.equal(view.rounds.length, 1);
  const r1 = view.rounds[0];
  assert.equal(r1.round, 1);
  assert.equal(r1.maker.costUsd, 2.5);
  assert.equal(r1.maker.turns, 17);
  assert.equal(r1.testGate.verdict, 'falsifies');
  assert.equal(r1.greenGate.pass, true);
  assert.equal(r1.verifier.overall, 'fail');
  assert.equal(r1.verifier.passCount, 2);
  assert.equal(r1.verifier.total, 3);
  assert.equal(r1.repairContext.instruction, '修 AC-002');
  assert.equal(r1.maker.committed, true);

  // 对照轮：仅缺 green-gate，maker.committed 应为 false。
  const id2 = 'task-20260713-901';
  const dir2 = dossierDirFor(cfg, id2);
  writeJson(dir2, 'maker-r1.json', makerRecord(1));
  const view2 = buildRoundsView(cfg, id2);
  assert.equal(view2.rounds[0].maker.committed, false);
});

// ---- AC-002：门缺失→未到达；门损坏→数据损坏，隔离到该门；maker.raw 缺失/null → turns 降级 null ----

test('buildRoundsView：半途轮各缺失门为 absent，不抛错（AC-002）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-902';
  const dir = dossierDirFor(cfg, id);
  writeJson(dir, 'maker-r1.json', makerRecord(1));

  assert.doesNotThrow(() => buildRoundsView(cfg, id));
  const view = buildRoundsView(cfg, id);
  assert.equal(view.rounds.length, 1);
  const r1 = view.rounds[0];
  assert.equal(r1.maker.status, 'ok');
  assert.equal(r1.testGate.status, 'absent');
  assert.equal(r1.greenGate.status, 'absent');
  assert.equal(r1.verifier.status, 'absent');
  assert.equal(r1.repairContext.status, 'absent');
});

test('buildRoundsView：损坏 JSON 只影响该门，同轮其他门不受影响（AC-002）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-903';
  const dir = dossierDirFor(cfg, id);
  writeJson(dir, 'maker-r1.json', makerRecord(1, { cost_usd: 1.1 }));
  fs.writeFileSync(path.join(dir, 'test-gate-r1.json'), '{ not valid json');
  writeJson(dir, 'green-gate-r1.json', greenGateRecord(1, 0));
  writeJson(dir, 'verify-r1.verdict.json', verdictRecord(1, 'pass', [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }]));

  assert.doesNotThrow(() => buildRoundsView(cfg, id));
  const view = buildRoundsView(cfg, id);
  const r1 = view.rounds[0];
  assert.equal(r1.testGate.status, 'corrupt');
  assert.equal(r1.maker.status, 'ok');
  assert.equal(r1.maker.costUsd, 1.1);
  assert.equal(r1.greenGate.status, 'ok');
  assert.equal(r1.greenGate.pass, true);
  assert.equal(r1.verifier.status, 'ok');
  assert.equal(r1.verifier.overall, 'pass');
});

test('buildRoundsView：maker.raw 缺失键或为 null 时不抛错，turns 降级为 null（AC-002）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);

  const idNoRaw = 'task-20260713-904';
  const dirNoRaw = dossierDirFor(cfg, idNoRaw);
  const { raw, ...noRaw } = makerRecord(1, { ok: false });
  writeJson(dirNoRaw, 'maker-r1.json', noRaw);
  writeJson(dirNoRaw, 'test-gate-r1.json', testGateRecord(1, 'falsifies'));
  assert.doesNotThrow(() => buildRoundsView(cfg, idNoRaw));
  const viewNoRaw = buildRoundsView(cfg, idNoRaw);
  assert.equal(viewNoRaw.rounds[0].maker.turns, null);
  assert.equal(viewNoRaw.rounds[0].maker.ok, false);
  assert.equal(viewNoRaw.rounds[0].testGate.status, 'ok');

  const idNullRaw = 'task-20260713-905';
  const dirNullRaw = dossierDirFor(cfg, idNullRaw);
  writeJson(dirNullRaw, 'maker-r1.json', makerRecord(1, { ok: false, raw: null }));
  assert.doesNotThrow(() => buildRoundsView(cfg, idNullRaw));
  const viewNullRaw = buildRoundsView(cfg, idNullRaw);
  assert.equal(viewNullRaw.rounds[0].maker.turns, null);
  assert.equal(viewNullRaw.rounds[0].maker.ok, false);
});

// ---- AC-003：attempts/<stamp>/ 归并为独立的早前攻坚周期组，与当前周期分列 ----

test('buildRoundsView：attempts/<stamp>/ 归并为独立组，与当前周期互不混入（AC-003）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-906';
  const dir = dossierDirFor(cfg, id);
  writeJson(dir, 'maker-r1.json', makerRecord(1, { cost_usd: 9.9 }));

  const stamp = '2026-07-05T11-13-31-284Z';
  const attemptDir = path.join(dir, 'attempts', stamp);
  fs.mkdirSync(attemptDir, { recursive: true });
  writeJson(attemptDir, 'maker-r1.json', makerRecord(1, { cost_usd: 3.3 }));

  const view = buildRoundsView(cfg, id);
  assert.equal(view.rounds.length, 1);
  assert.equal(view.rounds[0].maker.costUsd, 9.9);

  assert.equal(view.attempts.length, 1);
  assert.equal(view.attempts[0].stamp, stamp);
  assert.equal(view.attempts[0].rounds.length, 1);
  assert.equal(view.attempts[0].rounds[0].maker.costUsd, 3.3);
});

// ---- AC-004：maker.ok 字面透传，不作为轮次成败判据；ok:false 与 verifier pass 可共存 ----

test('buildRoundsView：maker.ok 字面透传，与 verifier.overall 解耦（AC-004）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-907';
  const dir = dossierDirFor(cfg, id);
  writeJson(dir, 'maker-r1.json', makerRecord(1, { ok: false, raw: null }));
  writeJson(dir, 'verify-r1.verdict.json', verdictRecord(1, 'pass', [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }]));

  const view = buildRoundsView(cfg, id);
  const r1 = view.rounds[0];
  assert.equal(r1.maker.ok, false);
  assert.equal(r1.verifier.overall, 'pass');
});

// ---- AC-005：spec 链轮次独立于 maker 轮组，缺失/损坏容错策略一致 ----

test('buildRoundsView：spec 轮组独立于 maker 轮组，缺失=未到达/损坏=数据损坏（AC-005）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-908';
  const dir = dossierDirFor(cfg, id);
  writeJson(dir, 'spec-agent-r1.json', { role: 'spec-agent', round: 1, ok: true, cost_usd: 0.4, raw: { num_turns: 5 } });
  writeJson(dir, 'spec-verify-r1.verdict.json', { schema_version: 1, round: 1, overall: 'pass', summary: 'ok', human_report: '', spec_agent_feedback: '', findings: [] });

  const view = buildRoundsView(cfg, id);
  assert.equal(view.rounds.length, 0, 'spec 产物不应污染 maker 轮组');
  assert.equal(view.specRounds.length, 1);
  assert.equal(view.specRounds[0].specVerify.overall, 'pass');
  assert.equal(view.specRounds[0].specAgent.status, 'ok');
  assert.equal(view.specRounds[0].specCheck.status, 'absent');
});

// ---- AC-006：三轮证据链，升序排列 ----

test('buildRoundsView：三轮证据链（vacuous→fail→pass）按升序排列（AC-006）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-909';
  const dir = dossierDirFor(cfg, id);

  writeJson(dir, 'maker-r1.json', makerRecord(1));
  writeJson(dir, 'test-gate-r1.json', testGateRecord(1, 'vacuous'));
  writeJson(dir, 'maker-r2.json', makerRecord(2));
  writeJson(dir, 'verify-r2.verdict.json', verdictRecord(2, 'fail', [{ ac_id: 'AC-001', status: 'fail', reason: 'no', evidence: [] }]));
  writeJson(dir, 'maker-r3.json', makerRecord(3));
  writeJson(dir, 'verify-r3.verdict.json', verdictRecord(3, 'pass', [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }]));

  const view = buildRoundsView(cfg, id);
  assert.deepEqual(view.rounds.map((r) => r.round), [1, 2, 3]);
  assert.equal(view.rounds[0].testGate.verdict, 'vacuous');
  assert.equal(view.rounds[1].verifier.overall, 'fail');
  assert.equal(view.rounds[2].verifier.overall, 'pass');
});

// ---- 空 dossier / 不存在的任务：永不抛错，退化为空数组 ----

test('buildRoundsView：dossier 目录不存在时不抛错，退化为空数组（核心不变量）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  assert.doesNotThrow(() => buildRoundsView(cfg, 'task-20260713-999'));
  assert.deepEqual(buildRoundsView(cfg, 'task-20260713-999'), { rounds: [], specRounds: [], attempts: [], records: [], routerRounds: [] });
});

// ---- 新状态机：router 轮次视图（records + routerRounds），与旧四门轮次并存 ----

test('buildRoundsView：有 router 轮次的任务给出 records 与按轮分组的 routerRounds', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260910-200';
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  w('router-r1.json', { role: 'router', round: 1, cost_usd: 0.02 });
  w('router-r1.log.json', { role: 'router', outcome: 'ok', action: 'maker', summary: '直接实现' });
  w('maker-r1.json', { role: 'maker', round: 1, cost_usd: 1.1 });
  w('maker-r1.log.json', { role: 'maker', outcome: 'ok', summary: 'AC-001 done' });
  w('router-r2.json', { role: 'router', round: 2, cost_usd: 0.02 });
  w('router-r2.log.json', { role: 'router', outcome: 'ok', action: 'review', summary: '整体冷审' });
  w('reviewer-r2.json', { role: 'reviewer', round: 2, cost_usd: 0.4, head_sha: 'a'.repeat(40) });
  w('reviewer-r2.log.json', { role: 'reviewer', outcome: 'fail', tier: 'unit', summary: 'AC-001 fail lib/x.mjs:1' });

  const view = buildRoundsView(cfg, id);
  assert.equal(view.records.length, 4);
  assert.deepEqual(view.routerRounds.map((r) => r.round), [1, 2]);
  assert.equal(view.routerRounds[0].router.action, 'maker');
  assert.deepEqual(view.routerRounds[0].agents.map((a) => a.role), ['maker']);
  assert.equal(view.routerRounds[1].agents[0].outcome, 'fail');
  assert.equal(view.routerRounds[1].agents[0].tier, 'unit');
});

// ---- 并行纪元：一轮里多个 worker、以及没有 router 记录的轮次（自动续跑 / 摘要轮） ----

test('groupRecordsByRound：一轮里并行的多个 worker 全部进 agents，顺序与记录一致', () => {
  const rec = (round, role, over = {}) => ({ round, role, ...over });
  const groups = groupRecordsByRound([
    rec(2, 'router', { action: 'dispatch' }),
    rec(2, 'worker', { key: 'api-layer', profile: 'write' }),
    rec(2, 'worker', { key: 'docs', profile: 'write' }),
    rec(2, 'worker', { key: 'tests', profile: 'write' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].router.action, 'dispatch');
  assert.deepEqual(groups[0].agents.map((a) => a.key), ['api-layer', 'docs', 'tests']);
  assert.equal(groups[0].precommit, null);
  assert.equal(groups[0].human, null);
});

test('groupRecordsByRound：没有 router 记录的轮次照样成组（自动续跑 / 摘要轮），router 恒 null', () => {
  const groups = groupRecordsByRound([
    { round: 1, role: 'digest' },
    { round: 3, role: 'worker', key: 'api-layer', resume_of: 2 },
    { round: 3, role: 'precommit' },
    { round: 2, role: 'router', action: 'dispatch' },
  ]);
  assert.deepEqual(groups.map((g) => g.round), [1, 2, 3], '按轮号升序，缺 router 的轮次不被丢掉');
  assert.equal(groups[0].router, null);
  assert.deepEqual(groups[0].agents.map((a) => a.role), ['digest']);
  assert.equal(groups[2].router, null);
  assert.equal(groups[2].agents[0].resume_of, 2);
  assert.ok(groups[2].precommit, 'precommit 不进 agents，占自己的槽');
});

test('buildRoundsView：并行 worker 与 digest 的案卷合成出带 key/profile/续接关系的记录', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260920-300';
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  w('digest-r1.json', { role: 'digest', round: 1, cost_usd: 0.01 });
  w('digest-r1.log.json', { role: 'digest', outcome: 'ok', summary: '摘要已写' });
  w('router-r2.json', { role: 'router', round: 2, cost_usd: 0.02 });
  // dispatch 的 assignments 走内核契约（lib/assignment-contract.mjs），字段少一个 log 就是 invalid
  const assignment = (key, title, intent, paths) => ({
    key, profile: 'write', intent, title,
    purpose: `${title}：本轮目的`, inputs: [`specs/${id}.md`], scope: '只改声明的 paths',
    deliverables: '代码改动与测试', done_when: '相关 AC 有测试钉住', paths,
  });
  w('router-r2.log.json', {
    role: 'router', outcome: 'ok', action: 'dispatch', summary: '并行两个包',
    assignments: [
      assignment('api-layer', '实现 API 层', 'implement', ['lib/api']),
      assignment('docs', '更新文档', 'implement', ['docs']),
    ],
  });
  w('worker-api-layer-r2.json', {
    role: 'worker', round: 2, key: 'api-layer', profile: 'write', intent: 'implement',
    title: '实现 API 层', cost_usd: 1.2, integration: 'integrated',
  });
  w('worker-api-layer-r2.log.json', {
    role: 'worker', outcome: 'ok', summary: 'AC-001 done', done: ['AC-001'], remaining: [],
  });
  w('worker-docs-r2.json', {
    role: 'worker', round: 2, key: 'docs', profile: 'write', intent: 'implement',
    title: '更新文档', cost_usd: 0.4, truncated: true,
  });
  w('worker-docs-r2.log.json', { role: 'worker', outcome: 'partial', summary: '写了一半', done: [], remaining: ['README'] });
  w('worker-docs-r3.json', {
    role: 'worker', round: 3, key: 'docs', profile: 'write', intent: 'implement',
    title: '更新文档', cost_usd: 0.3, resume_of: 2,
  });
  w('worker-docs-r3.log.json', { role: 'worker', outcome: 'ok', summary: '补完', done: ['README'], remaining: [] });

  const view = buildRoundsView(cfg, id);
  assert.deepEqual(view.routerRounds.map((r) => r.round), [1, 2, 3]);
  assert.equal(view.routerRounds[0].router, null, '摘要轮没有 router 记录');
  assert.deepEqual(view.routerRounds[0].agents.map((a) => a.role), ['digest']);

  const r2 = view.routerRounds[1];
  assert.equal(r2.router.action, 'dispatch');
  assert.deepEqual(r2.agents.map((a) => a.key), ['api-layer', 'docs']);
  assert.equal(r2.agents[0].role, 'worker');
  assert.equal(r2.agents[0].profile, 'write');
  assert.equal(r2.agents[0].intent, 'implement');
  assert.equal(r2.agents[0].integration, 'integrated');
  assert.deepEqual(r2.agents[0].done, ['AC-001']);
  assert.equal(r2.agents[1].truncated, true);

  const r3 = view.routerRounds[2];
  assert.equal(r3.router, null, '自动续跑的轮次没有 router 记录，但必须成组');
  assert.equal(r3.agents[0].resume_of, 2);
  assert.equal(r3.agents[0].outcome, 'ok');
});

test('buildRoundsView：旧任务不合成 records（同名 maker-r<n>.json 不当新契约看），四门口径不变（AC-029）', (t) => {
  const root = mkroot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = baseCfg(root);
  const id = 'task-20260713-201';
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'maker-r1.json'), JSON.stringify({ role: 'maker', round: 1, ok: true, cost_usd: 2 }));
  fs.writeFileSync(path.join(dir, 'verify-r1.verdict.json'), JSON.stringify({
    overall: 'pass', criteria_results: [{ ac_id: 'AC-001', status: 'pass' }],
  }));

  const view = buildRoundsView(cfg, id);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.routerRounds, []);
  assert.equal(view.rounds[0].maker.status, 'ok');
  assert.equal(view.rounds[0].verifier.overall, 'pass');
});
