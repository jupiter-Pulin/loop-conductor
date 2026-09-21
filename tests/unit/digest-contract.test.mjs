// 单元：spec 摘要（spec-digest/v1）的机械校验。
// 摘要是 router「回到原文」的入口，内核不懂它的自然语言，只能守住三件机械的事：格式、来源版本、
// 引用有效性。任何一条松掉，router 拿到的就是一份看起来合规、实则指不回原文的索引：
// source_sha256 松掉 → 上一版 spec 的摘要被当成当前版复用；行号 / quote 松掉 → 引用指向别处，
// router 以为自己核对过原文；AC 索引松掉 → 摘要悄悄裁掉几条 AC，范围就这样被缩小。
// 校验通过不代表语义正确，所以这里的每条断言都只钉「机械上不可能对」的那一面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateAcceptanceCriteria } from '../../conductor/lib/state.mjs';
import { sha256Of, splitLines } from '../../conductor/lib/spec-version.mjs';
import {
  validateDigest, validateDigestText, renderDigestForRouter,
  DIGEST_SCHEMA, DIGEST_MAX_BYTES, ITEM_TEXT_MAX, QUOTE_MIN, QUOTE_MAX, REF_SPAN_MAX, REFS_PER_ITEM_MAX,
  CONSTRAINT_KINDS, QUESTION_STATUS, PACKAGE_STATUS,
} from '../../conductor/lib/digest-contract.mjs';

// ---- 夹具：一份小而真实的 spec（含 `## 验收标准` 的 `- AC-00N: …` 列表） ----

const SPEC = `# task-20260918-004：spec 摘要的版本绑定

## 背景

摘要由快速模型生成，按 spec 内容哈希落盘；文件搬家不影响引用，人改一个字则全部过期。

## 目标

- router 拿到摘要就能定位到原文的行，不必整份重读 spec。
- 摘要不可用时必须显式降级，router 直接读原文，不得静默跳过。

## 涉及模块

- conductor/lib/digest-store.mjs：摘要的落盘布局与「能不能用」的现算判定。
- conductor/lib/digest-contract.mjs：摘要的机械校验，只看格式、版本与引用。

## 硬约束

- 内核只读摘要，绝不改写、补全或替模型生成摘要。
- 摘要的 source_sha256 必须等于内核交给摘要 agent 的那一版原文的 sha256。
- 摘要不是第二份 spec：验收依据永远是原文。

## 待决问题

- 摘要连续失败后是否自动换模型重试？safe default：不换，直接降级读原文。

## 验收标准

- AC-001: 摘要的 source_sha256 与当前 spec 的 sha256 不一致时，内核判定摘要不可用。
- AC-002: 摘要的行号越界或引用非逐字时，内核给出可修复的错误清单并退回重写。
- AC-003: 尝试次数用尽后状态为 exhausted，router 显式降级读原文，任务不卡死。

## 工作包提议

- P-001 摘要落盘与状态判定
- P-002 有界重试与显式降级
`;

const SPEC_SHA = sha256Of(SPEC);
const SPEC_LINES = splitLines(SPEC);
const AC_IDS = enumerateAcceptanceCriteria(SPEC).map((a) => a.ac_id);

/** 夹具里某段文字所在的 1 基行号（别把行号写死：夹具一改就全错）。 */
function L(needle) {
  const i = SPEC_LINES.findIndex((l) => l.includes(needle));
  assert.notEqual(i, -1, `夹具里找不到包含 ${JSON.stringify(needle)} 的行`);
  return i + 1;
}

/** 在夹具尾部补一个长附录：只有正文够长，才测得到「跨度 > 80 行」这条上限（越界检查会先返回）。 */
const PADDED_SPEC = `${SPEC}\n## 附录：术语\n\n${
  Array.from({ length: 60 }, (_, i) => `- 术语 ${i + 1}：摘要只是索引，验收永远回到原文。`).join('\n')}\n`;
