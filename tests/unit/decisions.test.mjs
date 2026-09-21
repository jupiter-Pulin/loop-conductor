// decisions.mjs 单测：router 纪元剩下的常量与两个零 IO 纯判据，
// 外加 AC-001 / AC-005 的静态执法（stage 集合封闭、内核自发转移只有八条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES, HUMAN_GATE_KINDS, overBudget, parseStrictJson, parseNumstat,
} from '../../conductor/stages/decisions.mjs';
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_FOR_DECISIONS = pathSync.resolve(pathSync.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('overBudget：达到上限即拒绝', () => {
  assert.equal(overBudget(0, 5), false);
  assert.equal(overBudget(4.99, 5), false);
  assert.equal(overBudget(5, 5), true);
  assert.equal(overBudget(5.01, 5), true);
  assert.equal(overBudget(null, 5), false);
  assert.equal(overBudget(undefined, 0), true);
});

test('parseStrictJson：只认严格 JSON，不在叙事里打捞', () => {
  assert.deepEqual(parseStrictJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStrictJson('  {"a":1} '), { a: 1 });
  assert.deepEqual(parseStrictJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStrictJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStrictJson('[1,2,3]'), [1, 2, 3]);
  assert.equal(parseStrictJson('我认为可以通过。{"a":1}'), null);
  assert.equal(parseStrictJson('not json'), null);
  assert.equal(parseStrictJson(null), null);
  assert.equal(parseStrictJson(123), null);
});

test('parseNumstat：行数累加、二进制行只计数不累加、空行与空路径跳过', () => {
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.mjs\n0\t7\tsrc/b.mjs\n'), {
    total_lines: 11, files: ['src/a.mjs', 'src/b.mjs'], binary: 0,
  });
  assert.deepEqual(parseNumstat('-\t-\tassets/logo.png\n2\t0\tsrc/a.mjs'), {
    total_lines: 2, files: ['assets/logo.png', 'src/a.mjs'], binary: 1,
  });
  assert.deepEqual(parseNumstat(''), { total_lines: 0, files: [], binary: 0 });
  assert.deepEqual(parseNumstat(null), { total_lines: 0, files: [], binary: 0 });
});

test('AC-001：STAGES 恰好是新状态机的四个 stage；人闸种类封闭为三种', () => {
  assert.deepEqual([...STAGES], ['ROUTING', 'AWAIT_HUMAN', 'FAILED_BOX', 'DONE']);
  assert.deepEqual([...HUMAN_GATE_KINDS], ['spec', 'merge', 'help']);
  // 遗留 stage 名一个都不许回来：它们没有 handler，只在 queue 里被跳过并警告。
  for (const gone of ['READY', 'VERIFY', 'FIXING', 'NEEDS_SPEC', 'AWAIT_SPEC_APPROVAL', 'AWAIT_HUMAN_MERGE']) {
    assert.equal(STAGES.includes(gone), false, `${gone} 应已删除`);
  }
});

// ---- AC-005：内核自行发起的 stage 转移只有八条 ----
//
// 这条 AC 的执法方式是「枚举全部转移调用点，与八条对照」。做法是静态扫两组文件：内核侧
// （stages/*，含 shared.mjs 的限额收箱与全部动作文件）与人闸侧（conductor.mjs 的 approve /
// reject / resume / retry / abandon）。任何人在内核里新写一处 `state.transitionState(` 或
// `failToBox(`，这个测试就会红——红了不是坏事，它逼着人回答一句「这条新转移是八条里的哪一条，
// 还是第九条？第九条要先改 spec」。**改不动就把数字调大**是最糟的修法：那等于把这份枚举废掉。
//
// 八条（router 纪元的现状，括号里是落点）：
//   1. spec 交付通过机械校验              → AWAIT_HUMAN(spec)             actions/spec.mjs
//   2. 任何 spawn 命中限额                → FAILED_BOX(rate_limited)      shared.mjs::rateLimitedToBox
//   3. 同签名连击保险丝                   → FAILED_BOX(fuse_no_progress)  router-kernel::checkFuseAndBox
//   4. 停滞保险丝（连续无硬进展）【新增】  → FAILED_BOX(fuse_no_progress)  router-kernel::checkStallAndBox
//   5. 整任务轮次上限【新增】             → FAILED_BOX(round_cap)         router-kernel::checkRoundCapAndBox
//   6. 预算耗尽                          → FAILED_BOX(budget_exhausted)  router-kernel::checkBudgetAndBox
//   7. 内核请人裁决                       → AWAIT_HUMAN(help, requested_by=kernel)，三个触发口：
//        · router 连续失效        routing.mjs::registerFailure
//        · 获批 spec 被动过【新增】 routing.mjs::guardApprovedSpec（事件 spec_tampered）
//        · 执行越过授权边界【新增】 actions/maker.mjs 与 actions/dispatch.mjs 的 verifyProtected
//                                （事件 boundary_violation）
//   8. 人批准 merge 后版本规则复算通过     → DONE                          conductor.mjs
//
// 注意两个「8」不是同一个集合，数目相同纯属巧合：上面是**语义清单**，下面断言的是**调用点**。
// 调用点少于语义条数的地方（第 7 条三个触发口共用 openHumanGate 一张嘴），也有语义清单里没有、
// 但确实存在的调用点（routing.mjs 的 abandon 是 router 动作触发，不算内核自发）。
//
// 分类口径：**人触发的转移单独归类，不计入八条**——人闸回 ROUTING、human abandon、两处 retry
// 都是人点出来的，内核只是执行。八条里唯一落在 conductor.mjs 的是「merge 批准 → DONE」：
// 人点的是「同意合并」，转移本身由内核在版本规则复算通过后自行落。
// 绕过 transitionState 直接 `Object.assign(runtime,{stage})` 的写法一律不许再出现——那样
// timeline 与 stage 事件都不会写，本测试也扫不到，等于在枚举面上开了个洞。

