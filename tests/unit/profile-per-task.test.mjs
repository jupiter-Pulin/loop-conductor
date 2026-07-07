// profile.mjs 单测：setup profile 的 key 派生按（taskCfg 解析后的）targetRepo 分叉，AC-005。
// task.targetRepo ≠ cfg.targetRepo 时，任务必须命中自己仓库的 profile，不能互相串档。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupProfileKey, setupProfilePaths, writeApprovedSetupProfile, hasApprovedSetupProfile } from '../../conductor/lib/profile.mjs';
import { taskCfg } from '../../conductor/lib/task-cfg.mjs';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-per-task-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('两个不同 targetRepo 路径派生出不同 profile key', (t) => {
  const root = tmpRoot(t);
  const cfg = { targetRepo: '/repos/global', targetProfilesDir: path.join(root, 'target-profiles') };
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  const keyA = setupProfileKey({ targetRepo: repoA });
  const keyB = setupProfileKey({ targetRepo: repoB });
  assert.notEqual(keyA, keyB);

  // task.targetRepo ≠ cfg.targetRepo 时，任务级 cfg（taskCfg）派生的 key 跟着任务仓库走，
  // 不是全局 cfg.targetRepo 那个 key。
  const tcfgA = taskCfg({ task: { targetRepo: repoA } }, cfg);
  const tcfgB = taskCfg({ task: { targetRepo: repoB } }, cfg);
  assert.equal(setupProfileKey(tcfgA), keyA);
  assert.equal(setupProfileKey(tcfgB), keyB);
  assert.notEqual(setupProfileKey(tcfgA), setupProfileKey(tcfgB));
});

test('各任务读写各自仓库的 profile，互不命中对方', (t) => {
  const root = tmpRoot(t);
  const cfg = { targetProfilesDir: path.join(root, 'target-profiles') };
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  const tcfgA = taskCfg({ task: { targetRepo: repoA } }, { ...cfg, targetRepo: repoA });
  const tcfgB = taskCfg({ task: { targetRepo: repoB } }, { ...cfg, targetRepo: repoB });

  writeApprovedSetupProfile(tcfgA, { markdown: '# Setup A\n', sourceTaskId: 'task-a' });
  assert.equal(hasApprovedSetupProfile(tcfgA), true);
  assert.equal(hasApprovedSetupProfile(tcfgB), false, '仓库 B 未审批，不该被仓库 A 的审批带过');

  writeApprovedSetupProfile(tcfgB, { markdown: '# Setup B\n', sourceTaskId: 'task-b' });
  assert.equal(hasApprovedSetupProfile(tcfgB), true);

  const pathsA = setupProfilePaths(tcfgA);
  const pathsB = setupProfilePaths(tcfgB);
  assert.notEqual(pathsA.dir, pathsB.dir);
  assert.equal(fs.readFileSync(pathsA.approved, 'utf8'), '# Setup A\n');
  assert.equal(fs.readFileSync(pathsB.approved, 'utf8'), '# Setup B\n');
});
