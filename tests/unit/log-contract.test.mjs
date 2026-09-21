// 单元：执行 log 契约（AC-007 / AC-011）。log 文件是 agent → 内核的唯一通道，
// 这份校验是唯一裁判——Stop hook 与记录合成都调它，任何一条规则松掉，router 就会读到
// 内核字段被 agent 自己盖章、或版本规则被一份非法 log 蒙混过去的记录。
// 并行委派上线后同一份裁判还要管 digest / worker 两个新角色，以及 assignments / guidance /
// done / remaining 四个新字段：它们决定 router 能不能派 worker、maker 能不能续做上一轮的残活。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLog, LOG_ROLES, ACTIONS, TIERS, PACKAGE_ID_RE, SUMMARY_MAX, OUTCOMES_BY_ROLE,
  GUIDANCE_MAX, PROGRESS_ITEMS_MAX, PROGRESS_ITEM_MAX,
} from '../../conductor/lib/log-contract.mjs';

const okRouter = (over = {}) => ({ role: 'router', outcome: 'ok', action: 'review', summary: '整体冷审', ...over });
const okMaker = (over = {}) => ({ role: 'maker', outcome: 'ok', summary: 'AC-001..004 done', ...over });
const okReviewer = (over = {}) => ({ role: 'reviewer', outcome: 'fail', tier: 'unit', summary: 'AC-001 pass', ...over });
const okSpec = (over = {}) => ({ role: 'spec', outcome: 'ok', summary: 'AC×19；工作包 4', ...over });
const okDigest = (over = {}) => ({ role: 'digest', outcome: 'ok', summary: '案卷压缩：3 轮 → 一页事实', ...over });
const okWorker = (over = {}) => ({ role: 'worker', outcome: 'ok', summary: '按委派查清 401 来源', ...over });

// 一份最小的合法委派：dispatch 动作必须带它，否则 router 无从说明派谁去做什么。
const assignment = (over = {}) => ({
  key: 'auth-probe',
  profile: 'read',
  intent: 'investigate',
  title: '查清登录态在哪一层丢失',
  purpose: '定位 401 只在特定分支复现的原因',
  inputs: ['maker-r3.report.md 第 2 节'],
  scope: '只读 src/auth 与相关测试，不改代码',
  deliverables: '一份 report.md 指出失效点与证据',
  done_when: '给出具体文件与行号，或明确说明证据不足',
  ...over,
});

test('AC-007: 常量面——角色 / 动作闭集 / tier / 包 id 正则', () => {
  // 并行委派把 digest（案卷压缩）与 worker（受派子任务）纳入同一份契约：
  // 少一个角色，内核派出它时 validateLog 直接返回「期望角色非法」，那一轮必然判失败。
  assert.deepEqual([...LOG_ROLES], ['router', 'spec', 'maker', 'reviewer', 'digest', 'worker']);
  // dispatch 是 router 的第四类动作（派 worker）；闭集缺它，routing.mjs 会把合法的 dispatch 决策当越界打回。
  assert.deepEqual([...ACTIONS], ['spec', 'plan', 'maker', 'dispatch', 'review', 'precommit', 'human', 'merge', 'abandon']);
  assert.deepEqual([...TIERS], ['unit', 'integration', 'e2e']);
  assert.equal(PACKAGE_ID_RE.test('P-001'), true);
  assert.equal(PACKAGE_ID_RE.test('P-1'), false);
  assert.equal(PACKAGE_ID_RE.test('p-001'), false);
  assert.equal(SUMMARY_MAX, 2000);
  // 三条新上限：guidance 逐字进 maker prompt，done/remaining 逐条进下一轮的续做说明——
  // 上限放开就等于让 agent 用 log 夹带整份文档，把 prompt 顶爆。
  assert.equal(GUIDANCE_MAX, 4000);
  assert.equal(PROGRESS_ITEMS_MAX, 60);
  assert.equal(PROGRESS_ITEM_MAX, 300);
});

