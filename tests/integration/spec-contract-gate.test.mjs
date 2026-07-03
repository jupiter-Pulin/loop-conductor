// 集成（新）：spec-agent 直写交付 + spec-doc/v1 契约门。
// ① 直写过门：--settings 注入 hook 护栏（写白名单 + Stop 预检）、受限写工具集、acs 落案卷；
// ② 契约门 fail：留在 NEEDS_SPEC 原地重试（废稿归档、结构化错误进下轮 prompt），
//    超 maxSpecContractRetries → FAILED_BOX(spec_contract_exhausted)，不 spawn spec-verifier；
// ③ fail 后下一轮过门：计数复位、正常推进；
// ④ SPEC_FIXING 修复稿同样过契约门（废稿保留作修复上下文）；
// ⑤ 崩溃残留半成品草稿：NEEDS_SPEC 幂等分支归档重产，绝不带病进 SPEC_VERIFY。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, specVerifierStep } from '../helpers/env.mjs';

const GOOD_SPEC = [
  '# 功能 spec',
  '',
  '## 背景',
  '',
  '一些背景。',
  '',
  '## 验收标准',
  '',
  '- AC-001: `node --test` 全绿',
  '',
].join('\n');
const GOOD_SPEC_V2 = GOOD_SPEC.replace('# 功能 spec', '# 功能 spec v2');
// 同义标题：契约门必须拒绝（标题不逐字）。
const BAD_SPEC_TITLE = '# spec\n\n## Acceptance Criteria\n\n- AC-001: whatever\n';

const SPEC_TOOLS_ARGV = 'Read,Grep,Glob,Write,Edit';

function newFeature(env, title) {
  const created = env.run('new', '--kind', 'feature', '--title', title);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);
  return { id, specAbs: path.join(env.root, 'specs', `${id}.md`) };
}

