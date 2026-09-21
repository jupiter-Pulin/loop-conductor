// 单元：保险丝签名与连击判定（AC-024）。
// 这根丝的唯一职责是「原地打转就停手」：同因失败三次收箱，事实一变就重新计数。
// 反过来的红线同样重要——正经工作（改了别的 AC、挂了别的用例、换了 tier）绝不能被它误杀。
// 角色 / outcome 空间后来变大了（worker、digest；partial / blocked）：这根丝只收编
// precommit / reviewer / maker，新加的记录字段也一律不得渗进签名（否则加字段 = 悄悄重置连击）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf, checkFuse, FUSE_ROLES } from '../../conductor/lib/fuse.mjs';

const precommit = (over = {}) => ({
  round: 1,
  role: 'precommit',
  package: null,
  outcome: 'fail',
  tier: 'unit',
  summary: 'build ok 1s；unit 1 fail: ✖ median',
  steps: [
    { step: 'build', command: 'npm run build', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 1000, tail: '' },
    { step: 'unit', command: 'npm test', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 2000, tail: 'not ok 1 - median\nlocation: \'/repo/test/stats.test.mjs:12:1\'\n...' },
  ],
  ...over,
});

const reviewer = (over = {}) => ({
  round: 1, role: 'reviewer', package: null, outcome: 'fail', tier: 'integration',
  summary: 'AC-001 pass\nAC-002 fail src/x.mjs:40 未扣手续费',
  ...over,
});

const maker = (over = {}) => ({
  round: 1, role: 'maker', package: null, outcome: 'ok',
  summary: 'AC-001..004 done；npm test 41/41 绿',
  ...over,
});

// 后加的两个角色：worker 是 dispatch 派出的委派（带 key / profile），digest 是内核的摘要轮。
const worker = (over = {}) => ({
  round: 1, role: 'worker', package: null, key: 'curve-fix', profile: 'write',
  outcome: 'fail', summary: 'Curve.sol:412 还是编译不过', progress: 'none', integration: 'done',
  ...over,
});

const digest = (over = {}) => ({
  round: 1, role: 'digest', package: null, outcome: 'fail', summary: '摘要没过机械校验：AC-007 缺行号', ...over,
});

// ---- 签名 ----

test('precommit 签名：失败步骤名 + 命令 + tail 签名；噪声不改变、事实改变即不同', () => {
  const base = signatureOf(precommit());
  assert.match(base, /^precommit\|unit\|[0-9a-f]{16}$/);

  // 同一失败的两份记录：耗时数字、ANSI、时间戳等噪声不同 → 同签名（buildSignature 的归一化）
  const noisy = precommit({
    steps: [
      { step: 'build', command: 'npm run build', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 9999, tail: '' },
      { step: 'unit', command: 'npm test', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 7777, tail: 'not ok 1 - median (12.34ms)\nlocation: \'/other/checkout/test/stats.test.mjs:12:1\'\n...' },
    ],
  });
  assert.equal(signatureOf(noisy), base, '耗时与路径前缀不该改变签名');

  // 换了失败的用例 → 不同签名（有进展）
  const other = precommit({
    steps: [precommit().steps[0], { ...precommit().steps[1], tail: 'not ok 1 - sweep\nlocation: \'/repo/test/sweep.test.mjs:3:1\'\n...' }],
  });
  assert.notEqual(signatureOf(other), base);

  // 换了失败的步 → 不同签名，且前缀带步名
  const buildFail = precommit({
    steps: [{ ...precommit().steps[0], status: 'fail', exit_code: 2, tail: 'error: cannot find module' }],
  });
  assert.match(signatureOf(buildFail), /^precommit\|build\|/);
  assert.notEqual(signatureOf(buildFail), base);
});

test('precommit 无失败步（ok / 候选冲突 / lock_timeout）→ 无签名', () => {
  const ok = precommit({
    outcome: 'ok',
    steps: [{ step: 'unit', command: 'npm test', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 10, tail: '' }],
  });
  assert.equal(signatureOf(ok), null);

  const conflict = precommit({
    outcome: 'fail',
    conflict_files: ['src/index.mjs'],
    steps: [{ step: 'unit', command: 'npm test', status: 'not_run', exit_code: null, timed_out: false, duration_ms: 0, tail: '' }],
  });
  assert.equal(signatureOf(conflict), null, '与 base 的冲突交给 router 求助，不是本任务的无进展');

  const lockTimeout = precommit({ outcome: 'fail', summary: 'lock_timeout', steps: [] });
  assert.equal(signatureOf(lockTimeout), null, '等锁超时是别的任务占着锁，不该计入连击');
});