const PADDED_SHA = sha256Of(PADDED_SPEC);

function baseDigest() {
  return {
    schema: DIGEST_SCHEMA,
    source_sha256: SPEC_SHA,
    goal: [
      {
        text: 'router 能按行定位回原文，不必整份重读 spec。',
        refs: [{ lines: [L('router 拿到摘要'), L('不得静默跳过')], quote: '不必整份重读 spec' }],
      },
    ],
    constraints: [
      {
        kind: 'must_not',
        text: '内核不得改写或补全摘要。',
        refs: [{ lines: [L('绝不改写'), L('绝不改写')], quote: '绝不改写、补全或替模型生成摘要' }],
      },
      {
        kind: 'invariant',
        text: '摘要的 source_sha256 必须等于内核交出的那一版原文的 sha256。',
        refs: [{ lines: [L('必须等于内核交给摘要'), L('必须等于内核交给摘要')], quote: 'source_sha256 必须等于内核交给摘要 agent' }],
      },
    ],
    acs: [
      {
        id: 'AC-001',
        group: '版本绑定',
        gist: '源哈希与当前 spec 不一致的摘要判不可用。',
        refs: [{ lines: [L('AC-001'), L('AC-001')], quote: '不一致时，内核判定摘要不可用' }],
      },
      {
        id: 'AC-002',
        gist: '越界或非逐字引用要给出可修复的错误清单。',
        refs: [{ lines: [L('AC-002'), L('AC-002')], quote: '给出可修复的错误清单并退回重写' }],
      },
      {
        id: 'AC-003',
        gist: '尝试用尽后显式降级，任务不卡死。',
        refs: [{ lines: [L('AC-003'), L('AC-003')], quote: '状态为 exhausted' }],
      },
    ],
    modules: [
      {
        name: 'conductor/lib/digest-store.mjs',
        text: '摘要的落盘布局与现算判定。',
        refs: [{ lines: [L('digest-store.mjs：'), L('digest-contract.mjs：')], quote: '摘要的落盘布局' }],
      },
    ],
    open_questions: [
      {
        status: 'unresolved',
        text: '连续失败后是否自动换模型重试？',
        safe_default: '不换，直接降级读原文。',
        refs: [{ lines: [L('是否自动换模型重试'), L('是否自动换模型重试')], quote: '是否自动换模型重试' }],
      },
    ],
    proposed_packages: [
      {
        id: 'P-001',
        title: '摘要落盘与状态判定',
        acs: ['AC-001', 'AC-002'],
        depends_on: [],
        status: 'proposal',
        refs: [{ lines: [L('P-001'), L('P-001')], quote: 'P-001 摘要落盘与状态判定' }],
      },
      {
        id: 'P-002',
        title: '有界重试与显式降级',
        acs: ['AC-003'],
        depends_on: ['P-001'],
        status: 'proposal',
        refs: [{ lines: [L('P-002'), L('P-002')], quote: 'P-002 有界重试与显式降级' }],
      },
    ],
  };
}

/** 造一份摘要：先拿合格的那份，再按 mutate 改坏一处（每个用例只改一处，错误数才说明得了问题）。 */
function digestOf(mutate) {
  const obj = baseDigest();
  if (mutate) mutate(obj);
  return obj;
}

const check = (obj, over = {}) => validateDigest(obj, { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS, ...over });

/** 断言恰好一条错误，且命中给定模式：错得多说明夹具连带坏了，测的就不是这条边界。 */
function onlyError(result, pattern) {
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, `期望恰好一条错误，实际：${result.errors.join(' | ')}`);
  assert.match(result.errors[0], pattern);
  return result.errors[0];
}

// ---- 夹具自检 ----

test('夹具自检：AC 编号由内核枚举得出，与写死的编号一致', () => {
  assert.deepEqual(AC_IDS, ['AC-001', 'AC-002', 'AC-003']);
  assert.deepEqual(enumerateAcceptanceCriteria(PADDED_SPEC).map((a) => a.ac_id), AC_IDS, '补附录不能改变 AC 枚举');
  assert.ok(splitLines(PADDED_SPEC).length > REF_SPAN_MAX + 4, '跨度上限用例需要正文超过 80 行');
});

