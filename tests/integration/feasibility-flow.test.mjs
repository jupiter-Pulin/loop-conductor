// 集成：feasibility gate——NEEDS_FEASIBILITY（feasibility-agent 直写决策 memo + 契约门终审）
// → AWAIT_FEASIBILITY_APPROVAL（人按 option ID 点名）→ 冻结 memo + decision → NEEDS_SPEC
// （spec 链吃到已选 option + brief）；以及 reject 回炉、契约门原地重试/耗尽收箱、
// approve-feasibility 的 option 机器校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, specVerifierStep } from '../helpers/env.mjs';

const FEASIBILITY_DOC = [
  '# Feasibility Study: median 能力扩展',
  '',
  '## 背景',
  '',
  '现状见 lib/stats.mjs（marker: FEAS-EVIDENCE-1）。',
  '',
  '## 选项对比',
  '',
  '| 选项 | 描述 | 收益 | 代价 | 结论 |',
  '| --- | --- | --- | --- | --- |',
  '| O-A: 就地扩展 stats.mjs | 在现有模块加函数 | 改动小 | 模块渐肥 | consider |',
  '| O-B: 新建 percentile 模块 | 独立模块 + 复用排序 | 边界清晰 | 多一个文件 | recommend |',
  '',
  '## 推荐',
  '',
  '推荐 O-B：与现有测试布局一致，回归面最小。',
  '',
  '## 开放问题',
  '',
  '| 问题 | Safe default | 影响 |',
  '| --- | --- | --- |',
  '| 空数组行为 | 抛 TypeError | AC 边界 case 措辞 |',
  '',
].join('\n');

const FEASIBILITY_DOC_V2 = FEASIBILITY_DOC
  .replace('median 能力扩展', 'median 能力扩展 v2（回应 reject）')
  .replace('（marker: FEAS-EVIDENCE-1）', '（marker: FEAS-EVIDENCE-2）');

// 缺「## 推荐」段 → 过不了 feasibility-doc/v1 契约门。
const FEASIBILITY_DOC_INVALID = FEASIBILITY_DOC.replace('## 推荐', '## 结论');

const SPEC_DRAFT = '# spec 草稿\n\n## 验收标准\n\n- AC-001 percentile 模块按已选 O-B 落地\n';

const BRIEF = '来自 Jira PROJ-42 的需求原文：支持 p95/p99 percentile 查询。（marker: BRIEF-1）';

/** 建一个 feature+feasibility 任务，返回 { id, taskDir, draftAbs }。 */
function newFeasibilityTask(env, { brief = true } = {}) {
  const args = ['new', '--kind', 'feature', '--title', 'percentile 查询', '--feasibility'];
  if (brief) {
    const briefPath = path.join(env.root, 'brief-input.md');
    fs.writeFileSync(briefPath, BRIEF);
    args.push('--brief', briefPath);
  }
  const created = env.run(...args);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  const taskDir = path.join(env.root, 'state', 'queue', id);
  return { id, taskDir, draftAbs: path.join(taskDir, 'feasibility-study.md') };
}

