#!/usr/bin/env node
// hooks/maker-git-guard.mjs — maker 的 PreToolUse(Bash) hook：git 破坏性操作护栏。
// maker 只负责改 worktree 代码；commit/merge/清理由 conductor 负责。放行本地 commit
// （无害，commitAll 兜底），拦截 push 与不可逆操作（exit 2 阻断，stderr 喂回模型自纠）。
// 判定逻辑移植自 will-session-workflow hooks/scripts/git-safety.mjs（去引号防误报、
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

function findDanger(command) {
  let segments = stripQuoted(command).split(/[;|&\n]+/);
  // sh -c '<payload>' 的引号内容是真要执行的命令，单独展开判定。
  if (/\b(?:sh|bash|zsh|dash)\s+(?:-[A-Za-z]+\s+)*-c\b/.test(command)) {
    segments = segments.concat(quotedContents(command).flatMap((inner) => inner.split(/[;|&\n]+/)));
  }
  for (const segment of segments) {
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
    '（commit、merge 与 worktree 清理由 conductor 负责）。请改用非破坏性方式完成当前步骤。',
  );
  process.exit(2);
}

main();
