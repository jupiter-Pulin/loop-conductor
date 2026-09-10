// decisions.mjs 单测：router 纪元剩下的常量与两个零 IO 纯判据，
// 外加 AC-001 / AC-005 的静态执法（stage 集合封闭、内核自发转移只有六条）。
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

// ---- AC-005：内核自行发起的 stage 转移只有六条 ----
//
// 这条 AC 的执法方式是「枚举全部 transitionState 调用点，与六条对照」。做法是静态扫两组文件：
// 内核侧（stages/*，含 shared.mjs 的限额收箱）与人闸侧（conductor.mjs 的 approve / reject /
// resume / retry / abandon）。多出一个调用点，这个测试就该红。
//
// 分类口径：**人触发的转移单独归类，不计入六条**——人闸回 ROUTING、human abandon、两处 retry
// 都是人点出来的，内核只是执行。六条里唯一落在 conductor.mjs 的是「merge 批准 → DONE」：
// 人点的是「同意合并」，转移本身由内核在版本规则复算通过后自行落。
// 绕过 transitionState 直接 `Object.assign(runtime,{stage})` 的写法一律不许再出现——那样
// timeline 与 stage 事件都不会写，本测试也扫不到，等于在枚举面上开了个洞。

/** 内核侧文件：这里出现的每一个转移点都必须能对上六条之一，或对上 router 的动作。 */
const KERNEL_FILES = [
  'conductor/stages/routing.mjs',
  'conductor/stages/await_human.mjs',
  'conductor/stages/actions/spec.mjs',
  'conductor/stages/actions/maker.mjs',
  'conductor/stages/actions/review.mjs',
  'conductor/stages/actions/precommit.mjs',
  'conductor/stages/router-kernel.mjs',
  'conductor/stages/shared.mjs',
];

/** 人闸侧文件：CLI 的五个动词各自的转移点。 */
const HUMAN_FILES = ['conductor/conductor.mjs'];

/**
 * 扫一个文件里的全部转移点。目标 stage 是字面量就记字面量，是变量就记 `<变量名>`
 * （限额 retry 回的是 `runtime.rate_limit.resume_stage` 记下的那个 stage，不是硬编码）。
 * `failToBox` 是 FAILED_BOX 的唯一封装口，调用点一并计入；它自己的函数声明不算转移。
 */
function scanTransitions(rel) {
  const body = fsSync.readFileSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, rel), 'utf8');
  const sites = [];
  for (const m of body.matchAll(/state\.transitionState\(\s*ts,\s*cfg,\s*(?:'([A-Z_]+)'|([A-Za-z_$][\w$]*))/g)) {
    sites.push({ file: rel, stage: m[1] ?? `<${m[2]}>`, via: 'transitionState' });
  }
  for (const m of body.matchAll(/(?<!function\s)failToBox\(\s*ts,\s*cfg,/g)) {
    void m;
    sites.push({ file: rel, stage: 'FAILED_BOX', via: 'failToBox' });
  }
  return sites;
}

const stagesOf = (sites, rel) => sites.filter((s) => s.file === rel).map((s) => s.stage);

test('AC-005：内核侧 transitionState 的调用点与六条自发转移一一对应', () => {
  const sites = KERNEL_FILES.flatMap(scanTransitions);

  // router-kernel.mjs：openHumanGate（spec / merge / help 三种闸共用一处）与保险丝 / 预算收箱。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/router-kernel.mjs').sort(),
    ['AWAIT_HUMAN', 'FAILED_BOX', 'FAILED_BOX'],
    'router-kernel 只有：开人闸 1 处 + 保险丝收箱 + 预算收箱',
  );
  // shared.mjs：failToBox 的实现本体 1 处 + 限额收箱 1 处（rateLimitedToBox）。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/shared.mjs'),
    ['FAILED_BOX', 'FAILED_BOX'],
    'shared 只有：failToBox 的实现本体 + 限额收箱',
  );
  // routing.mjs：abandon 一处收箱（router 动作触发，不算内核自发）。
  assert.deepEqual(
    stagesOf(sites, 'conductor/stages/routing.mjs'),
    ['FAILED_BOX'],
    'routing 自己只在 abandon 处收箱，其余转移都走 router-kernel 的封装',
  );
  // 四个动作文件本身不转移 stage：它们只产生记录，去向由 routing / router-kernel 决定。
  for (const rel of ['conductor/stages/actions/maker.mjs', 'conductor/stages/actions/review.mjs', 'conductor/stages/actions/precommit.mjs']) {
    assert.deepEqual(sites.filter((s) => s.file === rel), [], `${rel} 不该自己转移 stage`);
  }
  // spec 动作唯一的转移是「通过校验 → AWAIT_HUMAN(spec)」，且走 openHumanGate。
  assert.deepEqual(sites.filter((s) => s.file === 'conductor/stages/actions/spec.mjs'), []);
  assert.match(
    fsSync.readFileSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, 'conductor/stages/actions/spec.mjs'), 'utf8'),
    /openHumanGate\(ts, cfg, \{\s*\n\s*kind: 'spec'/,
  );
  // await_human 是停车位：一次转移都没有。
  assert.deepEqual(sites.filter((s) => s.file === 'conductor/stages/await_human.mjs'), []);
  assert.equal(sites.length, 6, '内核侧总共只有这 6 个转移点');
});

test('AC-005：人闸侧（approve / reject / resume / retry / abandon）的转移点单独归类', () => {
  const sites = HUMAN_FILES.flatMap(scanTransitions);

  assert.deepEqual(
    sites.map((s) => `${s.stage}:${s.via}`),
    [
      'ROUTING:transitionState', // backToRouting：spec 批准 / spec|merge 打回 / help resume 共用
      'DONE:transitionState', // merge 批准 —— 六条里唯一落在 CLI 侧的一条
      'FAILED_BOX:transitionState', // human abandon
      '<stage>:transitionState', // 限额 retry：回 rate_limit.resume_stage 记下的 stage
      'ROUTING:transitionState', // 保险丝 / 预算 / abandoned 的 retry
    ],
    '人闸侧的转移点恰好这五处，且全部走 transitionState（不许 Object.assign 绕行）',
  );
  // 绕行写法的静态执法：runtime 上的 stage 只许由 transitionState 写。
  const body = fsSync.readFileSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, HUMAN_FILES[0]), 'utf8');
  assert.equal(
    /Object\.assign\(\s*ts\.runtime\s*,\s*\{[^}]*stage/.test(body),
    false,
    'stage 不许绕过 transitionState 直接写进 runtime',
  );
});
