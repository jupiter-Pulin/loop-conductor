// decisions.mjs 单测：纯转移分支全覆盖 + verdict 严格解析与 schema 校验各分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markerStatus, overBudget, greenGatePassed, approvalNext, setupApprovalNext,
  needsSpecAction, makerMissNext, makerRound, verdictNext, verifierInvalidNext,
  fixingMode, parseStrictJson, specMissNext, specVerifierInvalidNext,
  needsFeasibilityAction, feasibilityApprovalNext, feasibilityContractInvalidNext,
  validateSpecVerifierVerdict, validateVerifierVerdict, MAX_MISS, STAGES,
  sameSignatureStreak,
} from '../../conductor/stages/decisions.mjs';

test('markerStatus：双标记四态', () => {
  assert.equal(markerStatus(null), 'none');
  assert.equal(markerStatus(undefined), 'none');
  assert.equal(markerStatus({}), 'none');
  assert.equal(markerStatus({ started: 't0' }), 'in-progress'); // 有 started 无 done = 上次崩溃
  assert.equal(markerStatus({ started: 't0', done: 't1' }), 'done');
  assert.equal(markerStatus({ started: 't0', abandoned: true }), 'none'); // 人工 retry 清理后
});

test('overBudget：达到上限即拒绝', () => {
  assert.equal(overBudget(0, 5), false);
  assert.equal(overBudget(4.99, 5), false);
  assert.equal(overBudget(5, 5), true);
  assert.equal(overBudget(10, 5), true);
  assert.equal(overBudget(null, 5), false);
});

test('greenGatePassed：只认 exit code 0', () => {
  assert.equal(greenGatePassed(0), true);
  assert.equal(greenGatePassed(1), false);
  assert.equal(greenGatePassed(-1), false);
  assert.equal(greenGatePassed(null), false);
});

test('makerMissNext：miss++ 走 1/2/3 阶梯', () => {
  assert.deepEqual(makerMissNext(0), { stage: 'FIXING', missCount: 1 });
  assert.deepEqual(makerMissNext(1), { stage: 'FIXING', missCount: 2 });
  assert.deepEqual(makerMissNext(2), { stage: 'FAILED_BOX', missCount: 3 });
  assert.deepEqual(makerMissNext(null), { stage: 'FIXING', missCount: 1 });
  // 自定义上限
  assert.deepEqual(makerMissNext(0, 1), { stage: 'FAILED_BOX', missCount: 1 });
  assert.deepEqual(makerMissNext(3, 5), { stage: 'FIXING', missCount: 4 });
  assert.equal(MAX_MISS, 3);
});

test('makerRound：maker 轮次恒等于 miss+1（唯一推导点）', () => {
  assert.equal(makerRound(0), 1); // READY 时 miss=0 → r1
  assert.equal(makerRound(1), 2);
  assert.equal(makerRound(undefined), 1);
});

test('verdictNext(overall)：pass 终点 / fail 同 miss 阶梯', () => {
  assert.deepEqual(verdictNext('pass', 0), { stage: 'AWAIT_HUMAN_MERGE', missCount: 0 });
  assert.deepEqual(verdictNext('pass', 2), { stage: 'AWAIT_HUMAN_MERGE', missCount: 2 });
  assert.deepEqual(verdictNext('fail', 0), { stage: 'FIXING', missCount: 1 });
  assert.deepEqual(verdictNext('fail', 1), { stage: 'FIXING', missCount: 2 });
  assert.deepEqual(verdictNext('fail', 2), { stage: 'FAILED_BOX', missCount: 3 });
  assert.deepEqual(verdictNext('fail', 5), { stage: 'FAILED_BOX', missCount: 6 });
  // 自定义上限透传
  assert.deepEqual(verdictNext('fail', 0, 1), { stage: 'FAILED_BOX', missCount: 1 });
});

test('verifierInvalidNext：留 VERIFY 重试 / 超额收箱（边界）', () => {
  // maxInvalid=2：共容忍初始 + 2 重试 = 3 次尝试
  assert.deepEqual(verifierInvalidNext(0, 2), { stage: 'VERIFY', invalidCount: 1, failureType: null });
  assert.deepEqual(verifierInvalidNext(1, 2), { stage: 'VERIFY', invalidCount: 2, failureType: null });
  assert.deepEqual(verifierInvalidNext(2, 2), {
    stage: 'FAILED_BOX', invalidCount: 3, failureType: 'verifier_protocol_exhausted',
  });
  // null 起点
  assert.deepEqual(verifierInvalidNext(null, 2), { stage: 'VERIFY', invalidCount: 1, failureType: null });
  // maxInvalid=0：第一次就收箱
  assert.deepEqual(verifierInvalidNext(0, 0), {
    stage: 'FAILED_BOX', invalidCount: 1, failureType: 'verifier_protocol_exhausted',
  });
});

