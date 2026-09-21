#!/usr/bin/env node
// hooks/read-guard.mjs — router 与 worker:read 的 PreToolUse hook：读范围白名单。
// router 现在读得懂内容（摘要、spec 原文、代码、diff、执行产物），但「能读」必须有范围：
// 只有内核点名的根目录（本任务的案卷、spec、worktree）之内可读，其余路径在工具执行前就被拒
// （exit 2 阻断，stderr 喂回模型）。conductor 的其他任务案卷、state、配置、用户主目录都不在范围里。
// 范围之内的 `.env*` 与常见密钥文件：本 hook 拒绝把它们当作 Read 的目标，或 Grep / Glob 的 path；
// 但 hook 看不到 Grep / Glob 在一个允许的目录里**搜到**了什么——那一层由同一份 settings 里的
// `permissions.deny: Read(**/.env …)` 规则交给宿主 CLI 执法（官方文档：Read 规则尽力覆盖 Grep / Glob），
// 见 lib/agent-settings.mjs::SECRET_READ_DENY。读进上下文的秘密收不回来，所以两层都挂。
// 读取能力不扩大执行权限：这个 hook 只管读，写由 write-guard 管，这两类角色根本没有 Bash。
// stdin：Claude Code hook 输入 JSON { tool_name, tool_input, cwd, ... }。
// 参数：--root <绝对路径>（可重复；目录或单个文件）。零 --root 时不拦（配置缺失不该变成硬故障）。
import fs from 'node:fs';
import path from 'node:path';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|.*\.pem|.*\.key)$/i;
/** 占位模板不是秘密：`.env.example` 正是「需要键名时该读的那个文件」。 */
const SECRET_EXEMPT = /^\.env\.(?:example|sample|template|dist)$/i;

function parseRoots(argv) {
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) roots.push(path.resolve(argv[++i]));
  }
  return roots;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * 解析符号链接后再比：`worktree/link -> /etc` 这种绕法不该过。路径（还）不存在时，解析它最深的
 * 已存在祖先再把余下的段接回去——否则 macOS 上 `/tmp → /private/tmp` 这类系统链接会让
 * 「根解析了、目标没解析」而误拒。
 */
function realOrSelf(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* 往上找 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

function within(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const roots = parseRoots(process.argv.slice(2)).map(realOrSelf);
if (roots.length === 0) process.exit(0);

const input = readStdinJson();
if (!READ_TOOLS.has(input.tool_name)) process.exit(0);

const cwd = input.cwd ?? process.cwd();
const raw = input.tool_input?.file_path ?? input.tool_input?.path ?? null;
// Grep / Glob 不给 path 时搜的是 cwd：按 cwd 判。
const target = realOrSelf(path.resolve(cwd, typeof raw === 'string' && raw !== '' ? raw : '.'));

if (!roots.some((r) => within(target, r))) {
  console.error(
    `本角色只能读这些位置之内的文件：\n- ${roots.join('\n- ')}\n`
    + `被拒绝的读取目标：${target}\n`
    + '需要的信息不在范围内时，把它写成一个未决问题或派一个调查任务，不要尝试读别处。',
  );
  process.exit(2);
}
if (SECRET_BASENAME.test(path.basename(target)) && !SECRET_EXEMPT.test(path.basename(target))) {
  console.error(`拒绝读取疑似密钥 / 环境变量文件：${target}（内容一旦进入上下文就收不回来；需要键名请读 .env.example）`);
  process.exit(2);
}
process.exit(0);
