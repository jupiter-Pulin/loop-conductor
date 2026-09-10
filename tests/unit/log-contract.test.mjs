// 单元：执行 log 契约（AC-007 / AC-011）。log 文件是 agent → 内核的唯一通道，
// 这份校验是唯一裁判——Stop hook 与记录合成都调它，任何一条规则松掉，router 就会读到
// 内核字段被 agent 自己盖章、或版本规则被一份非法 log 蒙混过去的记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLog, LOG_ROLES, ACTIONS, TIERS, PACKAGE_ID_RE, SUMMARY_MAX, OUTCOMES_BY_ROLE,
} from '../../conductor/lib/log-contract.mjs';

const okRouter = (over = {}) => ({ role: 'router', outcome: 'ok', action: 'review', summary: '整体冷审', ...over });
const okMaker = (over = {}) => ({ role: 'maker', outcome: 'ok', summary: 'AC-001..004 done', ...over });
const okReviewer = (over = {}) => ({ role: 'reviewer', outcome: 'fail', tier: 'unit', summary: 'AC-001 pass', ...over });
const okSpec = (over = {}) => ({ role: 'spec', outcome: 'ok', summary: 'AC×19；工作包 4', ...over });

test('AC-007: 常量面——角色 / 动作闭集 / tier / 包 id 正则', () => {
  assert.deepEqual([...LOG_ROLES], ['router', 'spec', 'maker', 'reviewer']);
  assert.deepEqual([...ACTIONS], ['spec', 'plan', 'maker', 'review', 'precommit', 'human', 'merge', 'abandon']);
  assert.deepEqual([...TIERS], ['unit', 'integration', 'e2e']);
  assert.equal(PACKAGE_ID_RE.test('P-001'), true);
  assert.equal(PACKAGE_ID_RE.test('P-1'), false);
  assert.equal(PACKAGE_ID_RE.test('p-001'), false);
  assert.equal(SUMMARY_MAX, 2000);
});

test('AC-007: 四个角色的 happy path 全过', () => {
  assert.equal(validateLog(okRouter(), 'router').ok, true);
  assert.equal(validateLog(okSpec(), 'spec').ok, true);
  assert.equal(validateLog(okMaker(), 'maker').ok, true);
  assert.equal(validateLog(okReviewer(), 'reviewer').ok, true);
});

test('AC-007: 非对象 / 期望角色非法 → 不抛错，返回 ok:false', () => {
  for (const bad of [null, undefined, 'x', 42, [], []]) {
    assert.equal(validateLog(bad, 'maker').ok, false);
  }
  const r = validateLog(okMaker(), 'committer');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /期望角色非法/);
});

test('AC-007: role 必须等于内核派出的角色（方案模式仍为 spec）', () => {
  const r = validateLog(okMaker({ role: 'reviewer' }), 'maker');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /role 不匹配/);
  // 方案模式派出的仍是 spec：log 写 spec 即合法
  assert.equal(validateLog(okSpec(), 'spec').ok, true);
});

test('AC-007: outcome 按角色限定', () => {
  assert.deepEqual([...OUTCOMES_BY_ROLE.router], ['ok']);
  assert.equal(validateLog(okRouter({ outcome: 'fail' }), 'router').ok, false, 'router 只能 ok');
  assert.equal(validateLog(okSpec({ outcome: 'needs_human' }), 'spec').ok, true);
  assert.equal(validateLog(okSpec({ outcome: 'fail' }), 'spec').ok, false, 'spec 不能 fail');
  assert.equal(validateLog(okMaker({ outcome: 'needs_human' }), 'maker').ok, true);
  assert.equal(validateLog(okReviewer({ outcome: 'needs_human' }), 'reviewer').ok, false, 'reviewer 只能 ok|fail');
  assert.equal(validateLog(okMaker({ outcome: undefined }), 'maker').ok, false, 'outcome 必填');
});

