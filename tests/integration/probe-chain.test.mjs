// 集成：probe 链（R6-H26，第四 task kind：只读调查）。契约：
//   1) happy path：new --kind probe → NEEDS_FEASIBILITY → feasibility-agent 产报告过契约门
//      → AWAIT_PROBE_CLOSE（无 worktree、无绿门、prompt 带 Probe 模式段）→ close →
//      报告固化 dossier/probe-report.md + 归档 done；
//   2) close 守卫：非 AWAIT_PROBE_CLOSE 拒绝；
//   3) 失败恢复：budget 收箱后 retry 恒回 NEEDS_FEASIBILITY（probe 无实现链，不走 READY）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf } from '../helpers/env.mjs';

const PROBE_REPORT = [
  '# Feasibility Study: 定位 stats 模块的精度漂移来源',
  '',
  '## 背景',
  '',
  '现状见 lib/stats.mjs（marker: PROBE-EVIDENCE-1）。',
  '',
  '## 选项对比',
  '',
  '| 选项 | 描述 | 收益 | 代价 | 结论 |',
  '| --- | --- | --- | --- | --- |',
  '| O-A: 浮点累加误差 | 逐元素求和放大误差 | 解释观测 | 需基准复现 | consider |',
  '| O-B: 排序稳定性无关 | sort 对中位数无影响 | 排除一个假设 | - | recommend |',
  '',
  '## 推荐',
  '',
  '推荐 O-B 作为结论：证据指向浮点累加，排序路径可排除。',
  '',
  '## 开放问题',
  '',
  '| 问题 | Safe default | 影响 |',
  '| --- | --- | --- |',
  '| 是否需要 Kahan 求和 | 暂不引入 | 后续 feature 任务裁决 |',
  '',
].join('\n');

function newProbeTask(env) {
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'probe', '--title', '定位 stats 精度漂移');
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  return { id, draftAbs: path.join(env.root, 'state', 'queue', id, 'feasibility-study.md') };
}

test('契约1：probe happy path——调查报告过契约门 → AWAIT_PROBE_CLOSE → close 归档 + 报告固化', (t) => {
  const env = makeEnv(t);
  const { id, draftAbs } = newProbeTask(env);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_FEASIBILITY', 'probe 入口即调查阶段');
  assert.equal(env.readTaskJson(id).kind, 'probe');

  env.setScenario([
    { actions: [{ type: 'writeFile', path: draftAbs, content: PROBE_REPORT }], session_id: 'sess-p1', cost: 0.05, result: 'report written' },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_PROBE_CLOSE', '报告就绪停人读闸门');
  assert.ok(!fs.existsSync(path.join(env.root, 'worktrees', id)), 'probe 不建任务 worktree');
  assert.ok(promptOf(env.calls()[0]).includes('Probe 模式（只读调查任务'), 'prompt 带 probe 模式段');

  // 幂等：再 run 一次零新 spawn、stage 不动
  env.run('run');
  assert.equal(env.calls().length, 1);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_PROBE_CLOSE');

  const close = env.run('close', id);
  assert.equal(close.status, 0, close.stderr);
  assert.equal(env.findTask(id).box, 'done');
  assert.equal(env.findTask(id).runtime.stage, 'DONE');
  assert.equal(
    fs.readFileSync(env.dossier(id, 'probe-report.md'), 'utf8'), PROBE_REPORT,
    '报告固化进 dossier（永久可查，不随任务目录搬箱）',
  );

  const again = env.run('close', id);
  assert.notEqual(again.status, 0, '已归档任务再 close 必须拒绝');
});

test('契约2：close 守卫——非 AWAIT_PROBE_CLOSE 一律拒绝', (t) => {
  const env = makeEnv(t);
  const { id } = newProbeTask(env);
  const early = env.run('close', id); // 还在 NEEDS_FEASIBILITY
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /close 仅适用于/);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_FEASIBILITY', '任务保持原状');
});

test('契约3：budget 收箱后 retry 恒回 NEEDS_FEASIBILITY（probe 无实现链）', (t) => {
  const env = makeEnv(t, { config: { budgetUsd: 0 } }); // spent 0 >= 0 → 立即 budget_exceeded
  const { id } = newProbeTask(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const failed = env.findTask(id);
  assert.equal(failed.box, 'failed');
  assert.equal(failed.runtime.last_failure_type, 'budget_exceeded');

  const retry = env.run('retry', id);
  assert.equal(retry.status, 0, retry.stderr);
  const back = env.findTask(id);
  assert.equal(back.box, 'queue');
  assert.equal(back.runtime.stage, 'NEEDS_FEASIBILITY', 'probe retry 不走 READY（无 spec/worktree 可跑）');
});
