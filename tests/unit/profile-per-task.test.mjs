// profile.mjs 单测：setup profile 的 key 派生按（taskCfg 解析后的）targetRepo 分叉，AC-005。
// task.targetRepo ≠ cfg.targetRepo 时，任务必须命中自己仓库的 profile，不能互相串档。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupProfileKey, setupProfilePaths, readPrecommitProfile } from '../../conductor/lib/profile.mjs';
import { taskCfg } from '../../conductor/stages/router-kernel.mjs';

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

test('各任务读各自仓库的 profile，互不命中对方', (t) => {
  const root = tmpRoot(t);
  const cfg = { targetProfilesDir: path.join(root, 'target-profiles') };
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  const tcfgA = taskCfg({ task: { targetRepo: repoA } }, { ...cfg, targetRepo: repoA });
  const tcfgB = taskCfg({ task: { targetRepo: repoB } }, { ...cfg, targetRepo: repoB });

  const pathsA = setupProfilePaths(tcfgA);
  const pathsB = setupProfilePaths(tcfgB);
  assert.notEqual(pathsA.dir, pathsB.dir, '两个仓库各有自己的 profile 目录');

  // profile 是人手写的：这里直接落盘 A 仓的 precommit 段，B 仓什么都不配。
  fs.mkdirSync(pathsA.dir, { recursive: true });
  fs.writeFileSync(pathsA.meta, `${JSON.stringify({
    schema_version: 1, profile_key: pathsA.key, targetRepo: repoA, precommit: { unit: 'forge test' },
  }, null, 2)}\n`);

  const readMeta = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  assert.equal(readPrecommitProfile(readMeta(pathsA.meta)).unit, 'forge test');
  assert.equal(readMeta(pathsB.meta), null, '仓库 B 没配 profile，不该被仓库 A 的带过');
  assert.equal(readPrecommitProfile(readMeta(pathsB.meta)).unit, null);
  // 任务快照的 testCommand 才是 B 仓 unit 的回落来源。
  assert.equal(readPrecommitProfile(readMeta(pathsB.meta), { testCommand: 'node --test' }).unit, 'node --test');
});
