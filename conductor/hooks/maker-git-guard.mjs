#!/usr/bin/env node
// hooks/maker-git-guard.mjs — 有执行能力的角色（maker / worker:sandbox / worker:write）的
// PreToolUse(Bash) hook：git 破坏性操作护栏 + 嵌套 claude CLI 护栏。
// 这是**命令文本**护栏，尽力而为，不是隔离：它拦得住模型顺手敲出来的危险命令，拦不住刻意绕行
// （脚本里再调、换个解释器）。真正的文件 / 网络 / 进程隔离只能来自宿主运行时的 OS 沙盒
// （workerSandbox），以及内核每轮执行后的机械核对（lib/integrity.mjs）。
// maker 只负责改 worktree 代码；commit/merge/清理由 conductor 负责。放行本地 commit
// （无害，commitAll 兜底），拦截 push 与不可逆操作（exit 2 阻断，stderr 喂回模型自纠）。
// 判定逻辑移植自一个 git-safety hook 脚本（去引号防误报、
// sh -c 嵌套展开），提示语适配无人值守 loop：没有「交还用户」，只有「不在你的职责内」。
// stdin：Claude Code hook 输入 JSON { tool_name, tool_input, ... }。
import fs from 'node:fs';

// git 全局选项里「值是独立 token」的（git -C <dir> push 也要能识别出 push）。
const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** 从一段 shell 片段里找出 git 子命令与其余参数；无 git 调用返回 null。 */
function gitInvocation(segment) {
  const tokens = segment.trim().split(/\s+/);
  const gitIndex = tokens.findIndex((token) => token === 'git' || token.endsWith('/git'));
  if (gitIndex === -1) return null;

  let index = gitIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
    } else if (token.startsWith('-')) {
      index += 1;
    } else {
      break;
    }
  }
  if (index >= tokens.length) return null;
  return { subcommand: tokens[index], rest: tokens.slice(index + 1) };
}

/** 危险判定：返回拦截理由字符串，安全返回 null。 */
function judge({ subcommand, rest }) {
  const restText = rest.join(' ');
  const hasForceFlag = rest.some((token) => token === '--force' || /^-[a-zA-Z]*f/.test(token));

  switch (subcommand) {
    case 'push':
      return 'git push（改远端；含 --force 变体）';
    case 'reset':
      return restText.includes('--hard') ? 'git reset --hard（丢弃本地改动）' : null;
    case 'clean':
      return hasForceFlag ? 'git clean -f（删除未追踪文件）' : null;
    case 'checkout':
      if (hasForceFlag) return 'git checkout -f / --force（强制丢弃 worktree 改动）';
      return rest.includes('--') || rest.includes('.')
        ? 'git checkout -- <path> / git checkout .（丢弃 worktree 改动）'
        : null;
    case 'restore': {
      const staged = rest.includes('--staged') || rest.some((token) => /^-[a-zA-Z]*S/.test(token));
      const worktree = rest.includes('--worktree') || rest.some((token) => /^-[a-zA-Z]*W/.test(token));
      return staged && !worktree ? null : 'git restore（丢弃 worktree 改动；只允许 --staged）';
    }
    case 'branch':
      return rest.some((token) => /^-[a-zA-Z]*D/.test(token))
        || (rest.includes('--delete') && rest.includes('--force'))
        ? 'git branch -D（强删分支）'
        : null;
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? 'git stash drop/clear（销毁暂存工作）' : null;
    case 'filter-branch':
      return 'git filter-branch（改写历史）';
    case 'reflog':
      return rest[0] === 'expire' ? 'git reflog expire（销毁恢复点）' : null;
    case 'update-ref':
      return rest.includes('-d') || rest.includes('--delete') ? 'git update-ref -d（删除 ref）' : null;
    case 'worktree':
      return rest[0] === 'remove' && hasForceFlag
        ? 'git worktree remove --force（可能销毁未提交工作）'
        : null;
    default:
      return null;
  }
}

