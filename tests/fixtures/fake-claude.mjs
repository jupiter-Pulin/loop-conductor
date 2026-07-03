#!/usr/bin/env node
// fake-claude — 测试 stub，经 CLAUDE_BIN 注入 lib/claude.mjs。
// 按调用序消费 FAKE_CLAUDE_SCRIPT（JSON 数组），每步可：
//   actions: [{type:'writeFile', path, content}]  在 cwd（即任务 worktree）落盘文件
//   exitCode: 非零则报错退出（模拟 CLI 失败 / resume 失效）
//   session_id / cost / result: 拼成 --output-format stream-json 的 result 事件
// 全部调用的 argv+cwd 追加记录到 FAKE_CLAUDE_LOG，测试据此断言（如 resume 是否带 -r）。
// 任何测试都不许调用真 claude 二进制 —— 本文件就是替身。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error('fake-claude: FAKE_CLAUDE_SCRIPT not set');
  process.exit(2);
}
const counterPath = `${scriptPath}.counter`;
const scenario = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
fs.writeFileSync(counterPath, String(n + 1));

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ call: n, argv: process.argv.slice(2), cwd: process.cwd(), started_at_ms: Date.now() })}\n`,
  );
}

const step = scenario[n];
if (!step) {
  console.error(`fake-claude: scenario has no step #${n}（多余的 spawn？）`);
  process.exit(2);
}

for (const a of step.actions ?? []) {
  if (a.type === 'writeFile') {
    const p = path.resolve(process.cwd(), a.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, a.content);
  } else {
    console.error(`fake-claude: unknown action type ${a.type}`);
    process.exit(2);
  }
}

if (step.delayMs) await sleep(step.delayMs);

if (step.exitCode) {
  console.error(step.stderr ?? 'fake-claude: scripted failure');
  process.exit(step.exitCode);
}

const outputFormatIndex = process.argv.indexOf('--output-format');
const outputFormat = outputFormatIndex === -1 ? 'json' : process.argv[outputFormatIndex + 1];

async function writeEvent(event, delayMs = 0) {
  if (delayMs) await sleep(delayMs);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (step.hang) {
  for (const event of step.events ?? []) {
    await writeEvent(event, event.delayMs ?? 0);
  }
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else if (step.slowAlive) {
  const intervalMs = step.intervalMs ?? 50;
  const count = step.count ?? 3;
  for (let i = 0; i < count; i++) {
    await writeEvent({ type: 'assistant', message: `tick-${i}`, session_id: step.session_id ?? `fake-sess-${n}`, num_turns: step.num_turns ?? 2 }, i === 0 ? 0 : intervalMs);
  }
}

const resultEvent = {
  type: 'result',
  subtype: 'success',
  session_id: step.session_id ?? `fake-sess-${n}`,
  total_cost_usd: step.cost ?? 0.01,
  result: step.result ?? '',
  ...(step.extra ?? {}), // 透传额外 raw 字段（如 is_error / api_error_status / num_turns）
};

if (step.noResult) {
  await writeEvent(step.event ?? { type: 'assistant', message: 'no-result', session_id: resultEvent.session_id, num_turns: step.num_turns ?? 2 });
  process.exit(0);
}

if (outputFormat === 'stream-json') {
  await writeEvent(resultEvent, step.resultDelayMs ?? 0);
} else {
  console.log(JSON.stringify(resultEvent));
}