test('AC-007: 六个角色的 happy path 全过', () => {
  assert.equal(validateLog(okRouter(), 'router').ok, true);
  assert.equal(validateLog(okSpec(), 'spec').ok, true);
  assert.equal(validateLog(okMaker(), 'maker').ok, true);
  assert.equal(validateLog(okReviewer(), 'reviewer').ok, true);
  // digest / worker 的最小 log 与其它角色同构：role + outcome + summary，别的一概不需要。
  assert.equal(validateLog(okDigest(), 'digest').ok, true);
  assert.equal(validateLog(okWorker(), 'worker').ok, true);
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
  // worker 是新角色，但 role 与派出角色的对齐规则没有例外：派 worker 写 maker 照样拒收。
  const cross = validateLog(okWorker({ role: 'maker' }), 'worker');
  assert.equal(cross.ok, false);
  assert.match(cross.errors.join(), /role 不匹配/);
});

test('AC-007: outcome 按角色限定', () => {
  assert.deepEqual([...OUTCOMES_BY_ROLE.router], ['ok']);
  assert.equal(validateLog(okRouter({ outcome: 'fail' }), 'router').ok, false, 'router 只能 ok');
  assert.equal(validateLog(okSpec({ outcome: 'needs_human' }), 'spec').ok, true);
  assert.equal(validateLog(okSpec({ outcome: 'fail' }), 'spec').ok, false, 'spec 不能 fail');
  assert.equal(validateLog(okMaker({ outcome: 'needs_human' }), 'maker').ok, true);
  // maker/reviewer 新增 partial：撞上限前写下的增量进度既不是完成也不是失败，
  // 判不出 partial，内核只能在「当没做」与「当失败」之间二选一，那一轮的进展会被整轮丢弃。
  assert.equal(validateLog(okMaker({ outcome: 'partial' }), 'maker').ok, true);
  assert.equal(validateLog(okReviewer({ outcome: 'partial' }), 'reviewer').ok, true);
  assert.equal(validateLog(okReviewer({ outcome: 'needs_human' }), 'reviewer').ok, false, 'reviewer 只能 ok|partial|fail');
  assert.equal(validateLog(okMaker({ outcome: undefined }), 'maker').ok, false, 'outcome 必填');

  // digest 只有成败两态：它不判产品、也没有「需要人」的口子。
  assert.deepEqual([...OUTCOMES_BY_ROLE.digest], ['ok', 'fail']);
  assert.equal(validateLog(okDigest({ outcome: 'fail' }), 'digest').ok, true);
  const digestHuman = validateLog(okDigest({ outcome: 'needs_human' }), 'digest');
  assert.equal(digestHuman.ok, false);
  assert.match(digestHuman.errors.join(), /outcome 取值非法/);

  // worker 五态最全：blocked（依赖失效，要 router 改计划）与 needs_human（要产品裁决）
  // 分得开，router 才知道该重派还是该开人工闸。
  assert.deepEqual([...OUTCOMES_BY_ROLE.worker], ['ok', 'partial', 'blocked', 'fail', 'needs_human']);
  for (const outcome of OUTCOMES_BY_ROLE.worker) {
    assert.equal(validateLog(okWorker({ outcome }), 'worker').ok, true, `worker outcome=${outcome} 应合法`);
  }
  // blocked 是 worker 独有的：maker 直接在任务分支上干活，卡住了只能 fail 或 needs_human。
  const makerBlocked = validateLog(okMaker({ outcome: 'blocked' }), 'maker');
  assert.equal(makerBlocked.ok, false);
  assert.match(makerBlocked.errors.join(), /outcome 取值非法/);
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
  // 新角色不因为是新的就拿到豁免：只有冷读过 diff 的 reviewer 才配声明测试层级。
  const workerTier = validateLog(okWorker({ tier: 'unit' }), 'worker');
  assert.equal(workerTier.ok, false);
  assert.match(workerTier.errors.join(), /tier 是 reviewer \/ router\(precommit\) 专属字段，worker 不得出现/);
  assert.equal(validateLog(okDigest({ tier: 'e2e' }), 'digest').ok, false, 'digest 出现 tier 即非法');
});

