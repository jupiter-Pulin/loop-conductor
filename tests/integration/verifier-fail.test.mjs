// 集成（新）：verifier 合法 fail → conductor 生成「最小」repair-context（只含失败/未知 AC），
// maker repair prompt 只喂结构化 repair-context，绝不含 verify-r<n>.md 人读叙事（契约 §7，AC-012/013）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, promptOf, criterion, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };
// 哨兵：放在「通过」AC 的 reason 里——它会进 verify-r1.md 叙事，但不该进 repair-context（只收失败 AC）。
const SENTINEL = 'SENTINEL_NARRATIVE_DO_NOT_LEAK_42';

// 合法 fail verdict：AC-001 pass（reason 带哨兵）、AC-002 fail。
const FAIL_VERDICT = JSON.stringify({
  schema_version: 1,
  round: 1,
  overall: 'fail',
  criteria_results: [
    criterion('AC-001', { status: 'pass', reason: `${SENTINEL} 这条已满足` }),
    criterion('AC-002', { status: 'fail', reason: '偶数分支仍未取平均' }),
  ],
  non_ac_findings: [],
});

test('verifier fail：repair-context 只含失败 AC，repair prompt 不泄露叙事', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260620-801';
  env.writeTask(id);
  env.setScenario([
    { actions: [FIX], session_id: 'sess-m1', cost: 0.1, result: 'r1' }, // 0 maker r1（green 绿）
    { cost: 0.02, result: FAIL_VERDICT },                               // 1 verifier r1 合法 fail
    { actions: [FIX], session_id: 'sess-m1', cost: 0.08, result: 'r2' }, // 2 maker r2（resume 修复）
    verifierStep(2, { 'AC-001': 'pass', 'AC-002': 'pass' }),            // 3 verifier r2 pass
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // repair-context-r1：verifier 源，只含失败 AC-002（AC-013）
  const ctx = env.readJson(env.dossier(id, 'repair-context-r1.json'));
  assert.equal(ctx.source, 'verifier');
  assert.deepEqual(ctx.failed_criteria.map((c) => c.ac_id), ['AC-002'], '只含失败/未知 AC');
  assert.equal(ctx.green_gate, null);

  // 叙事 verify-r1.md 确实含哨兵（证明哨兵进了 verifier 输出）
  assert.match(env.readFile(env.dossier(id, 'verify-r1.md')), new RegExp(SENTINEL));

  // maker r2（call 2）的 repair prompt：含 repair-context 与失败 AC，但绝不含叙事哨兵（AC-012）
  const calls = env.calls();
  const repairPrompt = promptOf(calls[2]);
  assert.ok(repairPrompt.includes('repair-context'), 'repair prompt 含结构化 repair-context');
  assert.ok(repairPrompt.includes('AC-002'), 'repair prompt 含失败 AC');
  assert.ok(!repairPrompt.includes(SENTINEL), 'repair prompt 不得泄露 verify-r1.md 叙事');

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 1);
});