test('常量面：schema 名、各项上限与三个枚举闭集', () => {
  assert.equal(DIGEST_SCHEMA, 'spec-digest/v1');
  assert.equal(DIGEST_MAX_BYTES, 120_000);
  assert.equal(ITEM_TEXT_MAX, 400);
  assert.equal(QUOTE_MIN, 6);
  assert.equal(QUOTE_MAX, 300);
  assert.equal(REF_SPAN_MAX, 80);
  assert.equal(REFS_PER_ITEM_MAX, 6);
  assert.deepEqual([...CONSTRAINT_KINDS], ['must', 'should', 'must_not', 'invariant', 'non_goal']);
  assert.deepEqual([...QUESTION_STATUS], ['unresolved', 'resolved_in_spec']);
  assert.equal(PACKAGE_STATUS, 'proposal');
});

test('合格摘要全票通过，stats 逐段计数', () => {
  const r = check(baseDigest());
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats, {
    goal: 1, constraints: 2, acs: 3, modules: 1, open_questions: 1, proposed_packages: 2,
  });
});

// ---- 逐个拒收类 ----

test('拒收：非对象输入不抛错，直接判不合格', () => {
  for (const bad of [null, undefined, 'x', 42, [], [{ schema: DIGEST_SCHEMA }]]) {
    const r = check(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['摘要不是 JSON 对象']);
    assert.equal(r.stats, null);
  }
});

test('拒收：schema 不是 spec-digest/v1（换了格式就不能按本契约解读）', () => {
  onlyError(check(digestOf((d) => { d.schema = 'spec-digest/v2'; })), /schema 必须为 "spec-digest\/v1"/);
  onlyError(check(digestOf((d) => { delete d.schema; })), /schema 必须为/);
});

test('拒收：source_sha256 对不上——为上一版 spec 生成的摘要不得被静默复用', () => {
  const oldSpec = SPEC.replace('不得静默跳过', '不得静默跳过（旧版措辞）');
  const oldSha = sha256Of(oldSpec);
  assert.notEqual(oldSha, SPEC_SHA);
  // 摘要本体一字未改、引用也都还对得上，仅仅因为它声明的来源版本是旧的 → 必须拒收。
  const e = onlyError(check(digestOf((d) => { d.source_sha256 = oldSha; })), /source_sha256 不匹配/);
  assert.ok(e.includes(oldSha) && e.includes(SPEC_SHA), '错误里要同时给出摘要写的版本与当前版本');
  onlyError(check(digestOf((d) => { delete d.source_sha256; })), /source_sha256 不匹配/);
});

test('拒收：AC 索引缺条（范围被摘要悄悄裁掉）', () => {
  const e = onlyError(check(digestOf((d) => { d.acs = d.acs.filter((a) => a.id !== 'AC-003'); })), /acs 缺 1 条/);
  assert.match(e, /AC-003/);
  assert.match(e, /不得裁剪/);
  const empty = check(digestOf((d) => { d.acs = []; }));
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(), /acs 缺 3 条：AC-001, AC-002, AC-003/);
});

test('拒收：AC 索引多出原文没有的编号（凭空发明验收项）', () => {
  const extra = onlyError(check(digestOf((d) => {
    d.acs.push({ id: 'AC-009', gist: '原文里根本没有这条。', refs: [{ lines: [L('AC-001'), L('AC-001')], quote: '不一致时，内核判定摘要不可用' }] });
  })), /acs\[3\]\.id="AC-009" 不在原文的 AC 编号里/);
  assert.match(extra, /内核枚举：3 条/);
  // id 写错类型 / 写错编号会同时触发两件事：多一条不认识的，少一条原文真有的。两条都要报。
  const wrongType = check(digestOf((d) => { d.acs[0].id = 42; }));
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.errors.join(' | '), /acs\[0\]\.id=42 不在原文的 AC 编号里/);
  assert.match(wrongType.errors.join(' | '), /acs 缺 1 条：AC-001/);
});

