// 集成：green gate 通过后可选 gateCommands（task-20260708-005）。
// AC-1 来源优先级、AC-2 按序执行+短路、AC-3 失败回 FIXING 复用 green_gate 回喂通道、
// AC-4 dossier 留证（gate-<name>-r<n>.json）、AC-5 默认空=旧行为不变量、AC-6 开关对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, promptOf, resumeIdOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX_ACTION = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
const PASS_CMD = 'node -e "process.exit(0)"';
const FAIL_CMD = "node -e \"console.error('type mismatch');process.exit(1)\"";
const MARKER_CMD = "node -e \"require('fs').writeFileSync('should-not-run.txt','x')\"";
const PASS_NAME = 'node-e-process-exit-0';
const FAIL_NAME = 'node-e-console-error-type-mismatch-process-exit-1';
const MARKER_NAME = 'node-e-require-fs-writefilesync-should-not-run-txt-x';

// maker r1：修好 testCommand 预埋 bug（green gate 独立判定，先于 gateCommands）。
const FIX_STEP = { actions: [FIX_ACTION], session_id: 'sess-m1', cost: 0.05, result: 'r1 修好 testCommand' };
// 一条同时对两种代码路径都安全消费的兜底步骤：在本任务的新代码路径里它被当作 maker r2
// （resume，result 只是叙事文本，不解析）；如果被拿去跑没有 gateCommands 概念的旧代码，
// testCommand 已修好后会径直进 VERIFY，这条会被当 verifier 调用消费——同样是合法 per-AC
// pass 严格 JSON，两边都不会因「scenario 缺步」触发 isTransientFailure 的长退避重试。
const FALLBACK_STEP = verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02, session_id: 'sess-m1' });

test('AC-2/AC-3/AC-4：gateCommands 按序执行，第一条失败即短路，repair-context 复用 green_gate 回喂通道', (t) => {
  const env = makeEnv(t, { config: { maxMakerMisses: 2 } });
  const id = 'task-20260708-701';
  env.writeTask(id, { gateCommands: [PASS_CMD, FAIL_CMD, MARKER_CMD] });
  env.setScenario([FIX_STEP, FALLBACK_STEP]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // green gate 本身照常独立判定通过
  const gg1 = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gg1.exit_code, 0, 'green gate（testCommand）r1 通过');

  // 第一条 gateCommand 通过 → 落 gate-<name>-r1.json，exit 0
  const g1 = env.readJson(env.dossier(id, `gate-${PASS_NAME}-r1.json`));
  assert.equal(g1.exit_code, 0);
  assert.equal(g1.command, PASS_CMD);
  assert.equal(g1.round, 1);

  // 第二条 gateCommand 失败 → 落 gate-<name>-r1.json，exit 非 0，附 stderr tail
  const g2 = env.readJson(env.dossier(id, `gate-${FAIL_NAME}-r1.json`));
  assert.notEqual(g2.exit_code, 0);
  assert.match(g2.stderr_tail, /type mismatch/);

  // 短路：第三条 gateCommand 不得执行——既不落 dossier 文件，也不在 worktree 留下副作用
  assert.ok(!env.exists(env.dossier(id, `gate-${MARKER_NAME}-r1.json`)), '短路后第三条命令不得执行（无 dossier 文件）');
  assert.ok(!env.exists(env.worktree(id, 'should-not-run.txt')), '短路后第三条命令不得执行（worktree 无副作用）');

  // repair-context r1：复用 green_gate 回喂通道——source 仍是 green_gate，ref 指向失败的 gate 命令文件
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'green_gate');
  assert.equal(ctx.green_gate, null, '存储层不复制 tail，只存 ref（同 green gate 去重策略）');
  assert.equal(ctx.green_gate_ref, `gate-${FAIL_NAME}-r1.json`);
  assert.match(ctx.instruction, /gate command/);

  // 该轮从未 spawn verifier（走 FIXING，不进 VERIFY）
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.verdict.json')), 'gateCommands 失败轮不得进 VERIFY');

  // maker r2（resume）prompt 展开该 gate 命令的 command/stdout/stderr tail（同 green gate 展开逻辑）
  const calls = env.calls();
  assert.equal(calls.length, 2, 'maker r1 + maker r2(resume)，从未 spawn verifier');
  assert.equal(resumeIdOf(calls[1]), 'sess-m1');
  const repairPrompt = promptOf(calls[1]);
  assert.ok(repairPrompt.includes(`"green_gate_ref": "gate-${FAIL_NAME}-r1.json"`));
  assert.ok(repairPrompt.includes(`"command": ${JSON.stringify(FAIL_CMD)}`), 'repair prompt 展开失败 gate 命令的 command');
  assert.ok(repairPrompt.includes('type mismatch'), 'repair prompt 展开失败 gate 命令的 stderr tail');

  // gateCommands 在 task.json 级不可被 maker 代码改动修复：miss 阶梯耗尽收箱（确定性终态）
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.last_failure_type, 'maker_misses_exhausted');
  assert.equal(after.runtime.maker_miss_count, 2);
});

