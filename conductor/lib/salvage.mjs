// lib/salvage.mjs — agent 来不及写最终 log 时（撞上限、被杀、runner 崩溃），内核从**可信执行记录**
// 里能说清楚的部分：原始流（内核自己逐行落盘的 stream.jsonl）里它调用过哪些工具、碰过哪些文件、
// 最后说了什么、用了多少 token。这份 salvage 只陈述「观察到了什么」，并明确列出「不知道什么」：
// 没有合格 log 就没有 outcome——内核不伪造完成信号，也绝不把未知当成功。
//
// 零副作用的读取 + 一个落盘口（writeSalvage）。

import fs from 'node:fs';

const TEXT_TAIL = 1200;
const FILES_MAX = 80;

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** stream.jsonl → 观察到的执行事实。文件不存在返回 null。 */
export function observeStream(streamFile) {
  let text;
  try { text = fs.readFileSync(streamFile, 'utf8'); } catch { return null; }
  const tools = {};
  const touched = new Set();
  const commands = [];
  let sessionId = null;
  let lastText = null;
  let turns = 0;
  let resultSubtype = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const e = safeParse(line);
    if (!e) continue;
    if (sessionId == null && typeof e.session_id === 'string') sessionId = e.session_id;
    if (e.type === 'result') resultSubtype = e.subtype ?? null;
    if (e.type !== 'assistant' || !e.message) continue;
    turns += 1;
    const u = e.message.usage;
    if (u) for (const k of Object.keys(usage)) usage[k] += Number(u[k]) || 0;
    for (const block of Array.isArray(e.message.content) ? e.message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') lastText = block.text;
      if (block?.type !== 'tool_use') continue;
      tools[block.name] = (tools[block.name] ?? 0) + 1;
      const input = block.input ?? {};
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
        const p = input.file_path ?? input.notebook_path;
        if (typeof p === 'string') touched.add(p);
      }
      if (block.name === 'Bash' && typeof input.command === 'string') commands.push(input.command.slice(0, 200));
    }
  }
  return {
    session_id: sessionId,
    assistant_turns: turns,
    result_subtype: resultSubtype,
    tool_calls: tools,
    files_written_via_tools: [...touched].slice(0, FILES_MAX),
    last_commands: commands.slice(-10),
    last_assistant_text_tail: lastText ? lastText.slice(-TEXT_TAIL) : null,
    token_usage_lower_bound: usage, // 只是流里看得到的部分；换算不成确定的美元，成本仍按 unknown 策略处理
  };
}

/**
 * 组装并落盘一份 salvage。
 *   known   —— 调用方补充的执行器事实（git 状态、是否有提交、报告是否存在…）
 *   reason  —— 为什么需要 salvage：truncated | interrupted | runner_crashed | log_missing | log_invalid
 */
export function writeSalvage(path, { role, round, key = null, reason, streamFile, known = {} }) {
  const observed = observeStream(streamFile);
  const salvage = {
    schema_version: 1,
    role,
    key,
    round,
    reason,
    written_by: 'kernel',
    observed, // 来自内核自己落盘的原始流：可信的执行记录
    known, // 来自 git / 文件系统的实际残留
    unknown: [
      'agent 对自己完成度的判断（没有合格的最终 log，outcome 未知，不得视为完成）',
      ...(observed == null ? ['原始流缺失：连调用过哪些工具都无从得知'] : []),
      ...(reason === 'runner_crashed' || reason === 'interrupted' ? ['被中断那一刻正在进行的那次工具调用是否生效'] : []),
      '本次会话的确切费用（按 unknown 成本策略入账）',
    ],
    written_at: new Date().toISOString(),
  };
  fs.writeFileSync(path, `${JSON.stringify(salvage, null, 2)}\n`);
  return salvage;
}
