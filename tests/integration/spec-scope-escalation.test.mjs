// 集成：spec 规模升闸（H18 软档之上的人闸）。契约：
//   1) spec-verifier fail + 本轮规模闸触发 + 人未豁免 → AWAIT_SCOPE_DECISION，本次 fail 挂起
//      （spec_miss_count 不动）、repair 上下文照落、scope_escalation 事件留痕；
//   2) approve-scope：豁免落 runtime + dossier，挂起的 fail 按原 miss 阶梯入账（SPEC_FIXING /
//      冷启动 / 耗尽收箱三条去向不因升闸改变）；
//   3) reject-scope：任务收箱（scope_split），notes 进 timeline 与裁决产物；
//   4) 豁免是任务作用域且持久：waived 后再 fail + 超规模一律直接进 miss 阶梯，永不再升闸；
//   5) pass + 超规模、fail + 未超规模两条现状路径零改动；
//   6) retry 复位 scope_decision（拆分收箱的任务复活后应能再次升闸）。
// 事故背景：task-20260802-002（AC×30-35 vs 阈值 12）每轮都在真实 blocker/major 上 fail，
// 2 epoch × 3 轮打满收箱烧 $30.9，而人闸只有 pass 才到得了——「要不要拆」从没被问过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, specVerifierStep } from '../helpers/env.mjs';

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

const MAJOR = {
  severity: 'major', audience: 'spec-agent',
  issue: 'AC-002 不可验证', recommendation: '改为可断言口径',
};
// 规模闸触发时 verdict 必须携拆分建议（H18 双向执法），否则走 invalid 阶梯。
const ADVISORY = {
  severity: 'advisory', audience: 'both',
  issue: '本 spec 含 3 条 AC，超过阈值', recommendation: '拆成 Milestone A（AC-001/002）与 B（AC-003）',
};

function newFeatureTask(env) {
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, created.stderr);
  return id;
}

/** spec-agent 直写草稿的剧本步骤（每轮 SPEC_FIXING 也复用它）。 */
function specAgentStep(env, id, content = DRAFT_3AC) {
  return {
    actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content }],
    session_id: 'sess-spec', cost: 0.03, result: 'spec written',
  };
}

function timelineOf(env, id) {
  try { return fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8'); } catch { return ''; }
}

function eventsOf(env, id) {
  try {
    return fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** 直接改写 queue 中的 runtime.json（构造 miss 阶梯前置状态，不走多轮真实 spawn）。 */
function patchRuntime(env, id, patch) {
  const ts = env.findTask(id);
  fs.writeFileSync(path.join(ts.dir, 'runtime.json'), `${JSON.stringify({ ...ts.runtime, ...patch }, null, 2)}\n`);
}

/** 一次 run 把 feature 任务推到规模升闸（spec-agent → spec-verifier r1 fail）。 */
function driveToEscalation(env) {
  const id = newFeatureTask(env);
  env.setScenario([
    specAgentStep(env, id),
    specVerifierStep(1, 'fail', { over: { findings: [MAJOR, ADVISORY] } }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  return id;
}

test('契约1：fail + 超规模 → AWAIT_SCOPE_DECISION，miss 不增、事件与菜单留痕', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2, eventsLogEnabled: true } });
  const id = driveToEscalation(env);

  const after = env.findTask(id);
  assert.equal(after.box, 'queue', '人闸与其它 AWAIT_* 一致，任务留在 queue');
  assert.equal(after.runtime.stage, 'AWAIT_SCOPE_DECISION');
  assert.equal(after.runtime.spec_miss_count, 0, '本次 fail 挂起，等人裁决后才入账');
  assert.equal(after.runtime.spec_epoch, 1);
  assert.equal(after.runtime.current_spec_round, 1);
  assert.equal(after.runtime.scope_decision, null);

  // 修复上下文照常落盘：人一旦接受规模，SPEC_FIXING 直接拿它开工，无需重跑 spec-verifier。
  const ctx = env.readJson(env.dossier(id, 'spec-repair-context-r1.json'));
  assert.equal(ctx.findings.length, 1, 'advisory 仍不进 repair 上下文');
  assert.equal(ctx.findings[0].severity, 'major');

  const esc = eventsOf(env, id).filter((e) => e.type === 'scope_escalation');
  assert.equal(esc.length, 1);
  assert.deepEqual(
    { round: esc[0].round, ac_count: esc[0].ac_count, max: esc[0].max },
    { round: 1, ac_count: 3, max: 2 },
  );
  const timeline = timelineOf(env, id);
  assert.match(timeline, /spec 规模升闸：AC×3 > 阈值 2/);
  assert.ok(timeline.includes('approve-scope') && timeline.includes('reject-scope'), 'timeline 给出裁决菜单');

  // 幂等：闸门未动时再 run 一次不推进、不新增 spawn。
  const calls = env.calls().length;
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SCOPE_DECISION');
  assert.equal(env.calls().length, calls, '人闸期间零 spawn');
});

test('契约2：approve-scope → 豁免落盘，挂起的 fail 入账 miss=1 进 SPEC_FIXING', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = driveToEscalation(env);

  const ok = env.run('approve-scope', id);
  assert.equal(ok.status, 0, ok.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'SPEC_FIXING');
  assert.equal(after.runtime.spec_miss_count, 1, '人裁后这次 fail 才入账');
  assert.equal(after.runtime.current_spec_round, 1);
  assert.equal(after.runtime.scope_decision, 'waived');

  const decision = env.readJson(env.dossier(id, 'scope-decision.json'));
  assert.equal(decision.decision, 'waived');
  assert.equal(decision.round, 1);
  assert.equal(decision.ac_count, 3);
  assert.equal(decision.max, 2);
  assert.ok(decision.decided_at, '裁决时间戳');
  assert.match(timelineOf(env, id), /human approve scope/);
});

test('契约2b：miss=2 时 approve-scope → 冷启动路径（epoch+1、草稿归档）完好', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = driveToEscalation(env);
  // 阶梯末级前置状态：前两次 fail 已入账（真实链路要多跑两轮 spec-agent/verifier，这里直接构造）。
  patchRuntime(env, id, { spec_miss_count: 2 });

  const ok = env.run('approve-scope', id);
  assert.equal(ok.status, 0, ok.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'NEEDS_SPEC', '第三次 fail 冷启动新 spec-agent');
  assert.equal(after.runtime.spec_miss_count, 0);
  assert.equal(after.runtime.spec_epoch, 2);
  assert.equal(after.runtime.current_spec_round, 0);
  assert.equal(after.runtime.scope_decision, 'waived');
  assert.equal(fs.existsSync(path.join(env.root, 'specs', `${id}.md`)), false, '冷启动前旧草稿已归档');
  assert.ok(fs.readdirSync(path.join(env.root, 'specs', 'archive')).some((n) => n.startsWith(`${id}-spec-fail-r1`)));
});