/** 内核侧文件：这里出现的每一个转移点都必须能对上八条之一，或对上 router 的动作。 */
const KERNEL_FILES = [
  'conductor/stages/routing.mjs',
  'conductor/stages/await_human.mjs',
  'conductor/stages/actions/spec.mjs',
  'conductor/stages/actions/maker.mjs',
  'conductor/stages/actions/review.mjs',
  'conductor/stages/actions/precommit.mjs',
  'conductor/stages/actions/dispatch.mjs',
  'conductor/stages/actions/digest.mjs',
  'conductor/stages/router-kernel.mjs',
  'conductor/stages/shared.mjs',
];

/** 人闸侧文件：CLI 的五个动词各自的转移点。 */
const HUMAN_FILES = ['conductor/conductor.mjs'];

/** 纯常量 / 纯判据，构造上不可能转移 stage（它连 ts 都拿不到）。 */
const STAGES_NON_KERNEL = ['conductor/stages/decisions.mjs'];

test('AC-005：KERNEL_FILES 覆盖 conductor/stages 下的每一个文件（枚举不许漏网）', () => {
  // 上面那张转移点表是按**文件名枚举**执法的：新写一个 actions/xxx.mjs 却忘了加进 KERNEL_FILES，
  // 它里面的 transitionState 就永远扫不到，枚举面上等于开了个洞（dispatch / digest 这两个动作
  // 就是这么加进来的）。所以先把「文件集合本身」钉死：stages 下多一个文件，这里先红。
  const walk = (dir, prefix) => fsSync.readdirSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`, `${prefix}${e.name}/`) : (e.name.endsWith('.mjs') ? [`${dir}/${e.name}`] : [])));
  const found = walk('conductor/stages', '').sort();
  assert.deepEqual(
    found,
    [...KERNEL_FILES, ...STAGES_NON_KERNEL].sort(),
    `conductor/stages 下的文件集合变了。新文件要么加进 KERNEL_FILES（然后补它的转移点断言），`
    + `要么加进 STAGES_NON_KERNEL（前提是它构造上就拿不到 ts / cfg）。实际扫到：\n${found.map((f) => `  ${f}`).join('\n')}`,
  );
});

const readRel = (rel) => fsSync.readFileSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, rel), 'utf8');
const lineOf = (body, index) => body.slice(0, index).split('\n').length;

/**
 * 扫一个文件里的全部转移点。目标 stage 是字面量就记字面量，是变量就记 `<变量名>`
 * （限额 retry 回的是 `runtime.rate_limit.resume_stage` 记下的那个 stage，不是硬编码）。
 * `failToBox` 是 FAILED_BOX 的唯一封装口，调用点一并计入；它自己的函数声明不算转移。
 */
function scanTransitions(rel) {
  const body = readRel(rel);
  const sites = [];
  for (const m of body.matchAll(/state\.transitionState\(\s*ts,\s*cfg,\s*(?:'([A-Z_]+)'|([A-Za-z_$][\w$]*))/g)) {
    sites.push({ file: rel, line: lineOf(body, m.index), stage: m[1] ?? `<${m[2]}>`, via: 'transitionState' });
  }
  for (const m of body.matchAll(/(?<!function\s)failToBox\(\s*ts,\s*cfg,/g)) {
    sites.push({ file: rel, line: lineOf(body, m.index), stage: 'FAILED_BOX', via: 'failToBox' });
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** 失败时人要看的东西：到底是哪个文件哪一行多出来 / 少掉了一个转移点。 */
function inventory(sites) {
  return sites.length === 0
    ? '（无）'
    : sites.map((s) => `  ${s.file}:${s.line}  → ${s.stage}  via ${s.via}`).join('\n');
}

const stagesOf = (sites, rel) => sites.filter((s) => s.file === rel).map((s) => s.stage);

test('AC-005：内核侧 transitionState / failToBox 的调用点与八条自发转移一一对应', () => {
  const sites = KERNEL_FILES.flatMap(scanTransitions);
  const listing = inventory(sites);

  // router-kernel.mjs：openHumanGate（spec / merge / help 三种闸共用一处）与四根熔断收箱。
  // 四根保险丝各自独立：同签名连击、停滞（无硬进展）、轮次上限、预算——少一处就有一类失控
  // 场景再也停不下来，所以这里逐一点名，不只数个数。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/router-kernel.mjs'),
    ['AWAIT_HUMAN', 'FAILED_BOX', 'FAILED_BOX', 'FAILED_BOX', 'FAILED_BOX'],
    `router-kernel 只有：开人闸 1 处 + 收箱 4 处（同签名保险丝 / 停滞保险丝 / 轮次上限 / 预算）\n${listing}`,
  );
  const kernelBody = readRel('conductor/stages/router-kernel.mjs');
  for (const [fn, failureType] of [
    ['checkFuseAndBox', 'fuse_no_progress'],
    ['checkStallAndBox', 'fuse_no_progress'],
    ['checkRoundCapAndBox', 'round_cap'],
    ['checkBudgetAndBox', 'budget_exhausted'],
  ]) {
    const seg = kernelBody.slice(kernelBody.indexOf(`export function ${fn}(`));
    assert.notEqual(seg, '', `${fn} 应存在于 router-kernel.mjs`);
    const end = seg.indexOf('\nexport function ', 1);
    const bodyOfFn = end === -1 ? seg : seg.slice(0, end);
    assert.match(bodyOfFn, /failToBox\(/, `${fn} 必须经 failToBox 收箱`);
    assert.ok(
      bodyOfFn.includes(`'${failureType}'`),
      `${fn} 的 last_failure_type 必须是 ${failureType}（人靠它判断能不能 retry）`,
    );
  }

  // shared.mjs：failToBox 的实现本体 1 处 + 限额收箱 1 处（rateLimitedToBox）。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/shared.mjs'),
    ['FAILED_BOX', 'FAILED_BOX'],
    `shared 只有：限额收箱 + failToBox 的实现本体\n${listing}`,
  );
  // routing.mjs：abandon 一处收箱（router 动作触发，不算内核自发）。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/routing.mjs'),
    ['FAILED_BOX'],
    `routing 自己只在 abandon 处收箱，其余转移都走 router-kernel 的封装\n${listing}`,
  );
  // 六个动作文件本身不转移 stage：它们只产生记录 / 产物，去向由 routing 与 router-kernel 决定。
  // dispatch 与 digest 是后加的动作，同样必须守这条线——它们要收箱就走 rateLimitedToBox，
  // 要停下等人就走 openHumanGate，绝不自己写 stage。
  for (const rel of [
    'conductor/stages/actions/maker.mjs',
    'conductor/stages/actions/review.mjs',
    'conductor/stages/actions/precommit.mjs',
    'conductor/stages/actions/spec.mjs',
    'conductor/stages/actions/dispatch.mjs',
    'conductor/stages/actions/digest.mjs',
  ]) {
    assert.deepEqual(
      sites.filter((s) => s.file === rel),
      [],
      `${rel} 不该自己转移 stage：收箱走 rateLimitedToBox，停下等人走 openHumanGate\n${listing}`,
    );
  }
  // 反面还不够：两个新动作必须真的接在封装上，否则「零转移点」也可能是「根本停不下来」。
  assert.match(readRel('conductor/stages/actions/dispatch.mjs'), /rateLimitedToBox\(ts, cfg, 'worker'/);
  assert.match(readRel('conductor/stages/actions/digest.mjs'), /rateLimitedToBox\(ts, cfg, 'digest'/);
  // await_human 是停车位：一次转移都没有。
  assert.deepEqual(sites.filter((s) => s.file === 'conductor/stages/await_human.mjs'), []);

  assert.equal(
    sites.length, 8,
    `内核侧总共只有这 8 个转移点。现在扫到 ${sites.length} 个：\n${listing}\n`
    + '多出来的那个属于八条里的哪一条？如果是第九条，先改 spec 再改这个数字。',
  );
});

/**
 * AWAIT_HUMAN 的唯一入口是 openHumanGate；谁在调它 = 内核会在哪些情形下停下来等人。
 * 这张表和上面的转移点表是互补的：上面数的是「转移落在哪」，这里数的是「为什么要停」——
 * 新加一道人闸不会改变转移点总数（都挤在 openHumanGate 那一处 transitionState 里），
 * 只会在这张表上多出一行，所以两张表都要枚举，少一张就漏得掉。
 */
function scanHumanGates(rel) {
  const body = readRel(rel);
  return [...body.matchAll(/(?<!function\s)openHumanGate\(\s*ts,\s*cfg,\s*\{\s*kind:\s*'(\w+)'/g)]
    .map((m) => ({ file: rel, line: lineOf(body, m.index), kind: m[1] }))
    .sort((a, b) => a.line - b.line);
}

test('AC-012：openHumanGate 的调用点恰好是三种闸的七个入口', () => {
  const gates = KERNEL_FILES.flatMap(scanHumanGates);
  const listing = gates.length === 0
    ? '（无）'
    : gates.map((g) => `  ${g.file}:${g.line}  kind=${g.kind}`).join('\n');

  assert.deepEqual(
    gates.map((g) => `${g.file}:${g.kind}`),
    [
      'conductor/stages/routing.mjs:help', // registerFailure：router 连续失效，裁判缺席
      'conductor/stages/routing.mjs:help', // executeAction：router 自己选了 human 动作
      'conductor/stages/routing.mjs:merge', // executeAction：router 选 merge，版本规则已过
      'conductor/stages/routing.mjs:help', // guardApprovedSpec：获批 spec 的冻结稿被动过
      'conductor/stages/actions/spec.mjs:spec', // spec 交付通过机械校验，送人审
      'conductor/stages/actions/maker.mjs:help', // maker 越过授权边界，已还原 / 隔离
      'conductor/stages/actions/dispatch.mjs:help', // worker 越过授权边界，已还原 / 隔离
    ],
    `内核停下等人的入口恰好这七处（按文件与行号）。现在扫到 ${gates.length} 处：\n${listing}\n`
    + '多一处 = 多一种「内核会卡住等人」的情形，必须有人确认它不是死锁。',
  );
  // kind 必须落在封闭集合里：HUMAN_GATE_KINDS 之外的 kind 进了 runtime.awaiting，
  // CLI 的 approve / reject / resume 都认不出来，任务就永远出不了 AWAIT_HUMAN。
  for (const g of gates) {
    assert.ok(HUMAN_GATE_KINDS.includes(g.kind), `${g.file}:${g.line} 的 kind=${g.kind} 不在闭集内`);
  }
  // 内核自发的那几道闸必须标明 requested_by: kernel（人在闸上要分得清是谁把它叫来的）。
  assert.match(readRel('conductor/stages/routing.mjs'), /kind: 'help',\s*\n\s*requestedBy: 'kernel'/);
  assert.match(readRel('conductor/stages/actions/spec.mjs'), /kind: 'spec',\s*\n\s*requestedBy: 'kernel'/);
});

test('AC-005：人闸侧（approve / reject / resume / retry / abandon）的转移点单独归类', () => {
  const sites = HUMAN_FILES.flatMap(scanTransitions);

  assert.deepEqual(
    sites.map((s) => `${s.stage}:${s.via}`),
    [
      'ROUTING:transitionState', // backToRouting：spec 批准 / spec|merge 打回 / help resume 共用
      'DONE:transitionState', // merge 批准 —— 八条里唯一落在 CLI 侧的一条
      'FAILED_BOX:transitionState', // human abandon
      '<stage>:transitionState', // 限额 retry：回 rate_limit.resume_stage 记下的 stage
      'ROUTING:transitionState', // 保险丝 / 预算 / 轮次上限 / abandoned 的 retry
    ],
    `人闸侧的转移点恰好这五处，且全部走 transitionState（不许 Object.assign 绕行）\n${inventory(sites)}`,
  );
  // 绕行写法的静态执法：runtime 上的 stage 只许由 transitionState 写。
  const body = readRel(HUMAN_FILES[0]);
  assert.equal(
    /Object\.assign\(\s*ts\.runtime\s*,\s*\{[^}]*stage/.test(body),
    false,
    'stage 不许绕过 transitionState 直接写进 runtime',
  );
});
