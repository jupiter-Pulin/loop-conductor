// 集成（新）：worktree harness 排除（契约 §8，AC-015/016）。
// ① maker 产出的 .claude_review_state.json 不得进 git diff <base>...HEAD；
// ② 若目标仓库已追踪该 harness 文件 → 不静默删除，以 tracked_harness_artifact_conflict 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('maker 创建的 .claude_review_state.json 被 worktree exclude 排除出 diff', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260620-901';
  env.writeTask(id);
  env.setScenario([
    { // maker 同时写修复与一个 harness artifact
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: '.claude_review_state.json', content: '{"harness":"local"}\n' },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'fixed + wrote harness file',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  // worktree 仍在（未 merge），harness 文件物理存在但被排除出 diff
  const wt = env.worktree(id);
  assert.ok(env.exists(path.join(wt, '.claude_review_state.json')), 'harness 文件物理存在于 worktree');
  const names = execFileSync('git', ['-C', wt, 'diff', 'main...HEAD', '--name-only'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(names.includes('lib/stats.mjs'), 'diff 应含真实修复');
  assert.ok(!names.includes('.claude_review_state.json'), 'diff 不得含 harness artifact');
});

test('目标仓库已追踪 harness 文件 → FAILED_BOX(tracked_harness_artifact_conflict)，不删除', (t) => {
  const env = makeEnv(t, { trackedHarness: true }); // target 仓库预先 commit 了 .claude_review_state.json
  const id = 'task-20260620-902';
  env.writeTask(id);
  env.setScenario([]); // 不应 spawn 任何 claude（冲突拦在 spawn 前）

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'tracked_harness_artifact_conflict');
  assert.equal(env.calls().length, 0, '冲突必须拦在 spawn 之前');
  // 不静默删除：文件仍在目标仓库
  assert.ok(env.exists(path.join(env.targetDir, '.claude_review_state.json')), '不得删除已追踪的 harness 文件');
});
