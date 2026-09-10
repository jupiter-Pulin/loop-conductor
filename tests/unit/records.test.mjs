// 单元：记录合成与渲染（AC-009 / AC-010，AC-040 的状态表与主责包渲染面）。
// 核心不变量：①内核只读不写，绝不改 agent 写的 .log.json；②log 缺失/非法只是记录里的一个
// 字段（product），不是异常路径；③product ≠ ok 时契约字段一律 null——版本规则读的是这些字段，
// 绝不能被一份非法 log 蒙混过去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  composeRecords, renderRecordsForRouter, renderFacts, renderDecisions,
  renderPackageStatusTable, renderAcOwners,
} from '../../conductor/lib/records.mjs';
import { needReview } from '../../conductor/lib/version-gate.mjs';

const H = 'a1b2c3d4'.repeat(5);
const B = 'e5f6a7b8'.repeat(5);

function makeDossier(t, id = 'task-20260830-001') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'));
  const dir = path.join(root, 'dossier', id);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { root, dossierDir: path.join(root, 'dossier') };
  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(obj, null, 2)}\n`);
  const writeRaw = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  return { cfg, id, dir, write, writeRaw };
}

const spawnRec = (over = {}) => ({
  role: 'maker', round: 1, started: '2026-08-30T00:00:00.000Z', done: '2026-08-30T00:10:00.000Z',
  ok: true, session_id: 's-1', cost_usd: 8.1, raw: { subtype: 'success' }, ...over,
});

test('AC-009: spawn 记录 + log 合成一条；内核字段来自 spawn 记录，契约字段来自 log', (t) => {
  const d = makeDossier(t);
  d.write('maker-r1.json', spawnRec({ head_sha: H, base_sha: B, package: 'P-001', mode: 'cold' }));
  d.write('maker-r1.log.json', { role: 'maker', outcome: 'ok', summary: 'AC-001..004 done；npm test 41/41 绿' });

  const [rec] = composeRecords(d.cfg, d.id);
  assert.equal(rec.role, 'maker');
  assert.equal(rec.round, 1);
  assert.equal(rec.product, 'ok');
  assert.equal(rec.product_error, null);
  assert.equal(rec.outcome, 'ok');
  assert.equal(rec.summary, 'AC-001..004 done；npm test 41/41 绿');
  assert.equal(rec.cost_usd, 8.1);
  assert.equal(rec.truncated, false);
  assert.equal(rec.duration_ms, 600000);
  assert.equal(rec.session_id, 's-1');
  assert.equal(rec.head_sha, H);
  assert.equal(rec.base_sha, B);
  assert.equal(rec.package, 'P-001');
  assert.equal(rec.mode, 'cold');
  assert.ok(Date.parse(rec.written_at) > 0);
});

test('AC-009: package / mode / head_sha / base_sha 缺省为 null（P2 才写入）', (t) => {
  const d = makeDossier(t);
  d.write('maker-r1.json', spawnRec());
  d.write('maker-r1.log.json', { role: 'maker', outcome: 'ok', summary: 'done' });
  const [rec] = composeRecords(d.cfg, d.id);
  assert.equal(rec.package, null);
  assert.equal(rec.mode, null);
  assert.equal(rec.head_sha, null);
  assert.equal(rec.base_sha, null);
});

test('AC-009: log 不存在 → product=missing；非法 → product=invalid 且带校验错误', (t) => {
  const d = makeDossier(t);
  d.write('maker-r1.json', spawnRec({ raw: { subtype: 'error_max_turns' }, cost_usd: 6.2 }));
  d.write('reviewer-r1.json', spawnRec({ role: 'reviewer', cost_usd: 4.1, head_sha: H }));
  d.writeRaw('reviewer-r1.log.json', '{ not json');
  d.write('spec-r1.json', spawnRec({ role: 'spec', cost_usd: 3.65 }));
  d.write('spec-r1.log.json', { role: 'spec', outcome: 'ok', summary: 'x', cost_usd: 3.65 }); // 未知字段

  const byRole = Object.fromEntries(composeRecords(d.cfg, d.id).map((r) => [r.role, r]));
  assert.equal(byRole.maker.product, 'missing');
  assert.equal(byRole.maker.product_error, null);
  assert.equal(byRole.maker.outcome, null);
  assert.equal(byRole.maker.truncated, true, 'raw.subtype=error_max_turns → truncated');
  assert.equal(byRole.maker.cost_usd, 6.2, 'cost 照记，撞 max-turns 也花了钱');

  assert.equal(byRole.reviewer.product, 'invalid');
  assert.match(byRole.reviewer.product_error.join(), /不是合法 JSON/);
  assert.equal(byRole.reviewer.outcome, null);

  assert.equal(byRole.spec.product, 'invalid');
  assert.match(byRole.spec.product_error.join(), /未知字段/);
  assert.equal(byRole.spec.outcome, null, '不合契约的 log 不携带契约级语义');
  assert.equal(byRole.spec.summary, 'x', 'summary 仍原样交给 router');
});

test('AC-009: 合成过程不写任何文件', (t) => {
  const d = makeDossier(t);
  d.write('maker-r1.json', spawnRec());
  d.write('maker-r1.log.json', { role: 'maker', outcome: 'ok', summary: 'done' });
  const before = fs.readdirSync(d.dir).sort();
  const logBytes = fs.readFileSync(path.join(d.dir, 'maker-r1.log.json'));
  composeRecords(d.cfg, d.id);
  composeRecords(d.cfg, d.id);
  assert.deepEqual(fs.readdirSync(d.dir).sort(), before);
  assert.deepEqual(fs.readFileSync(path.join(d.dir, 'maker-r1.log.json')), logBytes, '内核绝不改写 agent 的 log');
});

test('AC-010: 截断的 reviewer —— 合法 JSON 带「未判」清单 → product=ok / outcome=fail / truncated=true', (t) => {
  const d = makeDossier(t);
  d.write('reviewer-r1.json', spawnRec({
    role: 'reviewer', head_sha: H, cost_usd: 4.1, raw: { subtype: 'error_max_turns' },
  }));
  d.write('reviewer-r1.log.json', {
    role: 'reviewer',
    outcome: 'fail',
    tier: 'integration',
    summary: 'AC-001 pass\nAC-002 pass\nAC-003 fail src/launch/Curve.sol:412 sweep 未扣 pendingCreatorFee\n未判: AC-004, AC-005',
  });

  const records = composeRecords(d.cfg, d.id);
  const [rec] = records;
  assert.equal(rec.product, 'ok', '截断留下的是合法记录，不是空文件');
  assert.equal(rec.outcome, 'fail');
  assert.equal(rec.truncated, true);
  assert.equal(rec.tier, 'integration');
  assert.match(rec.summary, /未判: AC-004, AC-005/);

  const rendered = renderRecordsForRouter(records);
  assert.match(rendered, /未判: AC-004, AC-005/, 'router 能完整看到未判清单');
  assert.match(rendered, /truncated=yes/);
  assert.equal(needReview(records, H), true, '未判完 → need_review 保持 true');
});

test('AC-009: precommit 记录走同一契约；非法时同样只是 product=invalid', (t) => {
  const d = makeDossier(t);
  d.write('precommit-r1.json', {
    role: 'precommit', outcome: 'fail', tier: 'unit', cost_usd: 0,
    summary: 'build ok 42s；unit 3 fail: test/parse.test.mjs › 空板块不抛错',
    base_sha: B, head_sha: H, candidate_sha: 'f'.repeat(40),
    steps: [{ step: 'unit', command: 'npm test', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 9000, tail: '3 fail' }],
    skipped_tiers: ['integration', 'e2e'], conflict_files: [],
  });
  d.write('precommit-r2.json', { role: 'precommit', outcome: 'ok' }); // 缺一堆字段

  const [r1, r2] = composeRecords(d.cfg, d.id);
  assert.equal(r1.product, 'ok');
  assert.equal(r1.outcome, 'fail');
  assert.equal(r1.head_sha, H);
  assert.equal(r1.base_sha, B);
  assert.equal(r1.cost_usd, 0);
  assert.equal(r2.product, 'invalid');
  assert.equal(r2.outcome, null);
});

test('AC-009: 方案模式的 spec-agent（spec-plan-r<n>）与包 maker（maker-P-xxx-r<n>）各自归位', (t) => {
  const d = makeDossier(t);
  d.write('spec-plan-r1.json', spawnRec({ role: 'spec', mode: 'plan', cost_usd: 1.2 }));
  d.write('spec-plan-r1.log.json', { role: 'spec', outcome: 'ok', summary: '工作包 4；P-001 覆盖已完成的 AC-001..006' });
  d.write('maker-P-002-r1.json', spawnRec({ package: 'P-002', cost_usd: 9.4 }));
  d.write('maker-P-002-r1.log.json', { role: 'maker', outcome: 'ok', summary: 'AC-005..009 done' });

  const records = composeRecords(d.cfg, d.id);
  const plan = records.find((r) => r.mode === 'plan');
  assert.equal(plan.role, 'spec', '方案模式仍是 spec 角色');
  assert.equal(plan.product, 'ok');
  const pkg = records.find((r) => r.package === 'P-002');
  assert.equal(pkg.role, 'maker');
  assert.equal(pkg.product, 'ok');
  assert.match(renderRecordsForRouter(records), /r1 maker P-002/);
});

test('AC-012: 人的裁决进记录列表并渲染成「已裁决事项」（Invariant 7 的执法依据）', (t) => {
  const d = makeDossier(t);
  d.write('human-r1.json', {
    kind: 'spec', requested_by: 'kernel', summary: 'spec 待审',
    refs: ['specs/x.md'], decision: 'approved', notes: '按 4 包做；待决 1 取 A', no_packages: false,
  });
  const records = composeRecords(d.cfg, d.id);
  const [human] = records;
  assert.equal(human.role, 'human');
  assert.equal(human.kind, 'spec');
  assert.equal(human.decision, 'approved');
  assert.equal(human.notes, '按 4 包做；待决 1 取 A');
  assert.equal(human.no_packages, false);

  const line = renderRecordsForRouter(records);
  assert.match(line, /^r1 human {10}kind=spec {2}decision=approved/m);
  assert.match(renderDecisions(records), /notes="按 4 包做；待决 1 取 A"/);
});

test('渲染：一条两行、标签对齐、summary 换行整体缩进', (t) => {
  const d = makeDossier(t);
  d.write('spec-r1.json', spawnRec({ role: 'spec', cost_usd: 3.65 }));
  d.write('spec-r1.log.json', { role: 'spec', outcome: 'ok', summary: 'AC×19；工作包 4；待决 2' });
  const lines = renderRecordsForRouter(composeRecords(d.cfg, d.id)).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^r1 spec {11}outcome=ok {2}cost=\$3\.65 {2}truncated=no {2}product=ok$/);
  assert.equal(lines[1], '   AC×19；工作包 4；待决 2');
});

test('renderFacts：两个布尔量与两个 sha 直接给 router；空段不出现', () => {
  const facts = renderFacts({
    stage: 'ROUTING', round: 3, head: H, base: B,
    needReview: false, needPrecommit: true, hasDiff: true,
    lastActionRejected: 'merge 被拒：need_precommit=true',
    spentUsd: 12.5, budgetUsd: 40,
    records: [{ role: 'human', round: 1, kind: 'spec', decision: 'approved', notes: '按 4 包做' }],
  });
  assert.match(facts, /stage=ROUTING {2}round=r3/);
  assert.match(facts, /H=a1b2c3 {2}B=e5f6a7/);
  assert.match(facts, /need_review=false {2}need_precommit=true/);
  assert.match(facts, /任务分支相对 base 有 diff：yes/);
  assert.match(facts, /最近一次 action_rejected/);
  assert.match(facts, /预算：已花 \$12\.50 \/ 上限 \$40\.00/);
  assert.match(facts, /已裁决事项/);
  assert.equal(/工作包状态表/.test(facts), false, '无方案时不渲染状态表');
  assert.equal(/AC 主责包/.test(facts), false);
});

test('renderFacts：限额段 + 工作包状态表 / AC 主责包接口（P2b 填内容）', () => {
  assert.equal(renderPackageStatusTable([]), '');
  assert.equal(renderPackageStatusTable(null), '');
  assert.equal(renderAcOwners({}), '');
  const facts = renderFacts({
    head: H, base: B, needReview: true, needPrecommit: true,
    rateLimit: { type: 'five_hour', resets_at: 1788068400 },
    packageRows: [{
      id: 'P-002', title: 'Curve', acs: ['AC-005', 'AC-009'], deps: ['P-001'],
      files: ['src/launch/Curve.sol'], state: 'integrated', integrated_sha: 'e4f5a6b7c8',
      rounds: 1, cost_usd: 9.4, note: null,
    }],
    acOwners: { 'AC-005': 'P-002' },
  });
  assert.match(facts, /限额：five_hour，重置于 2026-08-30T05:40:00\.000Z/);
  assert.match(facts, /P-002 {2}Curve {2}acs=AC-005,AC-009 {2}deps=P-001/);
  assert.match(facts, /state=integrated@e4f5a6/);
  assert.match(facts, /AC 主责包：AC-005 → P-002/);
});

test('composeRecords：dossier 不存在返回空数组；无关文件被忽略', (t) => {
  const d = makeDossier(t);
  assert.deepEqual(composeRecords({ dossierDir: '/nonexistent' }, 'task-x'), []);
  d.writeRaw('timeline.md', '- x\n');
  d.writeRaw('events.jsonl', '{}\n');
  d.write('spec.md.json', {});
  assert.deepEqual(composeRecords(d.cfg, d.id), []);
});