test('契约3：reject-scope --notes → FAILED_BOX(scope_split)，notes 进 timeline 与裁决产物', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = driveToEscalation(env);

  const ok = env.run('reject-scope', id, '--notes', '拆成 A/B 两批，B 依赖 A');
  assert.equal(ok.status, 0, ok.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'scope_split');
  assert.equal(after.runtime.scope_decision, 'split');

  const decision = env.readJson(env.dossier(id, 'scope-decision.json'));
  assert.equal(decision.decision, 'split');
  assert.equal(decision.notes, '拆成 A/B 两批，B 依赖 A');
  assert.equal(decision.ac_count, 3);
  assert.match(timelineOf(env, id), /human reject scope：选择拆分（AC×3）：拆成 A\/B 两批，B 依赖 A/);
});

test('契约4：retry 拆分收箱的任务 → scope_decision 复位（可再次升闸）', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = driveToEscalation(env);
  assert.equal(env.run('reject-scope', id, '--notes', '拆').status, 0);

  const retried = env.run('retry', id);
  assert.equal(retried.status, 0, retried.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'NEEDS_SPEC');
  assert.equal(after.runtime.scope_decision, null, '豁免/拆分裁决不随任务复活');
  assert.equal(after.runtime.last_failure_type, null);
});

test('契约5：已 waived 的任务再遇 fail + 超规模 → 直接走 miss 阶梯，不再升闸', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2, eventsLogEnabled: true } });
  const id = driveToEscalation(env);
  assert.equal(env.run('approve-scope', id).status, 0); // miss=1, waived, SPEC_FIXING

  // 下一轮：spec-agent 重写（仍 3 条 AC，闸照旧触发）→ spec-verifier r2 fail。
  env.setScenario([
    specAgentStep(env, id),
    specVerifierStep(2, 'fail', { over: { findings: [MAJOR, ADVISORY] } }),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'SPEC_FIXING', '豁免后规模闸退回软档，fail 直接入 miss 阶梯');
  assert.equal(after.runtime.spec_miss_count, 2);
  assert.equal(after.runtime.scope_decision, 'waived');
  assert.equal(eventsOf(env, id).filter((e) => e.type === 'scope_escalation').length, 1, '不产生第二次升闸');
  // 软档本体不变：仍要求 spec-verifier 附拆分建议。
  assert.equal(eventsOf(env, id).filter((e) => e.type === 'spec_scale_gate').length, 2);
});

test('契约6：pass + 超规模 → AWAIT_SPEC_APPROVAL（现状不变，升闸只挂 fail）', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 2 } });
  const id = newFeatureTask(env);
  env.setScenario([
    specAgentStep(env, id),
    specVerifierStep(1, 'pass', { over: { findings: [ADVISORY] } }),
  ]);
  assert.equal(env.run('run').status, 0);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(after.runtime.scope_decision, null);
  assert.equal(fs.existsSync(env.dossier(id, 'scope-decision.json')), false);
});

test('契约7：fail + 未超规模 → SPEC_FIXING（现状不变）', (t) => {
  const env = makeEnv(t, { config: { specMaxAcs: 5 } }); // 3 条 AC ≤ 5
  const id = newFeatureTask(env);
  env.setScenario([
    specAgentStep(env, id),
    specVerifierStep(1, 'fail', { over: { findings: [MAJOR] } }),
  ]);
  assert.equal(env.run('run').status, 0);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'SPEC_FIXING');
  assert.equal(after.runtime.spec_miss_count, 1);
  assert.equal(timelineOf(env, id).includes('规模升闸'), false);
});