test('AC-007: tier —— reviewer 必填、router 仅 precommit 时必填、其余角色出现即非法', () => {
  assert.equal(validateLog({ role: 'reviewer', outcome: 'ok', summary: 's' }, 'reviewer').ok, false);
  assert.equal(validateLog(okReviewer({ tier: 'nope' }), 'reviewer').ok, false);
  assert.equal(validateLog(okRouter({ action: 'precommit', tier: 'integration' }), 'router').ok, true);
  const missing = validateLog(okRouter({ action: 'precommit' }), 'router');
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /precommit 时 tier 必填/);
  const stray = validateLog(okRouter({ action: 'review', tier: 'unit' }), 'router');
  assert.equal(stray.ok, false);
  assert.match(stray.errors.join(), /tier 只在 action=precommit/);
  assert.equal(validateLog(okMaker({ tier: 'unit' }), 'maker').ok, false, 'maker 出现 tier 即非法');
  assert.equal(validateLog(okSpec({ tier: 'unit' }), 'spec').ok, false, 'spec 出现 tier 即非法');
});

test('AC-007: action —— router 必填且在闭集内；其余角色出现即非法', () => {
  assert.equal(validateLog({ role: 'router', outcome: 'ok', summary: 's' }, 'router').ok, false);
  for (const a of ACTIONS) {
    const obj = a === 'precommit'
      ? okRouter({ action: a, tier: 'unit' })
      : okRouter({ action: a });
    assert.equal(validateLog(obj, 'router').ok, true, `action=${a} 应合法`);
  }
  const bad = validateLog(okRouter({ action: 'close' }), 'router');
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /action 不在闭集内/);
  assert.equal(validateLog(okMaker({ action: 'maker' }), 'maker').ok, false, 'maker 出现 action 即非法');
});

test('AC-007/033/035/039: packages —— 仅 router + planActive + action=maker 时合法且必填', () => {
  const ctx = { planActive: true };
  assert.equal(validateLog(okRouter({ action: 'maker', packages: ['P-001'] }), 'router', ctx).ok, true);

  const missing = validateLog(okRouter({ action: 'maker' }), 'router', ctx);
  assert.equal(missing.ok, false, '有方案时 maker 必须点名 packages');
  assert.match(missing.errors.join(), /必须点名 packages/);

  const empty = validateLog(okRouter({ action: 'maker', packages: [] }), 'router', ctx);
  assert.equal(empty.ok, false);

  const badId = validateLog(okRouter({ action: 'maker', packages: ['P-1'] }), 'router', ctx);
  assert.equal(badId.ok, false);
  assert.match(badId.errors.join(), /packages 元素非法/);

  // AC-039：review 动作不接受 packages
  const onReview = validateLog(okRouter({ action: 'review', packages: ['P-001'] }), 'router', ctx);
  assert.equal(onReview.ok, false);
  assert.match(onReview.errors.join(), /只在 action=maker 时合法/);

  // AC-033/035/044：无方案（含 --no-packages、packagesEnabled=false）任务出现 packages 即非法
  const noPlan = validateLog(okRouter({ action: 'maker', packages: ['P-001'] }), 'router', { planActive: false });
  assert.equal(noPlan.ok, false);
  assert.match(noPlan.errors.join(), /无生效方案/);
  assert.equal(validateLog(okRouter({ action: 'maker' }), 'router', { planActive: false }).ok, true);

  // 非 router 角色一律不得出现
  assert.equal(validateLog(okMaker({ packages: ['P-001'] }), 'maker', ctx).ok, false);
});

test('AC-007: summary 非空且 ≤ 2000 字符', () => {
  assert.equal(validateLog(okMaker({ summary: '' }), 'maker').ok, false);
  assert.equal(validateLog(okMaker({ summary: '   ' }), 'maker').ok, false);
  assert.equal(validateLog(okMaker({ summary: undefined }), 'maker').ok, false);
  assert.equal(validateLog(okMaker({ summary: 'a'.repeat(SUMMARY_MAX) }), 'maker').ok, true);
  const tooLong = validateLog(okMaker({ summary: 'a'.repeat(SUMMARY_MAX + 1) }), 'maker');
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.join(), /summary 超长/);
});

