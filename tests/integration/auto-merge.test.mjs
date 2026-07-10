// 集成：H33 机械全绿自动本地合并（config `autoMergeEnabled`，默认关）。契约：
//   1) 默认关：verdict pass 停 AWAIT_HUMAN_MERGE，零 automerge 产物（旧行为逐字节不变）；
//   2) 开但谓词不放行（本例 verifierShadowEnabled 未开 = 无第二意见，fail-closed）：
//      落 automerge-decision（eligible=false + reasons）+ timeline + 事件，任务留人审闸门；
//   3) 开且机械全绿（per-AC 全证明 + 守卫零命中 + anchors hard=0 + shadow 零分歧 + 规模达标）：
//      本地 merge → 归档 done + DONE 事件 note=auto-merged；绝不 push（本仓无 remote，机械成立）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeEnv, verifierStep, criterion } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-codex.mjs');

const GUARD_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.mjs';

test('median of odd-length array stays stable', () => {
  assert.equal(median([3, 1, 2]), 2);
});
`;

const PROPOSAL = { subject: 'fix(stats): correct even-length median', body: 'auto-merge integration fixture.' };

/** maker 步骤：修 bug + 守卫测试 + 合法 AC→测试映射（两条 AC 都有机械证明）。 */
const MAKER_STEP = {
  actions: [
    { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
    { type: 'writeFile', path: 'test/guard.test.mjs', content: GUARD_TEST },
    {
      type: 'writeFile',
      path: '.will-workflow/ac-tests.json',
      content: JSON.stringify({
        schema_version: 1,
        entries: [
          { ac_id: 'AC-001', command: 'node --test test/stats.test.mjs', expect: 'fail_on_baseline' },
          { ac_id: 'AC-002', command: 'node --test test/guard.test.mjs', expect: 'pass_on_baseline' },
        ],
      }, null, 2),
    },
  ],
  session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 守卫 + 映射',
};

function shadowVerdict(round, statuses) {
  return {
    schema_version: 1,
    round,
    overall: Object.values(statuses).every((s) => s === 'pass') ? 'pass' : 'fail',
    criteria_results: Object.entries(statuses).map(([acId, s]) => criterion(acId, { status: s, reason: `shadow 裁决 ${s}` })),
    non_ac_findings: [],
  };
}

function wireCodex(env, steps) {
  const script = path.join(env.root, 'fake-codex-scenario.json');
  fs.writeFileSync(script, JSON.stringify(steps));
  const log = path.join(env.root, 'fake-codex.log');
  return { overrides: { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_SCRIPT: script, FAKE_CODEX_LOG: log }, log };
}

test('契约1：默认关——verdict pass 停人审闸门，零 automerge 产物', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260708-990';
  env.writeTask(id);
  env.setScenario([MAKER_STEP, verifierStep(1)]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(!env.exists(env.dossier(id, 'verify-r1.automerge-decision.json')), '默认关零 automerge 产物');
});

test('契约2：开但谓词不放行——decision 落盘留人审，reasons 点名缺哪门', (t) => {
  const env = makeEnv(t, {
    config: {
      autoMergeEnabled: true,
      testChangeGuardEnabled: true,
      verifierEvidenceAnchorsMode: 'observe',
      eventsLogEnabled: true,
      // verifierShadowEnabled 故意不开：无第二意见必须 fail-closed
    },
  });
  const id = 'task-20260708-991';
  env.writeTask(id);
  env.setScenario([MAKER_STEP, verifierStep(1)]);
  assert.equal(env.run('run').status, 0);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '不放行 = 留人审闸门');

  const decision = env.readJson(env.dossier(id, 'verify-r1.automerge-decision.json'));
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((r) => r.includes('verifierShadowEnabled 未开')), JSON.stringify(decision.reasons));

  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ev = events.filter((e) => e.type === 'automerge_decision');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].eligible, false);
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /auto-merge r1：不放行/);
});

test('契约3：开且机械全绿——本地 merge 归档 done，事件 note=auto-merged', (t) => {
  const env = makeEnv(t, {
    config: {
      autoMergeEnabled: true,
      testChangeGuardEnabled: true,
      verifierEvidenceAnchorsMode: 'observe',
      verifierShadowEnabled: true,
      eventsLogEnabled: true,
    },
  });
  const id = 'task-20260708-992';
  env.writeTask(id);
  env.setScenario([
    MAKER_STEP,
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }),
    { cost: 0.01, result: JSON.stringify(PROPOSAL) }, // committer 提案（auto-merge 内消费）
  ]);
  const { overrides } = wireCodex(env, [{ lastMessage: shadowVerdict(1, { 'AC-001': 'pass', 'AC-002': 'pass' }) }]);

  const run = env.runWithEnv(overrides, 'run');
  assert.equal(run.status, 0, run.stderr);

  // 任务已归档 done、stage=DONE
  const after = env.findTask(id);
  assert.equal(after.box, 'done');
  assert.equal(after.runtime.stage, 'DONE');

  // 谓词产物：eligible=true 零 reasons
  const decision = env.readJson(env.dossier(id, 'verify-r1.automerge-decision.json'));
  assert.deepEqual({ eligible: decision.eligible, reasons: decision.reasons }, { eligible: true, reasons: [] });

  // merge 真实发生：target main 顶端是 committer 文案的 merge commit；task 分支已删、worktree 已清
  const subjects = execFileSync('git', ['-C', env.targetDir, 'log', '--format=%s'], { encoding: 'utf8' });
  assert.match(subjects, /fix\(stats\): correct even-length median/);
  const branches = execFileSync('git', ['-C', env.targetDir, 'branch', '--list', `task/${id}`], { encoding: 'utf8' });
  assert.equal(branches.trim(), '', 'task 分支已删除');
  assert.ok(!fs.existsSync(path.join(env.root, 'worktrees', id)), 'worktree 已清理');

  // 事件链：automerge_decision(eligible) + DONE note=auto-merged；timeline 记谓词通过
  const events = fs.readFileSync(env.dossier(id, 'events.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const dec = events.filter((e) => e.type === 'automerge_decision');
  assert.equal(dec.length, 1);
  assert.equal(dec[0].eligible, true);
  const done = events.filter((e) => e.type === 'stage' && e.stage === 'DONE');
  assert.equal(done.length, 1);
  assert.equal(done[0].note, 'auto-merged');
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /auto-merge r1：机械全绿谓词通过/);
  assert.match(timeline, /（auto-merge，机械全绿）/);
});