test('拒收：AC 编号重复（重复顶替了另一条，缺条检查看起来仍然满额）', () => {
  const r = check(digestOf((d) => { d.acs.push({ ...d.acs[2] }); }));
  onlyError(r, /acs\[3\]\.id 重复：AC-003/);
  // 换成「重复 + 漏一条」：两类错误必须都报，不能被重复项凑数掩盖。
  const swapped = check(digestOf((d) => { d.acs[2] = { ...d.acs[1] }; }));
  assert.equal(swapped.ok, false);
  assert.match(swapped.errors.join(' | '), /acs\[2\]\.id 重复：AC-002/);
  assert.match(swapped.errors.join(' | '), /acs 缺 1 条：AC-003/);
});

test('拒收：行号越界（起 < 1 / 止 < 起 / 止 > 总行数），错误里报出原文总行数', () => {
  const n = SPEC_LINES.length;
  const over = onlyError(check(digestOf((d) => { d.goal[0].refs[0].lines = [1, n + 1]; })), /goal\[0\]\.refs\[0\]\.lines=\[1,\d+\] 越界/);
  assert.ok(over.includes(`原文共 ${n} 行`), '要把坐标系上限告诉模型，它才改得对');
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].lines = [0, 3]; })), /越界/);
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].lines = [5, 3]; })), /越界/);
  // 形态本身不对：不是两个整数就直接判非法，不做任何猜测性修补。
  for (const bad of [[1], [1, 2, 3], [1, 2.5], ['1', '2'], '1-2', null]) {
    onlyError(check(digestOf((d) => { d.goal[0].refs[0].lines = bad; })), /lines 必须是两个整数/);
  }
});

test('拒收：单条引用跨度超过 80 行（引用要能定位，不是整章）', () => {
  const ctx = { specText: PADDED_SPEC, specSha: PADDED_SHA, acIds: AC_IDS };
  const quote = '不必整份重读 spec';
  const start = L('router 拿到摘要');
  // 边界：恰好 80 行合格，81 行拒收。
  const ok = check(digestOf((d) => { d.source_sha256 = PADDED_SHA; d.goal[0].refs[0] = { lines: [start, start + REF_SPAN_MAX - 1], quote }; }), ctx);
  assert.equal(ok.ok, true, ok.errors.join(' | '));
  const tooWide = check(digestOf((d) => { d.source_sha256 = PADDED_SHA; d.goal[0].refs[0] = { lines: [start, start + REF_SPAN_MAX], quote }; }), ctx);
  onlyError(tooWide, /lines 跨度 81 行超过上限 80/);
});

test('拒收：quote 没有逐字出现在所引行里，并提示它真正出现的行号', () => {
  // 引用指到「## 背景」附近，quote 却抄自 AC-003 那一行：范围内找不到即判非法。
  const bg = L('## 背景');
  const r = check(digestOf((d) => { d.goal[0].refs[0] = { lines: [bg, bg + 2], quote: '状态为 exhausted' }; }));
  const e = onlyError(r, /没有逐字出现在 L\d+-\d+/);
  assert.ok(e.includes(`该片段实际在 L${L('AC-003')}`), `要把真实行号告诉模型：${e}`);

  // 改写过的 quote（多一个字）全文都找不到 → 明确指出必须逐字复制，不得改写。
  const rewritten = check(digestOf((d) => { d.goal[0].refs[0].quote = '不必整份重读一遍 spec'; }));
  assert.match(onlyError(rewritten, /没有逐字出现/), /全文都找不到这个片段/);
});

