// 单元：tools/signatures.mjs —— 签名台账状态机与三次规则（E26/H31）。
// 核心不变量：①occurrence key 幂等——全库重扫计数不变；②distinct ≥3 才 proposal_due；
// ③每 ISO 周提案配额 2 条，超额留 open 下周再排；④28 天静默 → closed，closed/resolved 再现 → reopened；
// ⑤resolve 关联 E# 是唯一人工转移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractOccurrences, updateLedger, emptyLedger, isoWeekKey, routeOf,
} from '../../tools/signatures.mjs';

const DAY = 86400_000;

test('updateLedger：幂等重扫计数不变；3 次触发 proposal_due 并路由', () => {
  const now = Date.parse('2026-07-08T00:00:00Z');
  const occ2 = [
    { sig: 'maker:error_max_turns', key: 't1:r1' },
    { sig: 'maker:error_max_turns', key: 't2:r1' },
  ];
  let r = updateLedger(emptyLedger(), occ2, { nowMs: now });
  assert.equal(r.added, 2);
  assert.equal(r.ledger.signatures['maker:error_max_turns'].state, 'open', '2 次仍 open');

  // 同一批重扫：零新增（幂等）
  r = updateLedger(r.ledger, occ2, { nowMs: now + DAY });
  assert.equal(r.added, 0);
  assert.equal(r.ledger.signatures['maker:error_max_turns'].count, 2);

  // 第 3 个 distinct key → proposal_due + 路由 guard
  r = updateLedger(r.ledger, [...occ2, { sig: 'maker:error_max_turns', key: 't3:r2' }], { nowMs: now + DAY });
  const e = r.ledger.signatures['maker:error_max_turns'];
  assert.equal(e.count, 3);
  assert.equal(e.state, 'proposal_due');
  assert.equal(e.route, 'guard');
  assert.deepEqual(r.newly_due, [{ sig: 'maker:error_max_turns', route: 'guard', count: 3 }]);
});

test('updateLedger：每周提案配额 2 条，超额留 open 下周再排；跨周恢复配额', () => {
  const now = Date.parse('2026-07-08T00:00:00Z'); // 2026-W28
  const occs = [];
  for (const sig of ['a:x', 'b:x', 'c:x']) {
    for (let i = 1; i <= 3 + (sig === 'c:x' ? 2 : 0); i++) occs.push({ sig, key: `t${i}` }); // c:x 5 次最多
  }
  let r = updateLedger(emptyLedger(), occs, { nowMs: now });
  const dueNow = Object.entries(r.ledger.signatures).filter(([, e]) => e.state === 'proposal_due').map(([s]) => s);
  assert.equal(dueNow.length, 2, '本周只放 2 条');
  assert.ok(dueNow.includes('c:x'), '按 count 降序优先（c:x=5 必入）');
  const leftover = Object.entries(r.ledger.signatures).find(([, e]) => e.state === 'open');
  assert.ok(leftover, '第 3 条留 open');

  // 同周再跑：配额已耗尽，不再放
  r = updateLedger(r.ledger, [], { nowMs: now + DAY });
  assert.equal(r.newly_due.length, 0, '同周配额耗尽');

  // 下周：剩余的放行
  r = updateLedger(r.ledger, [], { nowMs: now + 7 * DAY });
  assert.equal(r.newly_due.length, 1);
  assert.equal(r.newly_due[0].sig, leftover[0]);
});