test('specMissNext：两次修复，第三次 fail 冷启动新 spec-agent', () => {
  assert.deepEqual(specMissNext(0, 3), { stage: 'SPEC_FIXING', missCount: 1, coldRestart: false });
  assert.deepEqual(specMissNext(1, 3), { stage: 'SPEC_FIXING', missCount: 2, coldRestart: false });
  assert.deepEqual(specMissNext(2, 3), { stage: 'NEEDS_SPEC', missCount: 3, coldRestart: true });
});

test('specVerifierInvalidNext：留 SPEC_VERIFY 重试 / 超额收箱', () => {
  assert.deepEqual(specVerifierInvalidNext(0, 2), { stage: 'SPEC_VERIFY', invalidCount: 1, failureType: null });
  assert.deepEqual(specVerifierInvalidNext(1, 2), { stage: 'SPEC_VERIFY', invalidCount: 2, failureType: null });
  assert.deepEqual(specVerifierInvalidNext(2, 2), {
    stage: 'FAILED_BOX', invalidCount: 3, failureType: 'spec_verifier_protocol_exhausted',
  });
});

test('approvalNext：人类闸门三分支', () => {
  assert.equal(approvalNext('approved'), 'READY');
  assert.equal(approvalNext('rejected'), 'NEEDS_SPEC');
  assert.equal(approvalNext(null), null);
  assert.equal(approvalNext('garbage'), null);
});

test('setupApprovalNext：setup 人类闸门', () => {
  assert.equal(setupApprovalNext('approved'), 'approved');
  assert.equal(setupApprovalNext(null), null);
  assert.equal(setupApprovalNext('garbage'), null);
});

test('needsSpecAction：spec 已存在且未打回 → 跳过 spawn', () => {
  assert.equal(needsSpecAction(true, null), 'skip-spawn');
  assert.equal(needsSpecAction(false, null), 'spawn');
  assert.equal(needsSpecAction(true, 'rejected'), 'spawn');
  assert.equal(needsSpecAction(false, 'rejected'), 'spawn');
});

test('STAGES：feasibility stage 对插在 setup 闸门与 NEEDS_SPEC 之间', () => {
  const i = STAGES.indexOf('NEEDS_FEASIBILITY');
  assert.ok(i > STAGES.indexOf('AWAIT_SETUP_APPROVAL'));
  assert.equal(STAGES[i + 1], 'AWAIT_FEASIBILITY_APPROVAL');
  assert.equal(STAGES[i + 2], 'NEEDS_SPEC');
});

test('feasibilityApprovalNext：option 人类闸门三分支', () => {
  assert.equal(feasibilityApprovalNext('approved'), 'NEEDS_SPEC');
  assert.equal(feasibilityApprovalNext('rejected'), 'NEEDS_FEASIBILITY');
  assert.equal(feasibilityApprovalNext(null), null);
  assert.equal(feasibilityApprovalNext('garbage'), null);
});

test('needsFeasibilityAction：草稿已存在且未打回 → 跳过 spawn', () => {
  assert.equal(needsFeasibilityAction(true, null), 'skip-spawn');
  assert.equal(needsFeasibilityAction(false, null), 'spawn');
  assert.equal(needsFeasibilityAction(true, 'rejected'), 'spawn');
});

test('feasibilityContractInvalidNext：交付契约失败阶梯（maxInvalid=2：初始+2 重试后耗尽）', () => {
  assert.deepEqual(feasibilityContractInvalidNext(0, 2), { exhausted: false, invalidCount: 1, failureType: null });
  assert.deepEqual(feasibilityContractInvalidNext(1, 2), { exhausted: false, invalidCount: 2, failureType: null });
  assert.deepEqual(
    feasibilityContractInvalidNext(2, 2),
    { exhausted: true, invalidCount: 3, failureType: 'feasibility_contract_exhausted' },
  );
  assert.deepEqual(feasibilityContractInvalidNext(null, 2), { exhausted: false, invalidCount: 1, failureType: null });
});

test('fixingMode：miss==1 且有 session 才 resume', () => {
  assert.equal(fixingMode(1, 'sess-abc'), 'resume');
  assert.equal(fixingMode(1, null), 'cold');
  assert.equal(fixingMode(2, 'sess-abc'), 'cold');
});

test('parseStrictJson：只认严格 JSON，不在叙事里打捞', () => {
  assert.deepEqual(parseStrictJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStrictJson('  {"a":1} '), { a: 1 });
  assert.deepEqual(parseStrictJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStrictJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStrictJson('[1,2,3]'), [1, 2, 3]); // 数组也是合法 JSON（schema 由上层校验）
  // 叙事 + JSON 混排 → 拒绝
  assert.equal(parseStrictJson('我认为可以通过。{"a":1}'), null);
  assert.equal(parseStrictJson('not json'), null);
  assert.equal(parseStrictJson(null), null);
  assert.equal(parseStrictJson(123), null);
});

