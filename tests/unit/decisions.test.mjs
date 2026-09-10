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
// 这条 AC 的执法方式是「枚举全部 transitionState 调用点，与六条对照」。做法是静态扫新状态机
// 的文件（stages/routing.mjs、await_human.mjs、actions/*、conductor.mjs 的人闸与 retry 面），
// 把每个调用点的目标 stage 与它所在的函数记下来——多出一个调用点，这个测试就该红。

test('AC-005：新状态机里 transitionState 的调用点与六条自发转移一一对应', () => {
  const files = [
    'conductor/stages/routing.mjs',
    'conductor/stages/await_human.mjs',
    'conductor/stages/actions/spec.mjs',
    'conductor/stages/actions/maker.mjs',
    'conductor/stages/actions/review.mjs',
    'conductor/stages/actions/precommit.mjs',
    'conductor/stages/router-kernel.mjs',
  ];
  const sites = [];
  for (const rel of files) {
    const body = fsSync.readFileSync(pathSync.join(REPO_ROOT_FOR_DECISIONS, rel), 'utf8');
    for (const m of body.matchAll(/state\.transitionState\(\s*ts,\s*cfg,\s*'([A-Z_]+)'/g)) {
      sites.push({ file: rel, stage: m[1] });
    }
    // failToBox 是 FAILED_BOX 的唯一封装口，一并计入。
    for (const m of body.matchAll(/failToBox\(\s*\n?\s*ts,\s*cfg,/g)) {
      sites.push({ file: rel, stage: 'FAILED_BOX', via: 'failToBox' });
    }
  }

  // router-kernel.mjs：openHumanGate（spec / merge / help 三种闸共用）与 checkFuse/checkBudget 的收箱。
  assert.deepEqual(
    sites.filter((s) => s.file === 'conductor/stages/router-kernel.mjs').map((s) => s.stage).sort(),
    ['AWAIT_HUMAN', 'FAILED_BOX', 'FAILED_BOX'],
    'router-kernel 只有：开人闸 1 处 + 保险丝收箱 + 预算收箱',
  );
  // routing.mjs：abandon 一处收箱（限额收箱在 shared.mjs::rateLimitedToBox，属既有 P0 面）。
  assert.deepEqual(
    sites.filter((s) => s.file === 'conductor/stages/routing.mjs').map((s) => s.stage),
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
});

