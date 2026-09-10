// 单元：保险丝签名与连击判定（AC-024）。
// 这根丝的唯一职责是「原地打转就停手」：同因失败三次收箱，事实一变就重新计数。
// 反过来的红线同样重要——正经工作（改了别的 AC、挂了别的用例、换了 tier）绝不能被它误杀。
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
