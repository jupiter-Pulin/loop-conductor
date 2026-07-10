// 集成：spec 规模闸（H18 软档，用户已批）。契约：
//   1) 默认 specMaxAcs=null：任何规模的 spec 都不触发（旧行为，prompt 无规模闸段）；
//   2) 超阈值：spec-verifier prompt 注入规模闸段（含机械计数）+ timeline + spec_scale_gate
//      事件；路由不受影响（pass 照常停 AWAIT_SPEC_APPROVAL——拆分决定权在人审）；
//   3) 未超阈值：零噪声（无段、无 timeline、无事件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, specVerifierStep } from '../helpers/env.mjs';

const DRAFT_3AC = [
  '# spec 草稿 v1',
  '',
  '## 验收标准',
  '',
  '- AC-001 median 偶数分支取平均',
  '- AC-002 median 奇数分支取中位',
  '- AC-003 node --test 全绿',
  '',
].join('\n');

function setupFeatureTask(env) {
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, created.stderr);
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: DRAFT_3AC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'pass', { cost: 0.02 }),
  ]);
  return id;
}

function timelineOf(env, id) {
  try { return fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'); } catch { return ''; }
}

test('契约1：默认 specMaxAcs=null——任何规模都不触发（旧行为）', (t) => {
  const env = makeEnv(t);
  const id = setupFeatureTask(env);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.ok(!promptOf(env.calls()[1]).includes('规模闸'), '默认不注入规模闸段');
  assert.ok(!timelineOf(env, id).includes('规模闸'));
});

test('契约2：超阈值——prompt 注入 + timeline + 事件，路由不变（软档不 block）', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2, eventsLogEnabled: true } });
  const id = setupFeatureTask(env); // 3 AC > 2
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL', '软档绝不改路由');

  const svPrompt = promptOf(env.calls()[1]);
  assert.ok(svPrompt.includes('# 规模闸（H18 软档，conductor 机械计数）'), 'spec-verifier prompt 应含规模闸段');
  assert.ok(svPrompt.includes('本 spec 含 3 条 AC，超过阈值 2'), '机械计数进 prompt');
  assert.ok(svPrompt.includes('拆分建议'), '要求拆分建议 finding');
  assert.match(timelineOf(env, id), /spec 规模闸（软档）：AC×3 > 阈值 2/);

  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const gate = events.filter((e) => e.type === 'spec_scale_gate');
  assert.equal(gate.length, 1);
  assert.equal(gate[0].ac_count, 3);
  assert.equal(gate[0].max, 2);
});

test('契约3：未超阈值——零噪声', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 5 } });
  const id = setupFeatureTask(env); // 3 AC ≤ 5
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.ok(!promptOf(env.calls()[1]).includes('规模闸'), '未超限不制造噪声');
  assert.ok(!timelineOf(env, id).includes('规模闸'));
});
