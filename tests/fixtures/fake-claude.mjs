#!/usr/bin/env node
// fake-claude — 测试 stub，经 CLAUDE_BIN 注入 lib/claude.mjs。
// 按调用序消费 FAKE_CLAUDE_SCRIPT（JSON 数组），每步可：
//   actions: [{type:'writeFile', path, content}]  在 cwd（即任务 worktree）落盘文件
//            [{type:'deleteFile', path}]          在 cwd 删除文件（对抗性删测试场景）
//            [{type:'rateLimit', resets_at, rate_limit_type}]
//                                                 发一条 rejected rate_limit_event + is_error result
//                                                 后非零退出（五小时/周限额，真实末三行形状）
//            [{type:'writeLog', content, path?}]  把 content 写成 JSON 到 prompt 里注入的 log 绝对
//                                                 路径（*.log.json；path 可显式覆盖）
//            [{type:'truncateAfterWrite'}]        发 subtype=error_max_turns 的 result 后 exit 1，
//                                                 模拟「写完 log 就撞轮次上限」（reviewer 增量协议）
//   exitCode: 非零则报错退出（模拟 CLI 失败 / resume 失效）
//   exitCodeAfterResult: 先照常发 result 事件再以该码退出（模拟 error_max_turns：CLI 留下
//                        subtype=error_max_turns 的 result 事件后 exit 1）
//   session_id / cost / result: 拼成 --output-format stream-json 的 result 事件
// 全部调用的 argv+cwd 追加记录到 FAKE_CLAUDE_LOG，测试据此断言（如 resume 是否带 -r）。
// 并发计数探针：设 FAKE_CLAUDE_INFLIGHT_LOG 时每次调用在开始/结束各追加一行
//   {call, phase:'start'|'end', ms}，供测试用 maxInFlight() 断言同时在飞的进程数。
// 任何测试都不许调用真 claude 二进制 —— 本文件就是替身。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error('fake-claude: FAKE_CLAUDE_SCRIPT not set');
  process.exit(2);
}
// prompt 正文不再经 argv 传入（MAX_ARG_STRLEN 红线），改从 stdin 读（对齐 lib/claude.mjs::runClaudeStream）。
const prompt = fs.readFileSync(0, 'utf8');
const counterPath = `${scriptPath}.counter`;
const scenario = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
fs.writeFileSync(counterPath, String(n + 1));

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ call: n, argv: process.argv.slice(2), prompt, cwd: process.cwd(), started_at_ms: Date.now() })}\n`,
  );
}

/** prompt 里注入的 log 绝对路径（取最后一个 *.log.json，即交付段那一条）。 */
function logPathFromPrompt(text) {
  const matches = String(text ?? '').match(/\/[^\s"'`]*\.log\.json/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

// 并发计数探针（P2b 的并行 spawn 用；本阶段只实现 + 单测）。append 对小行是原子的，
// start/end 两行足以精确还原任意时刻的在飞进程数。
const inflightLog = process.env.FAKE_CLAUDE_INFLIGHT_LOG;
if (inflightLog) {
  fs.appendFileSync(inflightLog, `${JSON.stringify({ call: n, phase: 'start', ms: Date.now() })}\n`);
  process.on('exit', () => {
    try {
      fs.appendFileSync(inflightLog, `${JSON.stringify({ call: n, phase: 'end', ms: Date.now() })}\n`);
    } catch { /* 探针写失败不影响被测行为 */ }
  });
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
  } else if (a.type === 'deleteFile') {
    fs.rmSync(path.resolve(process.cwd(), a.path), { force: true });
  } else if (a.type === 'writeLog') {
    // log 的绝对路径由内核注入 prompt（契约第一条）：这里按 agent 的做法从 prompt 里取，
    // 顺带钉住「prompt 真的带了绝对路径」——路径漏注入时测试当场红。
    const target = a.path ? path.resolve(process.cwd(), a.path) : logPathFromPrompt(prompt);
    if (!target) {
      console.error('fake-claude: writeLog 找不到 log 路径（prompt 未注入 *.log.json 绝对路径？）');
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof a.content === 'string' ? a.content : `${JSON.stringify(a.content, null, 2)}\n`);
  } else if (a.type === 'truncateAfterWrite') {
    // 撞 max-turns：CLI 留下 subtype=error_max_turns 的 result 事件后非零退出。
    await writeEvent({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: step.num_turns ?? 30,
      session_id: step.session_id ?? `fake-sess-${n}`,
      total_cost_usd: step.cost ?? 0.01,
      result: '',
    });
    process.exit(1);
  } else if (a.type === 'rateLimit') {
    // 五小时/周限额：形状照抄 dossier/task-20260829-002/maker-r1.stream.jsonl 的末三行
    // （rejected rate_limit_event → 合成 assistant 报错消息 → is_error 的 result 后非零退出）。
    const sid = step.session_id ?? `fake-sess-${n}`;
    const resultText = a.text ?? "You've hit your session limit · resets 1:40pm (Asia/Singapore)";
    await writeEvent({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: a.resets_at ?? a.resetsAt ?? 0,
        rateLimitType: a.rate_limit_type ?? a.rateLimitType ?? 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      },
      session_id: sid,
    });
    await writeEvent({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: resultText }] },
      session_id: sid,
      error: 'rate_limit',
      is_api_error_message: true,
    });
    await writeEvent({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      num_turns: 1,
      session_id: sid,
      total_cost_usd: step.cost ?? 0,
      result: resultText,
    });
    process.exit(a.exitCode ?? 1);
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

if (step.exitCodeAfterResult) process.exit(step.exitCodeAfterResult);
