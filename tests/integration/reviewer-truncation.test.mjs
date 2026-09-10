// 集成：reviewer 增量协议的端到端（AC-010）。
// reviewer 判完一条写一条，撞 max-turns 时盘上留下的是「带未判清单的合法记录」，不是空文件。
// 内核照单全收：product=ok、outcome=fail、truncated=true，need_review 保持 true；不自动重派。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptOf } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

const PARTIAL = 'AC-001 pass\nAC-002 pass\nAC-003 fail lib/stats.mjs:8 偶数分支未取平均\n未判: AC-004, AC-005';

test('AC-010：reviewer 写完部分判决后撞 max-turns → 记录 product=ok / truncated=true，need_review 仍为 true', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'), makerStep(),
    routerStep('review'),
    {
      cost: 4.1,
      actions: [
        { type: 'writeLog', content: { role: 'reviewer', outcome: 'fail', tier: 'unit', summary: PARTIAL } },
        { type: 'truncateAfterWrite' },
      ],
    },
    routerStep('merge', { summary: '被截断的 review 不算通过' }), // 必被拒：need_review=true
    routerStep('human', { summary: '停在这里' }),
  ]);
  assert.equal(env.run('run').status, 0);

  const spawn = env.readJson(env.dossier(id, 'reviewer-r2.json'));
  assert.equal(spawn.cost_usd, 4.1, '撞 max-turns 也花了钱，照记');
  assert.equal(spawn.raw.subtype, 'error_max_turns');

  const log = env.readJson(env.dossier(id, 'reviewer-r2.log.json'));
  assert.equal(log.outcome, 'fail');
  assert.match(log.summary, /未判: AC-004, AC-005/);

  // 内核不重派 reviewer：整条链里 reviewer 只被 spawn 过一次。
  assert.ok(!env.exists(env.dossier(id, 'reviewer-r3.json')));

  // 下一轮 router 完整看得到这条记录（含 truncated 与未判清单）。
  const routerPrompt = promptOf(env.calls().at(-2));
  assert.match(routerPrompt, /reviewer\s+outcome=fail\s+tier=unit/);
  assert.match(routerPrompt, /truncated=yes/);
  assert.match(routerPrompt, /product=ok/);
  assert.match(routerPrompt, /未判: AC-004, AC-005/);
  assert.match(routerPrompt, /need_review=true/);

  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /need_review=true/);
});
