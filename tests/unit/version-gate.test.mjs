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

// lib/review-ledger.mjs::reviewCoverage 的产物（只取版本门看的两个字段）。
const covOk = { complete: true, allPass: true, fails: [], remaining: [] };
const covHalf = { complete: false, allPass: false, fails: [], remaining: ['AC-007'] };
const covFail = { complete: true, allPass: false, fails: ['AC-007'], remaining: [] };

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

test('reviewerTierAt：只数当前 H 上的 reviewer 记录，缺 tier 与别的角色都不抬下界', () => {
  // 这个函数是 needPrecommit 的下界来源，返回值宁可偏低（null）也不能偏高：偏高会把一个
  // 本来够格的 precommit 判成不够，任务在 ROUTING 里空转；但它更不能把别人的层级算进来，
  // 否则「reviewer 声明过什么层级」这件事就不再由 reviewer 的记录说了算。
  assert.equal(reviewerTierAt(null, H), null, '记录缺失不抛错');
  assert.equal(reviewerTierAt(undefined, H), null);
  assert.equal(reviewerTierAt([null, undefined, reviewer({ tier: 'integration' })], H), 'integration', '脏条目跳过不抛错');
  assert.equal(reviewerTierAt([reviewer({ tier: undefined })], H), null, '没声明层级就没有下界');
  assert.equal(reviewerTierAt([precommit({ tier: 'e2e' })], H), null, 'precommit 抬不动自己的下界');
  assert.equal(reviewerTierAt([{ role: 'human', kind: 'help', tier: 'e2e', head_sha: H }], H), null, '人的裁决不是 review');
  // 顺序无关：先高后低、先低后高都取最高。
  assert.equal(reviewerTierAt([reviewer({ tier: 'e2e' }), reviewer({ tier: 'unit' })], H), 'e2e');
  assert.equal(reviewerTierAt([reviewer({ tier: 'unit' }), reviewer({ tier: 'e2e' })], H), 'e2e');
  // 当前 H 与旧 H 混在一起时，只有当前 H 的那条算数。
  assert.equal(reviewerTierAt([reviewer({ tier: 'unit' }), reviewer({ tier: 'e2e', head_sha: H2 })], H), 'unit');
});

test('needReview（有 spec 的任务）：只认判决台账，reviewer 自述 ok 顶不上', () => {
  // coverage 一给出来，旧口径就整个失效。这是 spec 纪元的核心：40 条 AC 的任务里，reviewer
  // 在当前 H 上写一条 outcome=ok 只说明「它这一轮跑完了」，不说明「40 条都判过且都 pass」。
  // 判了一半就放行 merge，等于把没人看过的 AC 合进 base——版本规则也就名存实亡。
  assert.equal(needReview([], H, { coverage: covOk }), false, '台账判全且全 pass，不必再有 reviewer 记录');
  assert.equal(needReview([reviewer()], H, { coverage: covOk }), false);
  assert.equal(needReview([reviewer()], H, { coverage: covHalf }), true, '判了一半：自述 ok 不算数');
  assert.equal(needReview([reviewer()], H, { coverage: covFail }), true, '判全但有 fail');
  // 防御性：complete 与 allPass 必须同时为真才算过。reviewCoverage 里 allPass 蕴含 complete，
  // 但版本门不靠那条蕴含关系——台账的算法哪天变了，这里也不会跟着误放行。
  assert.equal(needReview([reviewer()], H, { coverage: { complete: false, allPass: true } }), true);
  assert.equal(needReview([reviewer()], H, { coverage: { complete: true, allPass: false } }), true);
  assert.equal(needReview([reviewer()], H, { coverage: { complete: 'true', allPass: 'true' } }), true, '只认真正的 true');
  // 有 spec 但冻结稿读不到 → reviewStateFor 给 coverage=null：按「没有任何有效 review」处理，
  // 绝不悄悄退回旧口径（那正是 spec 被删掉时最危险的一刻）。
  assert.equal(needReview([reviewer()], H, { coverage: null }), true);
  // H 未知永远优先：没有任务分支就没有「被测过的那一版」，台账再漂亮也无处安放。
  assert.equal(needReview([reviewer()], null, { coverage: covOk }), true);
  assert.equal(needReview([], '', { coverage: covOk }), true);
});

test('needReview：显式 coverage: undefined 必须与不传 opts 完全同义（无 spec 任务的旧口径）', () => {
  // 无 spec 的任务（brief 即契约，AC 编号由 reviewer 自编，内核无从枚举）只能认 reviewer 记录。
  // router-kernel::reviewStateFor 对这类任务返回 coverage: undefined，routing / conductor 原样
  // 透传 `{ coverage: review.coverage }`——所以「显式传 undefined」与「整个 opts 都不传」必须
  // 一字不差地同义。哪天把判据写成 `'coverage' in opts`，无 spec 的任务就再也合不上了。
  assert.equal(needReview([reviewer()], H, { coverage: undefined }), false);
  assert.equal(needReview([reviewer()], H, {}), false);
  assert.equal(needReview([reviewer()], H), false);
  assert.equal(needReview([reviewer({ head_sha: H2 })], H, { coverage: undefined }), true, '旧口径下 H 仍要对上');
  assert.equal(needReview([reviewer({ outcome: 'fail' })], H, { coverage: undefined }), true);
  assert.equal(needReview([], H, { coverage: undefined }), true);
});

