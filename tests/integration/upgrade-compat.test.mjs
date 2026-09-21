// 集成：把升级接到已有任务上——不删任务、不重新编号、不丢案卷。
//
// 覆盖的验收场景：
//   · 当前待审任务在隔离副本上升级：原 spec、状态与历史保留，补齐摘要后能在正常审批后继续
//   · 升级前已经批准过 spec 的任务：补记版本哈希、补齐摘要；旧的 reviewer 记录不被当成新口径的放行依据
//   · 简单任务仍可直接按 brief 实现：不要求先有 spec、摘要与多份委派，最终安全门照旧
//   · 遗留（旧状态机）任务不因这次升级意外恢复执行资格
// 夹具按升级前的真实落盘形态手写：runtime 没有 spec_sha256、案卷里没有 digest/、没有委派台账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { promptOf } from '../helpers/env.mjs';
import {
  assignment, bigSpec, digestStep, dispatchStep, makeDigest, makerStep, reviewerStep, routerEnv, routerStep, workerStep,
} from '../helpers/router-env.mjs';
import { sha256Of } from '../../conductor/lib/spec-version.mjs';

const ID = 'task-20260920-001';
const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });

/** 升级前的案卷：r1 router 选了 spec，spec-agent 写完，任务停在 spec 人闸，已花 $1.378952。 */
function seedPreUpgradeTask(env, { spec, approved = false }) {
  const dir = env.writeRouterTask(ID, {
    title: '搭建多链 AMM 网站 v1 骨架', stage: approved ? 'ROUTING' : 'AWAIT_HUMAN', currentRound: 1, spent: 1.378952,
    awaiting: approved ? null : { kind: 'spec', round: 1 }, specApproved: approved,
    brief: '把 v1 决策落成 monorepo 骨架。\n',
  });
  const d = (name) => env.dossier(ID, name);
  fs.mkdirSync(env.dossier(ID), { recursive: true });
  fs.writeFileSync(d('router-r1.json'), JSON.stringify({ role: 'router', round: 1, started: '2026-09-20T12:30:40Z', done: '2026-09-20T12:32:00Z', ok: true, cost_usd: 0.31 }));
  fs.writeFileSync(d('router-r1.log.json'), JSON.stringify({ role: 'router', outcome: 'ok', action: 'spec', summary: '新能力，先出 spec 交人审' }));
  fs.writeFileSync(d('spec-r1.json'), JSON.stringify({ role: 'spec', round: 1, started: '2026-09-20T12:32:01Z', done: '2026-09-20T12:38:22Z', ok: true, cost_usd: 1.068952 }));
  fs.writeFileSync(d('spec-r1.log.json'), JSON.stringify({ role: 'spec', outcome: 'ok', summary: 'AC×6；工作包 1；待决问题 1' }));
  fs.writeFileSync(d('human-r1.json'), JSON.stringify({
    schema_version: 1, kind: 'spec', requested_by: 'kernel', summary: `spec 待审：AC×6（specs/${ID}.md）`, refs: [`specs/${ID}.md`],
    requested_at: '2026-09-20T12:38:22.421Z', ...(approved ? { decision: 'approved', notes: '升级前批准的', decided_at: '2026-09-20T13:00:00Z' } : {}),
  }));
  fs.writeFileSync(d('timeline.md'), '- 2026-09-20T12:30:37.494Z created (stage=ROUTING, brief 已落盘)\n- 2026-09-20T12:38:22.422Z stage → AWAIT_HUMAN (spec 闸（kernel）)\n');
  fs.writeFileSync(d('router-state.json'), JSON.stringify({ schema_version: 1, failures: [], last_action_rejected: null, fuse_reset_round: 0 }));
  if (approved) fs.writeFileSync(d('spec.md'), spec);
  else fs.writeFileSync(path.join(env.root, 'specs', `${ID}.md`), spec);
  return dir;
}

test('停在 spec 闸上的存量任务：升级后状态、原 spec、历史与成本原样；人改稿并正常批准后，先按获批内容补齐摘要再继续', (t) => {
  const env = routerEnv(t, { config: { digestEnabled: true } });
  const spec = bigSpec(6);
  seedPreUpgradeTask(env, { spec });
  const humanBefore = env.readFile(env.dossier(ID, 'human-r1.json'));

  // 升级后的第一次 run：任务在等人，什么都不该发生（不补摘要、不花钱、不改状态）。
  env.setScenario([]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.calls().length, 0);
  assert.equal(env.readRuntime(ID).stage, 'AWAIT_HUMAN');
  assert.equal(env.readFile(env.dossier(ID, 'human-r1.json')), humanBefore);
  const show = env.run('show', ID).stdout;
  assert.match(show, /阶段：等待人（spec 闸）/);
  assert.match(show, /摘要：missing/, '缺摘要是可见的，且有明确的补齐路径');

  // 人在升级期间继续改稿，然后正常批准。
  const revised = spec.replace('- AC-006: 第 6 条可观察行为成立', '- AC-006: 第 6 条可观察行为成立\n- AC-007: 升级期间人补的一条');
  fs.writeFileSync(path.join(env.root, 'specs', `${ID}.md`), revised);
  const approve = env.run('approve', ID, '--notes', '地址查不到的先留 null');
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, /这一版 spec 还没有可用摘要（missing）；下次 conductor run 会先自动补齐/);
  assert.equal(env.readRuntime(ID).spec_sha256, sha256Of(revised));

  env.setScenario([digestStep(makeDigest(revised)), stop()]);
  assert.equal(env.run('run').status, 0);
  const [digestCall, routerCall] = env.calls();
  assert.match(promptOf(digestCall), /digest-r2\.log\.json/, '轮次接着原来的编号走，不覆盖 r1 的案卷');
  assert.ok(promptOf(digestCall).includes(sha256Of(revised)), '摘要对的是最终获批内容');
  assert.match(promptOf(routerCall), /AC-007 AC-007 的要点/);
  assert.match(promptOf(routerCall), /notes="地址查不到的先留 null"/, '人的裁决逐字在场');

  // 历史与成本都在：r1 的记录没被动，成本在原来的基础上累加。
  assert.ok(env.exists(env.dossier(ID, 'spec-r1.log.json')) && env.exists(env.dossier(ID, 'router-r1.log.json')));
  assert.ok(env.readRuntime(ID).spent_usd > 1.378952);
  assert.match(promptOf(routerCall), /r1 spec .*outcome=ok/);
  assert.equal(env.findTask(ID).task.id, ID, '同一个任务、同一个编号');
});