test('AC-6：testCommand 绿但 gateCommands 含失败命令 → 回 FIXING（非 VERIFY）；gateCommands:[] → 直达 VERIFY', (t) => {
  const env = makeEnv(t, { config: { maxMakerMisses: 1 } });

  // (a) gateCommands:["false" 等价失败命令] → 不得进 VERIFY，回 FIXING（在基线上无 gateCommands 概念，此断言必失败）
  const idFail = 'task-20260708-702';
  env.writeTask(idFail, { gateCommands: [FAIL_CMD] });
  // maxMakerMisses=1 时新代码只消费 FIX_STEP 就直接收箱；FALLBACK_STEP 只在旧代码路径
  // （进 VERIFY 需要 verifier）时才会被消费，两边都不会因缺步触发长退避重试。
  env.setScenario([FIX_STEP, FALLBACK_STEP]);
  const runFail = env.run('run');
  assert.equal(runFail.status, 0, runFail.stderr);

  const gg = env.readJson(env.dossier(idFail, 'green-gate-r1.json'));
  assert.equal(gg.exit_code, 0, 'testCommand 本身是绿的');
  assert.ok(env.exists(env.dossier(idFail, `gate-${FAIL_NAME}-r1.json`)), 'gate 命令被实际执行且留证');
  const ctxFail = env.readJson(env.dossier(idFail, 'repair-context-r1.json'));
  assert.equal(ctxFail.source, 'green_gate');
  assert.equal(ctxFail.green_gate_ref, `gate-${FAIL_NAME}-r1.json`);
  assert.ok(!env.exists(env.dossier(idFail, 'verify-r1.verdict.json')), 'testCommand 绿但 gate 命令红：不得进 VERIFY');
  const afterFail = env.findTask(idFail);
  assert.notEqual(afterFail.runtime.stage, 'VERIFY');

  // (b) gateCommands:[] → 直达 VERIFY（与旧行为一致）
  const idEmpty = 'task-20260708-703';
  env.writeTask(idEmpty, { gateCommands: [] });
  env.setScenario([FIX_STEP, verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' })]);
  const runEmpty = env.run('run');
  assert.equal(runEmpty.status, 0, runEmpty.stderr);

  const afterEmpty = env.findTask(idEmpty);
  assert.equal(afterEmpty.runtime.stage, 'AWAIT_HUMAN_MERGE', 'gateCommands:[] 直达 VERIFY 并通过');
  assert.ok(env.exists(env.dossier(idEmpty, 'verify-r1.verdict.json')));
});

test('AC-5：gateCommands 缺省（task.json 无该字段）时不进入 gate 执行分支，逐字节等价旧行为', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260708-704';
  env.writeTask(id); // 不传 gateCommands：task.json 完全不含该字段
  env.setScenario([FIX_STEP, verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' })]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  assert.ok(!Object.hasOwn(env.readTaskJson(id), 'gateCommands'), 'task.json 确实不含 gateCommands 字段');
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(env.exists(env.dossier(id, 'verify-r1.verdict.json')), '绿门通过后直达 VERIFY，未被 gate 分支拦截');

  // dossier 目录里不得出现任何 gate-*-r*.json（不进入 gate 执行分支的机械证明）
  const entries = fs.readdirSync(env.dossier(id));
  assert.ok(!entries.some((n) => /^gate-.+-r\d+\.json$/.test(n)), '缺省 gateCommands 不产出任何 gate-*.json');
});

test('AC-1：task.json 缺字段时退回 target-profile 默认；task.json 显式值完全覆盖 profile（不合并）', (t) => {
  const env = makeEnv(t);

  // profile 默认 gateCommands 是失败命令
  env.writeApprovedSetupProfile('# Setup Profile\n', { gateCommands: [FAIL_CMD] });

  // (a) task.json 不含 gateCommands → 退回 profile 默认 → gate 命令被执行且失败
  env.writeConfig({ maxMakerMisses: 1 });
  const idProfile = 'task-20260708-705';
  env.writeTask(idProfile, { stage: 'READY' });
  // 同上：FALLBACK_STEP 只在旧代码路径（进 VERIFY 需要 verifier）时才会被消费。
  env.setScenario([FIX_STEP, FALLBACK_STEP]);
  const runProfile = env.run('run');
  assert.equal(runProfile.status, 0, runProfile.stderr);
  assert.ok(
    env.exists(env.dossier(idProfile, `gate-${FAIL_NAME}-r1.json`)),
    'task.json 缺字段时应退回 target-profile 默认执行',
  );
  assert.ok(!env.exists(env.dossier(idProfile, 'verify-r1.verdict.json')));

  // (b) task.json 显式提供 gateCommands（与 profile 不同）→ 完全覆盖 profile，不合并
  const idOverride = 'task-20260708-706';
  env.writeTask(idOverride, { gateCommands: [PASS_CMD] });
  env.setScenario([FIX_STEP, verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' })]);
  const runOverride = env.run('run');
  assert.equal(runOverride.status, 0, runOverride.stderr);
  assert.ok(
    env.exists(env.dossier(idOverride, `gate-${PASS_NAME}-r1.json`)),
    'task.json 显式 gateCommands 生效',
  );
  assert.ok(
    !env.exists(env.dossier(idOverride, `gate-${FAIL_NAME}-r1.json`)),
    'profile 默认的失败命令不得被执行（task.json 完全覆盖，不合并）',
  );
  const afterOverride = env.findTask(idOverride);
  assert.equal(afterOverride.runtime.stage, 'AWAIT_HUMAN_MERGE');
});
