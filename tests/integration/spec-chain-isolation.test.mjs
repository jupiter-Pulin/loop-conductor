// 集成：spec/feasibility 链物理隔离（R5-H19）。契约：
//   1) 默认关 = 旧行为：spec 链 cwd 是真 target 仓库——越轨相对路径写物理落在用户 checkout
//      （本 case 即降级面的机械对照证明）；不产生 .spec-ro worktree；
//   2) 开启：spec-agent / spec-verifier cwd 换到 worktrees/<id>.spec-ro 一次性 detached
//      worktree；越轨写到不了真仓库；spawn 后 worktree 即弃无残留；交付面（specs/<id>.md
//      绝对路径直写）与全链推进不受影响，approve 后直达 AWAIT_HUMAN_MERGE。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, specVerifierStep, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const SPEC_DRAFT = [
  '# spec 草稿 v1',
  '',
  '## 验收标准',
  '',
  '- AC-001 median 偶数分支取平均',
  '- AC-002 node --test 全绿',
  '',
].join('\n');

/** feature 任务 + spec-agent 剧本（直写绝对路径草稿 + 越轨相对路径写 stray-note.md）。 */
function setupFeatureTask(env, { withFullChain = false } = {}) {
  env.writeApprovedSetupProfile();
  const created = env.run('new', '--kind', 'feature', '--title', 'median 统计能力');
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, created.stderr);
  const specAbs = path.join(env.root, 'specs', `${id}.md`);
  const steps = [
    {
      actions: [
        { type: 'writeFile', path: specAbs, content: SPEC_DRAFT },       // 合法交付：编排侧绝对路径
        { type: 'writeFile', path: 'stray-note.md', content: '越轨写' }, // 越轨：相对 cwd
      ],
      session_id: 'sess-spec-1', cost: 0.03, result: 'spec written',
    },
    specVerifierStep(1, 'pass', { cost: 0.02 }),
  ];
  if (withFullChain) {
    steps.push(
      { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'done' },
      verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.02 }),
    );
  }
  env.setScenario(steps);
  return id;
}

test('契约1：默认关——cwd 是真仓库，越轨写物理落在用户 checkout（降级面对照）', (t) => {
  const env = makeEnv(t); // 不设 specChainIsolationEnabled → 默认 false
  const id = setupFeatureTask(env);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL');

  assert.ok(env.calls()[0].cwd.endsWith('target'), 'spec-agent cwd = 真 target 仓库');
  assert.ok(
    fs.existsSync(path.join(env.targetDir, 'stray-note.md')),
    '旧行为：越轨相对路径写物理落在真仓库（hook 白名单是唯一防线）',
  );
  assert.ok(!fs.existsSync(path.join(env.root, 'worktrees', `${id}.spec-ro`)), '默认关不产生隔离 worktree');
});

test('契约2：开启——cwd 换一次性 worktree，真仓库无痕、无残留、全链推进不受影响', (t) => {
  const env = makeEnv(t, { config: { specChainIsolationEnabled: true } });
  const id = setupFeatureTask(env, { withFullChain: true });

  const run1 = env.run('run');
  assert.equal(run1.status, 0, run1.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_SPEC_APPROVAL', '隔离不影响 spec 链推进');

  const isoWt = path.join(env.root, 'worktrees', `${id}.spec-ro`);
  // fake-claude 记录的是 process.cwd() 的 realpath（macOS /var → /private/var），用后缀对账
  const isoSuffix = path.join('worktrees', `${id}.spec-ro`);
  const specCall = env.calls()[0];
  const svCall = env.calls()[1];
  assert.ok(specCall.cwd.endsWith(isoSuffix), `spec-agent cwd = 隔离 worktree（实际 ${specCall.cwd}）`);
  assert.ok(svCall.cwd.endsWith(isoSuffix), `spec-verifier cwd = 隔离 worktree（实际 ${svCall.cwd}）`);

  assert.ok(!fs.existsSync(path.join(env.targetDir, 'stray-note.md')), '越轨写到不了真仓库（物理隔离）');
  assert.ok(!fs.existsSync(isoWt), 'spawn 后一次性 worktree 已清理，无残留');
  assert.equal(
    fs.readFileSync(path.join(env.root, 'specs', `${id}.md`), 'utf8'), SPEC_DRAFT,
    '交付面不受影响：草稿仍写到编排侧绝对路径',
  );
  const timeline = fs.readFileSync(env.dossier(id, 'timeline.md'), 'utf8');
  assert.match(timeline, /spec 链隔离：spec-agent cwd → 一次性 worktree/);
  assert.match(timeline, /spec 链隔离：spec-verifier cwd → 一次性 worktree/);

  // approve 后全链直达 AWAIT_HUMAN_MERGE（maker/verifier 不受 spec 链隔离影响）
  assert.equal(env.run('approve', id).status, 0);
  const run2 = env.run('run');
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.ok(!fs.existsSync(isoWt), '全链结束仍无隔离 worktree 残留');
});
