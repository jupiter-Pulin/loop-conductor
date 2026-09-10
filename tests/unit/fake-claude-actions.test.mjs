// 单元：fake-claude 新增夹具行为（P1）。夹具本身有 bug 时，靠它写的每个集成测试都会说谎，
// 所以这三件事必须自己有测试：
//   writeLog            —— 按 prompt 里注入的绝对路径写 log（顺带钉住「prompt 真的带了路径」）
//   truncateAfterWrite  —— 写完 log 就撞 max-turns（reviewer 增量协议的关键场景，AC-010）
//   并发计数探针        —— 同时在飞的进程数（P2b 的 maxParallelPackages 靠它验证）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaudeStream } from '../../conductor/lib/claude.mjs';
import { FAKE_CLAUDE, maxInFlight } from '../helpers/env.mjs';

function fixture(t, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const scenarioPath = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify(steps));
  const prev = { ...process.env };
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_SCRIPT = scenarioPath;
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.FAKE_CLAUDE_INFLIGHT_LOG;
  t.after(() => {
    for (const k of ['CLAUDE_BIN', 'FAKE_CLAUDE_SCRIPT', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_INFLIGHT_LOG']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('writeLog：按 prompt 里注入的 *.log.json 绝对路径落盘', async (t) => {
  const dir = fixture(t, [{
    actions: [{ type: 'writeLog', content: { role: 'maker', outcome: 'ok', summary: 'AC-001 done' } }],
    result: 'ok',
  }]);
  const logPath = path.join(dir, 'dossier', 'task-x', 'maker-r1.log.json');
  const res = await runClaudeStream({
    cwd: dir,
    prompt: `随便什么正文\n用 Write 工具把 log 写到这个绝对路径：\n${logPath}\n`,
    maxTurns: 5,
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(logPath, 'utf8')), { role: 'maker', outcome: 'ok', summary: 'AC-001 done' });
});

test('writeLog：prompt 未注入路径 → 夹具报错退出（漏注入当场暴露，不静默）', async (t) => {
  const dir = fixture(t, [{ actions: [{ type: 'writeLog', content: { role: 'maker' } }] }]);
  const res = await runClaudeStream({ cwd: dir, prompt: '没有路径', maxTurns: 5 });
  assert.equal(res.ok, false);
  assert.match(String(res.stderr ?? res.error), /writeLog 找不到 log 路径/);
});

test('truncateAfterWrite：log 已落盘，CLI 留下 error_max_turns 的 result 后非零退出（AC-010）', async (t) => {
  const dir = fixture(t, [{
    session_id: 'sess-cut',
    actions: [
      { type: 'writeLog', content: { role: 'reviewer', outcome: 'fail', tier: 'integration', summary: 'AC-001 pass\n未判: AC-004, AC-005' } },
      { type: 'truncateAfterWrite' },
    ],
  }]);
  const logPath = path.join(dir, 'dossier', 'task-x', 'reviewer-r1.log.json');
  const res = await runClaudeStream({ cwd: dir, prompt: `写到 ${logPath}`, maxTurns: 5 });

  assert.equal(res.ok, false, '撞 max-turns 的会话不是成功会话');
  assert.equal(res.raw.subtype, 'error_max_turns');
  assert.equal(res.raw.session_id, 'sess-cut');
  const written = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  assert.equal(written.outcome, 'fail');
  assert.match(written.summary, /未判: AC-004, AC-005/, '截断留下的是带未判清单的合法记录，不是空文件');
});

test('并发计数探针：串行调用峰值为 1，并行调用峰值为实际在飞数', async (t) => {
  const dir = fixture(t, [
    { delayMs: 120, result: 'a' },
    { delayMs: 120, result: 'b' },
    { delayMs: 120, result: 'c' },
  ]);
  const inflight = path.join(dir, 'inflight.jsonl');
  process.env.FAKE_CLAUDE_INFLIGHT_LOG = inflight;

  await runClaudeStream({ cwd: dir, prompt: 'x', maxTurns: 5 });
  assert.equal(maxInFlight(inflight), 1, '串行调用不得被记成并行');

  await Promise.all([
    runClaudeStream({ cwd: dir, prompt: 'x', maxTurns: 5 }),
    runClaudeStream({ cwd: dir, prompt: 'x', maxTurns: 5 }),
  ]);
  assert.equal(maxInFlight(inflight), 2, '两个进程同时在飞');
  assert.equal(maxInFlight(path.join(dir, 'nope.jsonl')), 0, '没有探针文件时返回 0');
});
