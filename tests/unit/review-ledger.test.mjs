// 单元：reviewer 的逐条 AC 判决台账（conductor/lib/review-ledger.mjs）。
// 有 spec 的任务，版本门（lib/version-gate.mjs::needReview）唯一认的就是这份台账算出来的
// complete ∧ allPass。所以这里每一条不变量都直接决定 merge 资格什么时候打开：
//   ①判了一半不算判完 —— 少一条 remaining，没审过的代码就能被合；
//   ②对旧 HEAD / 旧 spec 版本的判决一条都不沿用 —— 否则「被合并的」不再是「被审过的那一版」；
//   ③reviewer 自述 ok 不算数 —— 覆盖率由内核对照冻结 spec 机械算，agent 说了不算；
//   ④反过来，reviewer 撞上限（product ≠ ok）时它已经写下的判决必须照样算数，
//     否则 40 多条 AC 的大 review 永远判不完，只能整份作废重来。
// 本模块只读盘、绝不抛错：判决文件缺失 / 损坏都只是台账里的错误项，不是异常路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseVerdicts, reviewCoverage, renderCoverage, verdictsFileName,
  VERDICTS_MAX_BYTES, VERDICT_VALUES,
} from '../../conductor/lib/review-ledger.mjs';
import { needReview } from '../../conductor/lib/version-gate.mjs';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const S = 'c'.repeat(64);
const S2 = 'd'.repeat(64);

function makeDossier(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 往案卷里落一份判决文件（body 给字符串就原样写，给对象就序列化）。 */
function writeVerdicts(dir, round, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  fs.writeFileSync(path.join(dir, verdictsFileName(round)), raw);
  return raw;
}

/** composeRecords 产出的 reviewer 记录形状：head_sha / spec_sha 是内核盖的章，agent 改不了。 */
const reviewerRec = (over = {}) => ({
  role: 'reviewer', round: 1, product: 'ok', outcome: 'ok', tier: 'unit', head_sha: H, spec_sha: S, ...over,
});

const v = (ac, verdict = 'pass', evidence = `tests/x.test.mjs 钉住 ${ac}`) => ({ ac, verdict, evidence });

// ---- parseVerdicts ----

test('parseVerdicts：常量面与 happy path —— 编号闭集 AC-/B-，evidence 与 note 归一化到 800 字符', () => {
  assert.deepEqual([...VERDICT_VALUES], ['pass', 'fail']);
  assert.equal(VERDICTS_MAX_BYTES, 400_000);
  assert.equal(verdictsFileName(7), 'reviewer-r7.verdicts.json');

  const r = parseVerdicts(JSON.stringify({
    verdicts: [
      { ac: 'AC-001', verdict: 'pass', evidence: '  tests/a.test.mjs:12  ' },
      { ac: 'B-002', verdict: 'fail', evidence: 'src/x.mjs:88 少了边界判断', note: '  与 AC-001 同源  ' },
      // 未知字段只是被丢掉：判决文件没有内核盖章字段，多写不算违规，但也绝不许泄进 judged
      { ac: 'AC-003', verdict: 'pass', evidence: 'src/y.mjs:3', confidence: 0.9, ac_id: 'AC-999' },
    ],
  }));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.verdicts, [
    { ac: 'AC-001', verdict: 'pass', evidence: 'tests/a.test.mjs:12', note: null },
    { ac: 'B-002', verdict: 'fail', evidence: 'src/x.mjs:88 少了边界判断', note: '与 AC-001 同源' },
    { ac: 'AC-003', verdict: 'pass', evidence: 'src/y.mjs:3', note: null },
  ]);

  const long = parseVerdicts(JSON.stringify({
    verdicts: [{ ac: 'AC-001', verdict: 'pass', evidence: `  ${'x'.repeat(900)}  `, note: 'y'.repeat(900) }],
  }));
  assert.equal(long.verdicts[0].evidence.length, 800, 'evidence 先 trim 再截到 800');
  assert.equal(long.verdicts[0].note.length, 800);
});