test('reviewer 签名：tier + 排序 fail AC 编号 + 各 fail 首行', () => {
  const base = signatureOf(reviewer());
  assert.match(base, /^reviewer\|integration\|[0-9a-f]{16}$/);

  // pass 行、行序、未判清单都不改变签名；fail 集合才算数
  const reordered = reviewer({
    summary: 'AC-002 fail src/x.mjs:40 未扣手续费\nAC-001 pass\n未判: AC-003',
  });
  assert.equal(signatureOf(reordered), base);

  assert.notEqual(signatureOf(reviewer({ tier: 'unit' })), base, 'tier 变了就是不同签名');
  assert.notEqual(
    signatureOf(reviewer({ summary: 'AC-001 pass\nAC-002 fail src/x.mjs:88 位置变了' })),
    base,
    'fail 行内容变了（定位到别处）就是有进展',
  );
  assert.notEqual(
    signatureOf(reviewer({ summary: 'AC-001 fail src/y.mjs:1 别的问题\nAC-002 fail src/x.mjs:40 未扣手续费' })),
    base,
    '多 fail 一条 AC 就是不同签名',
  );
  // 无 spec 任务用 B-00x 编号，同样参与
  assert.match(signatureOf(reviewer({ summary: 'B-001 fail src/x.mjs:2 复现未修' })), /^reviewer\|integration\|/);
});

test('reviewer 全 pass → 无签名（签名整个由 fail 行构成）', () => {
  assert.equal(signatureOf(reviewer({ outcome: 'ok', summary: 'AC-001 pass\nAC-002 pass' })), null);
  // product 非法（outcome=null）仍算失败面，参与连击
  assert.match(signatureOf(reviewer({ outcome: null, tier: null, summary: null })), /^reviewer\|-\|/);
});

test('maker 签名：(package, outcome, summary 首行)；ok 记录照样参与', () => {
  const base = signatureOf(maker());
  assert.match(base, /^maker\|-\|ok\|[0-9a-f]{16}$/);
  assert.equal(signatureOf(maker({ summary: `${maker().summary}\n第二行随便写` })), base, '只看首行');
  assert.notEqual(signatureOf(maker({ outcome: 'fail' })), base);
  assert.notEqual(signatureOf(maker({ package: 'P-001' })), base);
  assert.match(signatureOf(maker({ package: 'P-002' })), /^maker\|P-002\|ok\|/);
  assert.notEqual(signatureOf(maker({ summary: 'AC-005..009 done；npm test 52/52 绿' })), base);
});

test('router / spec / human 记录不参与保险丝', () => {
  assert.deepEqual(FUSE_ROLES, ['precommit', 'reviewer', 'maker']);
  assert.equal(signatureOf({ role: 'router', outcome: 'ok', summary: 'maker' }), null);
  assert.equal(signatureOf({ role: 'spec', outcome: 'ok', summary: 'AC×19' }), null);
  assert.equal(signatureOf({ role: 'human', kind: 'help', decision: 'resumed' }), null);
  assert.equal(signatureOf(null), null);
  assert.equal(signatureOf('not a record'), null);
});

test('worker / digest 记录不参与保险丝：角色空间变大了，FUSE_ROLES 没跟着变', () => {
  assert.equal(FUSE_ROLES.includes('worker'), false, '要收编 worker 得显式改名单，不许靠默认分支漂移');
  assert.equal(FUSE_ROLES.includes('digest'), false);
  // worker 的五种 outcome 一个都不产生签名：委派的失败面是报告与 diff，不是这根「同一条失败记录
  // 反复出现」的丝能比的。反复派同一件事由 router-kernel 的停滞保险丝（checkStallAndBox：指纹含
  // 任务分支 tree / review 覆盖 / 人的裁决条数）兜底 —— 换个 key 重派也改不了那份指纹。
  for (const outcome of ['ok', 'partial', 'blocked', 'fail', 'needs_human']) {
    assert.equal(signatureOf(worker({ outcome })), null, `worker outcome=${outcome} 不该有签名`);
  }
  assert.equal(signatureOf(worker({ outcome: null, summary: null })), null, 'log 缺失的 worker 同样不参与');
  // digest 的重试上限由 digest 动作自己管（digestMaxAttempts，用尽即降级读原文），不进保险丝。
  assert.equal(signatureOf(digest()), null);
  assert.equal(signatureOf(digest({ outcome: 'ok' })), null);
});

