// decisions.mjs 单测：纯转移分支全覆盖 + verdict 严格解析与 schema 校验各分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markerStatus, overBudget, greenGatePassed, approvalNext, setupApprovalNext,
  needsSpecAction, makerMissNext, makerRound, verdictNext, verifierInvalidNext,
  fixingMode, parseStrictJson, specMissNext, specFailRoute, specVerifierInvalidNext, crashRecoveryNext,
  needsFeasibilityAction, feasibilityApprovalNext, feasibilityContractInvalidNext,
  specScaleGateViolation, validateSpecVerifierVerdict, validateVerifierVerdict, MAX_MISS, STAGES,
  sameSignatureStreak, normalizeGateCommands, resolveGateCommands, checkEvidenceAnchors, validateReviewReport,
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

test('crashRecoveryNext：孤儿腿有界自动恢复（默认额度 1）', () => {
  assert.deepEqual(crashRecoveryNext(0, 1), { action: 'auto-recover', count: 1 });
  assert.deepEqual(crashRecoveryNext(1, 1), { action: 'box', count: 1 }); // 额度用尽 → 旧行为
  assert.deepEqual(crashRecoveryNext(null, 1), { action: 'auto-recover', count: 1 });
  assert.deepEqual(crashRecoveryNext(undefined, 1), { action: 'auto-recover', count: 1 });
  // limit=0 = 关闭：count=0 时也直接收箱，且 count 保持 0（收箱文案不追加「已用尽」）
  assert.deepEqual(crashRecoveryNext(0, 0), { action: 'box', count: 0 });
  assert.deepEqual(crashRecoveryNext(null, 0), { action: 'box', count: 0 });
  // 多次额度：达界前逐次自增，达界即收箱
  assert.deepEqual(crashRecoveryNext(1, 3), { action: 'auto-recover', count: 2 });
  assert.deepEqual(crashRecoveryNext(2, 3), { action: 'auto-recover', count: 3 });
  assert.deepEqual(crashRecoveryNext(3, 3), { action: 'box', count: 3 });
  // 越界（历史 runtime 计数高于当前 limit）：一律收箱，不倒扣、不重开额度
  assert.deepEqual(crashRecoveryNext(5, 1), { action: 'box', count: 5 });
  // limit 非法（负数/非整数/缺失）按 0 处理：worktree 可能半改，拿不准时退回收箱侧
  assert.deepEqual(crashRecoveryNext(0, -1), { action: 'box', count: 0 });
  assert.deepEqual(crashRecoveryNext(0, 1.5), { action: 'box', count: 0 });
  assert.deepEqual(crashRecoveryNext(0, null), { action: 'box', count: 0 });
  assert.deepEqual(crashRecoveryNext(0, 'many'), { action: 'box', count: 0 });
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

test('specFailRoute：规模闸触发且未豁免才升闸，其余一律走 miss 阶梯', () => {
  const gate = { acCount: 30, max: 12 };
  assert.equal(specFailRoute(gate, null), 'escalate');
  assert.equal(specFailRoute(gate, undefined), 'escalate');
  assert.equal(specFailRoute(gate, 'split'), 'escalate'); // split 会立刻收箱，理论上到不了；不是豁免值就不放行
  assert.equal(specFailRoute(gate, 'waived'), 'miss-ladder'); // 人已接受规模：持久豁免，永不再升闸
  assert.equal(specFailRoute(null, null), 'miss-ladder');
  assert.equal(specFailRoute(null, 'waived'), 'miss-ladder');
});

test('STAGES：规模人闸排在 spec 修复循环与 spec 审批门之间', () => {
  const i = STAGES.indexOf('AWAIT_SCOPE_DECISION');
  assert.ok(i > STAGES.indexOf('SPEC_VERIFY'));
  assert.ok(i < STAGES.indexOf('AWAIT_SPEC_APPROVAL'));
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

test('validateSpecVerifierVerdict：advisory finding 合法，可随 pass 出现（H18 规模闸拆分建议）', () => {
  const r = validateSpecVerifierVerdict(goodSpecVerdict({
    findings: [{ severity: 'advisory', audience: 'both', issue: 'AC×24 超过阈值 12', recommendation: '拆 Milestone A/B 两任务' }],
  }));
  assert.equal(r.ok, true, r.errors?.join('; '));
});

test('specScaleGateViolation：闸触发 ⇔ advisory 在场，双向核验', () => {
  const advisory = { severity: 'advisory', audience: 'both', issue: '超阈值', recommendation: '拆分' };
  const gate = { acCount: 24, max: 12 };
  assert.equal(specScaleGateViolation(gate, goodSpecVerdict({ findings: [advisory] })), null, '闸开+advisory=守约');
  assert.equal(specScaleGateViolation(null, goodSpecVerdict()), null, '闸关+无 advisory=守约');
  assert.match(specScaleGateViolation(gate, goodSpecVerdict()) ?? '', /规模闸已触发.*advisory/, '闸开缺 advisory=违约');
  assert.match(specScaleGateViolation(null, goodSpecVerdict({ findings: [advisory] })) ?? '', /规模闸未触发/, '闸关带 advisory=违约');
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

test('normalizeGateCommands：非数组 / 含非字符串元素 → []，不抛错（AC-1）', () => {
  assert.deepEqual(normalizeGateCommands(undefined), []);
  assert.deepEqual(normalizeGateCommands(null), []);
  assert.deepEqual(normalizeGateCommands('npm run build'), []);
  assert.deepEqual(normalizeGateCommands({ 0: 'npm run build' }), []);
  assert.deepEqual(normalizeGateCommands(['npm run build', 42]), []);
  assert.deepEqual(normalizeGateCommands([]), []);
  assert.deepEqual(normalizeGateCommands(['npm run typecheck', 'npm run build']), ['npm run typecheck', 'npm run build']);
});

test('resolveGateCommands：task.json 未提供该字段 → 退回 target-profile 默认（AC-1）', () => {
  assert.deepEqual(resolveGateCommands({ id: 't1' }, ['npm run build']), ['npm run build']);
  assert.deepEqual(resolveGateCommands({ id: 't1' }, undefined), [], '两侧都缺省 → 空数组');
  assert.deepEqual(resolveGateCommands({ id: 't1' }, 'not-an-array'), [], 'profile 默认非法同样保守处理为 []');
});

test('resolveGateCommands：task.json 显式提供该字段即完全覆盖 profile，不做合并（AC-1）', () => {
  assert.deepEqual(
    resolveGateCommands({ gateCommands: ['npm run typecheck'] }, ['npm run build']),
    ['npm run typecheck'],
  );
  assert.deepEqual(
    resolveGateCommands({ gateCommands: [] }, ['npm run build']),
    [],
    'task.json 显式空数组仍完全覆盖 profile 默认，不合并',
  );
  assert.deepEqual(
    resolveGateCommands({ gateCommands: 'not-an-array' }, ['npm run build']),
    [],
    'task.json 字段存在但非法 → []，且不退回 profile（字段存在即覆盖）',
  );
});

// ---- checkEvidenceAnchors（H15）：hard=客观幻觉，soft=diff 外引用（合法，只观测） ----

function anchorVerdict(criteria) {
  return { schema_version: 1, round: 1, overall: 'pass', criteria_results: criteria, non_ac_findings: [] };
}

test('checkEvidenceAnchors：hard/soft 分类全谱', () => {
  const verdict = anchorVerdict([
    {
      ac_id: 'AC-001',
      status: 'pass',
      reason: 'ok',
      evidence: [
        { type: 'code', file: 'lib/a.mjs', summary: 's', start_line: 3, end_line: 10 },   // 在 diff 内、行数内 → 无记录
        { type: 'code', file: 'lib/gone.mjs', summary: 's', start_line: 1, end_line: 2 }, // 哪都不存在 → hard file_missing
      ],
    },
    {
      ac_id: 'AC-002',
      status: 'pass',
      reason: 'ok',
      evidence: [
        { type: 'code', file: 'lib/a.mjs', summary: 's', start_line: 9, end_line: 11 },   // 越界（10 行）→ hard line_out_of_range
        { type: 'code', file: 'README.md', summary: 's', start_line: 1, end_line: 2 },    // 存在但 diff 外 → soft outside_diff
        { type: 'code', file: '../etc/passwd', summary: 's', start_line: 1, end_line: 1 }, // 越狱路径 → hard unsafe_path（index 侧标注）
      ],
    },
  ]);
  const index = {
    'lib/a.mjs': { lines: 10, in_diff: true },
    'README.md': { lines: 3, in_diff: false },
    '../etc/passwd': { lines: null, in_diff: false, missing_reason: 'unsafe_path' },
    // lib/gone.mjs 故意不在 index：调用方解析不到 → 视同 lines null
  };
  const { hard, soft } = checkEvidenceAnchors(verdict, index);
  assert.equal(hard.length, 3);
  assert.deepEqual(hard.map((h) => [h.ac_id, h.file, h.reason]), [
    ['AC-001', 'lib/gone.mjs', 'file_missing'],
    ['AC-002', 'lib/a.mjs', 'line_out_of_range'],
    ['AC-002', '../etc/passwd', 'unsafe_path'],
  ]);
  assert.equal(hard[1].file_lines, 10, '越界记录附真实行数');
  assert.equal(soft.length, 1);
  assert.deepEqual([soft[0].ac_id, soft[0].file, soft[0].reason], ['AC-002', 'README.md', 'outside_diff']);
});

test('checkEvidenceAnchors：边界不炸——空 evidence（unknown）、行号恰等行数、空 verdict', () => {
  const okVerdict = anchorVerdict([
    { ac_id: 'AC-001', status: 'unknown', reason: 'n/a', evidence: [] },
    { ac_id: 'AC-002', status: 'pass', reason: 'ok', evidence: [{ type: 'code', file: 'f.mjs', summary: 's', start_line: 10, end_line: 10 }] },
  ]);
  const r = checkEvidenceAnchors(okVerdict, { 'f.mjs': { lines: 10, in_diff: true } });
  assert.equal(r.hard.length + r.soft.length, 0, 'end_line == 行数是合法锚定');
  const empty = checkEvidenceAnchors(undefined, undefined);
  assert.deepEqual(empty, { hard: [], soft: [] });
});

// ---- validateReviewReport（H21）：review-diff/v1 契约移植 + gate 机械推导 ----

const REVIEW_ACS = ['AC-001', 'AC-002'];

function reviewReport(over = {}) {
  return {
    schemaVersion: 1,
    stage: 'review-diff',
    gate: 'ready',
    findings: [],
    acCoverage: [
      { acId: 'AC-001', status: 'pass', evidence: 'diff 第 8 行取平均' },
      { acId: 'AC-002', status: 'pass', evidence: '探针 falsifies' },
    ],
    tests: { run: [], suggested: [] },
    residualRisk: false,
    ...over,
  };
}

function p1Finding() {
  return {
    severity: 'P1', file: 'lib/stats.mjs', line: 8, title: '空数组未防护',
    impact: 'median([]) 返回 NaN 而非抛错', trigger: '空数组输入',
    evidence: 'diff 未见空输入分支', fix: '入口加空数组守卫',
  };
}

test('validateReviewReport：合法 ready 报告 → ok + 机械推导 metrics/blockers', () => {
  const r = validateReviewReport(reviewReport(), REVIEW_ACS);
  assert.equal(r.ok, true, JSON.stringify(r.errors ?? []));
  assert.equal(r.report.gate, 'ready');
  assert.deepEqual(r.report.blockers, []);
  assert.equal(r.report.metrics.p1, 0);
});

test('validateReviewReport：gate 是机械推导——P1 声明 ready 拒收；blocked 声明一致才过', () => {
  const bad = validateReviewReport(reviewReport({ findings: [p1Finding()] }), REVIEW_ACS);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("gate 必须为机械推导值 'blocked'")));

  const good = validateReviewReport(
    reviewReport({ findings: [p1Finding()], gate: 'blocked' }), REVIEW_ACS,
  );
  assert.equal(good.ok, true, JSON.stringify(good.errors ?? []));
  assert.deepEqual(good.report.blockers, [{ code: 'P1_FINDINGS', count: 1 }]);

  // 仅 P2 / residualRisk → ready_with_concerns
  const concerns = validateReviewReport(
    reviewReport({ residualRisk: true, gate: 'ready_with_concerns' }), REVIEW_ACS,
  );
  assert.equal(concerns.ok, true);
  assert.equal(concerns.report.gate, 'ready_with_concerns');
});

test('validateReviewReport：finding 七字段 / acCoverage 覆盖纪律 / tests 形态逐项拒收', () => {
  const missingField = validateReviewReport(
    reviewReport({ findings: [{ ...p1Finding(), fix: '' , line: 0 }], gate: 'blocked' }), REVIEW_ACS,
  );
  assert.equal(missingField.ok, false);
  assert.ok(missingField.errors.some((e) => e.includes('.fix 必须非空')));
  assert.ok(missingField.errors.some((e) => e.includes('.line 必须是正整数')));

  const acProblems = validateReviewReport(
    reviewReport({
      acCoverage: [
        { acId: 'AC-001', status: 'pass', evidence: 'x' },
        { acId: 'AC-001', status: 'pass', evidence: 'x' }, // 重复
        { acId: 'AC-999', status: 'pass', evidence: 'x' }, // 多余
      ],
    }), REVIEW_ACS,
  );
  assert.equal(acProblems.ok, false);
  assert.ok(acProblems.errors.some((e) => e.includes('重复')));
  assert.ok(acProblems.errors.some((e) => e.includes('多余 AC：AC-999')));
  assert.ok(acProblems.errors.some((e) => e.includes('缺 AC：AC-002')));

  const badTests = validateReviewReport(
    reviewReport({ tests: { run: [{ command: '', status: 'maybe' }], suggested: [] } }), REVIEW_ACS,
  );
  assert.equal(badTests.ok, false);
  assert.ok(badTests.errors.some((e) => e.includes('tests.run[1].command')));
  assert.ok(badTests.errors.some((e) => e.includes('tests.run[1].status')));

  assert.equal(validateReviewReport(null, REVIEW_ACS).ok, false);
});
