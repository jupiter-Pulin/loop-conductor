// 集成：test gate per-AC 定向探针（测试证据链 B 批）。
// maker 在 worktree 写 .will-workflow/ac-tests.json（AC→测试映射，harness exclude 覆盖），
// conductor 按映射在基线探针 worktree 逐条复跑并方向裁决：fail_on_baseline 基线必须红、
// pass_on_baseline 基线必须绿；映射缺失/非法降级 v1 suite 模式；guard_broken/unmapped/error
// 一律放行（单侧闸门不变）。覆盖 AC-007/008/009/010/011/012/013 + AC-004 嵌入段联动。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

// 奇数分支守卫测试：预埋 bug 只坏偶数分支，此套件在基线与修复后都绿（回归守卫方向）。
const GUARD_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.mjs';

test('median of odd-length array stays stable', () => {
  assert.equal(median([3, 1, 2]), 2);
});
`;

// 处处全绿的空转测试（vacuous 场景用）。
const TRIVIAL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';

test('trivially green', () => {
  assert.equal(1, 1);
});
`;

// 三条 AC 的 bugfix spec：新行为（单元）+ 回归守卫 + 不可自动化（不写映射条目）。
const SPEC_3AC = [
  '# median 修复与守卫',
  '',
  '## 验收标准',
  '',
  '- AC-001: median 偶数长度取中间两数平均。（验证级别：单元）',
  '- AC-002: median 奇数长度行为保持不变。（验证级别：回归守卫）',
  '- AC-003: README 描述与实现一致，人工核对。（验证级别：不可自动化）',
  '',
].join('\n');

const mappingJson = (entries) => JSON.stringify({ schema_version: 1, entries }, null, 2);