test('maker 的新 outcome：partial / needs_human 各自成签名，结论变了就是有进展', () => {
  const sigs = ['ok', 'partial', 'fail', 'needs_human'].map((outcome) => signatureOf(maker({ outcome })));
  assert.equal(new Set(sigs).size, 4, 'outcome 进签名式：四种结论必须两两不同');
  assert.match(signatureOf(maker({ outcome: 'partial' })), /^maker\|-\|partial\|[0-9a-f]{16}$/);
  assert.match(signatureOf(maker({ outcome: 'needs_human', package: 'P-003' })), /^maker\|P-003\|needs_human\|/);

  // done / remaining 是后加的结构化进度清单，**不**进签名（spec 的签名式只有 package + outcome +
  // summary 首行）。所以「有进展」必须写进首行：这正是 agent 契约要求首行写结论的原因。
  assert.equal(
    signatureOf(maker({ outcome: 'partial', done: ['AC-001'] })),
    signatureOf(maker({ outcome: 'partial', done: ['AC-001', 'AC-002'], remaining: ['AC-003'] })),
    'done 变长但首行没变 → 同签名',
  );
  assert.notEqual(
    signatureOf(maker({ outcome: 'partial', summary: 'AC-001..002 done；余 AC-003' })),
    signatureOf(maker({ outcome: 'partial', summary: 'AC-001..004 done；余 AC-005' })),
    '首行写清进展就断连',
  );
});

test('reviewer 的 partial 照样参与：fail 集合 / tier 一变就是有进展', () => {
  const twoFails = reviewer({
    outcome: 'partial',
    summary: 'AC-001 pass\nAC-002 fail src/x.mjs:40 未扣手续费\nAC-004 fail src/y.mjs:9 越界\n未判: AC-005',
  });
  const base = signatureOf(twoFails);
  assert.match(base, /^reviewer\|integration\|[0-9a-f]{16}$/, 'partial 不是「没失败」，它带着 fail 行照常参与');

  // 修好一条、只剩另一条 → 不同签名。这是最该保住的红线：真修了东西不能被当成打转。
  assert.notEqual(
    signatureOf(reviewer({ outcome: 'partial', summary: 'AC-001 pass\nAC-004 fail src/y.mjs:9 越界\n未判: AC-005' })),
    base,
  );
  assert.notEqual(signatureOf(reviewer({ ...twoFails, tier: 'e2e' })), base, 'tier 上台阶也是进展');
  // 未判清单变长变短都不算：签名只由 fail 行构成。
  assert.equal(
    signatureOf(reviewer({ outcome: 'partial', summary: `${twoFails.summary}, AC-006, AC-007` })),
    base,
  );
});

test('新记录字段（key / profile / progress / integration …）不得渗进签名', () => {
  // records.mjs 这一版给记录加了一堆内核事实。它们若进了签名，每加一个字段就会把**活着的**
  // 连击悄悄清零——一个已经打转两轮的任务凭空多拿三轮预算，而且没人看得出来。
  const kernelFacts = {
    key: 'curve-fix', profile: 'write', intent: 'implement', title: '扣手续费', isolation: 'hooks-only',
    resume_of: 2, progress: 'changed', integration: 'integrated', violations: ['branch_moved:refs/heads/x'],
    spec_sha: 'a'.repeat(64), head_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40),
    done: ['AC-001'], remaining: ['AC-002'], guidance: '先补用例', assignments: null,
    artifacts: { report: 'maker-r1.report.md', log: 'maker-r1.log.json' },
    cost_usd: 8.1, cost_unknown: true, truncated: true, interrupted: true, duration_ms: 123,
    session_id: 's-1', product: 'ok', product_error: null, written_at: '2026-08-30T00:00:00.000Z',
  };
  assert.equal(signatureOf(maker({ ...kernelFacts })), signatureOf(maker()));
  assert.equal(signatureOf(reviewer({ ...kernelFacts })), signatureOf(reviewer()));
  assert.equal(
    signatureOf(precommit({ ...kernelFacts, steps: precommit().steps })),
    signatureOf(precommit()),
  );
  // 同一条记录反复算也必须一模一样（纯函数，零 IO）。
  const rec = maker({ outcome: 'partial' });
  assert.equal(signatureOf(rec), signatureOf(rec));
});