test('updateLedger：28 天静默 closed；closed 与 resolved 再现均 reopened；resolve 关联 E#', () => {
  const now = Date.parse('2026-07-08T00:00:00Z');
  let r = updateLedger(emptyLedger(), [{ sig: 'committer:degraded', key: 't1' }], { nowMs: now });

  // 29 天无新出现 → 本次调用关闭
  r = updateLedger(r.ledger, [], { nowMs: now + 29 * DAY });
  assert.equal(r.ledger.signatures['committer:degraded'].state, 'closed');
  assert.deepEqual(r.closed, ['committer:degraded']);

  // closed 后再现 → reopened
  r = updateLedger(r.ledger, [{ sig: 'committer:degraded', key: 't2' }], { nowMs: now + 30 * DAY });
  assert.equal(r.ledger.signatures['committer:degraded'].state, 'reopened');
  assert.deepEqual(r.reopened, ['committer:degraded']);

  // resolve → resolved 终态
  r = updateLedger(r.ledger, [], { nowMs: now + 31 * DAY, resolves: { 'committer:degraded': 'E27' } });
  assert.equal(r.ledger.signatures['committer:degraded'].state, 'resolved');
  assert.equal(r.ledger.signatures['committer:degraded'].resolved_by, 'E27');

  // resolved 后再现 → reopened（修复无效信号）；且此时 count=3 达阈值 → 同次调用升级 proposal_due
  r = updateLedger(r.ledger, [{ sig: 'committer:degraded', key: 't3' }], { nowMs: now + 32 * DAY });
  assert.deepEqual(r.reopened, ['committer:degraded'], '复发信号必须上报');
  assert.equal(r.ledger.signatures['committer:degraded'].state, 'proposal_due', '复发且达阈值 = 立即要新提案');
});

test('extractOccurrences：全库机械提取九族签名', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signatures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'dossier']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const writeTask = (box, id, runtime, dossier = {}, timeline = null) => {
    const sd = path.join(root, 'state', box, id);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'task.json'), JSON.stringify({ id, kind: 'bugfix' }));
    fs.writeFileSync(path.join(sd, 'runtime.json'), JSON.stringify({ stage: 'DONE', spent_usd: 0, ...runtime }));
    const dd = path.join(root, 'dossier', id);
    fs.mkdirSync(dd, { recursive: true });
    for (const [n, c] of Object.entries(dossier)) fs.writeFileSync(path.join(dd, n), JSON.stringify(c));
    if (timeline) fs.writeFileSync(path.join(dd, 'timeline.md'), timeline);
  };

  writeTask('failed', 'task-20260701-001', { stage: 'FAILED_BOX', last_failure_type: 'budget_exceeded' });
  writeTask('done', 'task-20260701-002', { stage: 'DONE' }, {
    'maker-r1.json': { round: 1, cost_usd: 1, raw: { subtype: 'error_max_turns' } },
    'maker-r2.json': { round: 2, mode: 'cold-degraded', cost_usd: 1, raw: {} },
    'verify-r1.invalid-a1.json': { reason: 'x' },
    'test-gate-r1.json': { mode: 'suite', verdict: 'vacuous' },
    'verify-r2.shadow-compare.json': { agreement: { disagreements: [{ ac_id: 'AC-004', main: 'pass', shadow: 'fail' }] } },
    'verify-r2.evidence-anchors.json': { hard_count: 2, hard: [{}, {}] },
    'verify-r2.test-change-guard.json': { schema_version: 1, round: 2, modified: ['test/x.test.mjs'], deleted: [], renamed: [], total: 1 },
  }, '- committer 提案两次 invalid，merge 降级机器文案\n');

  const occs = extractOccurrences(root);
  const sigs = occs.map((o) => `${o.sig}|${o.key}`).sort();
  assert.deepEqual(sigs, [
    'anchors:hard|task-20260701-002:r2:h1',
    'anchors:hard|task-20260701-002:r2:h2',
    'committer:degraded|task-20260701-002',
    'failed:budget_exceeded|task-20260701-001',
    'guard:existing_test_change|task-20260701-002:r2',
    'maker:cold_degraded|task-20260701-002:r2',
    'maker:error_max_turns|task-20260701-002:r1',
    'shadow:disagreement|task-20260701-002:r2:AC-004',
    'testgate:vacuous|task-20260701-002:r1',
    'verifier:invalid|task-20260701-002:invalid1',
  ]);
});

test('isoWeekKey / routeOf：周键与路由口径', () => {
  assert.equal(isoWeekKey(Date.parse('2026-07-08T00:00:00Z')), '2026-W28');
  assert.equal(isoWeekKey(Date.parse('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(routeOf('failed:spawn_failed'), 'guard');
  assert.equal(routeOf('committer:degraded'), 'addendum');
  assert.equal(routeOf('never:seen:before'), 'guard');
});
