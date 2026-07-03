// 集成：claude spawn 瞬态故障重试（403/408/429/5xx/spawn error）。
// ① 瞬态×2 后成功 → 正常推进、attempts=3、cost 累计；
// ② 失败带 session_id 且 num_turns>1 → 改 -r 续会话；
// ③ 瞬态×5 耗尽 → FAILED_BOX + timeline exhausted 标记；
// ④ setSleepFn 注入（in-process）：退避序列可观测、不真等待。
// 瞬态重试不算 maker miss（契约 §15）；verifier 步骤返回新 per-AC schema。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, promptOf, resumeIdOf, verifierStep, FAKE_CLAUDE } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { runClaudeWithRetry, setSleepFn } from '../../conductor/lib/claude.mjs';

/** 测试里退避必须归零（conductor 是子进程，setSleepFn 注入不进去）。 */
function setRetryConfig(env, { retries = 4, backoff = [0] } = {}) {
  env.writeConfig({ spawnRetries: retries, spawnBackoffMs: backoff });
}

const T403 = { cost: 0.05, extra: { is_error: true, api_error_status: 403, num_turns: 1 } };

test('瞬态 403 ×2 后成功：任务正常推进、attempts=3、spent 累计', (t) => {
  const env = makeEnv(t);
  setRetryConfig(env);
  const id = 'task-20260613-401';
  env.writeTask(id);
  env.setScenario([
    T403, // call 0: 403 秒死
    T403, // call 1: 403 秒死
    { // call 2: maker 第三次尝试成功
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1', cost: 0.10, result: 'fixed',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.05, session_id: 'sess-v1' }), // call 3: verifier
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '任务正常推进到人类闸门');
  assert.equal(after.runtime.maker_miss_count, 0, '瞬态重试不算 maker miss');
  assert.ok(Math.abs(after.runtime.spent_usd - 0.25) < 1e-9,
    `spent 应累计全部尝试 0.05+0.05+0.10+0.05=0.25，实际 ${after.runtime.spent_usd}`);

  // spawn 记录里有逐次 attempts；maker 记录的 cost 为三次尝试累计
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.attempts.length, 3);
  assert.equal(marker.attempts[0].transient, true);
  assert.equal(marker.attempts[0].api_error_status, 403);
  assert.equal(marker.attempts[1].transient, true);
  assert.equal(marker.attempts[2].transient, false);
  assert.ok(Math.abs(marker.cost_usd - 0.20) < 1e-9, `maker 记录 cost 累计 0.20，实际 ${marker.cost_usd}`);

  // num_turns<=1：原样重发，不带 -r
  const calls = env.calls();
  assert.equal(calls.length, 4);
  for (const c of calls.slice(0, 3)) assert.equal(resumeIdOf(c), null);

  // timeline 每次瞬态重试一行（attempt 序号 + status）
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /transient retry attempt 2 \(status=403\)/);
  assert.match(timeline, /transient retry attempt 3 \(status=403\)/);
  assert.doesNotMatch(timeline, /retries exhausted/);
});

test('瞬态失败带 session_id 且 num_turns>1 → 重试改 -r 续会话', (t) => {
  const env = makeEnv(t);
  setRetryConfig(env);
  const id = 'task-20260613-402';
  env.writeTask(id);
  env.setScenario([
    { // call 0: 跑了 3 turns 后被 403 打断，留下可续 session
      session_id: 's-mid', cost: 0.08,
      extra: { is_error: true, api_error_status: 403, num_turns: 3 },
    },
    { // call 1: resume 续会话成功并修复
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 's-mid', cost: 0.10, result: 'continued and fixed',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.05, session_id: 'sess-v1' }), // call 2: verifier
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', '续接后任务成功推进');

  const calls = env.calls();
  assert.equal(resumeIdOf(calls[0]), null, '首次冷启动不带 -r');
  const i = calls[1].argv.indexOf('-r');
  assert.ok(i !== -1, '第二次调用必须是 resume');
  assert.equal(calls[1].argv[i + 1], 's-mid', '-r 必须续上次失败的 session');
  assert.ok(promptOf(calls[1]).includes('瞬态错误打断'), 'resume prompt 提示从中断处继续');
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--output-format') + 1], 'stream-json', '保留 --output-format stream-json');
  assert.ok(calls[1].argv.includes('--max-turns'), '保留原 maxTurns');

  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.attempts.length, 2);
  assert.equal(marker.attempts[0].session_id, 's-mid');
});

test('瞬态 ×5 重试耗尽 → FAILED_BOX，timeline 记 exhausted', (t) => {
  const env = makeEnv(t);
  setRetryConfig(env, { retries: 4, backoff: [0] });
  const id = 'task-20260613-403';
  env.writeTask(id);
  const t503 = { cost: 0.01, extra: { is_error: true, api_error_status: 503, num_turns: 1 } };
  env.setScenario([t503, t503, t503, t503, t503]); // 1 次原始 + 4 次重试全瞬态

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(env.calls().length, 5, 'retries=4 → 共 5 次尝试');

  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.equal(marker.attempts.length, 5);
  assert.equal(marker.ok, false);
  assert.ok(marker.attempts.every((a) => a.transient && a.api_error_status === 503));

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /transient retries exhausted/);
  assert.match(timeline, /transient retry attempt 5 \(status=503\)/);
});

test('setSleepFn 注入：退避序列按 backoffMs 调用，不真等待', async (t) => {
  const env = makeEnv(t);
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_SCRIPT: process.env.FAKE_CLAUDE_SCRIPT,
    FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  };
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_SCRIPT = env.scenarioPath;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    setSleepFn(null); // 还原默认 sleep
  });

  env.setScenario([T403, T403, { session_id: 's-ok', cost: 0.01, result: 'done' }]);
  const sleeps = [];
  setSleepFn((ms) => sleeps.push(ms));

  const res = await runClaudeWithRetry({ prompt: 'x', cwd: env.root }, { retries: 4, backoffMs: [100, 200] });
  assert.equal(res.ok, true);
  assert.equal(res.sessionId, 's-ok');
  assert.deepEqual(sleeps, [100, 200], '注入的 sleep 收到退避序列');
  assert.equal(res.attempts.length, 3);
  assert.ok(Math.abs(res.costUsd - 0.11) < 1e-9, `costUsd 累计全部尝试，实际 ${res.costUsd}`);
});
