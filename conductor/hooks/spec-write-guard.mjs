#!/usr/bin/env node
// hooks/spec-write-guard.mjs — spec-agent 的 PreToolUse hook：写权限白名单。
// spec-agent 唯一交付物是 conductor 指定的 specs/<id>.md；写任何其他路径在
// 落盘之前就被拒绝（exit 2 阻断工具调用，stderr 喂回模型自纠）。
// stdin：Claude Code hook 输入 JSON { tool_name, tool_input, cwd, ... }。
// 参数：--allow <绝对路径>（可重复）。
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
if (allows.length === 0) process.exit(0); // 配置缺失时不拦（终审仍在 conductor）

const input = readStdinJson();
if (!WRITE_TOOLS.has(input.tool_name)) process.exit(0);

const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? null;
if (typeof target !== 'string' || target === '') process.exit(0); // 无路径的调用交给权限系统

const resolved = path.resolve(input.cwd ?? process.cwd(), target);
if (allows.includes(resolved)) process.exit(0);

console.error(
  `spec-agent 只允许写入唯一交付文件：${allows.join('、')}\n` +
  `被拒绝的写入目标：${resolved}\n` +
  '请把 spec 内容写进允许的文件；不要修改 target 仓库的任何代码或其他文件。',
);
process.exit(2);
