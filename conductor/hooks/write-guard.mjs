#!/usr/bin/env node
// hooks/write-guard.mjs — 各角色的 PreToolUse hook：写路径白名单。
// 每个角色只能写内核点名的那几个文件（router / reviewer 只有自己的 log；spec 是 spec + packages
// + log；方案模式**只有** packages + log），写任何其他路径在落盘之前就被拒（exit 2 阻断工具调用，
// stderr 喂回模型自纠）。这是 Invariant 8「方案不改范围」的执法点之一：方案模式下对 spec 正文的
// Write/Edit 必须被拒，spec 字节不变。
// stdin：Claude Code hook 输入 JSON { tool_name, tool_input, cwd, ... }。
// 参数：--allow <绝对路径>（可重复）。零 --allow 时不拦（配置缺失不该变成硬故障，终审在内核）。
import fs from 'node:fs';
import path from 'node:path';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function parseAllows(argv) {
  const allows = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow' && argv[i + 1]) allows.push(path.resolve(argv[++i]));
  }
  return allows;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const allows = parseAllows(process.argv.slice(2));
if (allows.length === 0) process.exit(0); // 配置缺失时不拦（终审仍在内核）

const input = readStdinJson();
if (!WRITE_TOOLS.has(input.tool_name)) process.exit(0);

const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? null;
if (typeof target !== 'string' || target === '') process.exit(0); // 无路径的调用交给权限系统

const resolved = path.resolve(input.cwd ?? process.cwd(), target);
if (allows.includes(resolved)) process.exit(0);

console.error(
  `本角色只允许写这些文件：\n- ${allows.join('\n- ')}\n`
  + `被拒绝的写入目标：${resolved}\n`
  + '请把内容写进允许的文件；不要修改 target 仓库的代码或任何其他文件。',
);
process.exit(2);