test('AC-007: action —— router 必填且在闭集内；其余角色出现即非法', () => {
  assert.equal(validateLog({ role: 'router', outcome: 'ok', summary: 's' }, 'router').ok, false);
  for (const a of ACTIONS) {
    // precommit 要 tier、dispatch 要 assignments：这两个动作各自带一份必填载荷，
    // 缺了就不是「router 选了个动作」而是「router 没说清要干什么」。
    let obj = okRouter({ action: a });
    if (a === 'precommit') obj = okRouter({ action: a, tier: 'unit' });
    if (a === 'dispatch') obj = okRouter({ action: a, assignments: [assignment()] });
    assert.equal(validateLog(obj, 'router').ok, true, `action=${a} 应合法`);
  }
  const bad = validateLog(okRouter({ action: 'close' }), 'router');
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /action 不在闭集内/);
  assert.equal(validateLog(okMaker({ action: 'maker' }), 'maker').ok, false, 'maker 出现 action 即非法');
  const workerAction = validateLog(okWorker({ action: 'dispatch' }), 'worker');
  assert.equal(workerAction.ok, false, 'worker 不得自己声明下一步动作——派活是 router 的事');
  assert.match(workerAction.errors.join(), /action 是 router 专属字段，worker 不得出现/);
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

  // dispatch 同理：工作包是 maker 的分工维度，worker 的范围写在 assignments 里，两套不能混。
  const onDispatch = validateLog(
    okRouter({ action: 'dispatch', assignments: [assignment()], packages: ['P-001'] }), 'router', ctx,
  );
  assert.equal(onDispatch.ok, false);
  assert.match(onDispatch.errors.join(), /只在 action=maker 时合法/);

  // AC-033/035/044：无方案（含 --no-packages、packagesEnabled=false）任务出现 packages 即非法
  const noPlan = validateLog(okRouter({ action: 'maker', packages: ['P-001'] }), 'router', { planActive: false });
  assert.equal(noPlan.ok, false);
  assert.match(noPlan.errors.join(), /无生效方案/);
  assert.equal(validateLog(okRouter({ action: 'maker' }), 'router', { planActive: false }).ok, true);

  // 非 router 角色一律不得出现
  assert.equal(validateLog(okMaker({ packages: ['P-001'] }), 'maker', ctx).ok, false);
});

// ---- 并行委派带来的三组新字段：assignments / guidance / done-remaining ----

test('assignments —— router 的 dispatch 必填，其余动作与其余角色出现即非法', () => {
  assert.equal(validateLog(okRouter({ action: 'dispatch', assignments: [assignment()] }), 'router').ok, true);
  assert.equal(validateLog(okRouter({
    action: 'dispatch',
    assignments: [assignment(), assignment({ key: 'auth-fix', profile: 'write', intent: 'fix', paths: ['src/auth/**'] })],
  }), 'router').ok, true, '一次派多个是 dispatch 的常态');

  // 缺 assignments 的 dispatch 等于「派了活但没说是什么活」：内核无法准备工作目录，也无法写台账。
  const missing = validateLog(okRouter({ action: 'dispatch' }), 'router');
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /dispatch 必须带非空的 assignments 数组/);

  // 非 dispatch 动作带 assignments：router 想绕过 dispatch 的台账与隔离直接指挥 maker，拒收。
  for (const action of ['maker', 'review', 'merge', 'human']) {
    const r = validateLog(okRouter({ action, assignments: [assignment()] }), 'router');
    assert.equal(r.ok, false, `action=${action} 不得带 assignments`);
    assert.match(r.errors.join(), /assignments 只在 action=dispatch 时合法/);
  }

  // 非 router 角色带 assignments：worker 自己派 worker，内核的并发与预算闸门就形同虚设。
  for (const [role, log] of [['maker', okMaker()], ['worker', okWorker()], ['reviewer', okReviewer()], ['spec', okSpec()], ['digest', okDigest()]]) {
    const r = validateLog({ ...log, assignments: [assignment()] }, role);
    assert.equal(r.ok, false, `${role} 不得带 assignments`);
    assert.match(r.errors.join(), new RegExp(`assignments 是 router 专属字段，${role} 不得出现`));
  }
});