test('parseVerdicts：部分接受 —— 合格条目照用、坏条目逐条记错（reviewer 写到一半也能用）', () => {
  // 这是这份台账存在的理由：整份作废重来的代价是 40 多条 AC 全部重判。
  const r = parseVerdicts(JSON.stringify({
    verdicts: [
      v('AC-001'),
      { ac: 'ac-002', verdict: 'pass', evidence: 'x' },
      { ac: 'AC-003', verdict: 'maybe', evidence: 'x' },
      { ac: 'AC-004', verdict: 'fail' },
      'nope',
      v('B-005', 'fail', 'src/a.mjs:12 没实现'),
    ],
  }));
  assert.equal(r.ok, false, '有坏条目时整份不算 ok');
  assert.deepEqual(r.verdicts.map((x) => x.ac), ['AC-001', 'B-005'], '合格的两条必须留下');
  assert.deepEqual(r.errors, [
    'verdicts[1].ac 非法："ac-002"',
    'verdicts[2].verdict 必须是 pass | fail',
    'verdicts[3]（AC-004）缺 evidence：pass 写钉住它的测试 / 代码位置，fail 写 文件:行号 与原因',
    'verdicts[4] 必须是对象',
  ], '错误要带下标与原值，reviewer 下一轮才知道改哪一条');
});

test('parseVerdicts：evidence 是硬门槛 —— 空串 / 纯空白 / 非字符串都判缺证据', () => {
  // 没有证据的 pass 等于没判：版本门会据此解除 need_review，必须留下可复核的落点。
  for (const evidence of ['', '   ', 42, null, undefined, ['a']]) {
    const r = parseVerdicts(JSON.stringify({ verdicts: [{ ac: 'AC-001', verdict: 'pass', evidence }] }));
    assert.equal(r.ok, false, `evidence=${JSON.stringify(evidence)} 应判不合格`);
    assert.deepEqual(r.verdicts, [], '缺证据的条目不得入账');
    assert.match(r.errors.join(), /verdicts\[0\]（AC-001）缺 evidence/);
  }
});

test('parseVerdicts：整份形态不合格时一条判决都不产出（缺失 / 非 JSON / 不是 {verdicts:[…]} / 超 400KB）', () => {
  const empty = ['', '   ', null, undefined, 42, {}];
  for (const raw of empty) {
    assert.deepEqual(parseVerdicts(raw), { ok: false, errors: ['判决文件缺失或为空'], verdicts: [] }, `${JSON.stringify(raw)} 应判缺失`);
  }
  const bad = parseVerdicts('{ 不是 json');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^判决文件不是合法 JSON：/);
  assert.deepEqual(bad.verdicts, []);

  for (const raw of ['[]', '3', '"x"', '{"verdicts":{}}', '{}', 'null']) {
    const r = parseVerdicts(raw);
    assert.equal(r.ok, false, `${raw} 应判形态非法`);
    assert.deepEqual(r.errors, ['判决文件必须是 {"verdicts":[…]}'], raw);
  }

  // 体积上限按字节算（不是字符数）：整份文件要能被内核完整读进来
  const okSize = JSON.stringify({ verdicts: [{ ac: 'AC-001', verdict: 'pass', evidence: 'x' }] });
  assert.equal(parseVerdicts(okSize).ok, true);
  const over = parseVerdicts('x'.repeat(VERDICTS_MAX_BYTES + 1));
  assert.deepEqual(over, { ok: false, errors: ['判决文件超过 400000 字节'], verdicts: [] });
});

// ---- reviewCoverage：版本合并 ----

test('reviewCoverage：同一版本上多轮合并，后判覆盖先判', (t) => {
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-002', 'fail', 'src/x.mjs:9 漏了空值')] });
  writeVerdicts(dir, 3, { verdicts: [v('AC-002', 'pass', '已补 tests/x.test.mjs:40'), v('AC-003')] });
  const records = [reviewerRec({ round: 1 }), reviewerRec({ round: 3 })];
  const acIds = ['AC-001', 'AC-002', 'AC-003'];

  const cov = reviewCoverage({ dossierDir: dir, records, head: H, specSha: S, acIds });
  assert.deepEqual(cov.rounds, [1, 3], '两轮都参与合并，且按轮次升序');
  assert.equal(cov.judged['AC-002'].verdict, 'pass');
  assert.equal(cov.judged['AC-002'].round, 3, '同版本内后判覆盖先判：r1 的 fail 已被 r3 推翻');
  assert.equal(cov.judged['AC-002'].evidence, '已补 tests/x.test.mjs:40');
  assert.deepEqual(cov.fails, []);
  assert.deepEqual(cov.remaining, []);
  assert.equal(cov.complete, true);
  assert.equal(cov.allPass, true);

  // 反向也成立：后一轮把 pass 判回 fail，门必须重新关上
  writeVerdicts(dir, 4, { verdicts: [v('AC-001', 'fail', 'src/y.mjs:3 回归了')] });
  const cov2 = reviewCoverage({
    dossierDir: dir, records: [...records, reviewerRec({ round: 4 })], head: H, specSha: S, acIds,
  });
  assert.deepEqual(cov2.fails, ['AC-001']);
  assert.equal(cov2.complete, true);
  assert.equal(cov2.allPass, false, '判全了但有 fail：仍然不许 merge');
});