test('映射有效：逐 AC 定向探测 falsifies/guard_holds/unmapped，映射不进 diff 不进 merge（AC-004/007/008/012/013）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-801';
  env.writeTask(id, { bodyAc: SPEC_3AC });
  env.setScenario([
    { // maker r1：修 bug + 写守卫测试 + 写 AC→测试映射（不可自动化的 AC-003 不写条目）
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: 'test/guard.test.mjs', content: GUARD_TEST },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/stats.test.mjs', expect: 'fail_on_baseline' },
            { ac_id: 'AC-002', command: 'node --test test/guard.test.mjs', expect: 'pass_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 映射',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // AC-008：per-AC 模式产物完备，且不再跑 v1 全量基线复跑（exit_code 留 null、无 suite tail）
  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.schema_version, 1, '增量字段不升 schema_version');
  assert.equal(tg.mode, 'per-ac');
  assert.equal(tg.mapping_status, 'valid');
  assert.ok(!('mapping_errors' in tg), 'valid 时无 mapping_errors');
  assert.equal(tg.exit_code, null, 'per-AC 模式跳过全量基线复跑');
  assert.equal(tg.stdout_tail, '', '无全量复跑输出');
  assert.equal(tg.verdict, 'falsifies');
  assert.ok(tg.overlay.copied.includes('test/guard.test.mjs'), '新增测试文件照常叠加进基线探针');

  // AC-012（混合场景前半）：fail_on_baseline 基线红 → falsifies；pass_on_baseline 基线绿 → guard_holds
  assert.equal(tg.per_ac.length, 3);
  const [pa1, pa2, pa3] = tg.per_ac;
  assert.equal(pa1.ac_id, 'AC-001');
  assert.equal(pa1.expect, 'fail_on_baseline');
  assert.notEqual(pa1.exit_code, 0, '定向命令在基线上必红');
  assert.equal(pa1.timed_out, false);
  assert.equal(pa1.verdict, 'falsifies');
  assert.equal(pa2.ac_id, 'AC-002');
  assert.equal(pa2.expect, 'pass_on_baseline');
  assert.equal(pa2.exit_code, 0, '守卫命令在基线上必绿');
  assert.equal(pa2.verdict, 'guard_holds');
  // AC-013：未映射 AC 只记 {ac_id, verdict:'unmapped'}，不 block
  assert.deepEqual(pa3, { ac_id: 'AC-003', verdict: 'unmapped' });

  // 放行进 VERIFY，无 miss
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0);

  // AC-004 + AC-013：verifier prompt 嵌探针机械事实段（去 tail），unmapped 可达 verifier
  const verifierPrompt = promptOf(env.calls()[1]);
  assert.ok(verifierPrompt.includes('# Test gate 探针结果（conductor 机械事实，审计测试证明力时以此为锚）'));
  assert.ok(verifierPrompt.includes('"mode": "per-ac"'));
  assert.ok(verifierPrompt.includes('"verdict": "unmapped"'), 'unmapped 经嵌入段可达 verifier prompt');
  assert.ok(!verifierPrompt.includes('stdout_tail'), '嵌入段不带 stdout_tail');

  // AC-007：映射文件物理存在于 worktree，但不进 diff
  const wt = env.worktree(id);
  assert.ok(env.exists(path.join(wt, '.will-workflow', 'ac-tests.json')), '映射文件物理存在');
  const names = execFileSync('git', ['-C', wt, 'diff', 'main...HEAD', '--name-only'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(names.includes('lib/stats.mjs'), 'diff 应含真实修复');
  assert.ok(!names.some((n) => n.startsWith('.will-workflow/')), '映射文件不得进 diff');

  // AC-007：conductor merge 后 target 主分支无 .will-workflow/
  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(env.findTask(id).box, 'done');
  assert.ok(!env.exists(path.join(env.targetDir, '.will-workflow')), 'merge 后主分支不得出现 .will-workflow/');
  assert.ok(!env.exists(env.worktree(`${id}.test-gate`)), '探针 worktree 已清理');
});

test('fail_on_baseline 基线绿 → 该 AC vacuous → FIXING miss=1，repair-context 精确到 ac_id（AC-009/012）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-802';
  env.writeTask(id);
  env.setScenario([
    { // maker r1：修了 bug，但把 AC-001 映射到一条处处全绿的空转测试上
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: 'test/new.test.mjs', content: TRIVIAL_TEST },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/new.test.mjs', expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 空转映射',
    },
    { // maker r2（resume）：把映射修正为真正钉住 AC-001 的定向命令
      actions: [
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/stats.test.mjs', expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.05, result: 'r2 修正映射',
    },
    verifierStep(2),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // r1：per-AC 探针判 vacuous（精确到条目），不 spawn verifier
  const tg1 = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg1.mode, 'per-ac');
  assert.equal(tg1.verdict, 'vacuous');
  assert.equal(tg1.per_ac[0].ac_id, 'AC-001');
  assert.equal(tg1.per_ac[0].verdict, 'vacuous');
  assert.deepEqual(tg1.per_ac[1], { ac_id: 'AC-002', verdict: 'unmapped' }, 'unmapped 不 block');
  assert.ok(!env.exists(env.dossier(id, 'verifier-r1.json')), 'vacuous 轮不得 spawn verifier');

  // AC-009：repair-context failed_criteria 精确到 ac_id
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'test_gate');
  assert.equal(ctx.test_gate_ref, 'test-gate-r1.json');
  assert.deepEqual(ctx.failed_criteria, [{
    ac_id: 'AC-001',
    status: 'vacuous',
    reason: '映射的测试命令在基线代码上仍 exit 0，未钉住该 AC 的新行为',
  }]);

  // FIXING 轮 maker prompt（resume）展开后含该 ac_id 与 per_ac 摘要
  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker r1 + maker r2(resume) + verifier r2');
  assert.equal(resumeIdOf(calls[1]), 'sess-m1');
  const repairPrompt = promptOf(calls[1]);
  assert.ok(repairPrompt.includes('"ac_id": "AC-001"'), 'repair prompt 精确点名空转 AC');
  assert.ok(repairPrompt.includes('"status": "vacuous"'));
  assert.ok(repairPrompt.includes('"per_ac"'), 'repair prompt 附 per_ac 摘要');

  // r2：映射修正 → 定向命令基线红 → falsifies → verifier → pass
  const tg2 = env.readJson(env.dossier(id, 'test-gate-r2.json'));
  assert.equal(tg2.mode, 'per-ac');
  assert.equal(tg2.verdict, 'falsifies');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1, 'per-AC vacuous 消耗一次 maker miss');
});

