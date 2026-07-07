#!/usr/bin/env node
// tests/fixtures/fake-codex.mjs — codex exec 的确定性替身（CODEX_BIN 挂载点）。
// 剧本：FAKE_CODEX_SCRIPT 指向 JSON 数组，按调用计数消费（同 fake-claude 模式）：
//   { lastMessage: string|object, exitCode?: number, delayMs?: number, noLastMessage?: true }
// 行为：stdout 吐两行 JSONL 事件（含 usage），把 lastMessage 写进 argv 里 -o 指定的文件；
// 全量调用记录追加到 FAKE_CODEX_LOG（argv/prompt/cwd），供测试断言默认关闭时零调用。
import fs from 'node:fs';

const scriptPath = process.env.FAKE_CODEX_SCRIPT;
const logPath = process.env.FAKE_CODEX_LOG;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const prompt = readStdin();
const argv = process.argv.slice(2);

if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify({ argv, cwd: process.cwd(), prompt_head: prompt.slice(0, 200), started_at_ms: Date.now() })}\n`);
}

let step = {};
if (scriptPath && fs.existsSync(scriptPath)) {
  const steps = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const counterPath = `${scriptPath}.counter`;
  let n = 0;
  try { n = Number(fs.readFileSync(counterPath, 'utf8')) || 0; } catch { /* 首次 */ }
  fs.writeFileSync(counterPath, String(n + 1));
  step = steps[n] ?? {};
}

const delay = step.delayMs ?? 0;
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ type: 'session.created', session_id: 'fake-codex-1' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 200 } })}\n`);
  const oIdx = argv.indexOf('-o');
  if (oIdx !== -1 && argv[oIdx + 1] && !step.noLastMessage) {
    const msg = typeof step.lastMessage === 'string' ? step.lastMessage : JSON.stringify(step.lastMessage ?? { note: 'fake-codex default' });
    fs.writeFileSync(argv[oIdx + 1], msg);
  }
  process.exit(step.exitCode ?? 0);
}, delay);