test('AC-007: 未知字段非法（内核盖章字段绝不许 agent 自己写）', () => {
  for (const field of ['cost_usd', 'truncated', 'head_sha', 'base_sha', 'package', 'mode', 'session_id']) {
    const r = validateLog(okMaker({ [field]: 1 }), 'maker');
    assert.equal(r.ok, false, `${field} 应判非法`);
    assert.match(r.errors.join(), /未知字段/);
  }
});

// ---- AC-011：precommit 记录的同构校验 ----

function precommitRecord(over = {}) {
  return {
    role: 'precommit',
    outcome: 'ok',
    tier: 'unit',
    summary: 'build ok 42s；service ready 3.1s；unit 41/41 ok',
    cost_usd: 0,
    base_sha: 'b'.repeat(40),
    head_sha: 'h'.repeat(40),
    candidate_sha: 'c'.repeat(40),
    steps: [
      { step: 'build', command: 'npm run build', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 42000, tail: '' },
      {
        step: 'service', command: 'npm run start', status: 'ok', exit_code: null, timed_out: false,
        duration_ms: 3100, tail: '', ready_ms: 3100, pid: 4242, stopped: true,
      },
      { step: 'unit', command: 'npm test', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 9000, tail: '41/41' },
    ],
    skipped_tiers: ['integration', 'e2e'],
    conflict_files: [],
    ...over,
  };
}

test('AC-011: precommit 记录 happy path', () => {
  const r = validateLog(precommitRecord(), 'precommit');
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('AC-011: precommit —— role/outcome/tier/summary/cost_usd 逐项拒收', () => {
  assert.equal(validateLog(precommitRecord({ role: 'maker' }), 'precommit').ok, false);
  assert.equal(validateLog(precommitRecord({ outcome: 'needs_human' }), 'precommit').ok, false);
  assert.equal(validateLog(precommitRecord({ tier: undefined }), 'precommit').ok, false);
  assert.equal(validateLog(precommitRecord({ summary: '' }), 'precommit').ok, false);
  const cost = validateLog(precommitRecord({ cost_usd: 0.01 }), 'precommit');
  assert.equal(cost.ok, false);
  assert.match(cost.errors.join(), /cost_usd 必须为 0/);
});

test('AC-011: precommit —— 事实字段与 steps 形态逐项拒收', () => {
  for (const f of ['base_sha', 'head_sha', 'candidate_sha', 'skipped_tiers', 'conflict_files']) {
    const rec = precommitRecord();
    delete rec[f];
    assert.equal(validateLog(rec, 'precommit').ok, false, `缺 ${f} 应拒收`);
  }
  assert.equal(validateLog(precommitRecord({ steps: 'nope' }), 'precommit').ok, false);
  assert.equal(validateLog(precommitRecord({
    steps: [{ step: 'lint', command: 'x', status: 'ok', exit_code: 0, timed_out: false, duration_ms: 1, tail: '' }],
  }), 'precommit').ok, false, 'step 取值必须在闭集内');
  assert.equal(validateLog(precommitRecord({
    steps: [{ step: 'unit', command: 'x', status: 'green', exit_code: 0, timed_out: false, duration_ms: 1, tail: '' }],
  }), 'precommit').ok, false, 'status 取值必须在闭集内');
  const noReady = validateLog(precommitRecord({
    steps: [{ step: 'service', command: 'x', status: 'ok', exit_code: null, timed_out: false, duration_ms: 1, tail: '' }],
  }), 'precommit');
  assert.equal(noReady.ok, false, 'service 项必须带 ready_ms / pid / stopped');
  assert.match(noReady.errors.join(), /ready_ms/);
  assert.equal(validateLog(precommitRecord({ conflict_files: ['src/index.mjs'], outcome: 'fail' }), 'precommit').ok, true);
});
