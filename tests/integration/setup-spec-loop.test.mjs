import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, specVerifierStep, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const SETUP_PROFILE = '# Setup Profile\n\n- Use `node --test`.\n- Keep test/ read-only.\n';
const SPEC_BAD = '# spec bad\n\n## 验收标准\n\n- 做好\n';
const SPEC_BAD2 = '# spec bad2\n\n## 验收标准\n\n- 更好一点\n';
const SPEC_BAD3 = '# spec bad3\n\n## 验收标准\n\n- 还是太泛\n';
const SPEC_GOOD = '# spec good\n\n## 验收标准\n\n- AC-001 `node --test` 全绿\n';

test('首次 target repo 无 approved setup profile：setup-agent → approve-setup → 原任务流程', (t) => {
  const env = makeEnv(t);
  env.setScenario([
    { session_id: 'sess-setup-1', cost: 0.04, result: SETUP_PROFILE },
    {
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-maker-1',
      cost: 0.10,
      result: 'fixed',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { session_id: 'sess-verifier-1' }),
  ]);

  const created = env.run('new', '--kind', 'bugfix', '--title', 'median 偶数分支错误');
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  assert.equal(env.findTask(id).runtime.stage, 'NEEDS_TARGET_SETUP');
  env.writeQueueSpec(id, [
    '# median 偶数分支错误',
    '',
    '## 验收标准',
    '',
    '- AC-001 median 偶数长度取平均',
    '- AC-002 `node --test` 全绿',
    '',
  ].join('\n'));

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SETUP_APPROVAL');
  assert.equal(env.calls().length, 1, '只 spawn setup-agent，不得提前 spawn maker');
  const setupCall = env.calls()[0];
  assert.ok(setupCall.cwd.endsWith('target'), 'setup-agent cwd 是 target repo');
  assert.equal(setupCall.argv[setupCall.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(env.readJson(env.dossier(id, 'setup-r1.json')).raw.session_id, 'sess-setup-1');

  const profileDirs = fs.readdirSync(path.join(env.root, 'target-profiles'));
  assert.equal(profileDirs.length, 1);
  const profileDir = path.join(env.root, 'target-profiles', profileDirs[0]);
  assert.equal(fs.readFileSync(path.join(profileDir, 'setup-profile.draft.md'), 'utf8'), SETUP_PROFILE);

  const approved = env.run('approve-setup', id);
  assert.equal(approved.status, 0, approved.stderr);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(fs.readFileSync(path.join(profileDir, 'setup-profile.md'), 'utf8'), SETUP_PROFILE);
  assert.equal(env.readJson(path.join(profileDir, 'setup-profile.json')).approved, true);
  assert.equal(env.calls().length, 3, 'setup + maker + verifier');
});

test('spec-verifier fail 两次修复，第三次 fail 冷启动新 spec-agent 并注入报告上下文', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', '统计能力 spec');
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id);
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  const specStep = (content, session_id) => ({
    actions: [{ type: 'writeFile', path: specAbs, content }],
    session_id, cost: 0.03, result: 'spec written',
  });
  env.setScenario([
    specStep(SPEC_BAD, 'sess-spec-1'),
    specVerifierStep(1, 'fail', { session_id: 'sess-sv-1' }),
    specStep(SPEC_BAD2, 'sess-spec-2'),
    specVerifierStep(2, 'fail', { session_id: 'sess-sv-2' }),
    specStep(SPEC_BAD3, 'sess-spec-3'),
    specVerifierStep(3, 'fail', { session_id: 'sess-sv-3' }),
    specStep(SPEC_GOOD, 'sess-spec-4'),
    specVerifierStep(4, 'pass', { session_id: 'sess-sv-4' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_SPEC_APPROVAL');
  assert.equal(after.runtime.spec_epoch, 2, '第三次 fail 后进入第二个 spec epoch');
  assert.equal(after.runtime.spec_miss_count, 0, '冷启动新 spec-agent 后重置 spec miss');
  assert.equal(after.runtime.current_spec_round, 4);
  assert.equal(fs.readFileSync(path.join(env.root, 'specs', `${id}.md`), 'utf8'), SPEC_GOOD);

  for (const n of [1, 2, 3]) {
    assert.equal(env.readJson(env.dossier(id, `spec-verify-r${n}.verdict.json`)).overall, 'fail');
    assert.ok(env.exists(env.dossier(id, `spec-verify-r${n}.md`)), `spec-verify-r${n}.md report exists`);
    assert.equal(env.readJson(env.dossier(id, `spec-repair-context-r${n}.json`)).source, 'spec_verifier');
  }
  assert.equal(env.readJson(env.dossier(id, 'spec-verify-r4.verdict.json')).overall, 'pass');
  const calls = env.calls();
  assert.equal(calls.length, 8);
  const coldRestartPrompt = promptOf(calls[6]);
  assert.ok(coldRestartPrompt.includes('Prior spec-verifier reports'), '新 spec-agent 收到历史报告区块');
  assert.ok(coldRestartPrompt.includes('Spec Verify Report r3'), '新 spec-agent 收到第三次失败报告');
  assert.ok(coldRestartPrompt.includes('feasibility-study context'), '预留 feasibility-study 上下文');
  // 修复轮 Read+Edit 指引：交付文件已存在时盲 Write 会撞 harness Read-before-Write 校验
  // （真实事故：task-20260801-001 r5 首次 Write 11.8KB 被拒，整份 payload 白烧）
  assert.ok(promptOf(calls[2]).includes('修复轮注意'), '修复轮 prompt 附 Read+Edit 指引');
  assert.ok(!promptOf(calls[0]).includes('修复轮注意'), '首稿 draft prompt 不带修复轮指引');
  assert.ok(!coldRestartPrompt.includes('修复轮注意'), '冷启动重写 prompt 不带修复轮指引');
  assert.ok(fs.readdirSync(path.join(env.root, 'specs', 'archive')).some((n) => n.includes('spec-fail-r3')));
});
