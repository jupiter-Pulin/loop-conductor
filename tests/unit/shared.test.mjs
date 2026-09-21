// stages/shared.mjs 单测：spawn 双标记留档、成本入账与对账、预算闸、限额时刻文案与 harness 常量。
// 成本口径的两条边界分支另有专门单测（deterministic-spawn-cost：确定性 spawn 失败不估价；
// role-cost-estimate：单角色样本的纳入规则），这里只覆盖入账 / 盖章 / 对账这条主链。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_ARTIFACTS, accountSpawnCost, addCost, budgetExceeded, estimateRoleCost, finishSpawnRecord,
  rateLimitResetIso, reconcileSpent, startSpawnRecord, sumAccountedCost, worktreePath,
} from '../../conductor/stages/shared.mjs';

function makeCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dossierDir: path.join(root, 'dossier'), worktreesDir: path.join(root, 'worktrees') };
}

const readRecord = (cfg, id, name) => JSON.parse(fs.readFileSync(path.join(cfg.dossierDir, id, name), 'utf8'));

/** 直接往案卷里摆一份记录（不经 startSpawnRecord），用于构造对账与估价的历史样本。 */
function putRecord(cfg, id, name, obj) {
  const dir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(obj)}\n`);
}

const timelineOf = (cfg, id) => {
  try { return fs.readFileSync(path.join(cfg.dossierDir, id, 'timeline.md'), 'utf8'); } catch { return ''; }
};

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

test('accountSpawnCost：成本已知 → 原样入账，并把 accounted_usd 盖回 spawn 记录（案卷才是账本）', (t) => {
  const cfg = makeCfg(t);
  const ts = { id: 'task-1', runtime: {} };
  const rec = startSpawnRecord(cfg, 'task-1', 'maker', 1, {});
  accountSpawnCost(ts, cfg, 'maker', 1, { ok: true, costUsd: 1.25, costUnknown: false }, rec);

  assert.equal(ts.runtime.spent_usd, 1.25);
  assert.equal(ts.runtime.unknown_cost_spawns, undefined, '成本确定的 spawn 不进未知计数');
  const onDisk = readRecord(cfg, 'task-1', 'maker-r1.json');
  assert.equal(onDisk.accounted_usd, 1.25, 'runtime.spent_usd 只是缓存：金额必须同时落在案卷里');
  assert.equal(onDisk.estimated_cost_usd, undefined, '没有估计成分就不该出现估计字段');
  assert.equal(timelineOf(cfg, 'task-1'), '', '正常入账不写 timeline 噪音');
});

test('accountSpawnCost：成本未知 → 已知部分照记、unknown_cost_spawns 逐次 +1（绝不当成确定免费）', (t) => {
  const cfg = makeCfg(t);
  const ts = { id: 'task-1', runtime: {} };
  const killed = (round) => {
    const rec = startSpawnRecord(cfg, 'task-1', 'maker', round, {});
    accountSpawnCost(ts, cfg, 'maker', round, { ok: false, killed: 'inactivity', costUsd: 0.4, costUnknown: true }, rec);
  };

  killed(1);
  assert.equal(ts.runtime.spent_usd, 0.4, '瞬态重试里已成功计费的那部分照常入账');
  assert.equal(ts.runtime.unknown_cost_spawns, 1);
  assert.equal(ts.runtime.estimated_cost_usd, undefined, '没开估价开关就不估，绝不凭空造数');
  assert.equal(readRecord(cfg, 'task-1', 'maker-r1.json').accounted_usd, 0.4);

  killed(2);
  assert.equal(ts.runtime.unknown_cost_spawns, 2, '未知费用逐次计数：预算闸的水分有多大要能算出来');
  assert.equal(ts.runtime.spent_usd, 0.8);
  const timeline = timelineOf(cfg, 'task-1');
  assert.equal(timeline.match(/lower-bound accounting/g).length, 2, '每一次都留痕，不合并不省略');
});

test('accountSpawnCost：开了估价且有历史样本 → 按均价补账，估计部分单列可审', (t) => {
  const cfg = { ...makeCfg(t), unknownSpawnCostEstimateEnabled: true };
  // 历史样本跨任务、跨 key 取：这次是第一次派 newkey，照样估得出价。
  putRecord(cfg, 'task-hist-a', 'worker-curve-r1.json', { started: 'x', cost_usd: 2 });
  putRecord(cfg, 'task-hist-b', 'worker-probe-r1.json', { started: 'x', cost_usd: 4 });
  const ts = { id: 'task-1', runtime: { spent_usd: 0 } };
  const rec = startSpawnRecord(cfg, 'task-1', 'worker-newkey', 7, { key: 'newkey', profile: 'write' });

  accountSpawnCost(ts, cfg, 'worker-newkey', 7, { ok: false, killed: 'wall_clock', costUsd: 0.5, costUnknown: true }, rec);

  assert.equal(ts.runtime.spent_usd, 3.5, '已知 0.5 + 均价 3：killed spawn 不再对预算闸系统性放水');
  assert.equal(ts.runtime.estimated_cost_usd, 3, '估计部分独立累计，随时能把水分剔出来');
  assert.equal(ts.runtime.unknown_cost_spawns, 1, '估了价也仍然是一次「不知道实际花多少」');
  const onDisk = readRecord(cfg, 'task-1', 'worker-newkey-r7.json');
  assert.equal(onDisk.accounted_usd, 3.5, '盖章金额 = 已知 + 估计，和 spent_usd 同口径');
  assert.equal(onDisk.estimated_cost_usd, 3);
  assert.match(timelineOf(cfg, 'task-1'), /worker-newkey r7 cost unknown → 按历史均价 \$3 估计入账（n=2，estimated）/);
});

test('sumAccountedCost：全部 spawn 记录（含被顶替的旧记录）合计；precommit / human / dispatch 与非 spawn 文件不计', (t) => {
  const cfg = makeCfg(t);
  const id = 'task-1';
  putRecord(cfg, id, 'maker-r1.json', { started: 'x', cost_usd: 8.1, accounted_usd: 1.5 }); // accounted 优先于 cost_usd
  putRecord(cfg, id, 'worker-k-r2.json', { started: 'x', cost_usd: 2 });                    // 没盖章时退回 cost_usd
  putRecord(cfg, id, 'digest-r1.json', { started: 'x', accounted_usd: 0.25 });
  putRecord(cfg, id, 'router-r9.json', { cost_usd: 3 });        // 没有 started：不是一次真的 spawn 留档
  putRecord(cfg, id, 'precommit-r1.json', { started: 'x', accounted_usd: 9 }); // 没有 agent，不花钱
  putRecord(cfg, id, 'human-r1.json', { started: 'x', accounted_usd: 5 });     // 人的裁决不是 spawn
  putRecord(cfg, id, 'dispatch-r2.json', { started: 'x', accounted_usd: 7 });  // 委派台账不是 spawn 记录
  putRecord(cfg, id, 'maker-r1.log.json', { started: 'x', cost_usd: 99 });     // agent 写的 log，不是账本
  // 同轮重 spawn：被顶替的旧记录也花过钱，必须一起算。
  startSpawnRecord(cfg, id, 'reviewer', 4, { accounted_usd: 0.5 });
  startSpawnRecord(cfg, id, 'reviewer', 4, { accounted_usd: 0.75 });

  assert.equal(sumAccountedCost(cfg, id), 5, '1.5 + 2 + 0.25 + (0.75 + 0.5)');
  assert.equal(sumAccountedCost(cfg, 'task-none'), 0, '没有案卷目录就是 0，不抛错');
});

test('reconcileSpent：只升不降——案卷比 runtime 多就补齐，少就一分不动', (t) => {
  const cfg = makeCfg(t);
  const id = 'task-1';
  putRecord(cfg, id, 'maker-r1.json', { started: 'x', accounted_usd: 3.25 });
  // 上次运行崩在「记录已写、runtime 未落盘」之间：确认过的成本不能丢，否则预算闸形同虚设。
  const ts = { id, runtime: { spent_usd: 0 } };
  assert.deepEqual(reconcileSpent(ts, cfg), { from: 0, to: 3.25 });
  assert.equal(ts.runtime.spent_usd, 3.25);
  assert.match(timelineOf(cfg, id), /成本对账：runtime\.spent_usd \$0 < 案卷合计 \$3\.25/);

  assert.equal(reconcileSpent(ts, cfg), null, '补过一次就不再动：绝不重复计算');

  // 归档到 attempts/ 的旧轮次不在合计里，runtime 高于案卷是常态——这时降下来等于凭空抹掉
  // 真花过的钱，会让跑飞的任务继续烧预算。宁可高估。
  fs.mkdirSync(path.join(cfg.dossierDir, id, 'attempts', '2026-08-30'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg.dossierDir, id, 'attempts', '2026-08-30', 'maker-r0.json'),
    JSON.stringify({ started: 'x', accounted_usd: 10 }),
  );
  ts.runtime.spent_usd = 12;
  assert.equal(reconcileSpent(ts, cfg), null);
  assert.equal(ts.runtime.spent_usd, 12, '案卷合计 3.25 < 12：绝不下调');
  assert.equal(timelineOf(cfg, id).match(/成本对账/g).length, 1, '没补账就不写对账行');
});

test('estimateRoleCost：worker 的样本按「全部 worker」取，不按单个 key 取（单 key 的历史太稀疏）', (t) => {
  const cfg = makeCfg(t);
  putRecord(cfg, 'task-a', 'worker-curve-r1.json', { cost_usd: 2 });
  putRecord(cfg, 'task-b', 'worker-probe-r1.json', { cost_usd: 4 });
  putRecord(cfg, 'task-b', 'worker-probe-r2.json', { cost_usd: 3, cost_unknown: true }); // 自己就是不知道花多少的样本
  putRecord(cfg, 'task-b', 'worker-curve-r1.log.json', { cost_usd: 50 });                // agent 的 log 不是样本
  putRecord(cfg, 'task-b', 'maker-r1.json', { cost_usd: 99 });

  const byCurve = estimateRoleCost(cfg, 'worker-curve');
  assert.deepEqual(byCurve, { avg: 3, samples: 2 }, '两个不同 key 的已知成本一起平均');
  assert.deepEqual(estimateRoleCost(cfg, 'worker-brandnew'), byCurve, '第一次派出的 key 也估得出价：答案与 key 无关');
  assert.deepEqual(estimateRoleCost(cfg, 'maker'), { avg: 99, samples: 1 }, '别的角色不被 worker 样本污染');
  assert.deepEqual(estimateRoleCost(cfg, 'reviewer'), { avg: 0, samples: 0 });
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