test('feasibility happy path：memo 过契约门 → 闸门停住 → approve --option → 冻结 + decision → spec 链吃到已选 option', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const { id, taskDir, draftAbs } = newFeasibilityTask(env);

  const task = env.readTaskJson(id);
  assert.equal(task.feasibility, true, 'task.json 快照记录 feasibility gate');
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_FEASIBILITY');
  assert.equal(fs.readFileSync(path.join(taskDir, 'brief.md'), 'utf8'), BRIEF, '--brief 落盘任务目录');

  env.setScenario([
    { // 0 feasibility-agent：直写唯一交付文件，最终回复只是确认
      actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC }],
      session_id: 'sess-feas-1', cost: 0.05, result: 'memo written' },
    { // 1 spec-agent（approve 之后）
      actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: SPEC_DRAFT }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written' },
    specVerifierStep(1, 'pass', { session_id: 'sess-sv-1' }), // 2 spec-verifier
  ]);

  // 第一次 run：feasibility-agent 产出 memo，停在 option 人审闸门
  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  const gated = env.findTask(id);
  assert.equal(gated.runtime.stage, 'AWAIT_FEASIBILITY_APPROVAL');
  assert.equal(gated.runtime.feasibility_approval, null);
  assert.equal(gated.runtime.current_feasibility_round, 1);
  assert.equal(fs.readFileSync(draftAbs, 'utf8'), FEASIBILITY_DOC);
  assert.equal(env.calls().length, 1, '闸门未批，不得 spawn spec-agent');

  // 工具形态：只读探索 + git 历史 + 受限写；--settings 注入 hook 护栏；cwd 是 target 仓库
  const feasCall = env.calls()[0];
  const FEAS_TOOLSET = 'Read,Grep,Glob,Bash(git log:*),Bash(git blame:*),Write,Edit';
  assert.equal(feasCall.argv[feasCall.argv.indexOf('--tools') + 1], FEAS_TOOLSET);
  assert.equal(feasCall.argv[feasCall.argv.indexOf('--allowedTools') + 1], FEAS_TOOLSET);
  assert.ok(feasCall.argv.includes('--settings'), 'feasibility-agent spawn 带 --settings hook 护栏');
  assert.ok(feasCall.cwd.endsWith('target'));
  const feasPrompt = promptOf(feasCall);
  assert.ok(feasPrompt.includes('BRIEF-1'), 'feasibility prompt 含 brief 原文');
  assert.ok(feasPrompt.includes('feasibility-doc/v1'), 'feasibility prompt 含交付契约');
  // 契约门终审记录 + spawn 双标记
  assert.equal(env.readJson(env.dossier(id, 'feasibility-check-r1.json')).ok, true);
  const feasRec = env.readJson(env.dossier(id, 'feasibility-agent-r1.json'));
  assert.ok(feasRec.started && feasRec.done, 'feasibility-agent-r1 双标记齐全');
  assert.equal(feasRec.raw.session_id, 'sess-feas-1');

  // 幂等：再 run 一次仍停在闸门、零新 spawn
  env.run('run');
  assert.equal(env.calls().length, 1);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_FEASIBILITY_APPROVAL');

  // 机器校验：不点名 option / 点名不存在的 option → 拒绝写入，任务保持原状
  const noOption = env.run('approve-feasibility', id);
  assert.equal(noOption.status, 1, '缺 --option 必须拒绝（无静默通过）');
  const ghost = env.run('approve-feasibility', id, '--option', 'O-Z');
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /O-Z 不在草稿枚举/);
  assert.equal(env.findTask(id).runtime.feasibility_approval, null, '非法 approve 不得写入');

  // 合法 approve：点名 O-B + 补充约束
  const ok = env.run('approve-feasibility', id, '--option', 'O-B', '--notes', '选 O-B，但先不做 p99 缓存');
  assert.equal(ok.status, 0, ok.stderr);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL', 'approve 后一路推进到 spec 人审闸门');
  assert.equal(after.runtime.chosen_option, 'O-B');

  // 冻结产物：dossier memo + decision；草稿归档不留双份
  assert.equal(fs.readFileSync(env.dossier(id, 'feasibility-study.md'), 'utf8'), FEASIBILITY_DOC, '冻结副本与批准稿一致');
  const decision = env.readJson(env.dossier(id, 'feasibility-decision.json'));
  assert.equal(decision.chosen_option, 'O-B');
  assert.match(decision.notes, /不做 p99 缓存/);
  assert.ok(!fs.existsSync(draftAbs), 'approve 后任务目录草稿不再存在');
  const archived = fs.readdirSync(path.join(taskDir, 'feasibility-archive')).filter((n) => n.startsWith('approved-'));
  assert.equal(archived.length, 1, '被批准的草稿归档到 feasibility-archive/');

  // spec 链输入：spec-agent 与 spec-verifier 的 prompt 都吃到 memo + 已选 option + brief
  const specPrompt = promptOf(env.calls()[1]);
  assert.ok(specPrompt.includes('FEAS-EVIDENCE-1'), 'spec prompt 含冻结 memo（feasibility context）');
  assert.ok(specPrompt.includes('chosen_option: O-B'), 'spec prompt 含人审已选 option');
  assert.ok(specPrompt.includes('不做 p99 缓存'), 'spec prompt 含人审补充约束');
  assert.ok(specPrompt.includes('BRIEF-1'), 'spec prompt 含任务 brief');
  const svPrompt = promptOf(env.calls()[2]);
  assert.ok(svPrompt.includes('chosen_option: O-B'), 'spec-verifier prompt 含已选 option');
  assert.ok(svPrompt.includes('BRIEF-1'), 'spec-verifier prompt 含任务 brief');
});

