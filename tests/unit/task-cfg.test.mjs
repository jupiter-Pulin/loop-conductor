// taskCfg 单测：任务级 targetRepo 解析（task.targetRepo ?? cfg.targetRepo），AC-001。
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCfg } from '../../conductor/lib/task-cfg.mjs';

test('taskCfg：task.json 有 targetRepo 快照时覆盖 cfg.targetRepo', () => {
  const cfg = { targetRepo: '/repos/global', testCommand: 'node --test' };
  const ts = { task: { targetRepo: '/repos/task-a' } };
  const out = taskCfg(ts, cfg);
  assert.equal(out.targetRepo, '/repos/task-a');
  // 其余字段原样透传，不丢
  assert.equal(out.testCommand, 'node --test');
});

test('taskCfg：task.json 缺 targetRepo 字段时回退 cfg.targetRepo（旧任务兼容）', () => {
  const cfg = { targetRepo: '/repos/global' };
  const ts = { task: {} };
  const out = taskCfg(ts, cfg);
  assert.equal(out.targetRepo, '/repos/global');
});

test('taskCfg：task.targetRepo 为 null/undefined 同样回退 cfg.targetRepo', () => {
  const cfg = { targetRepo: '/repos/global' };
  assert.equal(taskCfg({ task: { targetRepo: null } }, cfg).targetRepo, '/repos/global');
  assert.equal(taskCfg({ task: { targetRepo: undefined } }, cfg).targetRepo, '/repos/global');
});

test('taskCfg：task.targetRepo 与 cfg.targetRepo 相同时返回同一 cfg 引用（无谓拷贝）', () => {
  const cfg = { targetRepo: '/repos/same' };
  const out = taskCfg({ task: { targetRepo: '/repos/same' } }, cfg);
  assert.equal(out, cfg);
});