test('needPrecommit：tier 下界随 reviewer 在当前 H 上声明的最高层级抬升', () => {
  // precommit 现在也能在 review 之前当「集成检查」跑，层级由 router 选。于是会出现这个顺序：
  // 先跑一次 unit precommit（当时够用），reviewer 之后以 integration 层级判了一遍——那次 unit
  // precommit 就不再够格。没有这条下界，router 只要先跑一次最便宜的 precommit，再让 reviewer
  // 声明任意高的层级，就能用「已经验证过了」的名义合进去，而集成面根本没跑过。
  assert.equal(needPrecommit([precommit({ tier: 'unit' })], H, B), false, '没有 reviewer 声明层级时下界是 0');
  assert.equal(
    needPrecommit([precommit({ tier: 'unit' }), reviewer({ tier: 'integration' })], H, B),
    true,
    'reviewer 声明 integration → 之前那次 unit precommit 失效',
  );
  assert.equal(needPrecommit([precommit({ tier: 'integration' }), reviewer({ tier: 'integration' })], H, B), false, '齐平即够');
  assert.equal(needPrecommit([precommit({ tier: 'e2e' }), reviewer({ tier: 'integration' })], H, B), false, '更高当然够');
  assert.equal(needPrecommit([precommit({ tier: 'integration' }), reviewer({ tier: 'e2e' })], H, B), true);
  // 下界只看当前 H：旧版本上那次 e2e review 判的不是这份代码，抬不动这一版的下界。
  assert.equal(needPrecommit([precommit({ tier: 'unit' }), reviewer({ tier: 'e2e', head_sha: H2 })], H, B), false);
  // 多条 reviewer 时按最高的那条卡；多条 precommit 时只要有一条同时满足三项即可。
  assert.equal(
    needPrecommit([precommit({ tier: 'integration' }), reviewer({ tier: 'unit' }), reviewer({ tier: 'e2e' })], H, B),
    true,
  );
  assert.equal(
    needPrecommit([precommit({ tier: 'unit' }), precommit({ tier: 'e2e' }), reviewer({ tier: 'integration' })], H, B),
    false,
  );
  // tier 缺失的 precommit 记录按 0 算：有下界时不够格，没下界时照旧放行（旧记录的兼容口径）。
  assert.equal(needPrecommit([precommit({ tier: undefined })], H, B), false);
  assert.equal(needPrecommit([precommit({ tier: undefined }), reviewer({ tier: 'unit' })], H, B), true);
  // 层级与 head/base 是「与」不是「或」：拿一次更高层级的旧基线顶不了当前版本。
  assert.equal(needPrecommit([precommit({ tier: 'e2e', head_sha: H2 }), reviewer({ tier: 'unit' })], H, B), true);
  assert.equal(needPrecommit([precommit({ tier: 'e2e', base_sha: B2 }), reviewer({ tier: 'unit' })], H, B), true);
  assert.equal(needPrecommit([precommit({ tier: 'e2e', outcome: 'fail' }), reviewer({ tier: 'unit' })], H, B), true);
});

test('mergeAllowed：台账口径与层级下界必须同时成立才放行', () => {
  // merge 的唯一依据 = needReview ∧ needPrecommit 都为 false。两条新规则各自都能单独拦住 merge，
  // 所以这里逐一把另一条置成「已满足」，确认拦截来自被测的那一条，而不是别处顺带挡住了。
  assert.equal(
    mergeAllowed([reviewer({ tier: 'integration' }), precommit({ tier: 'integration' })], H, B, { coverage: covOk }),
    true,
  );
  assert.equal(
    mergeAllowed([reviewer({ tier: 'integration' }), precommit({ tier: 'unit' })], H, B, { coverage: covOk }),
    false,
    'review 齐了，但 precommit 层级低于 reviewer 声明',
  );
  assert.equal(
    mergeAllowed([reviewer({ tier: 'integration' }), precommit({ tier: 'integration' })], H, B, { coverage: covHalf }),
    false,
    'precommit 齐了，但台账没判全',
  );
  assert.equal(mergeAllowed([reviewer(), precommit()], H, B, { coverage: covFail }), false, '有 fail 的 AC');
  assert.equal(mergeAllowed([reviewer(), precommit()], H, B, { coverage: null }), false, 'spec 冻结稿读不到');
  // 无 spec 的任务（opts 不传 → coverage 为 undefined）仍走旧口径，不被新规则误伤。
  assert.equal(mergeAllowed([reviewer(), precommit()], H, B), true);
  // 人的 notes 在两套口径下都不参与计算：「我看过了，e2e 就别跑了」不是一次 e2e precommit。
  const withHuman = [
    reviewer({ tier: 'e2e' }), precommit({ tier: 'unit' }),
    { role: 'human', kind: 'help', decision: 'resumed', notes: '我看过了，e2e 就别跑了' },
  ];
  assert.equal(mergeAllowed(withHuman, H, B, { coverage: covOk }), false);
  assert.equal(mergeAllowed(withHuman, H, B), false);
});
