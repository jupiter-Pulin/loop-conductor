// 集成：spawn 确定性失败（EACCES/ENOENT 等）快速失败 + 清晰归因（H11）。
// dossier 证据：task-20260612-001 因 claude 二进制 EACCES 被判瞬态重试到耗尽，
// 归因成 spawn_transient_exhausted（失真）。退避阶梯加长（H7）后误判代价升至 ~18.75min。
// 新行为：确定性 errno 不进瞬态重试；maker 路径（进程未启动、worktree 未动）直接收箱
// spawn_failed，不跑 green gate、不吃 miss。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEnv } from '../helpers/env.mjs';

/** 造一个无执行位的假二进制：spawn 必报 EACCES。 */
function makeNonExecutableBin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-eacces-'));
  const binPath = path.join(dir, 'claude-broken.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', { mode: 0o644 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return binPath;
}

test('READY：maker spawn EACCES → 立即收箱 spawn_failed，不重试、不跑绿门、不吃 miss', (t) => {
  // 若确定性判定回归成瞬态，6 次 50ms 退避后会以 spawn_transient_exhausted 收箱 → 断言失败但测试不挂死
  const env = makeEnv(t, { config: { spawnRetries: 6, spawnBackoffMs: [50] } });
  const id = 'task-20260707-930';
  env.writeTask(id);
  env.setScenario([]); // 进程根本起不来，剧本不应被消费

  const run = env.runWithEnv({ CLAUDE_BIN: makeNonExecutableBin(t) }, 'run');
  assert.equal(run.status, 0, run.stderr);

  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'spawn_failed', '归因必须是 spawn_failed 而非 spawn_transient_exhausted');
  assert.equal(ts.runtime.maker_miss_count, 0, '进程未启动不得吃 miss');
  assert.ok(!env.exists(env.dossier(id, 'green-gate-r1.json')), '不得跑 green gate');
  assert.ok(!env.exists(env.dossier(id, 'repair-context-r1.json')), '不得生成修复上下文');

  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.ok(marker.done, '双标记照常收尾（可与 crashed 区分）');
  assert.equal(marker.attempts.length, 1, '确定性失败一次即返回，不重试');

  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(timeline.includes('spawn 确定性失败'), 'timeline 记录确定性归因');
  assert.ok(timeline.includes('EACCES'), 'timeline 带 errno 供人工修复');
});

test('FIXING：resume 轮 spawn EACCES → 冷启动兜底同样 EACCES → 收箱 spawn_failed', (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 6, spawnBackoffMs: [50] } });
  const id = 'task-20260707-931';
  // 直接构造 FIXING 前置状态（miss=1 + 已有会话 → resume 模式）
  env.writeTask(id, { stage: 'FIXING', miss: 1, sessionId: 'sess-old', currentRound: 1 });
  env.setScenario([]);

  const run = env.runWithEnv({ CLAUDE_BIN: makeNonExecutableBin(t) }, 'run');
  assert.equal(run.status, 0, run.stderr);

  const ts = env.findTask(id);
  assert.equal(ts.box, 'failed');
  assert.equal(ts.runtime.last_failure_type, 'spawn_failed');
  assert.equal(ts.runtime.maker_miss_count, 1, 'miss 保持进场值，不得因 spawn 故障递增');

  // resume 失败仍走冷启动逃生口（快速失败两次），随后收箱——不 spawn 第三次
  const marker = env.readJson(env.dossier(id, 'maker-r2.json'));
  assert.equal(marker.mode, 'cold-degraded', 'resume spawn 失败仍先降级冷启动兜底一次');
  assert.ok(!env.exists(env.dossier(id, 'green-gate-r2.json')), '不得跑 green gate');
});
