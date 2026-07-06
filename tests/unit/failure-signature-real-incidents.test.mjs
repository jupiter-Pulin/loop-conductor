// 真实案卷回归（AC-009）：task-20260706-003 两起实证事故的原始 green-gate-r<n>.json，
// 原样复制为 fixture（未做任何清洗），钉住 buildSignature/isEnvFailureSignature 对真实
// 噪声（每轮不同的耗时、per-run 绝对路径）的稳定性，防止未来重构悄悄改回「无签名」行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignature, isEnvFailureSignature } from '../../conductor/lib/failure-signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'real-incidents');

function loadFixture(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, name), 'utf8'));
}

test('事故 1（EADDRINUSE 观察面板端口冲突）：r1/r2/r3 三份真实记录签名两两相等且判定为环境类', () => {
  const dir = 'task-20260706-003-incident1-env';
  const r1 = buildSignature(loadFixture(dir, 'green-gate-r1.json'));
  const r2 = buildSignature(loadFixture(dir, 'green-gate-r2.json'));
  const r3 = buildSignature(loadFixture(dir, 'green-gate-r3.json'));

  assert.equal(r1.hash, r2.hash, 'r1 与 r2 签名应相等（同一 EADDRINUSE 失败，仅耗时/时间噪声不同）');
  assert.equal(r2.hash, r3.hash, 'r2 与 r3 签名应相等');
  assert.equal(r1.hash, r3.hash, 'r1 与 r3 签名应相等');

  for (const sig of [r1, r2, r3]) {
    assert.ok(sig.errorTokens.includes('EADDRINUSE'), 'errorTokens 应含 EADDRINUSE');
    assert.equal(isEnvFailureSignature(sig), true, '应判定为环境类失败');
  }
});

test('事故 2（task-scoped-target-repo 三个断言连败)：r2/r3 两份真实记录签名相等且非环境类', () => {
  const dir = 'task-20260706-003-incident2-code';
  const r2 = buildSignature(loadFixture(dir, 'green-gate-r2.json'));
  const r3 = buildSignature(loadFixture(dir, 'green-gate-r3.json'));

  assert.equal(r2.hash, r3.hash, '尽管两轮具体断言消息不同（actual/expected 路径漂移），失败测试身份相同，签名应相等');
  assert.equal(r2.failingTests.length, 3, '应识别出 3 个失败测试身份');
  for (const sig of [r2, r3]) {
    assert.equal(isEnvFailureSignature(sig), false, '纯断言失败，不应判定为环境类');
    assert.deepEqual(sig.errorTokens, [], '无环境错误 token');
  }
});