// ---- 连击 ----

test('连续 3 条同签名 → 触发；2 条不触发', () => {
  const rec = (round) => precommit({ round });
  assert.equal(checkFuse([rec(1), rec(2)], 3), null);
  const tripped = checkFuse([rec(1), rec(2), rec(3)], 3);
  assert.deepEqual(
    { role: tripped.role, package: tripped.package },
    { role: 'precommit', package: null },
  );
  assert.equal(tripped.signature, signatureOf(rec(1)));
});

test('事实一变即断连：中间换了失败用例，尾部只剩 1 条', () => {
  const same = (round) => precommit({ round });
  const other = precommit({
    round: 3,
    steps: [precommit().steps[0], { ...precommit().steps[1], tail: 'not ok 1 - sweep\nlocation: \'/repo/test/sweep.test.mjs:3:1\'\n...' }],
  });
  assert.equal(checkFuse([same(1), same(2), other, same(4)], 3), null);
  assert.equal(checkFuse([same(1), other, same(3), same(4)], 3), null, '旧连击不复活');
  assert.notEqual(checkFuse([other, same(2), same(3), same(4)], 3), null, '尾部三条同签名才算');
});

test('无签名记录打断连击，不被跳过', () => {
  const fail = (round) => precommit({ round });
  const lockTimeout = precommit({ round: 3, summary: 'lock_timeout', steps: [] });
  assert.equal(checkFuse([fail(1), fail(2), lockTimeout, fail(4)], 3), null);
  assert.equal(checkFuse([fail(1), fail(2), lockTimeout], 3), null, '尾部是无签名记录时不触发');
});

test('分组：(role, package) 各数各的，不同角色不互相抵消', () => {
  const list = [
    maker({ round: 1 }), reviewer({ round: 1 }),
    maker({ round: 2 }), reviewer({ round: 2 }),
    maker({ round: 3 }), reviewer({ round: 3 }),
  ];
  // maker 与 reviewer 各自连续 3 条同签名：交替出现也照数不误
  const tripped = checkFuse(list, 3);
  assert.ok(tripped);
  assert.equal(tripped.role, 'reviewer', '尾部记录最靠后的那一组优先');

  // 两个不同的包各 2 条 → 都不到 3
  const pkgs = [
    maker({ round: 1, package: 'P-001' }), maker({ round: 1, package: 'P-002' }),
    maker({ round: 2, package: 'P-001' }), maker({ round: 2, package: 'P-002' }),
  ];
  assert.equal(checkFuse(pkgs, 3), null);
  const p1 = checkFuse([...pkgs, maker({ round: 3, package: 'P-001' })], 3);
  assert.deepEqual({ role: p1.role, package: p1.package }, { role: 'maker', package: 'P-001' });
});

test('fuseStreak: 0 永不触发；非法值同样不触发', () => {
  const five = [1, 2, 3, 4, 5].map((round) => precommit({ round }));
  assert.equal(checkFuse(five, 0), null);
  assert.equal(checkFuse(five, -1), null);
  assert.equal(checkFuse(five, null), null);
  assert.equal(checkFuse(five, undefined), null);
  assert.notEqual(checkFuse(five, 3), null, '开着的时候必须能触发');
  assert.notEqual(checkFuse(five, 1), null, 'streak=1：一条即触发');
});