test('拒收：quote 长度越界 / 跨行（引用必须是可核对的单行片段）', () => {
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].quote = '重读'; })), /quote 必须是 6–300 字符的单行原文片段/);
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].quote = 'x'.repeat(QUOTE_MAX + 1); })), /quote 必须是 6–300/);
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].quote = '不必整份重读 spec\n摘要不可用时'; })), /单行原文片段/);
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].quote = 42; })), /quote 必须是 6–300/);
});

test('拒收：AC 的引用没落在这条 AC 自己所在的行（把 AC-003 的依据指到 AC-001 上）', () => {
  const r = check(digestOf((d) => {
    d.acs[2].refs = [{ lines: [L('AC-001'), L('AC-001')], quote: '不一致时，内核判定摘要不可用' }];
  }));
  // 引用本身完全合法（行号在范围内、quote 逐字），唯一的问题是它指向了别条 AC——
  // 这正是「摘要看起来核对过原文，实则张冠李戴」的典型形态。
  onlyError(r, /acs\[2\]（AC-003）的引用没有覆盖它在「验收标准」段里的定义行 L\d+/);
});

test('拒收：关键条目没有 refs（每条都必须能回到原文）', () => {
  for (const section of ['goal', 'constraints', 'acs', 'modules', 'open_questions', 'proposed_packages']) {
    onlyError(check(digestOf((d) => { d[section][0].refs = []; })), new RegExp(`${section}\\[0\\]\\.refs 必填且至少一条`));
    onlyError(check(digestOf((d) => { delete d[section][0].refs; })), new RegExp(`${section}\\[0\\]\\.refs 必填且至少一条`));
  }
  // 上限：一条条目最多 6 条引用，再多就不是「定位」了。
  const many = check(digestOf((d) => {
    d.goal[0].refs = Array.from({ length: REFS_PER_ITEM_MAX + 1 }, () => ({ lines: [L('router 拿到摘要'), L('router 拿到摘要')], quote: '不必整份重读 spec' }));
  }));
  onlyError(many, /goal\[0\]\.refs 超过 6 条/);
});

test('拒收：未知字段——顶层 / 条目 / 引用三层都不接受摘要 agent 自带私货', () => {
  onlyError(check(digestOf((d) => { d.notes = '我自己加的段'; })), /摘要 未知字段：notes/);
  onlyError(check(digestOf((d) => { d.goal[0].priority = 1; })), /goal\[0\] 未知字段：priority（只接受 text \/ refs）/);
  onlyError(check(digestOf((d) => { d.goal[0].refs[0].file = 'spec.md'; })), /goal\[0\]\.refs\[0\] 未知字段：file/);
  onlyError(check(digestOf((d) => { d.acs[0].verdict = 'pass'; })), /acs\[0\] 未知字段：verdict/);
});

test('拒收：段缺失 / 段不是数组 / 条目不是对象；goal 不得为空，其余段空数组合法', () => {
  // 六个段一个都不能省：省掉一段就等于「这份 spec 没有约束 / 没有未决问题」，是无声的结论。
  for (const section of ['goal', 'constraints', 'acs', 'modules', 'open_questions', 'proposed_packages']) {
    const missing = check(digestOf((d) => { delete d[section]; }));
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join(' | '), new RegExp(`${section} 必填且为数组（没有内容就给空数组）`));
  }
  onlyError(check(digestOf((d) => { d.goal = 'router 要能回到原文'; })), /goal 必填且为数组/);
  onlyError(check(digestOf((d) => { d.goal = []; })), /goal 至少一条/);
  onlyError(check(digestOf((d) => { d.goal = ['router 要能回到原文']; })), /goal\[0\] 必须是对象/);
  onlyError(check(digestOf((d) => { d.constraints = [null]; })), /constraints\[0\] 必须是对象/);
  // 没内容就给空数组：除 goal / acs 外都允许为空，摘要不必为了凑格式编内容。
  assert.equal(check(digestOf((d) => {
    d.constraints = []; d.modules = []; d.open_questions = []; d.proposed_packages = [];
  })).ok, true);
});

