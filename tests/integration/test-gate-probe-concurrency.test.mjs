// 集成：per-AC 定向探针的有界并发（testGateProbeConcurrency，默认 1 = 串行，行为与旧实现
// 逐字节一致）。并发是 opt-in：映射命令共享同一个探针 worktree，只有当命令之间无共享端口/
// 临时文件/全局状态时才允许 >1（由使用者对具体 target repo 负责）。本测试钉住四条硬约束：
//   并发上限生效、失败隔离（单条 error 不拖垮其他条目）、输出顺序稳定（按冻结 spec 的 AC
//   枚举序，与完成先后无关）、默认串行（不配置就没有重叠执行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeEnv, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const mappingJson = (entries) => JSON.stringify({ schema_version: 1, entries }, null, 2);

/**
 * 探针命令：把 start/end 时间戳记到 root 下的探针日志（绝对路径，探针 worktree 会被清理），
 * sleep 后按指定码退出。每条命令写各自的行，无共享文件写竞争（append 原子）。
 */
function probeCmd(logPath, acId, { sleepMs, exitCode }) {
  const js = [
    "const fs=require('fs');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, 'start ${acId} '+Date.now()+'\\n');`,
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(logPath)}, 'end ${acId} '+Date.now()+'\\n');process.exit(${exitCode});}, ${sleepMs});`,
  ].join('');
  return `node -e "${js.replace(/"/g, '\\"')}"`;
}

function parseProbeLog(logPath) {
  const spans = {};
  for (const line of fs.readFileSync(logPath, 'utf8').trim().split('\n')) {
    const [kind, acId, ts] = line.split(' ');
    spans[acId] ??= {};
    spans[acId][kind] = Number(ts);
  }
  return spans;
}

const SPEC_3AC = [
  '# 三条可并发探测的 AC',
  '',
  '## 验收标准',
  '',
  '- AC-001: 行为一。（验证级别：单元）',
  '- AC-002: 行为二。（验证级别：单元）',
  '- AC-003: 行为三。（验证级别：单元）',
  '',
].join('\n');

test('testGateProbeConcurrency=2：并发上限生效、顺序稳定、失败隔离', (t) => {
  const env = makeEnv(t, { config: { testGateProbeConcurrency: 2 } });
  const id = 'task-20260707-920';
  const logPath = path.join(env.root, 'probe-timing.log');
  env.writeTask(id, { bodyAc: SPEC_3AC });
  env.setScenario([
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            // AC-001 睡得最久：若顺序不稳，完成最晚的它会掉到 per_ac 末尾
            { ac_id: 'AC-001', command: probeCmd(logPath, 'AC-001', { sleepMs: 700, exitCode: 1 }), expect: 'fail_on_baseline' },
            { ac_id: 'AC-002', command: probeCmd(logPath, 'AC-002', { sleepMs: 150, exitCode: 1 }), expect: 'fail_on_baseline' },
            // 失败隔离：AC-003 命令本身崩溃（exit 7 非 0/1 也一样是红）→ 该条照常裁决，不拖垮别人
            { ac_id: 'AC-003', command: probeCmd(logPath, 'AC-003', { sleepMs: 150, exitCode: 7 }), expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 并发映射',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.equal(tg.mode, 'per-ac');
  // 顺序稳定：按冻结 spec 的 AC 枚举序，与完成先后无关
  assert.deepEqual(tg.per_ac.map((e) => e.ac_id), ['AC-001', 'AC-002', 'AC-003']);
  assert.deepEqual(tg.per_ac.map((e) => e.verdict), ['falsifies', 'falsifies', 'falsifies']);
  assert.equal(tg.per_ac[2].exit_code, 7, '失败隔离：单条崩溃码原样留痕');

  const spans = parseProbeLog(logPath);
  // 并发确凿证据：AC-002 在 AC-001 结束前就已开始（上限 2 → 前两条同时在跑）
  assert.ok(spans['AC-002'].start < spans['AC-001'].end,
    `并发未生效：AC-002 start=${spans['AC-002'].start} 应早于 AC-001 end=${spans['AC-001'].end}`);
  // 并发上限确凿证据：第 3 条必须等前面让出槽位（AC-002 先完，故 AC-003 start ≥ AC-002 end）
  assert.ok(spans['AC-003'].start >= spans['AC-002'].end,
    `并发越界：上限 2 时 AC-003 start=${spans['AC-003'].start} 不得早于 AC-002 end=${spans['AC-002'].end}`);

  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');
});

test('默认不配置：严格串行，无重叠执行（不制造 flaky 的底线承诺）', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260707-921';
  const logPath = path.join(env.root, 'probe-timing.log');
  env.writeTask(id, { bodyAc: SPEC_3AC });
  env.setScenario([
    {
      actions: [
        { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS },
        {
          type: 'writeFile',
          path: '.will-workflow/ac-tests.json',
          content: mappingJson([
            { ac_id: 'AC-001', command: probeCmd(logPath, 'AC-001', { sleepMs: 250, exitCode: 1 }), expect: 'fail_on_baseline' },
            { ac_id: 'AC-002', command: probeCmd(logPath, 'AC-002', { sleepMs: 100, exitCode: 1 }), expect: 'fail_on_baseline' },
            { ac_id: 'AC-003', command: probeCmd(logPath, 'AC-003', { sleepMs: 100, exitCode: 1 }), expect: 'fail_on_baseline' },
          ]),
        },
      ],
      session_id: 'sess-m1', cost: 0.1, result: 'r1 修复 + 映射',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass', 'AC-003': 'pass' }),
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const tg = env.readJson(env.dossier(id, 'test-gate-r1.json'));
  assert.deepEqual(tg.per_ac.map((e) => e.verdict), ['falsifies', 'falsifies', 'falsifies']);

  const spans = parseProbeLog(logPath);
  assert.ok(spans['AC-002'].start >= spans['AC-001'].end, '默认必须串行：AC-002 不得与 AC-001 重叠');
  assert.ok(spans['AC-003'].start >= spans['AC-002'].end, '默认必须串行：AC-003 不得与 AC-002 重叠');
});
