// 单元：tools/weekly-report.mjs —— 周窗口聚合口径（E21/H27）。
// 量尺错了传感层全失真，口径用测试钉死：
// 窗口归属 = events ts ∪ 角色轮次 JSON mtime；窗口外任务不算活跃；
// shadow 分歧/anchors 只认窗口内产物；AWAIT 停靠时长从最后一次 stage 事件起算；
// 摘要必须把「停靠 + shadow 分歧」组合成 merge 前必看告警。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectWeekly, parseSince, renderMarkdown, renderDigest } from '../../tools/weekly-report.mjs';

const DAY = 86400_000;

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-report-'));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'dossier']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTask(root, box, id, { kind = 'bugfix', runtime = {}, dossier = {}, events = null, mtimeMs = null } = {}) {
  const stateDir = path.join(root, 'state', box, id);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task.json'), JSON.stringify({ id, kind }));
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ stage: 'DONE', maker_miss_count: 0, spent_usd: 0, ...runtime }));
  const dDir = path.join(root, 'dossier', id);
  fs.mkdirSync(dDir, { recursive: true });
  for (const [name, content] of Object.entries(dossier)) {
    const p = path.join(dDir, name);
    fs.writeFileSync(p, JSON.stringify(content));
    if (mtimeMs !== null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }
  if (events) {
    fs.writeFileSync(path.join(dDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

test('parseSince：相对量 / ISO / 非法输入', () => {
  const until = Date.parse('2026-07-08T00:00:00Z');
  assert.equal(parseSince('7d', until), until - 7 * DAY);
  assert.equal(parseSince('24h', until), until - DAY);
  assert.equal(parseSince('2026-07-01T00:00:00Z', until), Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(parseSince(null, until), until - 7 * DAY); // 默认 7 天
  assert.throws(() => parseSince('next-tuesday', until), /无法解析/);
});

test('collectWeekly：窗口归属、成本按角色、shadow/anchors 收账、AWAIT 告警', (t) => {
  const root = makeRoot(t);
  const now = Date.now();
  const sinceMs = now - 7 * DAY;
  const untilMs = now + 3600_000;
  const iso = (ms) => new Date(ms).toISOString();

  // ① 窗口内完成的任务：r1 截断+续跑、committer a1 有效（事件流）、anchors hard0/soft2
  writeTask(root, 'done', 'task-20260707-101', {
    kind: 'bugfix',
    runtime: { stage: 'DONE', spent_usd: 5.5 },
    dossier: {
      'maker-r1.json': { round: 1, ok: false, cost_usd: 2, max_turns_continuations: 1, raw: { subtype: 'error_max_turns' } },
      'verifier-r1.json': { cost_usd: 1.1 },
      'verify-r1.verdict.json': { overall: 'pass' },
      'verify-r1.evidence-anchors.json': { mode: 'observe', hard: [], soft: [{ x: 1 }, { x: 2 }] },
      'committer-r1.json': { cost_usd: 0.02 },
    },
    events: [
      { ts: iso(now - 2 * DAY), type: 'stage', stage: 'VERIFY' },
      { ts: iso(now - 2 * DAY + 60_000), type: 'committer_attempt', attempt: 1, outcome: 'valid' },
      { ts: iso(now - 2 * DAY + 120_000), type: 'stage', stage: 'DONE', note: 'merged' },
    ],
  });

  // ② 窗口外的老任务：全部 mtime 拨到 10 天前、无事件流 —— 不得算活跃
  writeTask(root, 'done', 'task-20260601-001', {
    kind: 'feature',
    runtime: { stage: 'DONE', spent_usd: 44 },
    dossier: {
      'maker-r1.json': { round: 1, ok: true, cost_usd: 9, raw: { subtype: 'success' } },
      'verify-r1.verdict.json': { overall: 'pass' },
    },
    mtimeMs: sinceMs - 10 * DAY,
  });

  // ③ 停靠 AWAIT_HUMAN_MERGE 的任务：shadow 有 pass→fail 分歧 —— 必须升级为 merge 前必看
  writeTask(root, 'queue', 'task-20260708-201', {
    kind: 'bugfix',
    runtime: { stage: 'AWAIT_HUMAN_MERGE', spent_usd: 15.5 },
    dossier: {
      'maker-r1.json': { round: 1, ok: true, cost_usd: 3, raw: { subtype: 'success' } },
      'verify-r1.verdict.json': { overall: 'pass' },
      'verify-r1.shadow-compare.json': {
        agreement: {
          total_acs: 6,
          agreed: 5,
          high_risk_count: 0,
          disagreements: [{ ac_id: 'AC-004', main: 'pass', shadow: 'fail', high_risk: false }],
        },
      },
    },
    events: [{ ts: iso(now - 2 * DAY), type: 'stage', stage: 'AWAIT_HUMAN_MERGE', note: 'verdict pass r1' }],
  });

  const rep = collectWeekly(root, { sinceMs, untilMs, nowMs: now });

  // 吞吐：老任务不活跃
  assert.equal(rep.throughput.active, 2);
  assert.equal(rep.throughput.done, 1);
  assert.deepEqual(rep.throughput.done_by_kind, { bugfix: 1 });
  assert.equal(rep.throughput.new, 2);
  assert.ok(!rep.tasks.some((x) => x.id === 'task-20260601-001'), '窗口外任务不进报告');

  // 成本：只算窗口内角色轮次（① 2+1.1+0.02，③ 3）
  assert.equal(rep.cost.by_role.maker, 5);
  assert.equal(rep.cost.by_role.verifier, 1.1);
  assert.equal(rep.cost.by_role.committer, 0.02);
  assert.equal(rep.cost.window_total_usd, 6.12);

  // 质量：r1 截断 1/2、续跑 1、committer a1 1/1（事件流口径）
  assert.equal(rep.quality.maker_r1_total, 2);
  assert.equal(rep.quality.maker_r1_max_turns_cutoff, 1);
  assert.equal(rep.quality.maker_rounds_with_continuation, 1);
  assert.equal(rep.quality.committer_valid_a1, 1);
  assert.equal(rep.quality.committer_with_proposal, 1);

  // 开关收账
  assert.deepEqual(rep.switches.evidence_anchors, { rounds: 1, hard: 0, soft: 2 });
  assert.equal(rep.switches.shadow.acs, 6);
  assert.equal(rep.switches.shadow.agreed, 5);
  assert.deepEqual(rep.switches.shadow.disagreements, [
    { task: 'task-20260708-201', round: 1, ac: 'AC-004', main: 'pass', shadow: 'fail', high_risk: false },
  ]);

  // AWAIT 告警：停靠 ~2 天 + shadow 分歧标记
  assert.equal(rep.attention.length, 1);
  const a = rep.attention[0];
  assert.equal(a.task, 'task-20260708-201');
  assert.equal(a.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(a.aging_days > 1.9 && a.aging_days < 2.1, `停靠时长按最后 stage 事件起算，得 ${a.aging_days}`);
  assert.deepEqual(a.shadow_disagreements, ['AC-004 pass→fail']);

  // 渲染：全文有分歧明细，摘要有 merge 前必看
  const md = renderMarkdown(rep);
  assert.match(md, /task-20260708-201 r1 AC-004：main=pass → shadow=fail/);
  const digest = renderDigest(rep);
  assert.match(digest, /待你动作/);
  assert.match(digest, /task-20260708-201 停 AWAIT_HUMAN_MERGE .*shadow 分歧 AC-004 pass→fail，merge 前必看/);
});

test('collectWeekly：空窗口零任务不炸，摘要给全绿文案', (t) => {
  const root = makeRoot(t);
  const now = Date.now();
  const rep = collectWeekly(root, { sinceMs: now - 7 * DAY, untilMs: now, nowMs: now });
  assert.equal(rep.throughput.active, 0);
  assert.equal(rep.cost.window_total_usd, 0);
  assert.equal(rep.attention.length, 0);
  assert.match(renderDigest(rep), /无停靠任务/);
});
