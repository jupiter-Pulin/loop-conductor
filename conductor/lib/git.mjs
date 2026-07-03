// lib/git.mjs — git 子进程封装：worktree 生命周期 + merge + diff。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function gitOk(args, cwd) {
  const r = git(args, cwd);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (cwd=${cwd}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

export function currentBranch(repo) {
  return gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
}

export function branchExists(repo, branch) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).status === 0;
}

/**
 * 在任务 worktree 的本地 `.git/info/exclude` 逐行幂等追加 harness exclude pattern（契约 §8）。
 * 绝不碰目标仓库的 .gitignore：worktree 的 exclude 是 worktree-local 的。
 * - 用 `git -C wtPath rev-parse --git-path info/exclude` 解析真实路径（相对 cwd → resolve 绝对）。
 * - 读现有内容，已存在的 pattern 不重复追加，保留既有内容与尾换行。
 */
export function installWorktreeExcludes(wtPath, patterns) {
  const rel = gitOk(['rev-parse', '--git-path', 'info/exclude'], wtPath).trim();
  // rev-parse 可能给相对 cwd 的路径；以 wtPath 为基准 resolve 成绝对路径。
  const excludePath = path.isAbsolute(rel) ? rel : path.resolve(wtPath, rel);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(excludePath, 'utf8'); } catch { /* 文件可能尚不存在 */ }
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = patterns.filter((p) => !present.has(p.trim()));
  if (missing.length === 0) return excludePath; // 幂等：全部已在，原样不动
  // 保留既有内容（含其尾换行风格），把缺失 pattern 逐行追加到末尾。
  let next = existing;
  if (next !== '' && !next.endsWith('\n')) next += '\n';
  next += `${missing.join('\n')}\n`;
  fs.writeFileSync(excludePath, next);
  return excludePath;
}

/** 幂等：worktree 已存在则复用；分支残留（上次崩溃）则复用分支。末尾装 harness excludes。 */
export function ensureWorktree(repo, wtPath, branch, excludePatterns = []) {
  if (fs.existsSync(path.join(wtPath, '.git'))) {
    // 复用既有 worktree，但仍确保 exclude 已装（契约 §8 / 边界「Worktree 已存在」）。
    if (excludePatterns.length > 0) installWorktreeExcludes(wtPath, excludePatterns);
    return wtPath;
  }
  git(['worktree', 'prune'], repo);
  if (fs.existsSync(wtPath)) {
    throw new Error(`worktree dir exists but is not a valid worktree: ${wtPath}`);
  }
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  if (branchExists(repo, branch)) {
    gitOk(['worktree', 'add', wtPath, branch], repo);
  } else {
    gitOk(['worktree', 'add', '-b', branch, wtPath], repo);
  }
  if (excludePatterns.length > 0) installWorktreeExcludes(wtPath, excludePatterns);
  return wtPath;
}

/**
 * 检测哪些 harness 名已被目标仓库追踪（契约 §8）。对每个 name 跑
 * `git -C wtPath ls-files -- <name>`（目录名直接传，git 会列其下文件），
 * 输出非空即「已被追踪」，收集冲突名返回。
 */
export function checkTrackedHarness(wtPath, names) {
  const conflicts = [];
  for (const name of names) {
    const r = git(['ls-files', '--', name], wtPath);
    if (r.status === 0 && (r.stdout ?? '').trim() !== '') conflicts.push(name);
  }
  return conflicts;
}

export function removeWorktree(repo, wtPath) {
  git(['worktree', 'remove', '--force', wtPath], repo);
  git(['worktree', 'prune'], repo);
}

/** 把 worktree 当前改动全部提交（maker 产出固化为 commit，diff/merge 才可见）。 */
export function commitAll(wtPath, message) {
  gitOk(['add', '-A'], wtPath);
  git(['commit', '-m', message, '--allow-empty', '--no-verify'], wtPath);
}

/** 在 target 仓库（当前在主分支）合入任务分支。冲突/失败抛错，任务留在原地。 */
export function mergeBranch(repo, branch, message) {
  gitOk(['merge', '--no-ff', branch, '-m', message], repo);
}

export function deleteBranch(repo, branch) {
  git(['branch', '-d', branch], repo); // 已合并才删得掉；失败无害，忽略
}

/** worktree 相对 base 分支的三点 diff（verifier 的输入之一）。 */
export function diffAgainstBase(wtPath, baseBranch) {
  const r = git(['diff', `${baseBranch}...HEAD`], wtPath);
  if (r.status === 0) return r.stdout;
  return git(['diff', 'HEAD'], wtPath).stdout ?? '';
}

/** 同上的 name-status 清单（diff 超 verifierDiffMaxBytes 时降级喂 verifier）。 */
export function diffNameStatusAgainstBase(wtPath, baseBranch) {
  const r = git(['diff', '--name-status', `${baseBranch}...HEAD`], wtPath);
  if (r.status === 0) return r.stdout;
  return git(['diff', '--name-status', 'HEAD'], wtPath).stdout ?? '';
}
