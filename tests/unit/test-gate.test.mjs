// test gate 纯函数单测：glob 匹配、name-status 分类、AC→测试映射校验（lib/test-gate.mjs）
// 与 verdict 判定 / per-AC 方向裁决（decisions.mjs）。全部零 IO（AC-006）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEST_GLOBS, matchesTestGlobs, classifyTestFileChanges, listExistingTestFileChanges,
  AC_TESTS_MAPPING_PATH, validateAcTestsMapping,
} from '../../conductor/lib/test-gate.mjs';
import { testGateVerdict, perAcProbeVerdict, perAcGateVerdict } from '../../conductor/stages/decisions.mjs';

test('matchesTestGlobs：默认 glob 集命中测试文件、放过源码', () => {
  for (const p of [
    'test/stats.test.mjs',
    'test/nested/deep.mjs',
    'tests/a/b.mjs',
    'src/foo.test.ts',
    'foo.test.ts',
    'a/b/c.spec.js',
  ]) {
    assert.equal(matchesTestGlobs(p, DEFAULT_TEST_GLOBS), true, `${p} 应匹配`);
  }
  for (const p of [
    'lib/stats.mjs',
    'testdata/x.mjs', // 'test/**' 不得吞掉 test 前缀目录
    'src/latest.mjs',
    'contest/x.spec', // '**/*.spec.*' 要求 .spec. 后还有扩展段
  ]) {
    assert.equal(matchesTestGlobs(p, DEFAULT_TEST_GLOBS), false, `${p} 不应匹配`);
  }
});

