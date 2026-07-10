// 集成：verifier evidence 机械锚定核验（R5-H15）。契约：
//   1) 默认 off = 旧行为：evidence 全是幻觉也照旧接受（不核验、零锚定产物）；
//   2) observe：只落 verify-r<n>.evidence-anchors.json + timeline，任何锚定结果都不影响路由；
//   3) enforce：hard 错误（文件不存在 / 行号越界）走协议 invalid 阶梯（invalid-a<m> 带
//      anchor_mismatches），重试轮给出干净 verdict 后正常放行；
//   4) enforce 不误杀 soft：引用 diff 外真实文件（verifier 有全树只读权）不拒收，只记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, criterion, evidence, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

/** 两条 AC 全 pass、但 evidence 可自定义的严格 JSON verdict。 */
function rawVerdict(round, evidenceByAc) {
  return JSON.stringify({
    schema_version: 1,
    round,
    overall: 'pass',
    criteria_results: [
      criterion('AC-001', { evidence: evidenceByAc['AC-001'] }),
      criterion('AC-002', { evidence: evidenceByAc['AC-002'] }),
    ],
    non_ac_findings: [],
  });
}

// 幻觉证据组合：AC-001 引用不存在文件；AC-002 行号越界（FIXED_STATS 仅 10 行）。
const HALLUCINATED = {
  'AC-001': [evidence({ file: 'lib/no-such-file.mjs' })],
  'AC-002': [evidence({ start_line: 9, end_line: 999 })],
};

test('契约1：默认 off——幻觉 evidence 也照旧接受，零锚定产物（开关关闭 = 旧行为）', (t) => {
  const env = makeEnv(t); // 不写 verifierEvidenceAnchorsMode → 默认 off
  const id = 'task-20260708-970';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    { cost: 0.02, result: rawVerdict(1, HALLUCINATED) },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', '默认不核验，幻觉照旧过');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.evidence-anchors.json')), '不得产生锚定产物');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.invalid-a1.json')), '不得判 invalid');
});

test('契约2：observe——hard/soft 全记录，verdict 照常消费、stage 不受影响', (t) => {
  const env = makeEnv(t, { config: { verifierEvidenceAnchorsMode: 'observe' } });
  const id = 'task-20260708-971';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    {
      cost: 0.02,
      result: rawVerdict(1, {
        'AC-001': [evidence({ file: 'lib/no-such-file.mjs' })],
        // 越界 + diff 外真实文件（README.md 在 fixture 里 3 行、maker 未改它）
        'AC-002': [evidence({ start_line: 9, end_line: 999 }), evidence({ file: 'README.md', start_line: 1, end_line: 2 })],
      }),
    },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', 'observe 绝不影响路由');
  assert.equal(after.runtime.verifier_invalid_count, 0);

  const anchors = env.readJson(env.dossier(id, 'verify-r1.evidence-anchors.json'));
  assert.equal(anchors.mode, 'observe');
  assert.equal(anchors.hard_count, 2);
  assert.deepEqual(anchors.hard.map((h) => [h.ac_id, h.file, h.reason]), [
    ['AC-001', 'lib/no-such-file.mjs', 'file_missing'],
    ['AC-002', 'lib/stats.mjs', 'line_out_of_range'],
  ]);
  assert.equal(anchors.hard[1].file_lines, 9, '记录真实行数供分析（FIXED_STATS 共 9 行）');
  assert.equal(anchors.soft_count, 1);
  assert.deepEqual([anchors.soft[0].file, anchors.soft[0].reason], ['README.md', 'outside_diff']);
  assert.ok(env.exists(env.dossier(id, 'verify-r1.verdict.json')), 'verdict 照常落盘');
});

test('契约3：enforce——hard 错误判协议 invalid（带 anchor_mismatches），重试干净 verdict 后放行', (t) => {
  const env = makeEnv(t, { config: { verifierEvidenceAnchorsMode: 'enforce' } });
  const id = 'task-20260708-972';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    { cost: 0.02, result: rawVerdict(1, HALLUCINATED) }, // a1：幻觉 → invalid
    verifierStep(1),                                      // a2：干净 verdict（默认 evidence 锚在 lib/stats.mjs:8）
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const invalid = env.readJson(env.dossier(id, 'verify-r1.invalid-a1.json'));
  assert.equal(invalid.attempt, 1);
  assert.equal(invalid.errors.length, 2);
  assert.match(invalid.errors[0], /文件不存在.*lib\/no-such-file\.mjs/);
  assert.match(invalid.errors[1], /行号越界.*lib\/stats\.mjs:9-999（文件共 9 行）/);
  assert.equal(invalid.anchor_mismatches.hard.length, 2, 'invalid 文件附全量锚定明细');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '重试轮干净 verdict 正常放行');
  assert.equal(after.runtime.verifier_invalid_count, 0, 'valid 后计数重置');
  const anchors = env.readJson(env.dossier(id, 'verify-r1.evidence-anchors.json'));
  assert.equal(anchors.hard_count, 0, '干净轮锚定产物 hard=0');
  assert.ok(!env.exists(env.dossier(id, 'repair-context-r1.json')), '锚定 invalid 不是 maker 失败，不得产生 repair-context');
});

test('契约4：enforce——引用 diff 外真实文件只记 soft，不拒收（不误杀合法全树引用）', (t) => {
  const env = makeEnv(t, { config: { verifierEvidenceAnchorsMode: 'enforce' } });
  const id = 'task-20260708-973';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' },
    {
      cost: 0.02,
      result: rawVerdict(1, {
        'AC-001': [evidence()], // diff 内正常锚定
        'AC-002': [evidence({ file: 'README.md', start_line: 1, end_line: 3 })], // diff 外真实文件
      }),
    },
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE', 'soft-only 不拒收');
  const anchors = env.readJson(env.dossier(id, 'verify-r1.evidence-anchors.json'));
  assert.equal(anchors.hard_count, 0);
  assert.equal(anchors.soft_count, 1);
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.invalid-a1.json')), '不得判 invalid');
});