test('reviewCoverage：判了一半就是没判完 —— reviewer 自述 ok 也解除不了 need_review', (t) => {
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-002')] });
  const acIds = ['AC-001', 'AC-002', 'AC-003'];
  const cov = reviewCoverage({ dossierDir: dir, records: [reviewerRec({ outcome: 'ok' })], head: H, specSha: S, acIds });
  assert.deepEqual(cov.remaining, ['AC-003']);
  assert.equal(cov.complete, false);
  assert.equal(cov.allPass, false);

  // 记录在、判决文件根本没写：这一轮不进 rounds，覆盖率为零
  const none = reviewCoverage({ dossierDir: makeDossier(t), records: [reviewerRec()], head: H, specSha: S, acIds });
  assert.deepEqual(none.rounds, []);
  assert.deepEqual(none.judged, {});
  assert.deepEqual(none.remaining, acIds);
  assert.equal(none.complete, false);
});

test('reviewCoverage：旧 HEAD / 旧 spec 版本上的判决一条都不算数', (t) => {
  const dir = makeDossier(t);
  const acIds = ['AC-001', 'AC-002'];
  const all = { verdicts: [v('AC-001'), v('AC-002')] };
  writeVerdicts(dir, 1, all); // 记录绑在旧 HEAD 上
  writeVerdicts(dir, 2, all); // 记录绑在旧 spec 版本上
  const records = [
    reviewerRec({ round: 1, head_sha: H2, spec_sha: S }),
    reviewerRec({ round: 2, head_sha: H, spec_sha: S2 }),
  ];

  const cov = reviewCoverage({ dossierDir: dir, records, head: H, specSha: S, acIds });
  assert.deepEqual(cov.rounds, [], '两轮都不该参与合并');
  assert.deepEqual(cov.judged, {});
  assert.equal(cov.complete, false, '代码或 spec 变了，全部 AC 都要重判');
  // 文件确实在盘上：过滤掉它们的是版本规则，不是读盘失败（否则这个测试等于什么都没证明）
  assert.equal(fs.existsSync(path.join(dir, verdictsFileName(1))), true);
  assert.equal(reviewCoverage({ dossierDir: dir, records, head: H2, specSha: S, acIds }).allPass, true, '换回它自己的版本就该算数');
  assert.equal(reviewCoverage({ dossierDir: dir, records, head: H, specSha: S2, acIds }).allPass, true);

  // H 未知（还没有任务分支）时恒为空：null 不许与记录里的 null head_sha 配成一对
  const noHead = reviewCoverage({ dossierDir: dir, records: [reviewerRec({ head_sha: null })], head: null, specSha: S, acIds });
  assert.deepEqual(noHead.rounds, []);
  assert.equal(noHead.complete, false);
});

test('reviewCoverage：台账里出现 spec 没有的编号 → 记 unknown 并忽略，不顶替真正的 AC', (t) => {
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-999'), v('B-042')] });
  const cov = reviewCoverage({
    dossierDir: dir, records: [reviewerRec()], head: H, specSha: S, acIds: ['AC-001', 'AC-002'],
  });
  assert.deepEqual(cov.unknown, ['AC-999', 'B-042'], 'reviewer 自编的编号只报告，不入账');
  assert.deepEqual(Object.keys(cov.judged), ['AC-001']);
  assert.deepEqual(cov.remaining, ['AC-002'], '多判几条不存在的，照样不算判全');
  assert.equal(cov.complete, false);
});