// ---- validateVerifierVerdict ----

const goodCriterion = (acId = 'AC-001', status = 'pass') => ({
  ac_id: acId,
  status,
  reason: '实现正确',
  evidence: [{ type: 'source', file: 'lib/stats.mjs', start_line: 8, end_line: 8, summary: '偶数分支取平均' }],
});

const goodVerdict = (overrides = {}) => ({
  schema_version: 1,
  round: 1,
  overall: 'pass',
  criteria_results: [goodCriterion('AC-001'), goodCriterion('AC-002')],
  non_ac_findings: [],
  ...overrides,
});

test('validateVerifierVerdict：接受合法 verdict（多 AC，覆盖完整）', () => {
  const r = validateVerifierVerdict(goodVerdict(), ['AC-001', 'AC-002']);
  assert.equal(r.ok, true);
  assert.equal(r.verdict.overall, 'pass');
  assert.equal(r.verdict.criteria_results.length, 2);
  assert.deepEqual(r.verdict.non_ac_findings, []);
});

test('validateVerifierVerdict：non_ac_findings 缺省补 []', () => {
  const v = goodVerdict();
  delete v.non_ac_findings;
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdict.non_ac_findings, []);
});

test('validateVerifierVerdict：Set 形态 expectedAcIds 也接受', () => {
  const r = validateVerifierVerdict(goodVerdict(), new Set(['AC-001', 'AC-002']));
  assert.equal(r.ok, true);
});

test('validateVerifierVerdict：拒绝 prose-wrapped（非对象/数组/null）', () => {
  assert.equal(validateVerifierVerdict(null, ['AC-001']).ok, false);
  assert.equal(validateVerifierVerdict([1, 2], ['AC-001']).ok, false);
  assert.equal(validateVerifierVerdict('text', ['AC-001']).ok, false);
});

test('validateVerifierVerdict：缺 AC（覆盖不全）', () => {
  const v = goodVerdict({ criteria_results: [goodCriterion('AC-001')] });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /缺 AC：AC-002/.test(e)));
});

test('validateVerifierVerdict：多余 AC', () => {
  const v = goodVerdict({ criteria_results: [goodCriterion('AC-001'), goodCriterion('AC-002'), goodCriterion('AC-003')] });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /多余 AC：AC-003/.test(e)));
});

test('validateVerifierVerdict：重复 AC', () => {
  const v = goodVerdict({ criteria_results: [goodCriterion('AC-001'), goodCriterion('AC-001')] });
  const r = validateVerifierVerdict(v, ['AC-001']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /重复/.test(e)));
});

test('validateVerifierVerdict：非法 status', () => {
  const v = goodVerdict({
    overall: 'fail',
    criteria_results: [goodCriterion('AC-001'), { ...goodCriterion('AC-002'), status: 'maybe' }],
  });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /status 非法/.test(e)));
});

test('validateVerifierVerdict：pass 无 evidence 非法', () => {
  const v = goodVerdict({
    criteria_results: [goodCriterion('AC-001'), { ...goodCriterion('AC-002'), evidence: [] }],
  });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /缺 evidence/.test(e)));
});

test('validateVerifierVerdict：fail 无 evidence 非法', () => {
  const v = goodVerdict({
    overall: 'fail',
    criteria_results: [goodCriterion('AC-001'), { ...goodCriterion('AC-002'), status: 'fail', evidence: [] }],
  });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /缺 evidence/.test(e)));
});

test('validateVerifierVerdict：unknown 允许空 evidence 但 reason 必须非空', () => {
  const okV = goodVerdict({
    overall: 'fail',
    criteria_results: [goodCriterion('AC-001'), { ac_id: 'AC-002', status: 'unknown', reason: '缺实现', evidence: [] }],
  });
  assert.equal(validateVerifierVerdict(okV, ['AC-001', 'AC-002']).ok, true);

  const badReason = goodVerdict({
    overall: 'fail',
    criteria_results: [goodCriterion('AC-001'), { ac_id: 'AC-002', status: 'unknown', reason: '   ', evidence: [] }],
  });
  const r = validateVerifierVerdict(badReason, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /reason 必须非空/.test(e)));
});

test('validateVerifierVerdict：overall 不一致（pass 但有非 pass）', () => {
  const v = goodVerdict({
    overall: 'pass',
    criteria_results: [goodCriterion('AC-001'), { ...goodCriterion('AC-002'), status: 'fail' }],
  });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /overall=pass 但存在非 pass/.test(e)));
});

test('validateVerifierVerdict：非法 overall', () => {
  const v = goodVerdict({ overall: 'maybe' });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /overall 必须/.test(e)));
});

