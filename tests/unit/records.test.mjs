// 单元：记录合成与渲染（AC-009 / AC-010，AC-040 的状态表与主责包渲染面）。
// 核心不变量：①内核只读不写，绝不改 agent 写的 .log.json；②log 缺失/非法只是记录里的一个
// 字段（product），不是异常路径；③product ≠ ok 时契约字段一律 null——版本规则读的是这些字段，
// 绝不能被一份非法 log 蒙混过去；④渲染窗口压的是 prompt 不是案卷，而人的裁决一个字都不压。
// 角色空间含 dispatch 线的 worker（worker-<key>-r<n>.json，带委派身份与集成结论）与 digest。
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
const SPEC_SHA = 'c3d4e5f6'.repeat(8); // 获批 spec 的内容哈希（sha256，64 位）：派出时绑定，进 worker 的 spawn 记录

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

/**
 * worker 的 spawn 记录（stages/actions/dispatch.mjs 派出时由内核写，结束后再 patch
 * progress / integration / violations）：委派身份 key / profile / intent / title 与绑定的
 * spec 版本全是内核事实，agent 碰不到。
 */
const workerSpawn = (key, over = {}) => ({
  role: 'worker', round: 3, key, profile: 'write', intent: 'implement', title: `${key} 的活`,
  isolation: 'hooks-only', placement: 'inplace', dispatch_round: 3, base_head: B, spec_sha: SPEC_SHA,
  started: '2026-08-30T00:00:00.000Z', done: '2026-08-30T00:20:00.000Z',
  ok: true, session_id: 's-w', cost_usd: 5.5, raw: { subtype: 'success' },
  progress: 'changed', integration: 'integrated', ...over,
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

test('AC-014: 被版本规则拒回的 merge 闸渲染成 void(version_gate)，不是长期 pending', (t) => {
  const d = makeDossier(t);
  // 被拒回的那一轮：内核按批准时刻的 H/B 复算后拒了，人没有裁决过任何事 —— 记录里没有 decision，
  // 事实落在 events.jsonl 的 stale_review 上。
  d.write('human-r2.json', {
    schema_version: 1, kind: 'merge', requested_by: 'kernel', summary: '申请合并', refs: [],
    requested_at: '2026-08-30T01:00:00.000Z',
  });
  // 真正还等着人点的那一轮：没有事件，照旧 pending。
  d.write('human-r3.json', {
    schema_version: 1, kind: 'merge', requested_by: 'kernel', summary: '再次申请合并', refs: [],
    requested_at: '2026-08-30T02:00:00.000Z',
  });
  d.writeRaw('events.jsonl', [
    JSON.stringify({ ts: '2026-08-30T01:05:00.000Z', type: 'stale_review', round: 2, head_sha: H, base_sha: B }),
    '{ 半行坏 JSON',
    '',
  ].join('\n'));

  const records = composeRecords(d.cfg, d.id);
  const [r2, r3] = records;
  assert.equal(r2.decision, null, 'human 记录本身一个字节没改，仍然没有 decision');
  assert.equal(r2.void_reason, 'version_gate');
  assert.equal(r3.void_reason, null);

  const rendered = renderRecordsForRouter(records);
  assert.match(rendered, /r2 human\s+kind=merge\s+decision=void\(version_gate\)/);
  assert.match(rendered, /r3 human\s+kind=merge\s+decision=pending/);
  // 「已裁决事项」只收真正裁决过的：作废的闸不是人的决定，不进 Invariant 7 的比对面。
  assert.equal(renderDecisions(records), '');
});

test('AC-014: main_moved 同样作废该轮闸；无事件文件时一切照旧', (t) => {
  const d = makeDossier(t);
  d.write('human-r1.json', { schema_version: 1, kind: 'merge', requested_by: 'kernel', summary: '申请合并', refs: [] });
  assert.equal(composeRecords(d.cfg, d.id)[0].void_reason, null, '没有 events.jsonl 时不臆断');

  d.writeRaw('events.jsonl', `${JSON.stringify({ ts: '2026-08-30T01:00:00.000Z', type: 'main_moved', round: 1 })}\n`);
  assert.equal(composeRecords(d.cfg, d.id)[0].void_reason, 'version_gate');

  // 人真的点过的记录不受影响：有 decision 就按 decision 渲染。
  d.write('human-r1.json', {
    schema_version: 1, kind: 'merge', requested_by: 'kernel', summary: '申请合并', refs: [],
    decision: 'rejected', notes: '命名再改一版',
  });
  const rec = composeRecords(d.cfg, d.id)[0];
  assert.equal(rec.void_reason, null);
  assert.match(renderRecordsForRouter([rec]), /decision=rejected/);
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

test('worker 记录：worker-<key>-r<n>.json 归位，内核事实（key/profile/intent/title/spec_sha/progress/integration）+ log 的 done/remaining', (t) => {
  const d = makeDossier(t);
  d.write('worker-curve-fix-r3.json', workerSpawn('curve-fix', { title: '扣掉 pendingCreatorFee' }));
  d.write('worker-curve-fix-r3.log.json', {
    role: 'worker', outcome: 'partial', summary: 'sweep 已扣费；回归用例还差两条',
    done: ['Curve.sol sweep 扣 pendingCreatorFee'], remaining: ['补 sweep 的回归用例'],
  });
  d.writeRaw('worker-curve-fix-r3.report.md', '# 报告\n');

  const [rec] = composeRecords(d.cfg, d.id);
  assert.equal(rec.role, 'worker', '文件名的 worker-<key> 段决定角色，不看 log 自述');
  assert.equal(rec.round, 3);
  assert.equal(rec.key, 'curve-fix', 'key 带连字符也要整段还原，不能被 -r<n> 的分段切碎');
  assert.equal(rec.profile, 'write');
  assert.equal(rec.intent, 'implement');
  assert.equal(rec.title, '扣掉 pendingCreatorFee');
  assert.equal(rec.spec_sha, SPEC_SHA, '派出时绑定的 spec 版本：过期判定（AC-014 一族）读的就是它');
  assert.equal(rec.progress, 'changed', '进度证据由内核核实（worktree / HEAD / 报告），不是 agent 自述');
  assert.equal(rec.integration, 'integrated', '集成结论是内核 merge 的结果，与 outcome 是两回事');
  assert.equal(rec.product, 'ok');
  assert.equal(rec.outcome, 'partial', 'worker 的 partial 是合法 outcome（有进展没做完）');
  assert.deepEqual(rec.done, ['Curve.sol sweep 扣 pendingCreatorFee']);
  assert.deepEqual(rec.remaining, ['补 sweep 的回归用例']);
  assert.equal(rec.cost_usd, 5.5);
  assert.equal(rec.duration_ms, 1200000);
  assert.equal(rec.interrupted, false);
  // artifacts 只列真实存在的文件：router 要细节就照这个名字 Read，内核不替它转述。
  assert.deepEqual(rec.artifacts, {
    report: 'worker-curve-fix-r3.report.md', log: 'worker-curve-fix-r3.log.json',
  });

  const rendered = renderRecordsForRouter([rec]);
  assert.match(rendered, /^r3 worker curve-fix outcome=partial {2}profile=write {2}intent=implement/m);
  assert.match(rendered, / {2}progress=changed {2}integration=integrated {2}product=ok$/m);
  assert.match(rendered, /^ {3}done: Curve\.sol sweep 扣 pendingCreatorFee$/m);
  assert.match(rendered, /^ {3}remaining: 补 sweep 的回归用例$/m);
  assert.match(rendered, /↳ 完整产物：worker-curve-fix-r3\.report\.md/);
});

test('worker 记录：log 缺失 / 不合契约时内核不编 outcome，但自己核实过的事实一条不少', (t) => {
  const d = makeDossier(t);
  // 被静默超时杀掉的只读委派：没写 log，但内核知道它没留下进展、也知道钱花得不明不白。
  d.write('worker-probe-r4.json', workerSpawn('probe', {
    round: 4, profile: 'read', intent: 'investigate', done: undefined,
    ok: false, killed: 'inactivity', cost_usd: 0, cost_unknown: true,
    progress: 'none', integration: 'done',
  }));
  d.writeRaw('worker-probe-r4.salvage.json', '{}\n');
  // 写了 log 但越界盖内核的章（tier 是 reviewer 专属）：整份 log 不携带契约级语义。
  d.write('worker-fixdeps-r5.json', workerSpawn('fixdeps', { round: 5, progress: 'changed', integration: 'conflict' }));
  d.write('worker-fixdeps-r5.log.json', {
    role: 'worker', outcome: 'ok', tier: 'unit', summary: '依赖已升级',
    done: ['bump viem'], remaining: [],
  });

  const byKey = Object.fromEntries(composeRecords(d.cfg, d.id).map((r) => [r.key, r]));
  assert.equal(byKey.probe.product, 'missing');
  assert.equal(byKey.probe.product_error, null);
  assert.equal(byKey.probe.outcome, null, '没有 log 就是未知，绝不当成功');
  assert.equal(byKey.probe.done, null);
  assert.equal(byKey.probe.remaining, null);
  assert.equal(byKey.probe.summary, null);
  assert.equal(byKey.probe.written_at, null, 'log 不存在就没有写入时刻，不拿 spawn 记录的时间冒充');
  assert.equal(byKey.probe.interrupted, true, 'killed=inactivity → 会话没正常收尾，这是执行事实');
  assert.equal(byKey.probe.cost_unknown, true);
  assert.equal(byKey.probe.progress, 'none');
  assert.equal(byKey.probe.integration, 'done');
  assert.deepEqual(byKey.probe.artifacts, { salvage: 'worker-probe-r4.salvage.json' });

  assert.equal(byKey.fixdeps.product, 'invalid');
  assert.match(byKey.fixdeps.product_error.join(), /tier 是 reviewer \/ router\(precommit\) 专属字段/);
  assert.equal(byKey.fixdeps.outcome, null, '不合契约的 log 不携带 outcome');
  assert.equal(byKey.fixdeps.done, null, '进度清单同样不作数：一份非法 log 不能拿「我做完了」蒙混');
  assert.equal(byKey.fixdeps.remaining, null);
  assert.equal(byKey.fixdeps.summary, '依赖已升级', 'summary 仍原样交给 router');
  assert.equal(byKey.fixdeps.integration, 'conflict', '内核的集成结论与 log 合不合契约无关');

  const rendered = renderRecordsForRouter(composeRecords(d.cfg, d.id));
  assert.match(rendered, /^r4 worker probe {3}outcome=- .*cost=\$0\.00\(含未知\).*interrupted=yes.*product=missing$/m);
  assert.match(rendered, /product=invalid {2}product_error=.*tier 是 reviewer/m);
});

test('outcome 闭集按角色算：worker 的 blocked 合法、maker 的 blocked 非法；digest 只收 ok|fail', (t) => {
  const d = makeDossier(t);
  d.write('digest-r1.json', spawnRec({ role: 'digest', cost_usd: 0.4, spec_sha: SPEC_SHA }));
  d.write('digest-r1.log.json', { role: 'digest', outcome: 'ok', summary: '摘要覆盖 19 条 AC' });
  d.write('digest-r2.json', spawnRec({ role: 'digest', round: 2, cost_usd: 0.3 }));
  d.write('digest-r2.log.json', { role: 'digest', outcome: 'partial', summary: '只摘了一半' });
  d.write('worker-deps-r3.json', workerSpawn('deps', { round: 3 }));
  d.write('worker-deps-r3.log.json', { role: 'worker', outcome: 'blocked', summary: '依赖的 P-001 还没进主线' });
  d.write('maker-r4.json', spawnRec({ round: 4 }));
  d.write('maker-r4.log.json', { role: 'maker', outcome: 'blocked', summary: '同一句话，换个角色写就不合契约' });

  const byRound = Object.fromEntries(composeRecords(d.cfg, d.id).map((r) => [r.round, r]));
  assert.equal(byRound[1].role, 'digest', 'digest-r<n>.json 与其他角色同一条合成路径');
  assert.equal(byRound[1].product, 'ok');
  assert.equal(byRound[1].spec_sha, SPEC_SHA, '摘要是给哪一版 spec 做的，是内核盖的章');
  assert.equal(byRound[2].product, 'invalid', 'digest 只允许 ok|fail');
  assert.match(byRound[2].product_error.join(), /outcome 取值非法.*partial/);
  assert.equal(byRound[3].outcome, 'blocked', 'blocked = 依赖失效 / 约束冲突，是 worker 专属的合法结论');
  assert.equal(byRound[4].product, 'invalid', 'maker 没有 blocked：闭集是逐角色的，不是全局并集');
  assert.match(byRound[4].product_error.join(), /maker 允许 ok \| partial \| fail \| needs_human/);
});

test('记录只认 <base>-r<n>.json：dispatch 台账与光秃秃的产物都不是记录；同轮先按角色序、再按 key 排', (t) => {
  const d = makeDossier(t);
  d.write('dispatch-r2.json', { round: 2, closed: true, assignments: [{ key: 'alpha' }, { key: 'beta' }] });
  d.writeRaw('worker-gamma-r2.salvage.json', '{}\n'); // 只有残骸、没有 spawn 记录 → 不凭空生出一条记录
  d.write('reviewer-r2.json', spawnRec({ role: 'reviewer', round: 2, head_sha: H }));
  d.write('reviewer-r2.log.json', { role: 'reviewer', outcome: 'ok', tier: 'unit', summary: '全 pass' });
  d.write('human-r2.json', { kind: 'help', requested_by: 'kernel', summary: '越界了', refs: [] });
  d.write('digest-r2.json', spawnRec({ role: 'digest', round: 2 }));
  d.write('digest-r2.log.json', { role: 'digest', outcome: 'ok', summary: '摘要' });
  // 先写 beta 再写 alpha：写入顺序不该决定呈现顺序，key 才是同轮同角色的稳定次序。
  d.write('worker-beta-r2.json', workerSpawn('beta', { round: 2 }));
  d.write('worker-beta-r2.log.json', { role: 'worker', outcome: 'ok', summary: 'beta 做完' });
  d.write('worker-alpha-r2.json', workerSpawn('alpha', { round: 2 }));
  d.write('worker-alpha-r2.log.json', { role: 'worker', outcome: 'ok', summary: 'alpha 做完' });
  // key 里本来就可以含 r<数字> 段（只禁止以它结尾）：轮次是**最后**那个 -r<n>，不是第一个。
  d.write('worker-a-r2fix-r6.json', workerSpawn('a-r2fix', { round: 6 }));
  d.write('worker-a-r2fix-r6.log.json', { role: 'worker', outcome: 'ok', summary: '收尾' });
  const sameMtime = new Date('2026-08-30T03:00:00.000Z'); // 同毫秒落盘时 written_at 打平，逼出 key 这一层
  for (const n of ['worker-beta-r2.log.json', 'worker-alpha-r2.log.json']) {
    fs.utimesSync(path.join(d.dir, n), sameMtime, sameMtime);
  }

  const records = composeRecords(d.cfg, d.id);
  assert.deepEqual(
    records.map((r) => `r${r.round} ${r.role}${r.key ? `:${r.key}` : ''}`),
    ['r2 digest', 'r2 human', 'r2 worker:alpha', 'r2 worker:beta', 'r2 reviewer', 'r6 worker:a-r2fix'],
    'ROLE_ORDER：digest → human → worker/maker → reviewer；同角色再按 key；轮次永远排在最前',
  );
  assert.equal(records.length, 6, 'dispatch 台账与孤立的 .salvage.json 都不是记录');
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

// 窗口渲染用的最小记录（renderRecordsForRouter 是纯函数，直接给记录对象最能盯住切分本身）。
const agentRec = (round, over = {}) => ({
  round, role: 'maker', package: null, product: 'ok', outcome: 'ok',
  summary: `r${round} 摘要`, done: [`r${round} 完成项`], cost_usd: 1, truncated: false,
  artifacts: { report: `maker-r${round}.report.md`, log: `maker-r${round}.log.json` }, ...over,
});

test('渲染窗口：窗口外压成一行索引（结论还在），窗口内才带 summary / 进度 / 产物指路', () => {
  const records = [1, 2, 3, 4].map((n) => agentRec(n));
  const text = renderRecordsForRouter(records, { window: 2 });
  const lines = text.split('\n');

  assert.equal(lines[0], '（更早的 2 条记录只列索引；要看原文就 Read 对应的 <名字>.log.json / .report.md）');
  // 压缩的是 prompt 不是案卷：索引行仍带 outcome / cost / product，router 一眼知道那几轮是什么结局，
  // 需要原文时按 `r<n> <role>` 推出文件名自己 Read。
  assert.equal(lines[1], 'r1 maker          outcome=ok  cost=$1.00  truncated=no  product=ok');
  assert.equal(lines[2], 'r2 maker          outcome=ok  cost=$1.00  truncated=no  product=ok');
  assert.equal(lines[3], 'r3 maker          outcome=ok  cost=$1.00  truncated=no  product=ok');
  assert.equal(lines[4], '   r3 摘要');
  assert.equal(lines[5], '   done: r3 完成项');
  assert.equal(lines[6], '   ↳ 完整产物：maker-r3.report.md');
  assert.equal(lines.length, 11, '2 条索引 + 2 条四行全文 + 1 行说明');
  assert.equal(/r1 摘要|r2 摘要/.test(text), false, '窗口外不带 summary');
  assert.equal(/maker-r1\.report\.md/.test(text), false, '窗口外不带产物指路');
  assert.match(text, /r4 摘要/);

  // 边界：window 恰等于记录条数 → 一条都不压，也不出现那行说明。
  const full = renderRecordsForRouter(records, { window: 4 });
  assert.equal(/只列索引/.test(full), false);
  assert.match(full, /^ {3}r1 摘要$/m);
  assert.equal(full, renderRecordsForRouter(records), 'window 够大等同于不给 window');

  // 非正整数一律当「不限窗」：宁可 prompt 长，也不能因为一个坏配置悄悄把历史砍掉。
  for (const w of [null, undefined, 0, -1, 2.5, '2']) {
    assert.equal(renderRecordsForRouter(records, { window: w }), full, `window=${String(w)} 不该触发压缩`);
  }
});

test('渲染窗口：人的裁决永不压缩——再老的裁决也要逐字摆在 router 面前', () => {
  const human = {
    round: 1, role: 'human', kind: 'spec', decision: 'approved',
    notes: '按 4 包做；待决 1 取 A；P-003 本期不做', refs: [],
  };
  const records = [human, ...[2, 3, 4, 5].map((n) => agentRec(n))];
  const text = renderRecordsForRouter(records, { window: 1 });

  assert.match(text, /（更早的 4 条记录只列索引/);
  // human 在最老的位置（index 0，远在窗口外），notes 仍然一字不差：Invariant 7 靠它执法，
  // 一旦被压成索引，router 就会「忘记」人定过的范围，再去做已经被否掉的事。
  assert.match(text, /^r1 human {10}kind=spec {2}decision=approved {2}notes="按 4 包做；待决 1 取 A；P-003 本期不做"$/m);
  assert.match(text, /^r2 maker {10}outcome=ok/m);
  assert.equal(/r2 摘要|r3 摘要|r4 摘要/.test(text), false, '同样在窗口外的 agent 记录照压不误');
  assert.match(text, /^ {3}r5 摘要$/m, '窗口内的那一条仍是全文');
  // 另一条路（事实段的「已裁决事项」）同样逐字保留，两处口径一致。
  assert.match(renderDecisions(records), /r1 kind=spec decision=approved notes="按 4 包做；待决 1 取 A；P-003 本期不做"/);
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
