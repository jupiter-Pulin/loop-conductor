// 集成：precommit 单步墙钟上限（precommitStepTimeoutMs）打在真实子进程上。
// 装死的命令必须被杀掉并记 timed_out / exit_code=null，而不是把 run 挂到天亮。
// 这条护栏就是旧 green gate 超时那一条，随 green gate 迁进 precommit 的测试步。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPrecommit } from '../../conductor/lib/precommit.mjs';
import { validateLog } from '../../conductor/lib/log-contract.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { makePrecommitEnv, CMD_OK } from '../helpers/precommit-env.mjs';

const HANG = `node -e 'setInterval(()=>{},1000)'`;

test('测试步装死 → precommitStepTimeoutMs 到点即杀，timed_out=true / exit_code=null / outcome fail', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitStepTimeoutMs: 300 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  env.writeSetupProfile({ build: CMD_OK, unit: HANG });

  const record = await runPrecommit({ cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit' });

  assert.equal(record.outcome, 'fail');
  assert.deepEqual(validateLog(record, 'precommit'), { ok: true, errors: [] });
  const unit = env.stepOf(record, 'unit');
  assert.equal(unit.status, 'fail');
  assert.equal(unit.timed_out, true);
  assert.equal(unit.exit_code, null);
  assert.equal(env.stepOf(record, 'build').status, 'ok', '超时只判超时的那一步');
  // 无论结果，候选 worktree 结束时必须不存在（AC-017）
  assert.equal(fs.existsSync(env.candidateWorktree), false);
});

test('build 步装死 → 同样被杀，后续步骤 not_run', async (t) => {
  const env = makePrecommitEnv(t, { cfgOverrides: { precommitStepTimeoutMs: 300 } });
  env.commitOnTaskBranch({ 'lib/stats.mjs': FIXED_STATS }, 'fix median even branch');
  env.writeSetupProfile({ build: HANG, unit: CMD_OK });

  const record = await runPrecommit({ cfg: env.cfg, id: env.id, task: env.task(), round: 1, tier: 'unit' });

  assert.equal(record.outcome, 'fail');
  assert.equal(env.stepOf(record, 'build').timed_out, true);
  assert.equal(env.stepOf(record, 'unit').status, 'not_run');
});