test('直写过门：settings/hook/工具形态正确，契约门结果与 AC 枚举落案卷', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const { id, specAbs } = newFeature(env, '契约门 happy');
  env.setScenario([
    { // spec-agent 直写交付文件，最终回复只是确认
      actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'pass', { session_id: 'sess-sv-1' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(after.runtime.spec_contract_invalid_count, 0);
  assert.equal(fs.readFileSync(specAbs, 'utf8'), GOOD_SPEC, '交付文件就是 agent 直写的内容，conductor 不改写');

  // conductor 契约门结果（权威终审）落案卷，含 AC 枚举
  const gate = env.readJson(env.dossier(id, 'spec-check-r1.json'));
  assert.equal(gate.ok, true);
  assert.equal(gate.source, 'conductor');
  assert.equal(gate.contract, 'spec-doc/v1');
  assert.deepEqual(gate.acs.map((a) => a.ac_id), ['AC-001']);

  // spawn 形态：受限写工具集 + --settings 指向逐轮生成的 hook 护栏文件
  const specCall = env.calls()[0];
  assert.equal(specCall.argv[specCall.argv.indexOf('--tools') + 1], SPEC_TOOLS_ARGV);
  assert.equal(specCall.argv[specCall.argv.indexOf('--allowedTools') + 1], SPEC_TOOLS_ARGV);
  const settingsPath = specCall.argv[specCall.argv.indexOf('--settings') + 1];
  assert.equal(settingsPath, env.dossier(id, 'spec-agent-r1.settings.json'), '--settings 指向 dossier 内逐轮 settings');

  // settings 内容：PreToolUse 写白名单 + Stop 契约预检，两个 hook 命令都锚到交付文件绝对路径
  const settings = env.readJson(settingsPath);
  const pre = settings.hooks.PreToolUse[0];
  assert.equal(pre.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.ok(pre.hooks[0].command.includes('spec-write-guard.mjs'), 'PreToolUse 挂写白名单脚本');
  assert.ok(pre.hooks[0].command.includes(specAbs), '白名单锚定交付文件');
  const stop = settings.hooks.Stop[0];
  assert.ok(stop.hooks[0].command.includes('check-spec.mjs'), 'Stop 挂契约预检脚本');
  assert.ok(stop.hooks[0].command.includes(specAbs));
  assert.ok(stop.hooks[0].command.includes(env.dossier(id, 'spec-check-r1.hook.json')), '预检报告写进案卷');

  // prompt：交付路径 + 钉死的规范标题
  const prompt = promptOf(specCall);
  assert.ok(prompt.includes(specAbs), 'prompt 给出交付文件绝对路径');
  assert.ok(prompt.includes('## 验收标准'), 'prompt 钉死规范标题');
});

test('契约门 fail×3：原地重试带结构化错误，耗尽 → FAILED_BOX(spec_contract_exhausted)', (t) => {
  const env = makeEnv(t); // 默认 maxSpecContractRetries=2 → 容忍初始+2=3 次尝试
  env.writeApprovedSetupProfile();
  const { id, specAbs } = newFeature(env, '契约门耗尽');
  env.setScenario([
    { session_id: 'sess-spec-1', cost: 0.03, result: '我写好了' }, // r1：口头汇报但没写文件
    { // r2：写了文件但标题是同义词
      actions: [{ type: 'writeFile', path: specAbs, content: BAD_SPEC_TITLE }],
      session_id: 'sess-spec-2', cost: 0.03, result: 'done',
    },
    { session_id: 'sess-spec-3', cost: 0.03, result: '这次一定' }, // r3：又没写 → 耗尽
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX');
  assert.equal(after.runtime.last_failure_type, 'spec_contract_exhausted');
  assert.equal(after.runtime.spec_contract_invalid_count, 3, '收箱时落盘递增后的计数');

  // 三轮契约门结果各自留档、全 fail；spec-verifier 一次都不得 spawn
  for (const n of [1, 2, 3]) {
    assert.equal(env.readJson(env.dossier(id, `spec-check-r${n}.json`)).ok, false, `spec-check-r${n} fail`);
  }
  assert.equal(env.calls().length, 3, 'spec-agent×3，无 spec-verifier');
  assert.ok(!env.exists(env.dossier(id, 'spec-verify-r1.verdict.json')), '契约门失败不得进 SPEC_VERIFY');

  // 结构化契约错误进下一轮 prompt（r2 看 r1 的错，r3 看 r2 的错）
  const calls = env.calls();
  assert.ok(promptOf(calls[1]).includes('Spec 契约门失败反馈'), 'r2 prompt 带 r1 契约错误区块');
  assert.ok(promptOf(calls[1]).includes('缺失或为空'), 'r1 的错误是文件未写入');
  assert.ok(promptOf(calls[2]).includes('缺少「## 验收标准」段'), 'r3 prompt 带 r2 的标题错误');

  // r2 的废稿归档（不留在 specs/ 污染下一轮）
  const archiveDir = path.join(env.root, 'specs', 'archive');
  const archived = fs.readdirSync(archiveDir).filter((n) => n.includes('contract-invalid-r2'));
  assert.equal(archived.length, 1, '契约废稿归档 specs/archive/');
  assert.ok(!fs.existsSync(specAbs), '交付路径不残留废稿');
});

test('契约门 fail 后下一轮过门：计数复位，正常进入 spec-verifier', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const { id, specAbs } = newFeature(env, '契约门恢复');
  env.setScenario([
    { session_id: 'sess-spec-1', cost: 0.03, result: '忘了写文件' },      // r1：契约 fail #1
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC }],
      session_id: 'sess-spec-2', cost: 0.03, result: 'spec written' },     // r2：过门
    specVerifierStep(2, 'pass'),                                           // spec-verifier（round=2）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(after.runtime.spec_contract_invalid_count, 0, '过门后计数复位');
  assert.equal(after.runtime.current_spec_round, 2);
  assert.equal(env.readJson(env.dossier(id, 'spec-check-r1.json')).ok, false);
  assert.equal(env.readJson(env.dossier(id, 'spec-check-r2.json')).ok, true);
});

test('SPEC_FIXING 修复稿同样过契约门：废稿保留作上下文，过门后回 SPEC_VERIFY', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const { id, specAbs } = newFeature(env, '修复轮契约门');
  env.setScenario([
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'v1' },               // r1 过门
    specVerifierStep(1, 'fail'),                                            // 质量 fail → SPEC_FIXING
    { actions: [{ type: 'writeFile', path: specAbs, content: BAD_SPEC_TITLE }],
      session_id: 'sess-spec-2', cost: 0.03, result: 'v2 bad' },            // r2 修复稿契约 fail
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC_V2 }],
      session_id: 'sess-spec-3', cost: 0.03, result: 'v3' },                // r3 修复稿过门
    specVerifierStep(3, 'pass'),                                            // spec-verifier（round=3）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(after.runtime.spec_miss_count, 1, '质量 fail 消耗一次 spec miss');
  assert.equal(after.runtime.spec_contract_invalid_count, 0, '修复稿过门后契约计数复位');
  assert.equal(after.runtime.current_spec_round, 3);
  assert.equal(env.readJson(env.dossier(id, 'spec-check-r2.json')).ok, false, '修复稿契约 fail 留档');
  assert.equal(fs.readFileSync(specAbs, 'utf8'), GOOD_SPEC_V2);
  // r3 修复 prompt：带 r2 契约错误 + 现有（废）草稿作上下文
  const r3prompt = promptOf(env.calls()[3]);
  assert.ok(r3prompt.includes('Spec 契约门失败反馈'), 'r3 prompt 带契约错误');
  assert.ok(r3prompt.includes('Current spec draft'), '修复轮保留现有草稿作上下文');
  assert.ok(r3prompt.includes('Acceptance Criteria'), '废稿内容原样可见（供修复参考）');
});

test('崩溃残留半成品草稿：NEEDS_SPEC 幂等分支归档重产，不带病进 SPEC_VERIFY', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const id = 'task-20260702-901';
  env.writeTask(id, { kind: 'feature', stage: 'NEEDS_SPEC' });
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  fs.writeFileSync(specAbs, '# 半成品\n\n（崩溃残留，没有验收标准段）\n');
  env.setScenario([
    { actions: [{ type: 'writeFile', path: specAbs, content: GOOD_SPEC }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'rewritten' },
    specVerifierStep(1, 'pass'),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(fs.readFileSync(specAbs, 'utf8'), GOOD_SPEC);
  const archiveDir = path.join(env.root, 'specs', 'archive');
  assert.ok(
    fs.readdirSync(archiveDir).some((n) => n.includes('contract-invalid-leftover')),
    '半成品归档 specs/archive/，不静默丢弃',
  );
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.match(timeline, /归档重产/, 'timeline 记录残留自愈');
});