test('per-AC vacuous 耗尽阶梯 → FAILED_BOX(maker_misses_exhausted)（AC-009）', (t) => {
  const env = makeEnv(t, { config: { maxMakerMisses: 1 } });
  const id = 'task-20260704-803';
  env.writeTask(id);
  env.setScenario([
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        { type: 'writeFile', path: 'test/new.test.mjs', content: TRIVIAL_TEST },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/new.test.mjs', expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 空转映射',
    },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted');
  assert.equal(after.runtime.maker_miss_count, 1);
  assert.ok(!env.exists(env.worktree(`${id}.test-gate`)), '探针 worktree 已清理');
});

test('映射非法 → 降级 suite 模式 + mapping_errors 留痕，不因映射本身 miss（AC-010）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-804';
  env.writeTask(id);
  env.setScenario([
    { // maker r1：真修复（不动测试，基线红套件天然 falsifies），映射写坏
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-999', command: 'node --test', expect: 'always_green' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 坏映射',
    },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.mode, 'suite', '映射非法 → 降级 v1 全量模式');
  assert.equal(tg.mapping_status, 'invalid');
  assert.ok(tg.mapping_errors.length >= 1, '非法原因留痕');
  assert.ok(tg.mapping_errors.some((e) => e.includes('AC-999')), '错误点名越界 ac_id');
  assert.ok(!('per_ac' in tg), 'suite 模式无 per_ac');
  assert.equal(tg.verdict, 'falsifies', '降级后按 v1 全量复跑裁决');
  assert.notEqual(tg.exit_code, null, '降级后跑了全量基线复跑');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0, '映射格式问题不是 miss');
  assert.ok(!env.exists(env.dossier(id, 'repair-context-r1.json')), '不产生修复上下文');
});

test('fail-open：guard_broken 与单条命令超时（error）均放行进 VERIFY（AC-011/012）', (t) => {
  const env = makeEnv(t, { config: { greenGateTimeoutMs: 3000 } });
  const id = 'task-20260704-805';
  env.writeTask(id, { bodyAc: SPEC_3AC });
  env.setScenario([
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/stats.test.mjs', expect: 'fail_on_baseline' },
            // 写错方向的回归守卫：命令在基线上红 → guard_broken（放行留痕，交 verifier 裁量）
            { ac_id: 'AC-002', command: 'node --test test/stats.test.mjs', expect: 'pass_on_baseline' },
            // 挂死命令：单条超时 → 该条 error，不计入 block，其余条目照常
            { ac_id: 'AC-003', command: 'node -e "setInterval(()=>{},1000)"', expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 混合映射',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.mode, 'per-ac');
  assert.equal(tg.verdict, 'falsifies', 'guard_broken/error 均不触发 block');
  assert.deepEqual(tg.per_ac.map((e) => e.verdict), ['falsifies', 'guard_broken', 'error']);
  assert.equal(tg.per_ac[1].exit_code === 0, false, 'guard_broken：守卫命令基线红');
  assert.equal(tg.per_ac[2].timed_out, true, '超时条目留痕');
  assert.equal(tg.per_ac[2].exit_code, null);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0);
});

test('fail-open：per-AC 模式探针 worktree 创建失败 → 顶层 error 放行（AC-011）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-806';
  // baseBranch 不存在 → merge-base 取不到 → detached worktree add 失败（探针基建失败）
  env.writeTask(id, { baseBranch: 'no-such-branch' });
  env.setScenario([
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: 'node --test test/stats.test.mjs', expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 映射',
    },
    verifierStep(1),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.mode, 'per-ac', '映射有效仍记 per-ac 模式');
  assert.equal(tg.mapping_status, 'valid');
  assert.equal(tg.verdict, 'error');
  assert.match(tg.error, /git worktree add failed/);
  assert.deepEqual(tg.per_ac, [], '基建失败时无逐条结果');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', 'error 放行进 VERIFY');
  assert.equal(after.runtime.maker_miss_count, 0);
});
