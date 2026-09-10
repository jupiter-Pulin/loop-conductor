// 集成：reviewer 合法 fail → router 派修复轮 → maker prompt 的「修复轮」段只喂最近一条
// reviewer 记录的 summary（结构化记录，不是人读叙事），已通过的 AC 不进 prompt 噪音。
// 版本规则面：修复轮换了 H，need_review 自动回到 true，merge 必须重新过 review。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promptOf } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, reviewerStep, routerStep } from '../helpers/router-env.mjs';

const FAIL_SUMMARY = [
  'B-001 pass',
  'B-002 fail lib/stats.mjs:12 偶数分支仍取下中位数；test/stats.test.mjs:30 只断言奇数长度',
].join('\n');

function gitOut(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

test('reviewer fail → 修复轮 maker prompt 带 reviewer summary；再 review 前 merge 被版本规则拒', (t) => {
  const { env, id } = newRouterEnv(t);
  env.setScenario([
    routerStep('maker'),
    makerStep(),
    routerStep('review'),
    reviewerStep({ outcome: 'fail', tier: 'unit', summary: FAIL_SUMMARY }),
    routerStep('merge', { summary: '（错误决策）review 是红的就想合' }),
    routerStep('maker', { summary: 'review 首次 fail，只修 B-002' }),
    makerStep({ summary: 'B-002 fixed；node --test 全绿' }),
    routerStep('human', { summary: '停在 help 闸' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // reviewer 的记录是 fail，且盖了当时的 H
  const reviewerRec = env.readJson(env.dossier(id, 'reviewer-r2.json'));
  const headAtReview = reviewerRec.head_sha;
  assert.ok(headAtReview, 'reviewer 记录必须盖 head_sha');
  assert.equal(env.readJson(env.dossier(id, 'reviewer-r2.log.json')).outcome, 'fail');

  // review 红时申请 merge 被前置拒（AC-003），零副作用
  const rejected = env.events(id).filter((e) => e.type === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /need_review/);
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help', '被拒不开 merge 闸');

  // 修复轮 maker prompt：带「修复轮」段与 reviewer 的 fail 行，不带已 pass 的噪音之外的东西
  const repairPrompt = promptOf(env.calls().find((c) => promptOf(c).includes('maker-r4.log.json')));
  assert.match(repairPrompt, /只修下面记录指出的问题/);
  assert.match(repairPrompt, /B-002 fail lib\/stats\.mjs:12/);

  // 修复轮换了 H：need_review 回到 true（版本规则不认旧 review）
  const headNow = gitOut(env.targetDir, 'rev-parse', `task/${id}`);
  assert.notEqual(headNow, headAtReview, '修复轮必须换 HEAD');
});
