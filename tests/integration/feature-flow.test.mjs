// 集成：feature 档——NEEDS_SPEC（spec-agent 产出草稿）→ SPEC_VERIFY → AWAIT_SPEC_APPROVAL 人类闸门
// → approve 冻结 spec → READY → … → AWAIT_HUMAN_MERGE；以及 reject + notes 回炉路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, specVerifierStep, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

// spec 草稿含两条验收标准 → 抽取 AC-001 / AC-002（verifier 需逐条裁决）。
const SPEC_DRAFT = [
  '# spec 草稿 v1',
  '',
  '## 验收标准',
  '',
  '- AC-001 median 偶数分支取平均',
  '- AC-002 node --test 全绿',
  '',
].join('\n');
const SPEC_DRAFT_V2 = '# spec 草稿 v2（回应 reject）\n\n## 验收标准\n\n- AC-001 同 v1，并补充边界用例说明\n';

test('feature 档：spec-agent → spec-verifier → 闸门停住 → approve → 直达 AWAIT_HUMAN_MERGE', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_SPEC'); // feature 初始 NEEDS_SPEC
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([
    { // 0 spec-agent：直写唯一交付文件（specs/<id>.md），最终回复只是确认
      actions: [{ type: 'writeFile', path: specAbs, content: SPEC_DRAFT }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written' },
    specVerifierStep(1, 'pass', { cost: 0.02, session_id: 'sess-sv-1' }),   // 1 spec-verifier
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-m1', cost: 0.1, result: 'done' },                    // 2 maker
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }), // 3 verifier
  ]);

  // 第一次 run：spec-agent 产出草稿，经 spec-verifier pass 后停在人类闸门
  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  const gated = env.findTask(id);
  assert.equal(gated.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(gated.runtime.approval, null);
  const draftPath = path.join(env.root, 'specs', `${id}.md`);
  assert.equal(fs.readFileSync(draftPath, 'utf8'), SPEC_DRAFT);
  assert.equal(env.calls().length, 2, '闸门未批，不得 spawn maker');
  // spec-agent：只读探索 + 受限写（写白名单由 hook 强制），--settings 注入护栏；cwd 是 target 仓库
  const specCall = env.calls()[0];
  const SPEC_TOOLSET = 'Read,Grep,Glob,Bash(git log:*),Bash(git blame:*),Write,Edit';
  assert.equal(specCall.argv[specCall.argv.indexOf('--tools') + 1], SPEC_TOOLSET);
  assert.equal(specCall.argv[specCall.argv.indexOf('--allowedTools') + 1], SPEC_TOOLSET);
  assert.ok(specCall.argv.includes('--settings'), 'spec-agent spawn 带 --settings hook 护栏');
  assert.ok(specCall.argv.includes('--max-turns'), 'spec spawn 带 --max-turns');
  assert.ok(specCall.cwd.endsWith('target'));
  // spec-verifier 仍是纯只读工具集
  const svCall = env.calls()[1];
  assert.equal(svCall.argv[svCall.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  const specRec = env.readJson(env.dossier(id, 'spec-agent-r1.json'));
  assert.ok(specRec.started && specRec.done, 'spec-agent-r1 双标记齐全');
  assert.equal(specRec.raw.session_id, 'sess-spec-1');
  const specVerifyRec = env.readJson(env.dossier(id, 'spec-verifier-r1.json'));
  assert.ok(specVerifyRec.started && specVerifyRec.done, 'spec-verifier-r1 双标记齐全');
  assert.equal(specVerifyRec.raw.session_id, 'sess-sv-1');

  // 幂等：再 run 一次仍停在闸门、零新 spawn
  env.run('run');
  assert.equal(env.calls().length, 2);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');

  // approve → 冻结 spec → 直达 AWAIT_HUMAN_MERGE
  const ok = env.run('approve', id);
  assert.equal(ok.status, 0, ok.stderr);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  const done = env.findTask(id);
  assert.equal(done.runtime.stage, 'AWAIT_HUMAN_MERGE');
  // AC-003：批准稿冻结进 dossier/<id>/spec.md，且 maker/verifier prompt 用它作契约
  assert.equal(fs.readFileSync(env.dossier(id, 'spec.md'), 'utf8'), SPEC_DRAFT, '冻结副本与批准稿一致');
  assert.equal(env.calls().length, 4);
  const makerPrompt = promptOf(env.calls()[2]);
  assert.ok(makerPrompt.includes('median 偶数分支取平均'), 'maker prompt 含冻结 spec 内容');
  assert.equal(env.findTask(id).runtime.maker_miss_count, 0);

  // C1：approve 冻结后草稿归档，specs/ 下不留双份平行 spec（冻结稿是唯一契约）
  assert.ok(!fs.existsSync(draftPath), 'approve 后 specs/<id>.md 草稿不再存在');
  const archiveDir = path.join(env.root, 'specs', 'archive');
  const archivedDrafts = fs.readdirSync(archiveDir).filter((n) => n.startsWith(`${id}-approved-`));
  assert.equal(archivedDrafts.length, 1, '被批准的草稿应归档到 specs/archive/');
  assert.equal(fs.readFileSync(path.join(archiveDir, archivedDrafts[0]), 'utf8'), SPEC_DRAFT, '归档内容等于原草稿');
});

test('reject + notes 回炉：spec-agent 第二稿必须看到 reject_notes', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', '回炉测试');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: specAbs, content: SPEC_DRAFT }],
      session_id: 'sess-spec-1', cost: 0.03, result: 'v1 written' },      // 0 spec v1
    specVerifierStep(1, 'pass'),                                          // 1 spec-verifier v1
    { actions: [{ type: 'writeFile', path: specAbs, content: SPEC_DRAFT_V2 }],
      session_id: 'sess-spec-2', cost: 0.03, result: 'v2 written' },      // 2 spec v2（带 notes）
    specVerifierStep(2, 'pass'),                                          // 3 spec-verifier v2
  ]);
  env.run('run'); // → AWAIT_SPEC_APPROVAL

  const rejected = env.run('reject', id, '--notes', '验收标准太含糊，要可机判');
  assert.equal(rejected.status, 0, rejected.stderr);
  const afterReject = env.findTask(id);
  assert.equal(afterReject.runtime.approval, 'rejected');
  // notes 进任务目录 reject_notes.md，不入 runtime
  const notes = fs.readFileSync(path.join(afterReject.dir, 'reject_notes.md'), 'utf8');
  assert.match(notes, /验收标准太含糊/, 'notes 追加进任务目录 reject_notes.md');
  assert.equal('reject_notes' in afterReject.runtime, false, 'reject notes 不入 runtime');

  const run2 = env.run('run'); // AWAIT_SPEC_APPROVAL → NEEDS_SPEC → 重新 spec-agent/spec-verifier → 回到闸门
  assert.equal(run2.status, 0, run2.stderr);
  const back = env.findTask(id);
  assert.equal(back.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(back.runtime.approval, null, '重新出稿后 approval 复位');
  assert.equal(fs.readFileSync(path.join(env.root, 'specs', `${id}.md`), 'utf8'), SPEC_DRAFT_V2);

  // 旧草稿归档（保证 NEEDS_SPEC 的「草稿已存在」检查不误判）
  const archiveDir = path.join(env.root, 'specs', 'archive');
  const archived = fs.readdirSync(archiveDir).filter((n) => n.startsWith(`${id}-rejected-`));
  assert.equal(archived.length, 1, '被打回的旧草稿应归档到 specs/archive/');
  assert.equal(fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8'), SPEC_DRAFT, '归档内容是 v1 原稿');

  const calls = env.calls();
  assert.equal(calls.length, 4);
  assert.ok(promptOf(calls[2]).includes('验收标准太含糊'), '第二稿 prompt 必须带 reject_notes');
  // spec-verifier 与 spec-agent 同源同送：审查方看不到人审裁决会把「按 notes 换向」误判为
  // 未经授权偏离 brief（真实事故：task-20260801-002 r2 blocker，白烧一轮修复）
  assert.ok(promptOf(calls[3]).includes('验收标准太含糊'), '第二稿 spec-verifier prompt 必须带 reject_notes');
  assert.ok(promptOf(calls[3]).includes('人审打回意见'), 'spec-verifier prompt 标明 notes 的人审权威属性');
  assert.ok(!promptOf(calls[1]).includes('验收标准太含糊'), '打回前的 r1 spec-verifier prompt 无 notes 段');
  // 两次 spec-agent spawn 各自留档
  assert.equal(env.readJson(env.dossier(id, 'spec-agent-r1.json')).raw.session_id, 'sess-spec-1');
  assert.equal(env.readJson(env.dossier(id, 'spec-agent-r2.json')).raw.session_id, 'sess-spec-2');
});