test('reviewCoverage：reviewer 撞上限 / log 非法（product ≠ ok）时，已经写下的判决照样算数', (t) => {
  // 内核在 spawn 记录上盖的 head_sha / spec_sha 不受 log 合不合格影响，所以这些判决依旧是
  // 「对这一版」的判决。丢掉它们等于让大 review 永远判不完——这正是判决文件独立于短 log 的原因。
  const dir = makeDossier(t);
  const acIds = ['AC-001', 'AC-002'];
  writeVerdicts(dir, 5, { verdicts: [v('AC-001'), v('AC-002')] });
  const truncated = reviewerRec({
    round: 5, product: 'invalid', product_error: ['summary 超长'], outcome: null, tier: null, truncated: true,
  });

  const cov = reviewCoverage({ dossierDir: dir, records: [truncated], head: H, specSha: S, acIds });
  assert.deepEqual(cov.rounds, [5]);
  assert.equal(cov.complete, true);
  assert.equal(cov.allPass, true);
  assert.equal(cov.tier, null, 'tier 只认 product=ok 的记录：非法 log 不携带契约级语义');
  assert.equal(needReview([truncated], H, { coverage: cov }), false, '判全且全 pass → 版本门放行');
});

test('reviewCoverage：tier 取 product=ok 记录里的最高层级，其余记录不参与', (t) => {
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001')] });
  const acIds = ['AC-001'];
  const base = { dossierDir: dir, head: H, specSha: S, acIds };

  assert.equal(reviewCoverage({ ...base, records: [reviewerRec({ tier: 'unit' })] }).tier, 'unit');
  assert.equal(reviewCoverage({
    ...base,
    records: [reviewerRec({ round: 1, tier: 'unit' }), reviewerRec({ round: 2, tier: 'e2e' }), reviewerRec({ round: 3, tier: 'integration' })],
  }).tier, 'e2e', '取最高层级，不是最后一轮的层级');

  // product ≠ ok 的记录即便带着 tier 也不算：tier 是 precommit 的下界，不能被一份非法 log 抬高或顶替
  assert.equal(reviewCoverage({
    ...base,
    records: [reviewerRec({ round: 1, tier: 'unit' }), reviewerRec({ round: 2, product: 'invalid', tier: 'e2e' })],
  }).tier, 'unit');
  // 旧版本上声明的层级同样不算
  assert.equal(reviewCoverage({ ...base, records: [reviewerRec({ tier: 'e2e', head_sha: H2 })] }).tier, null);
});

test('reviewCoverage：判决文件坏掉只是台账里的一条 errors，不抛错也不吃掉合格条目', (t) => {
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), { ac: 'AC-002', verdict: 'pass' }] });
  writeVerdicts(dir, 2, '{ 半个文件');
  const records = [reviewerRec({ round: 1 }), reviewerRec({ round: 2 })];
  const cov = reviewCoverage({ dossierDir: dir, records, head: H, specSha: S, acIds: ['AC-001', 'AC-002'] });

  assert.deepEqual(cov.rounds, [1], 'r2 一条判决都没产出，不算参与合并的轮次');
  assert.deepEqual(Object.keys(cov.judged), ['AC-001'], 'r1 里合格的那条照常入账');
  assert.deepEqual(cov.errors.map((e) => e.round), [1, 2]);
  assert.match(cov.errors[0].errors.join(), /verdicts\[1\]（AC-002）缺 evidence/);
  assert.match(cov.errors[1].errors.join(), /不是合法 JSON/);
  assert.equal(cov.complete, false);

  // 案卷目录整个不存在也只是「没判过」，绝不抛错
  assert.doesNotThrow(() => reviewCoverage({
    dossierDir: path.join(dir, 'nope'), records, head: H, specSha: S, acIds: ['AC-001'],
  }));
  assert.equal(reviewCoverage({ dossierDir: path.join(dir, 'nope'), records, head: H, specSha: S, acIds: ['AC-001'] }).complete, false);
  assert.doesNotThrow(() => reviewCoverage({ dossierDir: dir, records: null, head: H, specSha: S, acIds: ['AC-001'] }));
});

test('reviewCoverage：spec 枚举不出 AC（acIds 为空）时 complete 恒为 false', (t) => {
  // 否则一份没有验收标准的 spec 会让 0/0 变成「判全了」，凭空打开 merge 资格。
  const dir = makeDossier(t);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001')] });
  const cov = reviewCoverage({ dossierDir: dir, records: [reviewerRec()], head: H, specSha: S, acIds: [] });
  assert.equal(cov.complete, false);
  assert.equal(cov.allPass, false);
  assert.deepEqual(cov.unknown, ['AC-001']);
  assert.equal(needReview([reviewerRec()], H, { coverage: cov }), true);
});

