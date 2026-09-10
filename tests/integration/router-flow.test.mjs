// 集成：router conductor 的主链（AC-001、002、012、013、016）。
// brief → router(maker) → maker → router(review) → reviewer → router(precommit) → precommit
//       → router(merge) → AWAIT_HUMAN(merge) → approve → DONE
// 断言的是「内核只做内核该做的事」：任务无 kind、runtime 字段就是 spec 列的那几个、
// 每轮有 router_decision、全程不 push、merge 是本地合并。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promptOf } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, reviewerStep, routerStep, specStep } from '../helpers/router-env.mjs';

function gitOut(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

test('AC-001/002/012/013/016：brief → maker → review → precommit → merge 闸 → approve → DONE', (t) => {
  const { env, id } = newRouterEnv(t);

  // AC-001：new 建的任务没有 kind，runtime 就是 spec 列的那几个字段。
  const created = env.findTask(id);
  assert.equal(created.runtime.stage, 'ROUTING');
  assert.ok(!Object.hasOwn(created.task, 'kind'), 'task.json 不应再有 kind');
  assert.deepEqual(Object.keys(created.runtime).sort(), [
    'awaiting', 'current_round', 'last_failure_type', 'plan_active', 'plan_source',
    'rate_limit', 'schema_version', 'spec_approved', 'spent_usd', 'stage', 'updated_at',
  ]);

  env.setScenario([
    routerStep('maker', { summary: 'bugfix 有复现与期望行为，brief 即 spec，直接实现' }),
    makerStep(),
    routerStep('review', { summary: 'maker 报全绿，整体冷审' }),
    reviewerStep(),
    routerStep('precommit', { tier: 'unit', summary: 'review 全 pass，跑 unit' }),
    routerStep('merge', { summary: 'need_review=false 且 need_precommit=false，申请合并' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const afterRun = env.findTask(id);
  assert.equal(afterRun.runtime.stage, 'AWAIT_HUMAN');
  assert.deepEqual(afterRun.runtime.awaiting, { kind: 'merge', round: 4 });

  // AC-012：进闸写 human-r<n>.json（kind / requested_by / summary / refs）。
  const gate = env.readJson(env.dossier(id, 'human-r4.json'));
  assert.equal(gate.kind, 'merge');
  assert.equal(gate.requested_by, 'kernel');
  assert.ok(gate.refs.some((r) => r.includes('reviewer-r2')), `refs 应含 reviewer 记录，实际 ${gate.refs}`);
  assert.ok(gate.refs.some((r) => r.includes('precommit-r3')), `refs 应含 precommit 记录，实际 ${gate.refs}`);

  // AC-002：每轮一条 router_decision。
  const decisions = env.events(id).filter((e) => e.type === 'router_decision');
  assert.deepEqual(decisions.map((d) => d.action), ['maker', 'review', 'precommit', 'merge']);
  assert.equal(decisions[2].tier, 'unit');
  assert.equal(env.events(id).filter((e) => e.type === 'action_rejected').length, 0);

  // precommit 记录盖了 H/B，且候选 worktree 已消失。
  const pre = env.readJson(env.dossier(id, 'precommit-r3.json'));
  assert.equal(pre.outcome, 'ok');
  assert.equal(pre.role, 'precommit');
  assert.equal(pre.head_sha, gitOut(env.targetDir, 'rev-parse', `task/${id}`));
  assert.equal(pre.base_sha, gitOut(env.targetDir, 'rev-parse', 'main'));
  assert.ok(!env.exists(path.join(env.root, 'worktrees', `${id}.precommit`)));

  // reviewer 的 spawn 记录盖了 head_sha（版本规则的判据）。
  assert.equal(
    env.readJson(env.dossier(id, 'reviewer-r2.json')).head_sha,
    gitOut(env.targetDir, 'rev-parse', `task/${id}`),
  );

  // AC-016：无 spec 的任务，maker / reviewer 以 brief 为契约。
  const calls = env.calls();
  assert.match(promptOf(calls[1]), /brief 即 spec/, 'maker prompt 应含「无 spec」段');
  assert.ok(!promptOf(calls[0]).includes('{{'), 'router prompt 不得残留占位');

  // 人闸批准：本地 merge → DONE，任务分支与 worktree 清干净。
  const approve = env.run('approve', id, '--message', `task ${id}: median 偶数分支`);
  assert.equal(approve.status, 0, approve.stderr);
  const done = env.findTask(id);
  assert.equal(done.box, 'done');
  assert.equal(done.runtime.stage, 'DONE');
  assert.equal(done.runtime.awaiting, null);
  assert.match(gitOut(env.targetDir, 'log', '-1', '--pretty=%s'), new RegExp(`task ${id}`));
  assert.equal(gitOut(env.targetDir, 'branch', '--list', `task/${id}`), '');
  assert.ok(!env.exists(env.worktree(id)));
  assert.ok(env.events(id).some((e) => e.type === 'merged'));

  // AC-006 的行为面：整条链没有任何 reflog 之外的远端操作——本仓测试用 grep 覆盖代码路径，
  // 这里补一条事实断言：目标仓没有任何 remote，push 若发生过必然失败。
  assert.equal(gitOut(env.targetDir, 'remote'), '');

  // 人的裁决进记录列表（AC-012）。
  const humanRecord = env.readJson(env.dossier(id, 'human-r4.json'));
  assert.equal(humanRecord.decision, 'approved');
  assert.equal(humanRecord.no_packages, false);
});

test('AC-013/016：spec 动作 → spec 闸 → approve 冻结 → maker 用冻结稿 + 人审补充约束', (t) => {
  const { env, id } = newRouterEnv(t, { brief: '给 stats 增加 percentile 能力，涉及新接口。\n' });
  const specBody = [
    '# median 偶数分支',
    '',
    '## 验收标准',
    '',
    '- AC-001: median([1,2,3,4]) 返回 2.5',
    '- AC-002: node --test 全绿',
    '',
  ].join('\n');

  env.setScenario([
    routerStep('spec', { summary: '新能力且改接口，先出 spec 交人审' }),
    specStep(specBody, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  assert.equal(env.run('run').status, 0);

  const gated = env.findTask(id);
  assert.equal(gated.runtime.stage, 'AWAIT_HUMAN');
  assert.equal(gated.runtime.awaiting.kind, 'spec');
  const gate = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.ok(gate.refs.includes(path.join('specs', `${id}.md`)), `refs 应含 spec 草稿，实际 ${gate.refs}`);
  assert.equal(gated.runtime.spec_approved, false);

  // spec-agent 的 cwd 是一次性只读 worktree，用完即弃。
  assert.ok(!env.exists(path.join(env.root, 'worktrees', `${id}.spec-ro`)));
  assert.match(env.calls()[1].cwd, new RegExp(`${id}\\.spec-ro$`), 'spec-agent 应在只读 worktree 里跑');

  const approve = env.run('approve', id, '--notes', '按最小改动做，不要动排序实现');
  assert.equal(approve.status, 0, approve.stderr);
  const approved = env.findTask(id);
  assert.equal(approved.runtime.stage, 'ROUTING');
  assert.equal(approved.runtime.spec_approved, true);
  assert.equal(env.readFile(env.dossier(id, 'spec.md')), specBody, '冻结稿逐字等于草稿');
  assert.ok(!env.exists(path.join(env.root, 'specs', `${id}.md`)), '草稿应已归档');
  assert.ok(fs.readdirSync(path.join(env.root, 'specs', 'archive')).some((n) => n.startsWith(id)));

  // 下一轮 maker：prompt 用冻结稿，并逐字带上人审补充约束（AC-016）。
  env.appendScenario([
    routerStep('maker'), makerStep(),
    routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' }),
  ]);
  assert.equal(env.run('run').status, 0);
  const makerCall = env.calls().find((c) => promptOf(c).includes('maker-r2.log.json'));
  assert.ok(makerCall, 'r2 应派出 maker');
  const makerPrompt = promptOf(makerCall);
  assert.match(makerPrompt, /AC-001: median\(\[1,2,3,4\]\) 返回 2\.5/);
  assert.match(makerPrompt, /按最小改动做，不要动排序实现/);
  assert.ok(!makerPrompt.includes('brief 即 spec'), '有 spec 时不注入「无 spec」段');
});
