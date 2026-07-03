// test gate 纯函数单测：glob 匹配、name-status 分类（lib/test-gate.mjs）与 verdict 判定（decisions.mjs）。
// 全部零 IO（AC-006）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEST_GLOBS, matchesTestGlobs, classifyTestFileChanges } from '../../conductor/lib/test-gate.mjs';
import { testGateVerdict } from '../../conductor/stages/decisions.mjs';

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

test('testGateVerdict：单侧闸门，只有基线 exit 0 判 vacuous', () => {
  assert.equal(testGateVerdict(0), 'vacuous');
  assert.equal(testGateVerdict(1), 'falsifies');
  assert.equal(testGateVerdict(-1), 'falsifies');
  assert.equal(testGateVerdict(null), 'falsifies'); // 超时（exit_code=null）不误伤
});
