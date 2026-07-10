// 单元：decisions.evaluateAutoMerge + parseNumstat —— H33 自动合并放行谓词。
// 谓词是唯一裁判，口径用测试钉死：全绿合取才放行；任何一门数据缺失 fail-closed；
// shadow 要求分歧数=0（任何方向——high_risk 字段的方向与自动合并风险相反，不采信）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutoMerge, parseNumstat } from '../../conductor/stages/decisions.mjs';

/** 全绿基准输入：每个 case 从这里突变单门，断言只挂那一门。 */
function greenInputs(over = {}) {
  return {
    kind: 'bugfix',
    allowedKinds: ['bugfix'],
    verdictOverall: 'pass',
    acCount: 4,
    maxAcs: 8,
    testGate: {
      mode: 'per-ac',
      verdict: 'falsifies',
      mapping_status: 'valid',
      per_ac: [
        { ac_id: 'AC-001', verdict: 'falsifies' },
        { ac_id: 'AC-002', verdict: 'guard_holds' },
      ],
    },
    guardEnabled: true,
    guardChanges: null,
    anchorsMode: 'observe',
    anchors: { hard_count: 0, soft_count: 2, hard: [], soft: [{}, {}] },
    shadowEnabled: true,
    shadowCompare: {
      shadow: { valid: true },
      agreement: { total_acs: 4, agreed: 4, disagreements: [], high_risk_count: 0 },
    },
    reviewCompare: null,
    diff: { total_lines: 120, files: ['lib/stats.mjs', 'test/stats.test.mjs'], binary: 0 },
    maxDiffLines: 400,
    deniedPaths: [],
    ...over,
  };
}

test('evaluateAutoMerge：全绿合取放行，reasons 为空', () => {
  const d = evaluateAutoMerge(greenInputs());
  assert.deepEqual(d, { eligible: true, reasons: [] });
});

test('evaluateAutoMerge：逐门突变各自拦截（单门单 reason）', () => {
  const cases = [
    [{ kind: 'feature' }, /kind=feature 不在 autoMergeKinds/],
    [{ verdictOverall: 'fail' }, /overall=fail ≠ pass/],
    [{ acCount: 9 }, /AC 数 9 > 上限 8/],
    [{ acCount: null }, /AC 数缺失/],
    [{ testGate: null }, /test-gate 产物缺失/],
    [{ testGate: { ...greenInputs().testGate, mode: 'suite' } }, /mode=suite ≠ per-ac/],
    [{ testGate: { ...greenInputs().testGate, verdict: 'vacuous' } }, /verdict=vacuous ≠ falsifies/],
    [{ testGate: { ...greenInputs().testGate, mapping_status: 'missing' } }, /mapping_status=missing/],
    [
      { testGate: { ...greenInputs().testGate, per_ac: [{ ac_id: 'AC-001', verdict: 'falsifies' }, { ac_id: 'AC-002', verdict: 'unmapped' }] } },
      /无机械证明的 AC：AC-002=unmapped/,
    ],
    [{ guardEnabled: false }, /testChangeGuardEnabled 未开/],
    [{ guardChanges: { modified: ['test/a.mjs'], deleted: [], renamed: [], total: 1 } }, /既有测试被改动（modified 1/],
    [{ anchorsMode: 'off' }, /verifierEvidenceAnchorsMode=off/],
    [{ anchors: null }, /evidence-anchors 产物缺失/],
    [{ anchors: { hard_count: 1, hard: [{}] } }, /hard=1 ≠ 0/],
    [{ shadowEnabled: false }, /verifierShadowEnabled 未开/],
    [{ shadowCompare: null }, /shadow 对照缺失/],
    [{ shadowCompare: { shadow: { valid: false }, agreement: null } }, /shadow 对照缺失或 shadow verdict 无效/],
    [
      {
        shadowCompare: {
          shadow: { valid: true },
          // high_risk=false 也必须拦：main=pass→shadow=fail 正是自动合并的假绿方向
          agreement: { total_acs: 4, agreed: 3, disagreements: [{ ac_id: 'AC-004', main: 'pass', shadow: 'fail', high_risk: false }], high_risk_count: 0 },
        },
      },
      /shadow 分歧：AC-004 pass→fail/,
    ],
    [{ reviewCompare: { review: { valid: true, gate: 'blocked' }, disagreement: true } }, /reviewer 分歧（gate=blocked）/],
    [{ reviewCompare: { review: { valid: false }, disagreement: null } }, /reviewer 对照存在但 review 无效/],
    [{ diff: { total_lines: 401, files: [], binary: 0 } }, /diff 401 行 > 上限 400/],
    [{ diff: { total_lines: 10, files: ['a.png'], binary: 1 } }, /含 1 个二进制/],
    [
      { deniedPaths: ['conductor/'], diff: { total_lines: 10, files: ['conductor/lib/git.mjs'], binary: 0 } },
      /命中危险路径 conductor\/：conductor\/lib\/git.mjs/,
    ],
    [
      { deniedPaths: ['package.json'], diff: { total_lines: 10, files: ['package.json'], binary: 0 } },
      /命中危险路径 package.json/,
    ],
  ];
  for (const [over, re] of cases) {
    const d = evaluateAutoMerge(greenInputs(over));
    assert.equal(d.eligible, false, `${JSON.stringify(over).slice(0, 80)} 应不放行`);
    assert.equal(d.reasons.length, 1, `单门突变只挂一条 reason，实际 ${JSON.stringify(d.reasons)}`);
    assert.match(d.reasons[0], re);
  }
});

test('evaluateAutoMerge：reviewer 对照缺席不阻塞（reviewStage 默认 off）', () => {
  const d = evaluateAutoMerge(greenInputs({ reviewCompare: null }));
  assert.equal(d.eligible, true);
});

test('parseNumstat：常规/二进制/rename/空输入', () => {
  const text = [
    '10\t3\tlib/stats.mjs',
    '5\t0\ttest/stats.test.mjs',
    '-\t-\tassets/logo.png',
    '2\t2\tsrc/{old => new}/util.mjs',
    '',
  ].join('\n');
  const d = parseNumstat(text);
  assert.equal(d.total_lines, 22);
  assert.equal(d.binary, 1);
  assert.deepEqual(d.files, ['lib/stats.mjs', 'test/stats.test.mjs', 'assets/logo.png', 'src/{old => new}/util.mjs']);
  assert.deepEqual(parseNumstat(''), { total_lines: 0, files: [], binary: 0 });
  assert.deepEqual(parseNumstat(null), { total_lines: 0, files: [], binary: 0 });
});
