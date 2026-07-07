// 集成：Codex verifier shadow（R4-E11，观测实验）。契约：
//   1) 默认配置行为完全不变（零 codex 调用、零 shadow 产物）；
//   2) 开启后不改变 task stage（主 verdict 仍是唯一裁判）；
//   3) shadow 产物正确落盘（verdict/md/compare/stream）；
//   4) shadow verdict 必须过 validateVerifierVerdict 才算有效；
//   5) shadow 协议/基建失败不污染 verifier_invalid_count、不产生 repair-context；
//   6) disagreement（含 high-risk false-pass）被记录，且不影响主 verdict 路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, criterion, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-codex.mjs');
const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

function verdictOf(round, statuses) {
  const entries = Object.entries(statuses);
  return {
    schema_version: 1,
    round,
    overall: entries.every(([, s]) => s === 'pass') ? 'pass' : 'fail',
    criteria_results: entries.map(([acId, s]) => criterion(acId, { status: s, reason: `shadow 裁决 ${s}` })),
    non_ac_findings: [],
  };
}

/** 挂 fake-codex：写剧本 + 返回 runWithEnv 用的环境覆盖与日志路径。 */
function wireCodex(env, steps) {
  const script = path.join(env.root, 'fake-codex-scenario.json');
  fs.writeFileSync(script, JSON.stringify(steps));
  const log = path.join(env.root, 'fake-codex.log');
  return { overrides: { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_SCRIPT: script, FAKE_CODEX_LOG: log }, log };
}

test('契约1：默认配置（shadow 关）——零 codex 调用、零 shadow 产物、行为不变', (t) => {
  const env = makeEnv(t); // 不写任何 shadow 配置 → 默认 false
  const id = 'task-20260707-960';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const { overrides, log } = wireCodex(env, [{ lastMessage: verdictOf(1, { 'AC-001': 'pass', 'AC-002': 'pass' }) }]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim() === '', '默认关闭不得调用 codex');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.shadow-compare.json')), '不得产生 shadow 产物');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.codex-shadow.verdict.json')));
});

test('契约2+3+4：shadow 开启且裁决一致——stage 不变、产物齐全、verdict 过契约', (t) => {
  const env = makeEnv(t, { config: { verifierShadowEnabled: true } });
  const id = 'task-20260707-961';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const { overrides, log } = wireCodex(env, [{ lastMessage: verdictOf(1, { 'AC-001': 'pass', 'AC-002': 'pass' }) }]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '主 verdict 唯一裁判，shadow 不影响 stage');
  assert.equal(after.runtime.verifier_invalid_count, 0);

  // 产物齐全且 shadow verdict 与主 verdict 同构（过了同一份 validateVerifierVerdict）
  const shadowVerdict = env.readJson(env.dossier(id, 'verify-r1.codex-shadow.verdict.json'));
  assert.equal(shadowVerdict.overall, 'pass');
  assert.equal(shadowVerdict.criteria_results.length, 2);
  assert.ok(env.exists(env.dossier(id, 'verify-r1.codex-shadow.md')), '人读报告落盘');
  assert.ok(env.exists(env.dossier(id, 'verify-r1.codex-shadow.stream.jsonl')), '事件流留证');

  const compare = env.readJson(env.dossier(id, 'verify-r1.shadow-compare.json'));
  assert.equal(compare.backend, 'codex-exec');
  assert.equal(compare.shadow.valid, true);
  assert.equal(compare.agreement.total_acs, 2);
  assert.equal(compare.agreement.agreed, 2);
  assert.equal(compare.agreement.high_risk_count, 0);
  assert.equal(compare.main.overall, 'pass');
  assert.ok(compare.shadow.usage, 'shadow token usage 捞到（成本对照锚点）');

  // codex 收到与主 verifier 同源的输入（spec + AC 枚举 + verdict contract）
  const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.ok(call.argv.includes('exec') && call.argv.includes('read-only'), 'read-only 沙箱');
  assert.ok(call.prompt_head.length > 0, 'prompt 经 stdin 注入');
});

