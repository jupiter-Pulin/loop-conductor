// 单元：版本规则（Invariant 6 / AC-003 / AC-014 的纯函数面）。
// 这是 merge 的唯一依据：被合并的 == 被测过的。人的 notes、包状态、越界文件都不能替代它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { needReview, needPrecommit, mergeAllowed, reviewerTierAt } from '../../conductor/lib/version-gate.mjs';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const B = 'c'.repeat(40);
const B2 = 'd'.repeat(40);

const reviewer = (over = {}) => ({ role: 'reviewer', outcome: 'ok', head_sha: H, tier: 'unit', ...over });
const precommit = (over = {}) => ({ role: 'precommit', outcome: 'ok', head_sha: H, base_sha: B, tier: 'unit', ...over });

test('needReview：当前 H 上有 outcome=ok 的 reviewer 记录才为 false', () => {
  assert.equal(needReview([], H), true, '没有记录就必须审');
  assert.equal(needReview([reviewer()], H), false);
  assert.equal(needReview([reviewer({ outcome: 'fail' })], H), true, 'fail 的 review 不算数');
  assert.equal(needReview([reviewer({ head_sha: H2 })], H), true, '旧版本的 review 不算数');
  assert.equal(needReview([reviewer()], H2), true, 'H 变了就要重审');
  assert.equal(needReview(null, H), true, '记录缺失按需要审处理');
  assert.equal(needReview([reviewer()], null), true, 'H 未知时不放行');
});

test('needPrecommit：H 与 B 必须同时对上', () => {
  assert.equal(needPrecommit([], H, B), true);
  assert.equal(needPrecommit([precommit()], H, B), false);
  assert.equal(needPrecommit([precommit({ outcome: 'fail' })], H, B), true);
  assert.equal(needPrecommit([precommit({ head_sha: H2 })], H, B), true);
  // base 分支被人推进 → 基线过期，必须重跑（Edge Case：precommit 期间 base 前进）
  assert.equal(needPrecommit([precommit()], H, B2), true);
  assert.equal(needPrecommit([precommit()], H, null), true);
});

test('角色不串味：reviewer 记录不能顶 precommit，反之亦然', () => {
  assert.equal(needPrecommit([reviewer()], H, B), true);
  assert.equal(needReview([precommit()], H), true);
});

test('mergeAllowed：两条都不需要时才允许申请 merge；人的 notes 不参与计算', () => {
  assert.equal(mergeAllowed([reviewer(), precommit()], H, B), true);
  assert.equal(mergeAllowed([reviewer()], H, B), false, '缺 precommit');
  assert.equal(mergeAllowed([precommit()], H, B), false, '缺 review');
  const withHuman = [
    reviewer(), precommit(),
    { role: 'human', kind: 'help', decision: 'resumed', notes: '我看过了，直接合' },
  ];
  assert.equal(mergeAllowed(withHuman, H2, B), false, 'H 变了，notes 不能豁免');
});

test('reviewerTierAt：precommit 的 tier 下界取当前 H 上 reviewer 声明的最高层级', () => {
  assert.equal(reviewerTierAt([], H), null);
  assert.equal(reviewerTierAt([reviewer({ tier: 'unit' })], H), 'unit');
  assert.equal(
    reviewerTierAt([reviewer({ tier: 'unit' }), reviewer({ tier: 'e2e' }), reviewer({ tier: 'integration' })], H),
    'e2e',
  );
  assert.equal(reviewerTierAt([reviewer({ tier: 'e2e', head_sha: H2 })], H), null, '旧版本的声明不算数');
  // fail 的 review 也声明过 tier：下界照样算（precommit 不得低于 reviewer 声明的层级）
  assert.equal(reviewerTierAt([reviewer({ outcome: 'fail', tier: 'integration' })], H), 'integration');
});