test('reject 回炉：notes 进 feasibility_reject_notes.md，第二稿 prompt 必须带 notes，旧稿归档', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const { id, taskDir, draftAbs } = newFeasibilityTask(env, { brief: false });
  env.setScenario([
    { actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC }],
      session_id: 'sess-feas-1', cost: 0.05, result: 'v1 written' },
    { actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC_V2 }],
      session_id: 'sess-feas-2', cost: 0.05, result: 'v2 written' },
  ]);
  env.run('run'); // → AWAIT_FEASIBILITY_APPROVAL

  const rejected = env.run('reject-feasibility', id, '--notes', '缺少「不做」选项与成本证据');
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(env.findTask(id).runtime.feasibility_approval, 'rejected');
  const notes = fs.readFileSync(path.join(taskDir, 'feasibility_reject_notes.md'), 'utf8');
  assert.match(notes, /缺少「不做」选项/, 'notes 追加进任务目录 feasibility_reject_notes.md');

  const run2 = env.run('run'); // 归档旧稿 → NEEDS_FEASIBILITY → 重产 → 回到闸门
  assert.equal(run2.status, 0, run2.stderr);
  const back = env.findTask(id);
  assert.equal(back.runtime.stage, 'AWAIT_FEASIBILITY_APPROVAL');
  assert.equal(back.runtime.feasibility_approval, null, '重产后 approval 复位');
  assert.equal(fs.readFileSync(draftAbs, 'utf8'), FEASIBILITY_DOC_V2);
  const archived = fs.readdirSync(path.join(taskDir, 'feasibility-archive')).filter((n) => n.startsWith('rejected-'));
  assert.equal(archived.length, 1, '被打回的旧稿归档');
  assert.ok(promptOf(env.calls()[1]).includes('缺少「不做」选项'), '第二稿 prompt 必须带 reject notes');
});

