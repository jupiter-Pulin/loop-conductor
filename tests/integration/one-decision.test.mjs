// 集成：一次裁决一次有效（Invariant 7 / AC-042）。
// 人在闸上给过的裁决进「已裁决事项」；router 拿逐字相同的 summary 再求助一次 → duplicate_help。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promptOf } from '../helpers/env.mjs';
import { newRouterEnv, routerStep, specStep } from '../helpers/router-env.mjs';

const SPEC_BODY = '# t\n\n## 验收标准\n\n- AC-001: median([1,2,3,4]) 返回 2.5\n';
const HELP = '这个改动要不要顺便把 percentile 也做了？请裁决';

test('AC-042：同一句 help summary 第一次开闸、第二次被 duplicate_help 拒；已裁决事项逐字进事实段', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('spec'),
    specStep(SPEC_BODY, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.run('approve', id, '--notes', '按 4 包做，不再拆细').status, 0);

  // 第一次 human：开闸。
  env.appendScenario([routerStep('human', { summary: HELP })]);
  assert.equal(env.run('run').status, 0);
  const first = env.findTask(id);
  assert.equal(first.runtime.awaiting.kind, 'help');
  assert.equal(env.readJson(env.dossier(id, `human-r${first.runtime.awaiting.round}.json`)).requested_by, 'router');

  assert.equal(env.run('resume', id, '--notes', '不做 percentile').status, 0);

  // 第二次同一句：被拒，不开闸。
  env.appendScenario([
    routerStep('human', { summary: HELP }),
    routerStep('human', { summary: '换一句新的求助：命名要 percentile 还是quantile' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'duplicate_help');

  // 措辞不同的新求助照常开闸。
  const after = env.findTask(id);
  assert.equal(after.runtime.awaiting.kind, 'help');
  assert.match(
    env.readJson(env.dossier(id, `human-r${after.runtime.awaiting.round}.json`)).summary,
    /命名要 percentile/,
  );

  // 事实段逐条列出全部 human 记录的 kind / decision / notes 原文（Invariant 7 的执法依据）。
  const lastRouterPrompt = promptOf(env.calls().at(-1));
  assert.match(lastRouterPrompt, /已裁决事项（同一事项不得再次 human）/);
  assert.match(lastRouterPrompt, /kind=spec decision=approved notes="按 4 包做，不再拆细"/);
  assert.match(lastRouterPrompt, /kind=help decision=resumed notes="不做 percentile"/);
});
