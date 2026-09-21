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
//            [{type:'writeReport', content}]      写到 prompt 里注入的 *.report.md 绝对路径
//            [{type:'writeVerdicts', content}]    写到 prompt 里注入的 *.verdicts.json 绝对路径
//            [{type:'writeDigest', content}]      写到 prompt 里注入的摘要路径（…/digest/<sha12>.json）
//            [{type:'writeNotes', content}]       写到 prompt 里注入的 router-notes.json 绝对路径
//            [{type:'writeAbs', path, content}]   写任意绝对路径（越权写入场景：模拟 Bash 绕过 hook）
//            [{type:'git', args:[…]}]             在 cwd 里跑一条 git（越权移动分支等场景）
//   keyed 剧本（FAKE_CLAUDE_KEYED，{ "<log 基名>": [step…] }）：并行 worker 的调用顺序不确定，
//            按 prompt 里 log 的基名（如 worker-a1）各走各的队列与计数器；没有对应 key 的调用
//            仍按调用序消费 FAKE_CLAUDE_SCRIPT。
//   init: true        先发一条 system/init（带 session_id），与真实 CLI 一致——崩溃恢复靠它从原始流里找回会话。
//                     默认不发：既有用例里「零事件的非零退出 = 不透明失败」的瞬态判定依赖 stream 为空。
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

// `claude --version`：模型探测的缓存键有一半是二进制版本（lib/model-probe.mjs）。
// 必须在读 stdin / 剧本之前短路——它不是一次「调用」，不该消费剧本步骤、不该进调用日志。
const FAKE_CLAUDE_VERSION = '0.0.0-fake (fake-claude)';
if (process.argv.includes('--version')) {
  process.stdout.write(`${FAKE_CLAUDE_VERSION}\n`);
  process.exit(0);
}

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error('fake-claude: FAKE_CLAUDE_SCRIPT not set');
  process.exit(2);
}
// prompt 正文不再经 argv 传入（MAX_ARG_STRLEN 红线），改从 stdin 读（对齐 lib/claude.mjs::runClaudeStream）。
const prompt = fs.readFileSync(0, 'utf8');
/** prompt 里注入的 log 绝对路径（取最后一个 *.log.json，即交付段那一条）。 */
function logPathFromPrompt(text) {
  const matches = String(text ?? '').match(/\/[^\s"'`]*\.log\.json/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

/** prompt 里第一个匹配的绝对路径（report / verdicts / digest / notes 各有固定后缀）。 */
function pathFromPrompt(text, re) {
  const m = String(text ?? '').match(re);
  return m ? m[m.length - 1] : null;
}

// keyed 剧本优先：log 基名（worker-a1 / maker / reviewer …）在 keyed 表里有队列就走它自己的计数器。
const keyedPath = process.env.FAKE_CLAUDE_KEYED;
const logBase = (logPathFromPrompt(prompt) ?? '').split('/').pop().replace(/-r\d+\.log\.json$/, '');
let keyedSteps = null;
if (keyedPath && fs.existsSync(keyedPath) && logBase) {
  const keyed = JSON.parse(fs.readFileSync(keyedPath, 'utf8'));
  if (Array.isArray(keyed[logBase])) keyedSteps = keyed[logBase];
}
const counterPath = keyedSteps ? `${keyedPath}.${logBase}.counter` : `${scriptPath}.counter`;
const scenario = keyedSteps ?? JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
fs.writeFileSync(counterPath, String(n + 1));

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ call: n, key: keyedSteps ? logBase : null, argv: process.argv.slice(2), prompt, cwd: process.cwd(), pid: process.pid, started_at_ms: Date.now() })}\n`,
  );
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
  console.error(`fake-claude: scenario has no step #${n}${keyedSteps ? `（key=${logBase}）` : ''}（多余的 spawn？）`);
  process.exit(2);
}

// 真实 CLI 的第一条事件：system/init 带 session_id。runner 中途崩溃时，恢复流程从已落盘的原始流里
// 找回这个 session_id，之后才可能续会话。
if (process.argv.includes('stream-json') && step.init === true) {
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: step.session_id ?? `fake-sess-${keyedSteps ? `${logBase}-` : ''}${n}`, cwd: process.cwd() })}\n`);
}

function writeTo(target, content, what) {
  if (!target) {
    console.error(`fake-claude: ${what} 找不到目标路径（prompt 未注入？）`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
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
  } else if (a.type === 'writeReport') {
    writeTo(pathFromPrompt(prompt, /\/[^\s"'`]*\.report\.md/g), a.content, 'writeReport');
  } else if (a.type === 'writeVerdicts') {
    writeTo(pathFromPrompt(prompt, /\/[^\s"'`]*\.verdicts\.json/g), a.content, 'writeVerdicts');
  } else if (a.type === 'writeDigest') {
    writeTo(pathFromPrompt(prompt, /\/[^\s"'`]*\/digest\/[0-9a-f]{12}\.json/g), a.content, 'writeDigest');
  } else if (a.type === 'writeNotes') {
    writeTo(pathFromPrompt(prompt, /\/[^\s"'`]*\/router-notes\.json/g), a.content, 'writeNotes');
  } else if (a.type === 'writeAbs') {
    writeTo(a.path, a.content, 'writeAbs');
  } else if (a.type === 'git') {
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', a.args, { cwd: process.cwd(), stdio: 'ignore' });
  } else if (a.type === 'sleep') {
    await sleep(a.ms ?? 0);
  } else if (a.type === 'truncateAfterWrite') {
    // 撞 max-turns：CLI 留下 subtype=error_max_turns 的 result 事件后非零退出。
    await writeEvent({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: step.num_turns ?? 30,
      session_id: step.session_id ?? `fake-sess-${keyedSteps ? `${logBase}-` : ''}${n}`,
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
  session_id: step.session_id ?? `fake-sess-${keyedSteps ? `${logBase}-` : ''}${n}`,
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
