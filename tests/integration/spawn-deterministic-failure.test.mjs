// 集成：spawn 确定性失败（EACCES/ENOENT 等）快速失败 + 清晰归因（H11）。
// dossier 证据：task-20260612-001 因 claude 二进制 EACCES 被判瞬态重试到耗尽，
// 归因成 spawn_transient_exhausted（失真）。退避阶梯加长（H7）后误判代价升至 ~18.75min。
// 新行为：确定性 errno 不进瞬态重试，也不进历史均价估计（进程从未起来、零 API 消费）。
//
// router 纪元的去向面：内核不因 spawn 故障收箱（AC-005），连续两次 router 失效才开 help 闸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newRouterEnv } from '../helpers/router-env.mjs';

/** 造一个无执行位的假二进制：spawn 必报 EACCES。 */
function makeNonExecutableBin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-eacces-'));
  const binPath = path.join(dir, 'claude-broken.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', { mode: 0o644 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return binPath;
}

test('router spawn EACCES → 一次即返回、不吃退避阶梯、不做估计入账，两次失效开 help 闸', (t) => {
  // 若确定性判定回归成瞬态，6 次 50ms 退避会把 attempts 撑到 7 → 断言失败但测试不挂死
  const { env, id } = newRouterEnv(t, {
    config: { spawnRetries: 6, spawnBackoffMs: [50], unknownSpawnCostEstimateEnabled: true },
  });
  env.setScenario([]); // 进程根本起不来，剧本不应被消费

  const run = env.runWithEnv({ CLAUDE_BIN: makeNonExecutableBin(t) }, 'run');
  assert.equal(run.status, 0, run.stderr);

  const ts = env.findTask(id);
  assert.equal(ts.box, 'queue', '内核不因 spawn 故障收箱');
  assert.equal(ts.runtime.last_failure_type, null);
  assert.equal(ts.runtime.awaiting.kind, 'help', '两次 router 失效 → 内核开 help 闸');

  const marker = env.readJson(env.dossier(id, 'router-r1.json'));
  assert.ok(marker.done, '双标记照常收尾（可与 crashed 区分）');
  assert.equal(marker.attempts.length, 1, '确定性失败一次即返回，不重试');

  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(timeline.includes('spawn 确定性失败'), 'timeline 记录确定性归因');
  assert.ok(timeline.includes('EACCES'), 'timeline 带 errno 供人工修复');
  assert.ok(!timeline.includes('估计入账（n='), '进程未启动，零 API 消费，不得估计入账');
  assert.equal(ts.runtime.estimated_cost_usd, undefined);
});