test('sinceRound：人 retry 后连击从零开始', () => {
  const three = [1, 2, 3].map((round) => precommit({ round }));
  assert.notEqual(checkFuse(three, 3), null);
  assert.equal(checkFuse(three, 3, { sinceRound: 2 }), null, 'retry 复位后只剩 2 条参与');
  assert.notEqual(
    checkFuse([...three, precommit({ round: 4 }), precommit({ round: 5 })], 3, { sinceRound: 3 }),
    null,
    '复位后又攒够三条照样收箱',
  );
});

test('空输入与缺失字段不抛错', () => {
  assert.equal(checkFuse([], 3), null);
  assert.equal(checkFuse(null, 3), null);
  assert.equal(checkFuse([null, undefined, {}], 3), null);
});

test('连击里的新角色：maker partial 照数；worker / digest 既不计数也不打断别人的连击', () => {
  // 委派轮反复失败不由这根丝收箱（见上面的角色边界）：连五轮一模一样也不触发。
  assert.equal(checkFuse([1, 2, 3, 4, 5].map((round) => worker({ round })), 3), null);
  assert.equal(checkFuse([1, 2, 3].map((round) => digest({ round })), 3), null);

  // maker 自述 partial 而整体一直不绿，正是要拦的那种打转：partial 与 ok 一样参与计数。
  const stuck = (round) => maker({ round, outcome: 'partial', summary: '还在接 sweep 的回归用例' });
  const tripped = checkFuse([stuck(1), stuck(2), stuck(3)], 3);
  assert.deepEqual({ role: tripped.role, package: tripped.package }, { role: 'maker', package: null });
  assert.equal(checkFuse([stuck(1), stuck(2), maker({ round: 3, outcome: 'fail', summary: '还在接 sweep 的回归用例' })], 3), null,
    'partial → fail：结论变了就是新事实，连击归零');

  // worker / digest 记录对签名丝根本不存在：夹在中间既不算一条，也不会把 maker 的尾部连击切断。
  // （夹着的那一轮真做了事，任务分支会变 —— 那由停滞保险丝的指纹去认，不是这里的职责。）
  const across = checkFuse([stuck(1), worker({ round: 2 }), digest({ round: 3 }), stuck(4), stuck(5)], 3);
  assert.deepEqual({ role: across.role, package: across.package }, { role: 'maker', package: null });
});

test('reviewer partial 且没有 fail 行：是在续审、不是同因失败——无签名，连判三轮也不触发保险丝', () => {
  // reviewer 的 partial = 「还有 AC 没判完」（分轮续审）。它的 summary 只写统计与 fail 原因，所以
  // 「判到第 4 / 9 / 14 条、全 pass」三轮的 fail 集合都是空的；若照样出签名，三轮真进展会被当成打转收箱。
  // 续审原地打转（覆盖率不涨）由停滞保险丝管——review 覆盖在它的硬进展指纹里，不归这根保险丝。
  const partial = (round, judged) => reviewer({
    round, outcome: 'partial', summary: `已判 ${judged}/19，全 pass；未判: AC-${String(judged + 1).padStart(3, '0')}..AC-019`,
  });
  assert.equal(signatureOf(partial(1, 4)), null);
  assert.equal(checkFuse([partial(1, 4), partial(2, 9), partial(3, 14)], 3), null, '三轮各多判 5 条 AC：不是无进展');

  // 对照：partial 里带**独占一行**的 fail（fail 行的抽取是行首锚定的）→ 有签名；同一条 fail 连续三轮 → 触发。
  const withFail = (round) => reviewer({ round, outcome: 'partial', summary: '已判 9/19\nAC-006 fail src/x.mjs:12 漏了退款\n未判: AC-010..AC-019' });
  assert.notEqual(signatureOf(withFail(2)), null);
  assert.equal(checkFuse([partial(1, 4), withFail(2), partial(3, 14)], 3), null, '无签名的记录出现即断连');
  assert.equal(checkFuse([withFail(1), withFail(2), withFail(3)], 3)?.role, 'reviewer', '同一条 fail 连续三轮仍然收箱');
  // fail 写在别的文字后面（不在行首）抽不出来 → 等同于零 fail → 无签名。
  const inlineFail = reviewer({ round: 2, outcome: 'partial', summary: '已判 9/19；AC-006 fail src/x.mjs:12 漏了退款' });
  assert.equal(signatureOf(inlineFail), null);
});
