// 集成：五小时 / 周限额 → FAILED_BOX，人手动恢复，永不自动续跑（AC-021/022/023）。
// 关键纪律：限额不是任务的失败——不归档产物、不动计数、不重试；恢复只由人在 resets_at 之后触发。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makerThenHelp, newRouterEnv, routerEnv, routerStep } from '../helpers/router-env.mjs';
import { loadCfg } from '../../conductor/conductor.mjs';
import { buildTaskDetail } from '../../conductor/dashboard/model.mjs';
import { rateLimitPanel } from '../../conductor/dashboard/static/view.mjs';
import { scanAlerts } from '../../tools/alerts-scan.mjs';

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** 一步 fake-claude 剧本：spawn 即撞 rejected rate_limit_event。 */
function rateLimitStep(resetsAt, { type = 'five_hour' } = {}) {
  return { actions: [{ type: 'rateLimit', resets_at: resetsAt, rate_limit_type: type }] };
}

function readEvents(env, id) {
  const p = env.dossier(id, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- AC-021：命中即收箱，本次 run 内其余任务不再 spawn ----

test('AC-021: maker spawn 撞限额 → FAILED_BOX(rate_limited) + runtime.rate_limit + 事件', (t) => {
  const { env, id } = newRouterEnv(t, { config: { eventsLogEnabled: true } });
  const resetsAt = nowSec() + 2 * HOUR;
  env.setScenario([routerStep('maker'), rateLimitStep(resetsAt)]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'rate_limited');
  assert.equal(after.runtime.rate_limit.type, 'five_hour');
  assert.equal(after.runtime.rate_limit.resets_at, resetsAt);
  assert.equal(after.runtime.rate_limit.resume_stage, 'ROUTING', 'resume_stage = 命中时所在 stage');
  assert.ok(Number.isFinite(after.runtime.rate_limit.hit_at));
  assert.equal(env.calls().length, 2, '零重试：撞限额的那次 spawn 只发一次');

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /命中限额/);
  assert.match(timeline, /FAILED_BOX/);
  const events = readEvents(env, id);
  const rl = events.find((e) => e.type === 'rate_limited');
  assert.ok(rl, 'events.jsonl 应含 rate_limited 事件');
  assert.equal(rl.limit_type, 'five_hour');
  assert.equal(rl.resets_at, resetsAt);
  assert.equal(rl.resume_stage, 'ROUTING');
});

test('AC-021: 同一次 run 内其余任务不再 spawn，stage 不变并记 spawn skipped', (t) => {
  const env = routerEnv(t, { config: { maxConcurrentTasks: 1 } });
  const hit = 'task-20260830-402';
  const spared = 'task-20260830-403'; // id 序在后 → 先处理 hit
  env.writeRouterTask(hit);
  env.writeRouterTask(spared);
  const resetsAt = nowSec() + 2 * HOUR;
  // 只给一步：第二次 spawn 会被 fake-claude 判为「多余的 spawn」而报错，从而暴露漏拦。
  env.setScenario([rateLimitStep(resetsAt)]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  assert.equal(env.findTask(hit).box, 'failed');
  const other = env.findTask(spared);
  assert.equal(other.box, 'queue', '未开跑的任务不受连累');
  assert.equal(other.runtime.stage, 'ROUTING', 'stage 不变');
  assert.equal(env.calls().length, 1, '限额后本次 run 不再发起任何新 spawn');

  const timeline = fs.readFileSync(env.dossier(spared, 'timeline.md'), 'utf8');
  assert.match(timeline, /spawn skipped: rate limited until /);
  assert.match(timeline, new RegExp(new Date(resetsAt * 1000).toISOString()));
});

// ---- AC-022：retry 必须在重置时刻之后 ----

test('AC-022: resets_at 未到 → retry exit 非 0、打印本地重置时刻、状态不变；--force 越过', (t) => {
  const { env, id } = newRouterEnv(t);
  const resetsAt = nowSec() + 3 * HOUR;
  env.setScenario([rateLimitStep(resetsAt)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).box, 'failed');

  const early = env.run('retry', id);
  assert.notEqual(early.status, 0, 'resets_at 之前 retry 必须非 0 退出');
  const local = new Date(resetsAt * 1000);
  assert.match(early.stdout, new RegExp(`${local.getFullYear()}-`), 'stdout 含本地时间的重置时刻');
  assert.match(early.stdout, /尚未重置/);
  assert.equal(env.findTask(id).box, 'failed', '被拒的 retry 不得改变状态');
  assert.equal(env.findTask(id).runtime.stage, 'FAILED_BOX');

  const forced = env.run('retry', id, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'ROUTING');
});

test('AC-022: resets_at 已过 → 回 resume_stage，current_round 不变、无产物归档', (t) => {
  const { env, id } = newRouterEnv(t);
  const resetsAt = nowSec() - HOUR; // 已过
  env.setScenario([routerStep('maker'), rateLimitStep(resetsAt, { type: 'weekly' })]);
  assert.equal(env.run('run').status, 0);

  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed');
  assert.equal(boxed.runtime.rate_limit.type, 'weekly');
  assert.equal(boxed.runtime.rate_limit.resume_stage, 'ROUTING');
  const streamBefore = env.dossier(id, 'maker-r1.stream.jsonl');
  assert.ok(fs.existsSync(streamBefore), '轮次产物应已落盘');

  const retried = env.run('retry', id);
  assert.equal(retried.status, 0, retried.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'ROUTING', '回到命中时所在 stage');
  assert.equal(after.runtime.current_round, boxed.runtime.current_round, 'current_round 不变');
  assert.equal(after.runtime.spent_usd, boxed.runtime.spent_usd, '不动任何账');
  assert.equal(after.runtime.last_failure_type, null);
  assert.equal(after.runtime.rate_limit, null);
  assert.ok(fs.existsSync(streamBefore), '不归档轮次产物');
  assert.equal(fs.existsSync(env.dossier(id, 'attempts')), false, '不建 attempts/');
});

test('AC-022: retry --rate-limited 批量恢复全部此类任务，不碰其他失败类型', (t) => {
  const env = routerEnv(t, { config: { maxConcurrentTasks: 1 } });
  const a = 'task-20260830-406';
  const b = 'task-20260830-407';
  const other = 'task-20260830-408';
  env.writeRouterTask(a);
  env.writeRouterTask(b);
  env.writeRouterTask(other, { spent: 99 }); // 预算耗尽 → budget_exhausted
  const resetsAt = nowSec() - 60;
  env.setScenario([rateLimitStep(resetsAt)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(a).box, 'failed');

  // b 与 other 在同一 run 内被跳过（限额短路），单独把它们也推成 failed 以构造批量场景。
  env.setScenario([rateLimitStep(resetsAt)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(b).box, 'failed');
  assert.equal(env.findTask(b).runtime.last_failure_type, 'rate_limited');
  env.setScenario([]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(other).runtime.last_failure_type, 'budget_exhausted');

  const batch = env.run('retry', '--rate-limited');
  assert.equal(batch.status, 0, batch.stderr);
  assert.equal(env.findTask(a).box, 'queue');
  assert.equal(env.findTask(b).box, 'queue');
  assert.equal(env.findTask(other).box, 'failed', '非限额失败不被批量恢复');
});

// ---- AC-023：无人操作时没有任何路径把它搬出 FAILED_BOX ----

test('AC-023: resets_at 已过后连续两次 run，rate_limited 任务仍在 FAILED_BOX', (t) => {
  const { env, id } = newRouterEnv(t);
  const resetsAt = nowSec() - 2 * HOUR; // 早已重置
  env.setScenario([rateLimitStep(resetsAt)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).box, 'failed');

  env.setScenario([]); // 此后任何 spawn 都会让 fake-claude 报错
  for (const pass of [1, 2]) {
    const r = env.run('run');
    assert.equal(r.status, 0, r.stderr);
    const after = env.findTask(id);
    assert.equal(after.box, 'failed', `第 ${pass} 次 run 后仍在 failed 箱`);
    assert.equal(after.runtime.stage, 'FAILED_BOX');
    assert.equal(after.runtime.last_failure_type, 'rate_limited');
  }
  assert.equal(env.calls().length, 0, '两次 run 零 spawn');
});

test('AC-023: alerts-scan 只读报警，不移动 rate_limited 任务', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([rateLimitStep(nowSec() - HOUR)]);
  assert.equal(env.run('run').status, 0);

  const alerts = scanAlerts(env.root);
  assert.ok(alerts.some((a) => a.key === `${id}:failed:rate_limited`), 'failed 箱任务应有报警');
  assert.equal(env.findTask(id).box, 'failed', 'alerts-scan 不搬任务');
  assert.equal(env.findTask(id).runtime.stage, 'FAILED_BOX');
});

// ---- AC-023：dashboard 面板数据与「恢复」按钮开关 ----

test('AC-023: dashboard 详情暴露 rate_limit；resets_at 前「恢复」disabled，到点后启用', (t) => {
  const { env, id } = newRouterEnv(t);
  const resetsAt = nowSec() + HOUR;
  env.setScenario([rateLimitStep(resetsAt)]);
  assert.equal(env.run('run').status, 0);

  const cfg = loadCfg(env.root);
  const detail = buildTaskDetail(cfg, id);
  assert.equal(detail.review.kind, 'failed');
  assert.equal(detail.review.lastFailureType, 'rate_limited');
  assert.equal(detail.review.rateLimit.resets_at, resetsAt);

  const before = rateLimitPanel(detail.review.rateLimit, resetsAt * 1000 - 1);
  assert.equal(before.canResume, false, '重置时刻之前「恢复」按钮 disabled');
  assert.match(before.label, /^限额 five_hour，重置于 /);
  const after = rateLimitPanel(detail.review.rateLimit, resetsAt * 1000);
  assert.equal(after.canResume, true, '到点后启用');

  // 非限额失败不渲染该面板。
  assert.equal(rateLimitPanel(null), null);
});

test('AC-023: 限额产物路径与 dossier 布局一致（stream 留档在案卷内）', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([routerStep('maker'), rateLimitStep(nowSec() + HOUR)]);
  assert.equal(env.run('run').status, 0);
  const stream = env.dossier(id, 'maker-r1.stream.jsonl');
  assert.ok(fs.existsSync(stream));
  const lines = fs.readFileSync(stream, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'rate_limit_event' && l.rate_limit_info.status === 'rejected'));
  assert.ok(fs.existsSync(path.join(env.root, 'dossier', id)));
});