// ---- renderCoverage ----

test('renderCoverage：事实段里的一行人话把「判了几条 / fail 了谁 / 还剩谁 / 来自哪几轮」说全', (t) => {
  const dir = makeDossier(t);
  const acIds = ['AC-001', 'AC-002', 'AC-003'];
  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-002', 'fail', 'src/x.mjs:9')] });
  writeVerdicts(dir, 3, { verdicts: [v('AC-004')] });
  const records = [reviewerRec({ round: 1 }), reviewerRec({ round: 3 })];
  const cov = reviewCoverage({ dossierDir: dir, records, head: H, specSha: S, acIds });

  assert.equal(
    renderCoverage(cov, acIds.length),
    '已判 2/3；fail 1（AC-002）；未判 1：AC-003；台账里有 spec 不存在的编号（已忽略）：AC-004；来自 reviewer r1 / r3',
  );
  assert.equal(renderCoverage(null, 3), '', 'coverage 为 null（冻结稿读不到）时不渲染任何文字');

  // 全判全过：未判段消失，fail 段留 0（「没有 fail」也要明说，不能靠读者自己推断）
  writeVerdicts(dir, 4, { verdicts: [v('AC-002'), v('AC-003')] });
  const full = reviewCoverage({ dossierDir: dir, records: [...records, reviewerRec({ round: 4 })], head: H, specSha: S, acIds });
  assert.equal(
    renderCoverage(full, acIds.length),
    '已判 3/3；fail 0；台账里有 spec 不存在的编号（已忽略）：AC-004；来自 reviewer r1 / r3 / r4',
  );
});

test('renderCoverage：未判清单最多列 30 条，其余折成省略号（短 log 的 2000 字符放不下 40 多条）', (t) => {
  const dir = makeDossier(t);
  const acIds = Array.from({ length: 40 }, (_, i) => `AC-${String(i + 1).padStart(3, '0')}`);
  writeVerdicts(dir, 1, { verdicts: [v('AC-001')] });
  const cov = reviewCoverage({ dossierDir: dir, records: [reviewerRec()], head: H, specSha: S, acIds });
  const line = renderCoverage(cov, acIds.length);

  assert.match(line, /^已判 1\/40；fail 0；未判 39：AC-002, AC-003, /);
  assert.ok(line.includes('AC-031 …'), '列到第 30 条为止');
  assert.equal(line.includes('AC-032'), false);
  assert.ok(line.endsWith('；来自 reviewer r1'));
});

// ---- 与版本门的契约 ----

test('与 version-gate 的契约：needReview(records, H, {coverage}) 只在 complete ∧ allPass 时放行', (t) => {
  const dir = makeDossier(t);
  const acIds = ['AC-001', 'AC-002'];
  const records = [reviewerRec()];
  const cov = (over) => reviewCoverage({ dossierDir: dir, records, head: H, specSha: S, acIds, ...over });

  writeVerdicts(dir, 1, { verdicts: [v('AC-001')] });
  assert.equal(needReview(records, H, { coverage: cov() }), true, '判了一半 → 还要审');

  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-002', 'fail', 'src/x.mjs:9')] });
  assert.equal(needReview(records, H, { coverage: cov() }), true, '判全但有 fail → 还要审');

  writeVerdicts(dir, 1, { verdicts: [v('AC-001'), v('AC-002')] });
  const green = cov();
  assert.equal(needReview(records, H, { coverage: green }), false, '判全且全 pass → 放行');

  // coverage 显式传 null（有 spec 但冻结稿读不到）→ 按「没有任何有效 review」处理，绝不放行
  assert.equal(needReview(records, H, { coverage: null }), true);
  // 同一份 green coverage 换个 H 问也不行：H 变了必须重算（调用方拿的是对当前 H 的 coverage）
  assert.equal(needReview(records, H2, { coverage: reviewCoverage({ dossierDir: dir, records, head: H2, specSha: S, acIds }) }), true);
  // 不传 coverage = 无 spec 的旧口径：只看有没有 outcome=ok 的 reviewer 记录
  assert.equal(needReview(records, H), false);
  assert.equal(needReview([reviewerRec({ outcome: 'fail' })], H), true);
});