test('assignments 载荷非法 → 整条 router log 非法，且委派契约的原话原样浮上来', () => {
  // log 契约把 assignments 的判决整份委托给 lib/assignment-contract.mjs：
  // 错误文案必须逐字透出，否则 agent 在 Stop hook 里只看到「log 非法」，不知道改哪个字段。
  const badKey = validateLog(
    okRouter({ action: 'dispatch', assignments: [assignment({ key: 'auth-r2' })] }), 'router',
  );
  assert.equal(badKey.ok, false);
  assert.match(badKey.errors.join(), /assignments\[0\]\.key 非法/);
  assert.match(badKey.errors.join(), /不得以 r<数字> 结尾/);

  const badProfile = validateLog(
    okRouter({ action: 'dispatch', assignments: [assignment({ profile: 'admin' })] }), 'router',
  );
  assert.equal(badProfile.ok, false);
  assert.match(badProfile.errors.join(), /assignments\[0\]\.profile 取值非法/);

  const tooMany = validateLog(okRouter({
    action: 'dispatch',
    assignments: Array.from({ length: 9 }, (_, i) => assignment({ key: `probe-${i}` })),
  }), 'router');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join(), /assignments 一次最多 8 个/);

  // 形态本身就不对（非数组 / 空数组 / 非对象元素）也一样拦在 log 这一层。
  for (const payload of [[], 'x', {}, null, [null], [42]]) {
    assert.equal(
      validateLog(okRouter({ action: 'dispatch', assignments: payload }), 'router').ok,
      false,
      `assignments=${JSON.stringify(payload)} 应判非法`,
    );
  }
});

test('guidance —— 只在 router 的 action=maker 时合法，非空且 ≤ GUIDANCE_MAX', () => {
  assert.equal(validateLog(okRouter({ action: 'maker', guidance: '先补 AC-003 的边界用例，再动实现' }), 'router').ok, true);
  assert.equal(validateLog(okRouter({ action: 'maker', guidance: 'a'.repeat(GUIDANCE_MAX) }), 'router').ok, true);

  // 超长 / 空白 / 非字符串：guidance 逐字进 maker 的 prompt，这三种都会让 prompt 里出现
  // 一段无意义或超预算的注入文本。
  for (const bad of ['a'.repeat(GUIDANCE_MAX + 1), '', '   ', 42, ['x'], null]) {
    const r = validateLog(okRouter({ action: 'maker', guidance: bad }), 'router');
    assert.equal(r.ok, false, `guidance=${JSON.stringify(bad)} 应判非法`);
    assert.match(r.errors.join(), new RegExp(`guidance 须为非空字符串，≤ ${GUIDANCE_MAX} 字符`));
  }

  // 其它动作不接受 guidance：多任务的具体指导有 assignments 那套结构化字段，不走这条自由文本口子。
  for (const extra of [{ action: 'dispatch', assignments: [assignment()] }, { action: 'review' }, { action: 'precommit', tier: 'unit' }]) {
    const r = validateLog(okRouter({ ...extra, guidance: '顺手把这个也改了' }), 'router');
    assert.equal(r.ok, false, `action=${extra.action} 不得带 guidance`);
    assert.match(r.errors.join(), /guidance 只在 router 的 action=maker 时合法/);
  }

  // 非 router 角色带 guidance = agent 给自己下指令，指导必须来自 router。
  for (const [role, log] of [['maker', okMaker()], ['worker', okWorker()], ['spec', okSpec()], ['digest', okDigest()]]) {
    const r = validateLog({ ...log, guidance: '照我说的做' }, role);
    assert.equal(r.ok, false, `${role} 不得带 guidance`);
    assert.match(r.errors.join(), /guidance 只在 router 的 action=maker 时合法/);
  }
});

