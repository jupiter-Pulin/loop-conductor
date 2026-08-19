// 集成：spec 规模闸（H18 软档，用户已批）。契约：
//   1) 默认 specMaxAcs=null：任何规模的 spec 都不触发（旧行为，prompt 无规模闸段；
//      注：JSON 字段行对 advisory 枚举的一句说明是全局的，不属规模闸段）；
//   2) 超阈值：spec-verifier prompt 注入规模闸段（含机械计数，要求 severity=advisory
//      拆分建议）+ timeline + spec_scale_gate 事件；路由不受影响（pass 照常停
//      AWAIT_SPEC_APPROVAL——拆分决定权在人审）；
//   3) 未超阈值：规模闸零噪声（无规模闸段、无 timeline、无事件）；
//   4) 双向执法（机械核验，非 prompt 君子协定）：闸触发 ⇔ verdict 携 advisory，
//      违约走 spec-verifier invalid 阶梯；
//   5) advisory 不进 repair 上下文（防 spec-agent 私自折叠 AC 规避规模闸）。
// 回归背景：task-20260801-001 六轮死锁——旧文案强制 severity=major 而 major 必 fail。
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

const ADVISORY_FINDING = {
  severity: 'advisory', audience: 'both',
  issue: '本 spec 含 3 条 AC，超过阈值',
  recommendation: '拆分为 Milestone A（AC-001/002）与 Milestone B（AC-003）',
};

function setupFeatureTask(env, { verifierOver } = {}) {
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, created.stderr);
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: DRAFT_3AC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'pass', { cost: 0.02, ...(verifierOver ? { over: verifierOver } : {}) }),
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
  // 双向执法后，闸触发时合规 verdict 必须携 advisory 拆分建议。
  const id = setupFeatureTask(env, { verifierOver: { findings: [ADVISORY_FINDING] } }); // 3 AC > 2
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL', '软档绝不改路由');

  const svPrompt = promptOf(env.calls()[1]);
  assert.ok(svPrompt.includes('# 规模闸（H18 软档，conductor 机械计数）'), 'spec-verifier prompt 应含规模闸段');
  assert.ok(svPrompt.includes('本 spec 含 3 条 AC，超过阈值 2'), '机械计数进 prompt');
  assert.ok(svPrompt.includes('severity=advisory'), '拆分建议必须要求 advisory 档（major 会被 overall 规则打成 fail——task-20260801-001 六轮死锁根因）');
  assert.ok(svPrompt.includes('advisory 档不参与 overall 判定'), 'prompt 必须显式豁免 advisory 对 overall 的影响');
  assert.ok(svPrompt.includes('拆分建议'), '要求拆分建议 finding');
  assert.match(timelineOf(env, id), /spec 规模闸（软档）：AC×3 > 阈值 2/);

  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const gate = events.filter((e) => e.type === 'spec_scale_gate');
  assert.equal(gate.length, 1);
  assert.equal(gate[0].ac_count, 3);
  assert.equal(gate[0].max, 2);
});

test('契约4：超阈值 + verifier pass 携 advisory 拆分建议——verdict 过校验、路由停人审闸门（死锁回归守卫）', (t) => {
  // 回归背景：task-20260801-001 六轮死锁——规模闸旧文案强制 severity=major，
  // 而 verifier 协议规定 major 必 fail，人审闸门永远不可达，epoch 耗尽进 failed 箱。
  // 本契约钉死修复后的世界：pass + advisory 是合法 verdict，任务停在 AWAIT_SPEC_APPROVAL。
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, created.stderr);
  const advisory = {
    severity: 'advisory', audience: 'both',
    issue: '本 spec 含 3 条 AC，超过阈值 2',
    recommendation: '拆分为 Milestone A（AC-001/002）与 Milestone B（AC-003），B 依赖 A',
  };
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: DRAFT_3AC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'pass', { over: { findings: [advisory] } }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL', 'pass+advisory 必须到达人审闸门');
  const verdict = JSON.parse(fs.readFileSync(env.dossier(id, 'spec-verify-r1.verdict.json'), 'utf8'));
  assert.equal(verdict.overall, 'pass');
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0].severity, 'advisory', 'advisory finding 原样落入 verdict 供人审阅读');
});

test('契约3：未超阈值——零噪声', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 5 } });
  const id = setupFeatureTask(env); // 3 AC ≤ 5
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.ok(!promptOf(env.calls()[1]).includes('规模闸'), '未超限不制造噪声');
  assert.ok(!timelineOf(env, id).includes('规模闸'));
});

test('契约5：闸触发但 verdict 缺 advisory——机械执法走 invalid 阶梯，不放行', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = setupFeatureTask(env); // 3 AC > 2，fake verifier pass 但零 findings = 违约
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'SPEC_VERIFY', '违约 verdict 不得放行，留在 SPEC_VERIFY 重试');
  const invalid = JSON.parse(fs.readFileSync(env.dossier(id, 'spec-verify-r1.invalid-a1.json'), 'utf8'));
  assert.ok(invalid.errors.some((e) => e.includes('规模闸已触发') && e.includes('advisory')), JSON.stringify(invalid.errors));
  assert.ok(!fs.existsSync(env.dossier(id, 'spec-verify-r1.verdict.json')), '违约 verdict 不得落盘');
});

test('契约6：闸未触发却携 advisory——同判违约（关掉洗白通道）', (t) => {
  const env = makeEnv(t); // specMaxAcs 默认 null，闸永不触发
  const id = setupFeatureTask(env, { verifierOver: { findings: [ADVISORY_FINDING] } });
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'SPEC_VERIFY');
  const invalid = JSON.parse(fs.readFileSync(env.dossier(id, 'spec-verify-r1.invalid-a1.json'), 'utf8'));
  assert.ok(invalid.errors.some((e) => e.includes('规模闸未触发')), JSON.stringify(invalid.errors));
});

test('契约7：fail 混携 major+advisory——advisory 不进 repair 上下文，防私自缩范围', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const major = { severity: 'major', audience: 'spec-agent', issue: 'AC-002 不可验证', recommendation: '改为可断言口径' };
  const id = setupFeatureTask(env, { verifierOver: { findings: [major, ADVISORY_FINDING] } });
  // 覆盖 scenario 第二步为 fail verdict
  env.setScenario([
    {
      actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: DRAFT_3AC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'fail', { over: { findings: [major, ADVISORY_FINDING] } }),
  ]);
  assert.equal(env.run('run').status, 0);
  // fail + 规模闸触发的路由已升格为人闸（tests/integration/spec-scope-escalation.test.mjs），
  // 但 repair 上下文照落——本契约钉的是它的内容口径，与去向无关。
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SCOPE_DECISION', '规模超限的 fail 交人裁拆分');
  const ctx = JSON.parse(fs.readFileSync(env.dossier(id, 'spec-repair-context-r1.json'), 'utf8'));
  assert.equal(ctx.findings.length, 1, 'advisory 必须被过滤');
  assert.equal(ctx.findings[0].severity, 'major');
  assert.ok(ctx.instruction.includes('Do NOT split'), 'instruction 必须封死自拆通道');
});