test('升级前已批准 spec 的任务：第一次推进时补记版本哈希并补齐摘要；旧 reviewer 记录（无台账）不足以放行 merge', (t) => {
  const env = routerEnv(t, { config: { digestEnabled: true } });
  const spec = bigSpec(3);
  seedPreUpgradeTask(env, { spec, approved: true });
  assert.equal(env.readRuntime(ID).spec_sha256, undefined);

  env.setScenario([
    digestStep(makeDigest(spec)),
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep({ summary: 'AC-001 pass\nAC-002 pass\nAC-003 pass' }), // 旧写法：只有 summary，没有判决台账
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '旧口径下这样就能合了' }),
    stop(),
  ]);
  assert.equal(env.run('run', '--continuous').status, 0);
  assert.equal(env.readRuntime(ID).spec_sha256, sha256Of(spec), '补记获批版本');
  assert.match(env.readFile(env.dossier(ID, 'timeline.md')), /补记获批 spec 的版本哈希/);
  const rejected = env.events(ID).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /need_review=true need_precommit=false（review：已判 0\/3/, '只有 summary 自述、没有逐条判决 → 不放行');
});

test('简单任务照旧走直通路径：无 spec、无摘要、无委派，brief → maker → review → precommit → merge 闸', (t) => {
  const env = routerEnv(t, { config: { digestEnabled: true } });
  const briefPath = env.writeBrief('median 的偶数分支应取中间两数平均；补一条在旧代码上会失败的测试。\n');
  const created = env.run('new', '--title', 'median 偶数分支', '--brief', briefPath);
  const id = /id: (task-\d{8}-\d{3})/.exec(created.stdout)[1];
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'), reviewerStep(),
    routerStep('precommit', { tier: 'unit' }),
    routerStep('merge', { summary: '可以合并' }),
  ]);
  assert.equal(env.run('run', '--continuous').status, 0);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'merge');
  assert.equal(env.calls().some((c) => /digest-r\d+/.test(promptOf(c))), false, '没有 spec 就没有摘要会话');
  assert.equal(env.exists(env.dossier(id, 'digest')), false);
  assert.equal(fs.readdirSync(env.dossier(id)).some((n) => n.startsWith('dispatch-')), false);
});

test('无 spec 的任务也能用 dispatch（brief 即契约）：委派照样逐字到达，worker 的 prompt 带 brief 全文', (t) => {
  const env = routerEnv(t);
  const briefPath = env.writeBrief('给 stats 加 percentile。\n');
  const id = /id: (task-\d{8}-\d{3})/.exec(env.run('new', '--title', 'percentile', '--brief', briefPath).stdout)[1];
  env.setKeyed({ 'worker-impl': [workerStep({ files: { 'lib/p.mjs': 'export const p = 1;\n' } })] });
  env.setScenario([dispatchStep([assignment('impl')]), stop()]);
  assert.equal(env.run('run').status, 0);
  const prompt = promptOf(env.calls().find((c) => c.key === 'worker-impl'));
  assert.match(prompt, /\[契约\] 本任务没有 spec，brief 即契约/);
  assert.match(prompt, /# 任务 brief（即契约）\n\n给 stats 加 percentile。/);
});

test('遗留任务不因升级恢复执行资格：run 跳过它，新动词一律拒绝，案卷仍可读', (t) => {
  const env = routerEnv(t);
  env.writeTask('task-20260611-001', { stage: 'READY' });
  env.setScenario([]);
  const run = env.run('run', '--continuous');
  assert.equal(run.status, 0);
  assert.match(run.stderr, /未知 stage "READY"，跳过/);
  assert.equal(env.calls().length, 0);
  for (const verb of [['pause'], ['unpause'], ['digest'], ['retry'], ['approve']]) {
    const r = env.run(...verb, 'task-20260611-001');
    assert.notEqual(r.status, 0, `${verb[0]} 应拒绝遗留任务`);
  }
  assert.match(env.run('status').stdout, /task-20260611-001\s+READY/);
  assert.equal(env.run('show', 'task-20260611-001').status, 0, 'show 只读，照常可用');
});