test('validateVerifierVerdict：schema_version 错误', () => {
  const r = validateVerifierVerdict(goodVerdict({ schema_version: 2 }), ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /schema_version/.test(e)));
});

test('validateVerifierVerdict：criteria_results 非数组', () => {
  const r = validateVerifierVerdict(goodVerdict({ criteria_results: {} }), ['AC-001']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /criteria_results 必须是数组/.test(e)));
});

test('validateVerifierVerdict：evidence 行号非法', () => {
  const badStart = goodVerdict({
    criteria_results: [goodCriterion('AC-001'), {
      ...goodCriterion('AC-002'),
      evidence: [{ type: 'source', file: 'a.mjs', start_line: 0, end_line: 3, summary: 's' }],
    }],
  });
  assert.ok(validateVerifierVerdict(badStart, ['AC-001', 'AC-002']).errors.some((e) => /行号非法/.test(e)));

  const inverted = goodVerdict({
    criteria_results: [goodCriterion('AC-001'), {
      ...goodCriterion('AC-002'),
      evidence: [{ type: 'source', file: 'a.mjs', start_line: 9, end_line: 3, summary: 's' }],
    }],
  });
  assert.ok(validateVerifierVerdict(inverted, ['AC-001', 'AC-002']).errors.some((e) => /行号非法/.test(e)));
});

test('validateVerifierVerdict：evidence 缺 type/file/summary 字段', () => {
  const v = goodVerdict({
    criteria_results: [goodCriterion('AC-001'), {
      ...goodCriterion('AC-002'),
      evidence: [{ file: 'a.mjs', start_line: 1, end_line: 1 }],
    }],
  });
  const r = validateVerifierVerdict(v, ['AC-001', 'AC-002']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /缺 type\/file\/summary/.test(e)));
});

function goodSpecVerdict(over = {}) {
  return {
    schema_version: 1,
    round: 1,
    overall: 'pass',
    summary: 'spec is ready',
    human_report: 'Human can approve this spec.',
    spec_agent_feedback: 'No repair needed.',
    findings: [],
    ...over,
  };
}

test('validateSpecVerifierVerdict：合法 pass / fail', () => {
  assert.equal(validateSpecVerifierVerdict(goodSpecVerdict()).ok, true);
  const fail = goodSpecVerdict({
    overall: 'fail',
    findings: [{ severity: 'major', audience: 'both', issue: 'AC 太泛', recommendation: '拆成可验证条目' }],
  });
  assert.equal(validateSpecVerifierVerdict(fail).ok, true);
});

test('validateSpecVerifierVerdict：fail 必须有 findings 且报告字段非空', () => {
  const noFindings = validateSpecVerifierVerdict(goodSpecVerdict({ overall: 'fail', findings: [] }));
  assert.equal(noFindings.ok, false);
  assert.ok(noFindings.errors.some((e) => /findings 至少 1 条/.test(e)));

  const noReport = validateSpecVerifierVerdict(goodSpecVerdict({ human_report: ' ' }));
  assert.equal(noReport.ok, false);
  assert.ok(noReport.errors.some((e) => /human_report/.test(e)));
});

test('validateSpecVerifierVerdict：finding 字段枚举与文本校验', () => {
  const r = validateSpecVerifierVerdict(goodSpecVerdict({
    overall: 'fail',
    findings: [{ severity: 'huge', audience: 'nobody', issue: '', recommendation: '' }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /severity/.test(e)));
  assert.ok(r.errors.some((e) => /audience/.test(e)));
  assert.ok(r.errors.some((e) => /issue/.test(e)));
  assert.ok(r.errors.some((e) => /recommendation/.test(e)));
});

test('sameSignatureStreak：尾部连续相等 run 长度', () => {
  assert.equal(sameSignatureStreak(['A', 'A']), 2);
  assert.equal(sameSignatureStreak(['A', 'A', 'B']), 1);
  assert.equal(sameSignatureStreak(['A', 'B', 'A']), 1);
  assert.equal(sameSignatureStreak([]), 0);
  assert.equal(sameSignatureStreak(undefined), 0);
  assert.equal(sameSignatureStreak(['A', 'A', 'A']), 3);
});

test('sameSignatureStreak：undefined（旧记录/无签名）打断连续', () => {
  assert.equal(sameSignatureStreak([undefined, 'A', 'A']), 2, '尾部两个仍相等，不受更早的 undefined 影响');
  assert.equal(sameSignatureStreak(['A', undefined, 'A']), 1, '紧邻的 undefined 打断连续');
  assert.equal(sameSignatureStreak(['A', 'A', undefined]), 1, '尾元素本身 undefined，只算自身长度 1');
  assert.equal(sameSignatureStreak([undefined, undefined]), 1, '两个 undefined 不视为彼此相等');
});
