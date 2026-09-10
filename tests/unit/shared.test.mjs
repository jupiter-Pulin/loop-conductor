// stages/shared.mjs 单测：spawn 双标记留档、成本累计、预算闸、限额时刻文案与 harness 常量。
// 成本估计的两条分支各有自己的单测（deterministic-spawn-cost / role-cost-estimate），这里不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_ARTIFACTS, addCost, budgetExceeded, finishSpawnRecord, rateLimitResetIso,
  startSpawnRecord, worktreePath,
} from '../../conductor/stages/shared.mjs';

function makeCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dossierDir: path.join(root, 'dossier'), worktreesDir: path.join(root, 'worktrees') };
}

const readRecord = (cfg, id, name) => JSON.parse(fs.readFileSync(path.join(cfg.dossierDir, id, name), 'utf8'));

test('worktreePath / HARNESS_ARTIFACTS：路径与排除清单是唯一构造点', (t) => {
  const cfg = makeCfg(t);
  assert.equal(worktreePath(cfg, 'task-1'), path.join(cfg.worktreesDir, 'task-1'));
  // node_modules 必须在 exclude 里：testCommand 常 ln -s 出来一个，进了 diff 就会在 merge 时炸。
  assert.ok(HARNESS_ARTIFACTS.patterns.includes('/node_modules'));
  assert.ok(HARNESS_ARTIFACTS.tracked.includes('node_modules'));
  assert.equal(HARNESS_ARTIFACTS.patterns.length, HARNESS_ARTIFACTS.tracked.length);
});

test('startSpawnRecord：先落 started 标记（崩溃可识别），extra 原样进记录', (t) => {
  const cfg = makeCfg(t);
  startSpawnRecord(cfg, 'task-1', 'maker', 2, { role: 'maker', head_sha: 'abc123', package: null });
  const rec = readRecord(cfg, 'task-1', 'maker-r2.json');
  assert.equal(rec.role, 'maker');
  assert.equal(rec.round, 2);
  assert.equal(rec.head_sha, 'abc123');
  assert.ok(rec.started, 'started 时刻必须先落盘');
  assert.equal(rec.done, undefined, '未收尾时没有 done');
});

test('startSpawnRecord：同轮重 spawn 把旧记录压进 superseded，不覆盖丢档且不嵌套', (t) => {
  const cfg = makeCfg(t);
  startSpawnRecord(cfg, 'task-1', 'router', 1, { attempt: 'first' });
  startSpawnRecord(cfg, 'task-1', 'router', 1, { attempt: 'second' });
  startSpawnRecord(cfg, 'task-1', 'router', 1, { attempt: 'third' });
  const rec = readRecord(cfg, 'task-1', 'router-r1.json');
  assert.equal(rec.attempt, 'third');
  assert.deepEqual(rec.superseded.map((s) => s.attempt), ['first', 'second']);
  assert.ok(rec.superseded.every((s) => !('superseded' in s)), 'superseded 链不许嵌套');
});

test('finishSpawnRecord：done/ok/cost/raw 收尾；killed 与 cost_unknown 如实记，成功轮不写 error', (t) => {
  const cfg = makeCfg(t);
  const ok = startSpawnRecord(cfg, 'task-1', 'reviewer', 1, {});
  finishSpawnRecord(ok, { ok: true, sessionId: 's1', costUsd: 0.25, raw: { subtype: 'success' } });
  const okRec = readRecord(cfg, 'task-1', 'reviewer-r1.json');
  assert.equal(okRec.ok, true);
  assert.equal(okRec.session_id, 's1');
  assert.equal(okRec.cost_usd, 0.25);
  assert.deepEqual(okRec.raw, { subtype: 'success' });
  assert.ok(okRec.done);
  assert.equal(okRec.error, undefined);
  assert.equal(okRec.cost_unknown, undefined);

  const killed = startSpawnRecord(cfg, 'task-1', 'maker', 1, {});
  finishSpawnRecord(killed, {
    ok: false, sessionId: null, costUsd: 0, killed: 'inactivity', costUnknown: true,
    attempts: [{ transient: true }], error: 'killed after 200ms of silence',
  });
  const killedRec = readRecord(cfg, 'task-1', 'maker-r1.json');
  assert.equal(killedRec.ok, false);
  assert.equal(killedRec.killed, 'inactivity');
  assert.equal(killedRec.cost_unknown, true);
  assert.equal(killedRec.cost_usd, 0, '不知道花了多少就记 0，绝不猜');
  assert.equal(killedRec.attempts.length, 1);
  assert.match(killedRec.error, /silence/);
});

test('addCost：累计到 6 位小数，null/undefined 当 0；给了 cfg 才进 run 预算', () => {
  const ts = { runtime: {} };
  addCost(ts, 0.1);
  addCost(ts, 0.2);
  assert.equal(ts.runtime.spent_usd, 0.3, '浮点误差必须被 1e6 归一吃掉');
  addCost(ts, null);
  addCost(ts, undefined);
  assert.equal(ts.runtime.spent_usd, 0.3);
});

test('budgetExceeded：达到 budgetUsd 即为真（与 overBudget 同一口径）', () => {
  assert.equal(budgetExceeded({ runtime: { spent_usd: 4.9 } }, { budgetUsd: 5 }), false);
  assert.equal(budgetExceeded({ runtime: { spent_usd: 5 } }, { budgetUsd: 5 }), true);
  assert.equal(budgetExceeded({ runtime: {} }, { budgetUsd: 0 }), true);
});

test('rateLimitResetIso：有 resets_at 给 ISO，缺失给 unknown（绝不造时刻）', () => {
  assert.equal(rateLimitResetIso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(rateLimitResetIso(1767225600), new Date(1767225600 * 1000).toISOString());
  assert.equal(rateLimitResetIso(null), 'unknown');
  assert.equal(rateLimitResetIso(undefined), 'unknown');
  assert.equal(rateLimitResetIso(Number.NaN), 'unknown');
  assert.equal(rateLimitResetIso('1767225600'), 'unknown');
});
