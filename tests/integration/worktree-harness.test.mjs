// 集成：worktree harness 排除（契约 §8）。
// maker 产出的 .claude_review_state.json 不得进 git diff <base>...HEAD——reviewer 冷读的是
// 真实改动，不是 harness 噪音。
//
// 旧纪元还有一条「目标仓库已追踪该 harness 文件 → FAILED_BOX(tracked_harness_artifact_conflict)」，
// router 纪元不再保留：AC-005 把内核自发的 stage 转移封闭成六条，harness 冲突不在其中。
// 已追踪的文件本来就会照常进 diff，由整体 review 与 merge 闸的人来看，没有静默面。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('maker 创建的 .claude_review_state.json 被 worktree exclude 排除出 diff', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'),
    makerStep({
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: '.claude_review_state.json', content: '{"harness":"local"}\n' },
      ],
    }),
    routerStep('human', { summary: '停在 help 闸，保留 worktree 供断言' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN');

  // worktree 仍在（未 merge），harness 文件物理存在但被排除出 diff
  const wt = env.worktree(id);
  assert.ok(env.exists(path.join(wt, '.claude_review_state.json')), 'harness 文件物理存在于 worktree');
  const names = execFileSync('git', ['-C', wt, 'diff', 'main...HEAD', '--name-only'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(names.includes('lib/stats.mjs'), 'diff 应含真实修复');
  assert.ok(!names.includes('.claude_review_state.json'), 'diff 不得含 harness artifact');
});