test('拒收：constraints.kind 不在闭集内', () => {
  onlyError(check(digestOf((d) => { d.constraints[0].kind = 'nice_to_have'; })), /constraints\[0\]\.kind 取值非法（must \| should \| must_not \| invariant \| non_goal）/);
  onlyError(check(digestOf((d) => { delete d.constraints[0].kind; })), /kind 取值非法/);
  for (const kind of CONSTRAINT_KINDS) {
    assert.equal(check(digestOf((d) => { d.constraints[0].kind = kind; })).ok, true, `${kind} 应合法`);
  }
});

test('拒收：open_questions.status 越出枚举——待决问题不得被写成已批准事实', () => {
  const e = onlyError(check(digestOf((d) => { d.open_questions[0].status = 'decided'; })), /open_questions\[0\]\.status 取值非法/);
  assert.match(e, /safe default 不是已批准事实/);
  onlyError(check(digestOf((d) => { delete d.open_questions[0].status; })), /status 取值非法/);
  for (const status of QUESTION_STATUS) {
    assert.equal(check(digestOf((d) => { d.open_questions[0].status = status; })).ok, true, `${status} 应合法`);
  }
});

test('拒收：proposed_packages.status 不是 proposal——原 spec 的工作包只是提议', () => {
  const e = onlyError(check(digestOf((d) => { d.proposed_packages[0].status = 'approved'; })), /proposed_packages\[0\]\.status 必须是 "proposal"/);
  assert.match(e, /不是已批准的执行计划/);
  onlyError(check(digestOf((d) => { delete d.proposed_packages[1].status; })), /proposed_packages\[1\]\.status 必须是 "proposal"/);
});

test('拒收：工作包的 acs / depends_on 指向不存在的东西（引用完整性）', () => {
  onlyError(check(digestOf((d) => { d.proposed_packages[0].acs = ['AC-001', 'AC-042']; })), /proposed_packages\[0\]\.acs 必须是原文 AC 编号的数组/);
  onlyError(check(digestOf((d) => { d.proposed_packages[0].acs = 'AC-001'; })), /proposed_packages\[0\]\.acs 必须是原文 AC 编号的数组/);
  onlyError(check(digestOf((d) => { d.proposed_packages[1].depends_on = ['P-404']; })), /proposed_packages\[1\]\.depends_on 必须是本摘要里出现过的工作包 id 数组/);
  onlyError(check(digestOf((d) => { delete d.proposed_packages[1].depends_on; })), /depends_on 必须是本摘要里出现过的工作包 id 数组/);
  onlyError(check(digestOf((d) => { d.proposed_packages[1].id = ''; })), /proposed_packages\[1\]\.id 必填/);
  // 被依赖的那个包 id 空掉时，连带把依赖它的包也判非法——引用完整性是双向的。
  const orphaned = check(digestOf((d) => { d.proposed_packages[0].id = ''; }));
  assert.equal(orphaned.ok, false);
  assert.match(orphaned.errors.join(' | '), /proposed_packages\[0\]\.id 必填/);
  assert.match(orphaned.errors.join(' | '), /proposed_packages\[1\]\.depends_on 必须是本摘要里出现过的工作包 id 数组/);
});