test('契约5a：shadow 协议失败（非 JSON 输出）——不计主 invalid、不影响 stage', (t) => {
  const env = makeEnv(t, { config: { verifierShadowEnabled: true } });
  const id = 'task-20260707-962';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const { overrides } = wireCodex(env, [{ lastMessage: '我觉得都挺好的（非 JSON 叙事）' }]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.verifier_invalid_count, 0, 'shadow 协议失败绝不污染主 invalid 计数');

  const invalid = env.readJson(env.dossier(id, 'verify-r1.codex-shadow.invalid.json'));
  assert.equal(invalid.kind, 'protocol');
  const compare = env.readJson(env.dossier(id, 'verify-r1.shadow-compare.json'));
  assert.equal(compare.shadow.valid, false);
  assert.equal(compare.agreement, null);
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.codex-shadow.verdict.json')), '无效输出不得落 verdict');
  assert.ok(!env.exists(env.dossier(id, 'repair-context-r1.json')), '不得产生 repair-context');
});

test('契约5b：shadow 基建失败（非零退出）——记 infra 证据，主链无感', (t) => {
  const env = makeEnv(t, { config: { verifierShadowEnabled: true } });
  const id = 'task-20260707-963';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);
  const { overrides } = wireCodex(env, [{ exitCode: 1, noLastMessage: true }]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(env.readJson(env.dossier(id, 'verify-r1.codex-shadow.invalid.json')).kind, 'infra');
  assert.equal(env.readJson(env.dossier(id, 'verify-r1.shadow-compare.json')).shadow.valid, false);
});

test('契约6：disagreement——主裁 fail/shadow 裁 pass 记 high-risk，主路由（FIXING→修复→过）不受影响', (t) => {
  const env = makeEnv(t, { config: { verifierShadowEnabled: true } });
  const id = 'task-20260707-964';
  env.writeTask(id);
  const mainFail = JSON.stringify({
    schema_version: 1,
    round: 1,
    overall: 'fail',
    criteria_results: [
      criterion('AC-001', { status: 'pass', reason: '已满足' }),
      criterion('AC-002', { status: 'fail', reason: '偶数分支仍未取平均' }),
    ],
    non_ac_findings: [],
  });
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' }, // maker r1
    { cost: 0.02, result: mainFail },                                    // verifier r1 合法 fail
    { actions: [FIX], session_id: 'sess-m1', cost: 0.08, result: 'r2' }, // maker r2 修复
    verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' }),             // verifier r2 pass
  ]);
  const { overrides } = wireCodex(env, [
    { lastMessage: verdictOf(1, { 'AC-001': 'pass', 'AC-002': 'pass' }) }, // shadow r1：与主裁分歧（false-pass 风险形态）
    { lastMessage: verdictOf(2, { 'AC-001': 'pass', 'AC-002': 'pass' }) }, // shadow r2：一致
  ]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);

  // 主路由不受影响：r1 fail → repair-context + miss=1 → r2 修复 → AWAIT_HUMAN_MERGE
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, '主 verdict fail 照常吃 miss');
  assert.ok(env.exists(env.dossier(id, 'repair-context-r1.json')), '主链 repair-context 照常生成');

  // disagreement 记录：AC-002 main=fail / shadow=pass → high_risk（false-pass 候选否决证据）
  const c1 = env.readJson(env.dossier(id, 'verify-r1.shadow-compare.json'));
  assert.equal(c1.agreement.agreed, 1);
  assert.deepEqual(c1.agreement.disagreements, [{ ac_id: 'AC-002', main: 'fail', shadow: 'pass', high_risk: true }]);
  assert.equal(c1.agreement.high_risk_count, 1);
  assert.equal(c1.main.overall, 'fail');
  assert.equal(c1.shadow.overall, 'pass');

  const c2 = env.readJson(env.dossier(id, 'verify-r2.shadow-compare.json'));
  assert.equal(c2.agreement.agreed, 2);
  assert.equal(c2.agreement.high_risk_count, 0);
});