/** 去掉引号内容做分段判定，防 commit message 里的字面 "git push" 误报。 */
function stripQuoted(command) {
  return command.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

function quotedContents(command) {
  const contents = [];
  for (const match of command.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    contents.push(match[1] ?? match[2] ?? '');
  }
  return contents;
}

/**
 * 抽取命令替换 `$(...)` / 反引号内部会被 shell 展开执行的内容（双引号内、无引号处都展开；
 * 单引号内是字面量，跳过不展开，如 `git commit -m '$(git push)'`）。
 */
function extractSubstitutions(command) {
  const results = [];
  let inSingle = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
        j += 1;
      }
      results.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j;
      continue;
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      results.push(command.slice(i + 1, end === -1 ? command.length : end));
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    i += 1;
  }
  return results;
}

/**
 * 嵌套的 claude CLI：worker 自己再起一个 agent 会话 = 不经内核授权、不入任务成本、不受停止控制的
 * 子委派。本版不开放递归委派（要再拆任务就回到 router），所以命令词是 claude 的片段一律拦。
 */
function nestedAgentInvocation(segment) {
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (tokens.length === 0) return null;
  // 片段里任何位置出现 claude 这个词（`npx claude`、`npm exec claude`、`pnpm dlx claude`、
  // `timeout 60 claude`、`/usr/local/bin/claude` …）都算；只读 / 查询类的命令词豁免，
  // 免得 `echo claude`、`which claude`、`grep claude README` 被误伤。带尾斜杠的 `claude/` 是目录，不算。
  const harmless = new Set(['echo', 'printf', 'grep', 'rg', 'cat', 'ls', 'cd', 'mkdir', 'which', 'type', 'git', 'find', 'head', 'tail', 'wc', 'sed', 'awk']);
  if (harmless.has(tokens[0])) return null;
  const hit = tokens.some((t) => t === 'claude' || t.endsWith('/claude') || t === '@anthropic-ai/claude-code' || t.startsWith('@anthropic-ai/claude-code@'));
  return hit
    ? '嵌套调用 claude CLI（不入账、不继承限制的子委派；需要再拆任务请在 log 里说明，由 router 派）'
    : null;
}

function findDanger(command) {
  let segments = stripQuoted(command).split(/[;|&\n]+/);
  // sh -c '<payload>' 的引号内容是真要执行的命令，单独展开判定。
  if (/\b(?:sh|bash|zsh|dash)\s+(?:-[A-Za-z]+\s+)*-c\b/.test(command)) {
    segments = segments.concat(quotedContents(command).flatMap((inner) => inner.split(/[;|&\n]+/)));
  }
  segments = segments.concat(extractSubstitutions(command).flatMap((inner) => inner.split(/[;|&\n]+/)));
  for (const segment of segments) {
    const nested = nestedAgentInvocation(segment);
    if (nested) return nested;
    const invocation = gitInvocation(segment);
    if (!invocation) continue;
    const danger = judge(invocation);
    if (danger) return danger;
  }
  return null;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const input = readStdinJson();
  if (input.tool_name !== 'Bash') process.exit(0);
  const command = String(input.tool_input?.command ?? '');
  if (!command) process.exit(0);

  const danger = findDanger(command);
  if (!danger) process.exit(0);

  console.error(
    `maker-git-guard 拦截：${danger}\n` +
    '你的职责是修改当前 worktree 的代码与测试并让测试命令全绿；' +
    '本地 git commit 允许，push 与任何不可逆的历史/worktree 操作不在你的职责内' +
    '（commit、merge 与 worktree 清理由 conductor 负责）。请改用非破坏性方式完成当前步骤：' +
    '如需把误改的单个文件恢复为基线内容，用 `git show HEAD:<path> > <path>` 定点重写该文件（无波及面）。',
  );
  process.exit(2);
}

main();
