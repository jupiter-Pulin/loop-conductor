// 集成：spec 审批门机器放行（config `autoApproveSpecEnabled` / task `autoApproveSpec`，默认关）。契约：
//   1) 默认关：feature 停 AWAIT_SPEC_APPROVAL，approval=null，零 autoapprove 产物（旧行为逐字节不变）；
//   2) 开（new --auto-approve-spec 逐任务）但 verdict pass 带 major finding：不放行——decision 落盘
//      （eligible=false + reasons）+ timeline + 事件，留人审；同轮幂等，二次 run 不重复评估/留痕；
//   3) 开且谓词全绿（pass 无重 finding + AC 数达标）：机器代章——单次 run 从 NEEDS_SPEC 直达
//      AWAIT_HUMAN_MERGE（中间零人工），冻结稿进 dossier、草稿归档、approval_source=auto；
//   4) 全局 config 开（无逐任务旗标）也生效，但 AC 数超上限拦截（fail-closed 到人审）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, specVerifierStep, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const SPEC_DRAFT = [
  '# spec 草稿 v1',
  '',
  '## 验收标准',
  '',
  '- AC-001 median 偶数分支取平均',
  '- AC-002 node --test 全绿',
  '',
].join('\n');

/** 9 条 AC（> 默认上限 8）：内容合法，仅规模超档。 */
const SPEC_DRAFT_9AC = [
  '# spec 草稿（规模超档）',
  '',
  '## 验收标准',
  '',
  ...Array.from({ length: 9 }, (_, i) => `- AC-00${i + 1} 可验证标准第 ${i + 1} 条`),
  '',
].join('\n');

function specAgentStep(env, id, draft) {
  return {
    actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: draft }],
    session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
  };
}
const MAKER_STEP = {
  actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
  session_id: 'sess-m1', cost: 0.1, result: 'done',
};

function newFeature(env, ...extra) {
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力', ...extra);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  return id;
}

test('契约1：默认关——feature 停人审闸门，零 autoapprove 产物', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const id = newFeature(env);
  assert.equal(env.findTask(id).task.autoApproveSpec, undefined, '无旗标时 task.json 不含该字段');
  env.setScenario([specAgentStep(env, id, SPEC_DRAFT), specVerifierStep(1)]);
  assert.equal(env.run('run').status, 0);
  const gated = env.findTask(id);
  assert.equal(gated.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(gated.runtime.approval, null);
  assert.ok(!env.exists(env.dossier(id, 'spec-verify-r1.autoapprove-decision.json')), '默认关零 autoapprove 产物');
});

test('契约2：开但 verdict 带 major finding——不放行留人审，同轮幂等', (t) => {
  const env = makeEnv(t, { config: { eventsLogEnabled: true } });
  env.writeApprovedSetupProfile();
  const id = newFeature(env, '--auto-approve-spec');
  assert.equal(env.findTask(id).task.autoApproveSpec, true, '--auto-approve-spec 进 task.json 快照');
  env.setScenario([
    specAgentStep(env, id, SPEC_DRAFT),
    specVerifierStep(1, 'pass', { over: {
      findings: [{ severity: 'major', audience: 'both', issue: '规模超档，建议拆分', recommendation: '拆 Milestone A/B' }],
    } }),
  ]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL', '不放行 = 留人审闸门');
  assert.equal(after.runtime.approval, null);

  const decision = env.readJson(env.dossier(id, 'spec-verify-r1.autoapprove-decision.json'));
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((r) => r.includes('需人裁决的 finding')), JSON.stringify(decision.reasons));

  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ev = events.filter((e) => e.type === 'autoapprove_decision');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].eligible, false);

  // 同轮幂等：二次 run 零新 spawn、不重复评估/留痕
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.equal(timeline.split('auto-approve-spec r1：不放行').length - 1, 1, '决策 timeline 只留痕一次');

  // 人审通道未被侵蚀：照常 approve 后冻结进 READY
  assert.equal(env.run('approve', id).status, 0);
  env.setScenario([MAKER_STEP, verifierStep(1)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.findTask(id).runtime.approval_source, undefined, '人审路径不含 approval_source=auto');
});

test('契约3：开且谓词全绿——单次 run 机器代章直达 AWAIT_HUMAN_MERGE', (t) => {
  const env = makeEnv(t, { config: { eventsLogEnabled: true } });
  env.writeApprovedSetupProfile();
  const id = newFeature(env, '--auto-approve-spec');
  env.setScenario([
    specAgentStep(env, id, SPEC_DRAFT),
    specVerifierStep(1),
    MAKER_STEP,
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '中间零人工直达 merge 闸门');
  assert.equal(after.runtime.approval, 'approved');
  assert.equal(after.runtime.approval_source, 'auto');
  assert.equal(env.calls().length, 4, 'spec-agent/spec-verifier/maker/verifier 四次 spawn 一气呵成');

  // 谓词产物 + 冻结链完整：decision eligible、冻结稿=草稿、草稿已归档
  const decision = env.readJson(env.dossier(id, 'spec-verify-r1.autoapprove-decision.json'));
  assert.deepEqual({ eligible: decision.eligible, reasons: decision.reasons }, { eligible: true, reasons: [] });
  assert.equal(fs.readFileSync(env.dossier(id, 'spec.md'), 'utf8'), SPEC_DRAFT, '冻结副本与草稿一致');
  assert.ok(!fs.existsSync(path.join(env.root, 'specs', `${id}.md`)), '草稿已归档，specs/ 不留平行 spec');

  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /auto-approve-spec r1：谓词全绿/);
  assert.match(timeline, /stage → READY \(spec auto-approved\)/);
  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ev = events.filter((e) => e.type === 'autoapprove_decision');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].eligible, true);
});

test('契约4：全局 config 开也生效，但 AC 数超上限拦截', (t) => {
  const env = makeEnv(t, { config: { autoApproveSpecEnabled: true } });
  env.writeApprovedSetupProfile();
  const id = newFeature(env); // 无逐任务旗标，走全局开关
  env.setScenario([specAgentStep(env, id, SPEC_DRAFT_9AC), specVerifierStep(1)]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL', 'AC 超上限 = 留人审');
  const decision = env.readJson(env.dossier(id, 'spec-verify-r1.autoapprove-decision.json'));
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((r) => r.includes('AC 数 9 > 上限 8')), JSON.stringify(decision.reasons));
});
