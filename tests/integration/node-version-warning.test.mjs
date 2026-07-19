// AC-003: node 主版本 < 24 时 conductor CLI 任意子命令启动应在 stderr 打一行警告（不阻断）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeEnv, REPO_ROOT } from '../helpers/env.mjs';

const WRAPPER = path.join(REPO_ROOT, 'tests', 'fixtures', 'version-check-wrapper.mjs');
const CONDUCTOR_ENTRY = path.join(REPO_ROOT, 'conductor', 'conductor.mjs');

function runWithFakeVersion(env, fakeVersion, argv) {
  return spawnSync(process.execPath, [WRAPPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONDUCTOR_ROOT: env.root,
      CONDUCTOR_ENTRY,
      FAKE_NODE_VERSION: fakeVersion,
      FAKE_ARGV: JSON.stringify(argv),
    },
  });
}

test('AC-003: node < 24 时 stderr 出现版本警告，退出码/行为不受影响', (t) => {
  const env = makeEnv(t);
  const res = runWithFakeVersion(env, 'v22.9.0', ['status']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /v22\.9\.0/, 'stderr 应含当前版本号');
  assert.match(res.stderr, /v24/, 'stderr 应含「本仓测试需 v24」提示');
});

test('AC-003: node >= 24 时不输出版本警告（回归守卫）', (t) => {
  const env = makeEnv(t);
  const res = runWithFakeVersion(env, 'v24.13.0', ['status']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /本仓测试需 v24/);
});

test('AC-003: node 主版本号解析健壮 — 非常规 version 字符串不误报也不崩溃', (t) => {
  const env = makeEnv(t);
  const res = runWithFakeVersion(env, 'not-a-version', ['status']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /本仓测试需 v24/);
});