test('done / remaining —— 只有 maker 与 worker 能写进度清单', () => {
  assert.equal(validateLog(okMaker({ outcome: 'partial', done: ['AC-001 已绿'], remaining: ['AC-002 未起'] }), 'maker').ok, true);
  assert.equal(validateLog(okWorker({ outcome: 'partial', done: [], remaining: ['查 refresh token 分支'] }), 'worker').ok, true,
    '空数组合法：明确说「这一项没有」与漏写不是一回事');
  assert.equal(validateLog(okMaker({ done: Array(PROGRESS_ITEMS_MAX).fill('x') }), 'maker').ok, true);
  assert.equal(validateLog(okWorker({ remaining: ['y'.repeat(PROGRESS_ITEM_MAX)] }), 'worker').ok, true);

  // 下一轮的续做说明由这两份清单逐条拼出：不是字符串数组 / 条数或长度超限，
  // 要么拼不出来，要么把 prompt 顶爆——两种都会让「续做」退化成「重做」。
  const shapes = [
    'AC-001 已绿',
    [123],
    [''],
    ['  '],
    [{ ac: 'AC-001' }],
    Array(PROGRESS_ITEMS_MAX + 1).fill('x'),
    ['y'.repeat(PROGRESS_ITEM_MAX + 1)],
    null,
  ];
  for (const field of ['done', 'remaining']) {
    for (const bad of shapes) {
      const r = validateLog(okMaker({ [field]: bad }), 'maker');
      assert.equal(r.ok, false, `${field}=${JSON.stringify(bad)} 应判非法`);
      assert.match(r.errors.join(), new RegExp(`${field} 须为字符串数组（≤ ${PROGRESS_ITEMS_MAX} 项，每项 ≤ ${PROGRESS_ITEM_MAX} 字符）`));
    }
  }

  // 只有真正在改东西的角色才有「做完/没做完」：router 写进度就是把自己的路由理由伪装成执行证据。
  for (const [role, log] of [['router', okRouter()], ['reviewer', okReviewer()], ['spec', okSpec()], ['digest', okDigest()]]) {
    for (const field of ['done', 'remaining']) {
      const r = validateLog({ ...log, [field]: ['x'] }, role);
      assert.equal(r.ok, false, `${role} 不得带 ${field}`);
      assert.match(r.errors.join(), new RegExp(`${field} 是 maker / worker 专属字段，${role} 不得出现`));
    }
  }
});

test('digest / worker —— 最小 log 形态与越界字段', () => {
  // digest 的职责是把案卷压成一页事实，它不路由、不判产品：
  // 除 role/outcome/summary 外任何字段都属于越权。
  assert.equal(validateLog(okDigest(), 'digest').ok, true);
  for (const extra of [{ action: 'review' }, { tier: 'unit' }, { packages: ['P-001'] }, { done: ['x'] }, { guidance: 'g' }]) {
    assert.equal(validateLog(okDigest(extra), 'digest').ok, false, `digest 带 ${Object.keys(extra)[0]} 应判非法`);
  }
  assert.equal(validateLog(okDigest({ summary: '' }), 'digest').ok, false, 'digest 也要留摘要：压缩结果得有结论');

  // worker 比 digest 多且只多一对进度清单。
  assert.equal(validateLog(okWorker({ done: ['读完 src/auth'], remaining: [] }), 'worker').ok, true);
  for (const extra of [{ action: 'dispatch' }, { tier: 'unit' }, { packages: ['P-001'] }, { assignments: [assignment()] }]) {
    assert.equal(validateLog(okWorker(extra), 'worker').ok, false, `worker 带 ${Object.keys(extra)[0]} 应判非法`);
  }
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
  // 新字段进了白名单，但白名单本身仍是闭集：拼错一个字母（assignment / guidences）照样拒收，
  // 免得 router 以为自己派出去了、内核却什么都没读到。
  for (const field of ['assignment', 'guidences', 'todo', 'progress']) {
    const r = validateLog(okRouter({ action: 'dispatch', assignments: [assignment()], [field]: ['x'] }), 'router');
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

// precommit 记录不共用 agent 的字段白名单：内核自己合成的那条记录里，
// 并行委派的新字段一个都不该出现，否则等于内核在自己的记录里伪造 agent 行为。
test('AC-011: precommit 记录不接受 agent 的新字段（assignments / guidance / done）', () => {
  for (const field of ['assignments', 'guidance', 'done', 'remaining', 'action', 'packages']) {
    const r = validateLog(precommitRecord({ [field]: ['x'] }), 'precommit');
    assert.equal(r.ok, false, `precommit 带 ${field} 应判非法`);
    assert.match(r.errors.join(), /未知字段/);
  }
});