test('拒收：正文字段超长——摘要是索引，不是把原文搬一遍', () => {
  assert.equal(check(digestOf((d) => { d.goal[0].text = 'x'.repeat(ITEM_TEXT_MAX); })).ok, true, '正好 400 字符合法');
  onlyError(check(digestOf((d) => { d.goal[0].text = 'x'.repeat(ITEM_TEXT_MAX + 1); })), /goal\[0\]\.text 必填，≤ 400 字符/);
  onlyError(check(digestOf((d) => { d.acs[0].gist = 'x'.repeat(ITEM_TEXT_MAX + 1); })), /acs\[0\]\.gist 必填，≤ 400 字符/);
  onlyError(check(digestOf((d) => { d.acs[0].group = 'g'.repeat(81); })), /acs\[0\]\.group 须为 ≤ 80 字符的字符串/);
  onlyError(check(digestOf((d) => { d.modules[0].name = 'n'.repeat(161); })), /modules\[0\]\.name 必填，≤ 160 字符/);
  onlyError(check(digestOf((d) => { d.proposed_packages[0].title = 't'.repeat(201); })), /proposed_packages\[0\]\.title 必填，≤ 200 字符/);
  onlyError(check(digestOf((d) => { d.open_questions[0].safe_default = 's'.repeat(ITEM_TEXT_MAX + 1); })), /open_questions\[0\]\.safe_default 须为 ≤ 400 字符的字符串/);
  onlyError(check(digestOf((d) => { d.goal[0].text = '   '; })), /goal\[0\]\.text 必填/);
});

test('错误清单封顶 40 条 + 一条汇总：喂回模型的反馈太长反而修不动', () => {
  const r = check(digestOf((d) => { d.goal = Array.from({ length: 45 }, () => ({})); }));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 41);
  assert.match(r.errors[40], /… 另有 \d+ 条同类错误/);
  assert.equal(r.stats.goal, 45, 'stats 仍按真实条数统计，不受封顶影响');
});

// ---- validateDigestText：把「读不出来」也归成校验结果 ----

test('validateDigestText：空 / 非字符串 → 缺失或为空', () => {
  for (const raw of ['', '   \n', null, undefined, 42, {}]) {
    const r = validateDigestText(raw, { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS });
    assert.deepEqual(r.errors, ['摘要文件缺失或为空']);
    assert.equal(r.ok, false);
    assert.equal(r.digest, null);
  }
});