test('契约门 fail：原地重试（废稿归档 + 错误进下轮 prompt），超上限收箱 feasibility_contract_exhausted', (t) => {
  const env = makeEnv(t, { config: { maxFeasibilityContractRetries: 1 } });
  env.writeApprovedSetupProfile();
  const { id, taskDir, draftAbs } = newFeasibilityTask(env, { brief: false });
  env.setScenario([
    { actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC_INVALID }],
      session_id: 'sess-feas-1', cost: 0.05, result: 'bad v1' },
    { actions: [{ type: 'writeFile', path: draftAbs, content: FEASIBILITY_DOC_INVALID }],
      session_id: 'sess-feas-2', cost: 0.05, result: 'bad v2' },
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const boxed = env.findTask(id);
  assert.equal(boxed.box, 'failed', '契约门耗尽收箱');
  assert.equal(boxed.runtime.stage, 'FAILED_BOX');
  assert.equal(boxed.runtime.last_failure_type, 'feasibility_contract_exhausted');
  assert.equal(env.calls().length, 2, '初始 + 1 次重试 = 2 次 spawn');

  // 终审记录逐轮留档且 ok:false；废稿归档；第二轮 prompt 带契约错误
  assert.equal(env.readJson(env.dossier(id, 'feasibility-check-r1.json')).ok, false);
  assert.equal(env.readJson(env.dossier(id, 'feasibility-check-r2.json')).ok, false);
  const archivedDir = path.join(env.root, 'state', 'failed', id, 'feasibility-archive');
  assert.ok(fs.readdirSync(archivedDir).some((n) => n.startsWith('contract-invalid-r1-')), '废稿归档');
  const retryPrompt = promptOf(env.calls()[1]);
  assert.ok(retryPrompt.includes('契约门失败反馈'), '重试 prompt 带上一轮契约错误');
  assert.ok(retryPrompt.includes('推荐'), '错误内容点名缺失段');

  // retry：缺冻结 memo → 回 NEEDS_FEASIBILITY，轮次产物移入 attempts/
  const retried = env.run('retry', id);
  assert.equal(retried.status, 0, retried.stderr);
  const requeued = env.findTask(id);
  assert.equal(requeued.box, 'queue');
  assert.equal(requeued.runtime.stage, 'NEEDS_FEASIBILITY', 'feasibility gate 任务缺冻结 memo → 复位到 NEEDS_FEASIBILITY');
  assert.equal(requeued.runtime.feasibility_contract_invalid_count, 0);
  assert.ok(!fs.existsSync(env.dossier(id, 'feasibility-check-r1.json')), '轮次产物已移入 attempts/');
});

test('feasibility 开关：缺省关（NEEDS_SPEC）；config feasibilityEnabled=true 默认开；--feasibility false 逐任务关', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();

  const off = env.run('new', '--kind', 'feature', '--title', '缺省关');
  assert.equal(env.findTask(off.stdout.match(/task-\d{8}-\d{3}/)[0]).runtime.stage, 'NEEDS_SPEC');

  env.writeConfig({ feasibilityEnabled: true });
  const on = env.run('new', '--kind', 'feature', '--title', 'config 默认开');
  assert.equal(env.findTask(on.stdout.match(/task-\d{8}-\d{3}/)[0]).runtime.stage, 'NEEDS_FEASIBILITY');

  const forceOff = env.run('new', '--kind', 'feature', '--title', '逐任务关', '--feasibility', 'false');
  assert.equal(env.findTask(forceOff.stdout.match(/task-\d{8}-\d{3}/)[0]).runtime.stage, 'NEEDS_SPEC');

  // bugfix 不受 feasibility 开关影响
  const bugfix = env.run('new', '--kind', 'bugfix', '--title', 'bugfix 不走 gate');
  assert.equal(env.findTask(bugfix.stdout.match(/task-\d{8}-\d{3}/)[0]).runtime.stage, 'READY');
});

test('brief 注入（不开 feasibility gate）：spec-agent / spec-verifier prompt 直接吃到 brief', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const briefPath = path.join(env.root, 'brief-input.md');
  fs.writeFileSync(briefPath, BRIEF);
  const created = env.run('new', '--kind', 'feature', '--title', 'brief 注入', '--brief', briefPath);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_SPEC');

  env.setScenario([
    { actions: [{ type: 'writeFile', path: path.join(env.root, 'specs', `${id}.md`), content: SPEC_DRAFT }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written' },
    specVerifierStep(1, 'pass'),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(promptOf(env.calls()[0]).includes('BRIEF-1'), 'spec-agent prompt 含 brief');
  assert.ok(promptOf(env.calls()[1]).includes('BRIEF-1'), 'spec-verifier prompt 含 brief');

  // --brief 指向不存在的文件 → 拒绝创建
  const bad = env.run('new', '--kind', 'feature', '--title', 'bad brief', '--brief', path.join(env.root, 'nope.md'));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--brief 文件不存在/);
});
