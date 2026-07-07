// 共享夹具：demo target 仓库（预埋 bug + 会挂的 node:test 测试）。
// 同时被集成测试与根目录 ./target 的初始化复用，保证两者一致。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BUGGY_STATS = `// lib/stats.mjs — 预埋 bug：偶数长度数组的中位数应取中间两数平均，这里错取了上中位。
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median: input must be a non-empty array');
  }
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s[mid]; // BUG: 偶数长度时应为 (s[mid - 1] + s[mid]) / 2
}
`;

export const FIXED_STATS = `// lib/stats.mjs — median：奇数取中位，偶数取中间两数平均。
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median: input must be a non-empty array');
  }
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
`;

export const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.mjs';

test('median of odd-length array', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median of even-length array averages the middle pair', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5); // 预埋 bug 下此用例必挂
});

test('median throws on empty input', () => {
  assert.throws(() => median([]));
});
`;

function git(dir, ...args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

/** 在 dir 创建独立小型 node 项目并 git init + commit（唯一允许 commit 的地方：测试夹具）。 */
export function initTargetRepo(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo-target', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'lib', 'stats.mjs'), BUGGY_STATS);
  fs.writeFileSync(path.join(dir, 'test', 'stats.test.mjs'), TEST_FILE);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo-target\n\n预埋 bug 的演示仓库：`npm test` 会挂（median 偶数分支）。\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'conductor@example.com');
  git(dir, 'config', 'user.name', 'conductor-fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'demo target: stats module with seeded median bug + failing test');
  return dir;
}

/**
 * 独立的第二个 target 仓库：内容与 initTargetRepo 相同，但多落一次提交，
 * 保证其 HEAD 与其他用 initTargetRepo 建的仓库不同 SHA——多仓 targetRepo 测试若误用了
 * 别的仓库，跨仓库的 git 操作（如按此仓库 baseCommit 在别处 worktree add）会直接失败，
 * 而不是「误用了但内容恰好一样看不出来」。
 */
export function initSecondTargetRepo(dir) {
  initTargetRepo(dir);
  fs.appendFileSync(path.join(dir, 'README.md'), '\n第二个 target 仓库（多一次提交，与其他 target fixture 的 HEAD 不同）。\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'second target repo: extra commit to diverge HEAD from sibling fixtures');
  return dir;
}

/**
 * 同上，但额外把一个 harness artifact（.claude_review_state.json）预先 commit 进目标仓库，
 * 让它「已被目标仓库追踪」。供 tracked_harness_artifact_conflict 测试用（契约 §8 / AC-016）。
 */
export function initTargetRepoWithTrackedHarness(dir) {
  initTargetRepo(dir);
  fs.writeFileSync(
    path.join(dir, '.claude_review_state.json'),
    `${JSON.stringify({ note: 'pre-existing harness artifact tracked by target repo' }, null, 2)}\n`,
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'target repo: pre-tracked harness artifact (.claude_review_state.json)');
  return dir;
}