test('validateDigestText：不是合法 JSON → 带上解析器的原话，绝不尝试修补', () => {
  const r = validateDigestText('{ "schema": "spec-digest/v1", }', { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /摘要不是合法 JSON：/);
  assert.equal(r.digest, null);
  assert.equal(validateDigestText('这不是 JSON', { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS }).ok, false);
});

test('validateDigestText：超过 120000 字节先于解析被拒（不为一份巨型文件付解析代价）', () => {
  const huge = 'x'.repeat(DIGEST_MAX_BYTES + 1);
  const r = validateDigestText(huge, { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [`摘要超过 ${DIGEST_MAX_BYTES} 字节上限：摘要是索引，不是第二份 spec`]);
  assert.equal(r.digest, null);
  // 按字节算而不是按字符：一个中文字 3 字节，40001 个就该超。
  const cjk = '摘'.repeat(40_001);
  assert.ok(cjk.length < DIGEST_MAX_BYTES && Buffer.byteLength(cjk, 'utf8') > DIGEST_MAX_BYTES);
  assert.match(validateDigestText(cjk, { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS }).errors[0], /字节上限/);
});

test('validateDigestText：合格文本 → ok 且原样回传 parse 出的摘要对象', () => {
  const raw = `${JSON.stringify(baseDigest(), null, 2)}\n`;
  const r = validateDigestText(raw, { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(r.digest, baseDigest());
  assert.deepEqual(r.stats, { goal: 1, constraints: 2, acs: 3, modules: 1, open_questions: 1, proposed_packages: 2 });
  // 不合格时也要把 parse 结果带出来（内核据此写 meta），只是 ok=false。
  const bad = validateDigestText(JSON.stringify(digestOf((d) => { d.schema = 'x'; })), { specText: SPEC, specSha: SPEC_SHA, acIds: AC_IDS });
  assert.equal(bad.ok, false);
  assert.equal(bad.digest.schema, 'x');
});

// ---- 渲染 ----

test('renderDigestForRouter：每条都带 L 起-止 引用，工作包明确标成提议', () => {
  const out = renderDigestForRouter(baseDigest());
  // 引用格式是 router 回原文的唯一线索：跨行 L9-10、单行 L29。
  assert.match(out, /\[L\d+-\d+\]/);
  assert.match(out, new RegExp(`\\[L${L('AC-001')}\\]`));
  assert.equal(/\[L\]|\[\]/.test(out), false, '不允许出现空引用');

  assert.match(out, /^目标：/m);
  assert.match(out, /- \(must_not\) 内核不得改写或补全摘要。/);
  assert.match(out, /- AC-001〔版本绑定〕/);
  assert.match(out, /- AC-002 /, 'group 可省，省了就不带书名号');
  assert.match(out, /AC 索引（验收依据永远是原文，这里只是目录）/);
  assert.match(out, /- \(unresolved\) 连续失败后是否自动换模型重试？｜safe default：不换，直接降级读原文。/);

  // 提议必须写成提议：router 读到的是「可以重新拆」，不是「已批准的执行计划」。
  assert.match(out, /原 spec 提议的工作包（提议，不是强制计划；怎么拆、什么顺序由你定）/);
  assert.match(out, /- P-001 摘要落盘与状态判定｜AC：AC-001,AC-002｜依赖：-/);
  assert.match(out, /- P-002 有界重试与显式降级｜AC：AC-003｜依赖：P-001/);
  assert.equal(out.endsWith('\n'), false, '尾部空行已 trim，拼进 prompt 不留空段');
});

test('renderDigestForRouter：非对象 → 空串；空段落整段省略，不留空标题', () => {
  for (const bad of [null, undefined, 'x', 42, []]) assert.equal(renderDigestForRouter(bad), '');
  const out = renderDigestForRouter(digestOf((d) => { d.modules = []; d.open_questions = []; d.proposed_packages = []; }));
  assert.equal(/涉及模块/.test(out), false);
  assert.equal(/未决问题/.test(out), false);
  assert.equal(/原 spec 提议的工作包/.test(out), false);
  assert.match(out, /^目标：/m);
});

// ---- AC 引用的 quote 可省：定义行才是更硬的锚点 ----
//
// 来历：真实的 44 条 AC、40KB 的 spec 上，快速模型给出的行号全部正确，却习惯把长句「概括」进 quote，
// 逐字核对因此整份作废、白烧重试。AC 条目另有内核自己算出的锚点（引用必须覆盖该 AC 在「验收标准」段
// 里的定义行），所以 AC 引用只给 lines 即可；给了 quote 照样逐字核对，其余各段的 quote 仍然必填。
test('AC 引用可以只给 lines（不带 quote）：靠定义行锚点校验；给了 quote 仍逐字核对；其它段 quote 照旧必填', () => {
  const noQuote = digestOf((d) => { for (const ac of d.acs) ac.refs = ac.refs.map((r) => ({ lines: r.lines })); });
  assert.equal(check(noQuote).ok, true, 'AC 引用省略 quote 合法');

  // 省了 quote 也逃不过定义行：把 AC-002 的行号指到 AC-001 那一行 → 拒收
  const wrongLine = digestOf((d) => { d.acs[1].refs = [{ lines: d.acs[0].refs[0].lines }]; });
  onlyError(check(wrongLine), /acs\[1\]（AC-002）的引用没有覆盖它在「验收标准」段里的定义行/);

  // 给了 quote 就得是真的
  const badQuote = digestOf((d) => { d.acs[0].refs[0].quote = '这一句原文里没有，是模型自己概括的'; });
  const r = check(badQuote);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /acs\[0\]\.refs\[0\]\.quote 没有逐字出现/);
  assert.match(r.errors.join('\n'), /的原文开头是 "/, '错误里带所引行的原文开头，方便模型对照重抄（机械提示，不是内核替它改）');

  // 非 AC 段不享受这个豁免
  const goalNoQuote = digestOf((d) => { d.goal[0].refs = d.goal[0].refs.map((x) => ({ lines: x.lines })); });
  onlyError(check(goalNoQuote), /goal\[0\]\.refs\[0\]\.quote 必须是/);
});
