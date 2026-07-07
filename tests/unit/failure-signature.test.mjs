// failure-signature.mjs 单测：签名对噪声稳定、对真实差异敏感；环境类判定白名单枚举（AC-001/002/005）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignature, isEnvFailureSignature, ENV_FAILURE_ERRNOS } from '../../conductor/lib/failure-signature.mjs';

function gateRecord(over = {}) {
  return {
    command: 'npm test',
    exit_code: 1,
    stdout_tail: '',
    stderr_tail: '',
    ...over,
  };
}

const STDOUT_A = [
  '✔ some passing test (1.234ms)',
  'ℹ tests 2',
  'ℹ pass 1',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  'test at tests/integration/foo.test.mjs:10:1',
  '✖ some failing test (12.345ms)',
  '  Error: boom',
  '      at Object.<anonymous> (/Users/alice/project/tests/integration/foo.test.mjs:11:5)',
  '',
].join('\n');

// 同一失败：耗时不同、绝对路径前缀不同、多一层 ANSI 着色、混入时间戳——噪声不同，失败形态相同。
const STDOUT_B = [
  '\x1b[32m✔ some passing test (9.876ms)\x1b[0m',
  'ℹ tests 2',
  'ℹ pass 1',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  'test at /Users/bob/other-project/tests/integration/foo.test.mjs:10:1',
  '\x1b[31m✖ some failing test (99.999ms)\x1b[0m',
  '  Error: boom at 2026-07-06T08:05:04.466Z',
  '      at Object.<anonymous> (/Users/bob/other-project/tests/integration/foo.test.mjs:23:9)',
  '',
].join('\n');

test('buildSignature：同一失败两份记录（耗时/时间戳/路径前缀/ANSI 噪声不同）产出相同 hash', () => {
  const sigA = buildSignature(gateRecord({ stdout_tail: STDOUT_A }));
  const sigB = buildSignature(gateRecord({ stdout_tail: STDOUT_B }));
  assert.equal(sigA.hash, sigB.hash);
  assert.deepEqual(sigA.failingTests, ['foo.test.mjs :: some failing test']);
  assert.deepEqual(sigA.errorTokens, []);
});

test('buildSignature：返回对象含 hash/failingTests[]/errorTokens[]', () => {
  const sig = buildSignature(gateRecord({ stdout_tail: STDOUT_A }));
  assert.equal(typeof sig.hash, 'string');
  assert.ok(sig.hash.length > 0);
  assert.ok(Array.isArray(sig.failingTests));
  assert.ok(Array.isArray(sig.errorTokens));
});

test('buildSignature：失败测试集合不同 → hash 不同', () => {
  const other = STDOUT_A.replace('some failing test', 'a totally different test');
  const sigA = buildSignature(gateRecord({ stdout_tail: STDOUT_A }));
  const sigOther = buildSignature(gateRecord({ stdout_tail: other }));
  assert.notEqual(sigA.hash, sigOther.hash);
});

test('buildSignature：错误 token 不同 → hash 不同（即便失败测试身份相同）', () => {
  const withErrno = `${STDOUT_A}\n  code: 'ECONNREFUSED'\n`;
  const sigA = buildSignature(gateRecord({ stdout_tail: STDOUT_A }));
  const sigErrno = buildSignature(gateRecord({ stdout_tail: withErrno }));
  assert.notEqual(sigA.hash, sigErrno.hash);
  assert.deepEqual(sigErrno.errorTokens, ['ECONNREFUSED']);
});

test('buildSignature：L1 结构层（command/exit_code/timed_out）参与哈希', () => {
  const a = buildSignature(gateRecord({ stdout_tail: STDOUT_A, command: 'npm test' }));
  const b = buildSignature(gateRecord({ stdout_tail: STDOUT_A, command: 'node --test' }));
  const c = buildSignature(gateRecord({ stdout_tail: STDOUT_A, timed_out: true }));
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});

test('extractFailingTests：非白名单堆栈行/行号/耗时不进入签名', () => {
  const changedLineNo = STDOUT_A.replace(':11:5', ':999:1').replace('12.345ms', '0.001ms');
  const sigA = buildSignature(gateRecord({ stdout_tail: STDOUT_A }));
  const sigChanged = buildSignature(gateRecord({ stdout_tail: changedLineNo }));
  assert.equal(sigA.hash, sigChanged.hash, '堆栈行号/耗时变化不应改变签名');
});

test('extractFailingTests：test at <file>:<line> 的文件部分归一为 basename', () => {
  const abs = STDOUT_A.replace(
    'test at tests/integration/foo.test.mjs:10:1',
    'test at /Users/alice/project/tests/integration/foo.test.mjs:10:1',
  );
  const sig = buildSignature(gateRecord({ stdout_tail: abs }));
  assert.deepEqual(sig.failingTests, ['foo.test.mjs :: some failing test']);
});

test('extractErrorTokens：errno / Cannot find module / address already in use 排序去重', () => {
  const text = [
    "Error: Cannot find module '/abs/path/to/left-pad.js'",
    'listen EADDRINUSE: address already in use 127.0.0.1:4400',
    'listen EADDRINUSE: address already in use 127.0.0.1:4400', // 重复出现
  ].join('\n');
  const sig = buildSignature(gateRecord({ stdout_tail: text }));
  assert.deepEqual(sig.errorTokens, [
    'Cannot find module \'left-pad.js\'',
    'EADDRINUSE',
    'address already in use 127.0.0.1:4400',
  ].sort());
});

test('isEnvFailureSignature：命中环境枚举返回 true（至少含 EADDRINUSE/ECONNREFUSED/ETIMEDOUT/ENOENT/EACCES）', () => {
  for (const errno of ['EADDRINUSE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOENT', 'EACCES']) {
    assert.ok(ENV_FAILURE_ERRNOS.includes(errno), `枚举应含 ${errno}`);
    assert.equal(isEnvFailureSignature({ errorTokens: [errno] }), true, `${errno} 应判定为环境类`);
  }
});

test('isEnvFailureSignature：纯断言失败（无环境 token）返回 false', () => {
  assert.equal(isEnvFailureSignature({ errorTokens: [] }), false);
  assert.equal(isEnvFailureSignature({ errorTokens: ["Cannot find module 'foo'"] }), false);
  assert.equal(isEnvFailureSignature(null), false);
});