test('classifyTestFileChanges：A/M 复制、D 删除、R 旧删新增、非测试文件忽略', () => {
  const nameStatus = [
    'M\tlib/stats.mjs',
    'A\ttest/new.test.mjs',
    'M\ttest/stats.test.mjs',
    'D\ttests/old.test.mjs',
    'R100\ttest/a.test.mjs\ttest/b.test.mjs',
    '',
  ].join('\n');
  const r = classifyTestFileChanges(nameStatus, DEFAULT_TEST_GLOBS);
  assert.deepEqual(r.copy, ['test/new.test.mjs', 'test/stats.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(r.remove, ['tests/old.test.mjs', 'test/a.test.mjs']);
});

test('classifyTestFileChanges：空输入 / 全非测试文件 → 空 overlay', () => {
  assert.deepEqual(classifyTestFileChanges('', DEFAULT_TEST_GLOBS), { copy: [], remove: [] });
  assert.deepEqual(classifyTestFileChanges(null, DEFAULT_TEST_GLOBS), { copy: [], remove: [] });
  assert.deepEqual(
    classifyTestFileChanges('M\tlib/a.mjs\nD\tsrc/b.mjs\n', DEFAULT_TEST_GLOBS),
    { copy: [], remove: [] },
  );
});

test('listExistingTestFileChanges（H16）：M/T/D/R 入清单，A/C/非测试忽略', () => {
  const nameStatus = [
    'M\ttest/a.test.mjs',
    'T\ttest/b.test.mjs',           // typechange 也算 modified
    'D\ttests/c.spec.js',
    'R100\ttest/old.test.mjs\ttest/new.test.mjs',
    'R90\ttest/into-src.test.mjs\tsrc/helper.mjs', // 改名「出」测试目录 → 同样可疑
    'R80\tsrc/util.mjs\ttest/from-src.test.mjs',   // 改名「进」测试目录 → 同样可疑
    'A\ttest/brand-new.test.mjs',   // 新增测试是期望行为，不入清单
    'C75\ttest/base.test.mjs\ttest/copy.test.mjs', // copy 既有侧无损，不入清单
    'M\tlib/stats.mjs',             // 非测试忽略
    'D\tsrc/gone.mjs',
    '',
  ].join('\n');
  const r = listExistingTestFileChanges(nameStatus, DEFAULT_TEST_GLOBS);
  assert.deepEqual(r.modified, ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(r.deleted, ['tests/c.spec.js']);
  assert.deepEqual(r.renamed, [
    { from: 'test/old.test.mjs', to: 'test/new.test.mjs' },
    { from: 'test/into-src.test.mjs', to: 'src/helper.mjs' },
    { from: 'src/util.mjs', to: 'test/from-src.test.mjs' },
  ]);
});

test('listExistingTestFileChanges（H16）：空输入 / 全新增 / 全非测试 → 三清单皆空', () => {
  const empty = { modified: [], deleted: [], renamed: [] };
  assert.deepEqual(listExistingTestFileChanges('', DEFAULT_TEST_GLOBS), empty);
  assert.deepEqual(listExistingTestFileChanges(null, DEFAULT_TEST_GLOBS), empty);
  assert.deepEqual(listExistingTestFileChanges('A\ttest/x.test.mjs\nA\ttest/y.test.mjs', DEFAULT_TEST_GLOBS), empty);
  assert.deepEqual(listExistingTestFileChanges('M\tlib/a.mjs\nD\tsrc/b.mjs', DEFAULT_TEST_GLOBS), empty);
});

test('testGateVerdict：单侧闸门，只有基线 exit 0 判 vacuous', () => {
  assert.equal(testGateVerdict(0), 'vacuous');
  assert.equal(testGateVerdict(1), 'falsifies');
  assert.equal(testGateVerdict(-1), 'falsifies');
  assert.equal(testGateVerdict(null), 'falsifies'); // 超时（exit_code=null）不误伤
});

// ---- 约定 2（B 批）：AC→测试映射校验（AC-006） ----

test('validateAcTestsMapping：合法映射 → ok:true，entries 归一为 {ac_id,command,expect}', () => {
  assert.equal(AC_TESTS_MAPPING_PATH, '.will-workflow/ac-tests.json', '路径常量即约定，不新增配置项');
  const raw = {
    schema_version: 1,
    entries: [
      { ac_id: 'AC-001', command: 'node --test test/a.test.mjs', expect: 'fail_on_baseline', extra: '多余字段忽略' },
      { ac_id: 'AC-002', command: 'node --test test/b.test.mjs', expect: 'pass_on_baseline' },
    ],
  };
  const r = validateAcTestsMapping(raw, ['AC-001', 'AC-002', 'AC-003']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries, [
    { ac_id: 'AC-001', command: 'node --test test/a.test.mjs', expect: 'fail_on_baseline' },
    { ac_id: 'AC-002', command: 'node --test test/b.test.mjs', expect: 'pass_on_baseline' },
  ]);
});

test('validateAcTestsMapping：全部非法分支 → ok:false + errors，绝不抛错（AC-006）', () => {
  const expected = ['AC-001', 'AC-002'];
  const entry = (over = {}) => ({ ac_id: 'AC-001', command: 'node --test', expect: 'fail_on_baseline', ...over });
  const cases = [
    ['非对象：null', null],
    ['非对象：数组', []],
    ['非对象：字符串', 'not-an-object'],
    ['schema_version≠1', { schema_version: 2, entries: [entry()] }],
    ['entries 非数组', { schema_version: 1, entries: {} }],
    ['entry 非对象', { schema_version: 1, entries: ['x'] }],
    ['ac_id 非字符串', { schema_version: 1, entries: [entry({ ac_id: 3 })] }],
    ['ac_id 空白串', { schema_version: 1, entries: [entry({ ac_id: ' ' })] }],
    ['command 非字符串', { schema_version: 1, entries: [entry({ command: null })] }],
    ['command 空串', { schema_version: 1, entries: [entry({ command: '' })] }],
    ['expect 非枚举', { schema_version: 1, entries: [entry({ expect: 'always_green' })] }],
    ['ac_id 重复', { schema_version: 1, entries: [entry(), entry()] }],
    ['ac_id 不在枚举集', { schema_version: 1, entries: [entry({ ac_id: 'AC-999' })] }],
  ];
  for (const [label, raw] of cases) {
    let r;
    assert.doesNotThrow(() => { r = validateAcTestsMapping(raw, expected); }, label);
    assert.equal(r.ok, false, label);
    assert.ok(Array.isArray(r.errors) && r.errors.length >= 1, `${label}：errors 至少 1 条`);
    assert.deepEqual(r.entries, [], `${label}：非法映射不得回传 entries`);
  }
});

// ---- 方向裁决（B 批）：perAcProbeVerdict 六格真值表 + 顶层聚合 ----

test('perAcProbeVerdict：方向表六格 + 超时/spawn error 一律 error 放行（AC-011）', () => {
  // fail_on_baseline：基线绿 → vacuous（block）；基线红 → falsifies
  assert.equal(perAcProbeVerdict('fail_on_baseline', 0, false), 'vacuous');
  assert.equal(perAcProbeVerdict('fail_on_baseline', 1, false), 'falsifies');
  // pass_on_baseline：基线绿 → guard_holds；基线红 → guard_broken（放行留痕）
  assert.equal(perAcProbeVerdict('pass_on_baseline', 0, false), 'guard_holds');
  assert.equal(perAcProbeVerdict('pass_on_baseline', 2, false), 'guard_broken');
  // 超时（exit_code=null）/ spawn error（exit_code=-1）→ error，两方向一致
  assert.equal(perAcProbeVerdict('fail_on_baseline', null, true), 'error');
  assert.equal(perAcProbeVerdict('fail_on_baseline', -1, false), 'error');
  assert.equal(perAcProbeVerdict('pass_on_baseline', null, true), 'error');
  assert.equal(perAcProbeVerdict('pass_on_baseline', -1, false), 'error');
});

test('perAcGateVerdict：任一 vacuous → vacuous；guard_broken/unmapped/error 均不 block', () => {
  assert.equal(perAcGateVerdict([]), 'falsifies');
  assert.equal(perAcGateVerdict([{ verdict: 'falsifies' }, { verdict: 'guard_holds' }]), 'falsifies');
  assert.equal(perAcGateVerdict([{ verdict: 'guard_broken' }, { verdict: 'unmapped' }, { verdict: 'error' }]), 'falsifies');
  assert.equal(perAcGateVerdict([{ verdict: 'falsifies' }, { verdict: 'vacuous' }]), 'vacuous');
});
