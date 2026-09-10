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
export function ensureWorktree(repo, wtPath, branch, excludePatterns = [], startPoint = null) {
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
    // F18/E29：新建任务分支必须显式给起点（task.baseBranch）。不传时 git 默认用活体仓
    // 瞬时 HEAD——基线随人切分支漂移，diff/探针/verifier 全部错档（20260710-001 真实事故）。
    gitOk(['worktree', 'add', '-b', branch, wtPath, ...(startPoint ? [startPoint] : [])], repo);
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

/** merge-base(baseBranch, HEAD)（test gate 探针的基线提交）。失败返回 null。 */
export function mergeBaseWith(wtPath, baseBranch) {
  const r = git(['merge-base', baseBranch, 'HEAD'], wtPath);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 在 commit 上开 detached 临时 worktree（test gate 探针用）。失败不抛，返回 { ok, error }。 */
export function addDetachedWorktree(repo, wtPath, commit) {
  const r = git(['worktree', 'add', '--detach', wtPath, commit], repo);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() };
  return { ok: true };
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

/**
 * 在 target 仓库（当前在主分支）合入任务分支。冲突/失败抛错，任务留在原地。
 * F15/E28：失败必须先 `merge --abort` 还原——半合并状态会把冲突标记留在工作区；
 * dogfood 自举仓（targetRepo=.）时 conductor 自身源码被污染，后续任何命令直接语法崩溃。
 */
export function mergeBranch(repo, branch, message) {
  const r = git(['merge', '--no-ff', branch, '-m', message], repo);
  if (r.status !== 0) {
    git(['merge', '--abort'], repo); // best-effort 还原；无 MERGE_HEAD 时失败无害
    throw new Error(`git merge --no-ff ${branch} failed (cwd=${repo}): ${(r.stderr || r.stdout || '').trim()}`);
  }
}

/**
 * 删分支。默认 `-d`（已合并才删得掉；失败无害，忽略）。
 * `{ force: true }` 用 `-D`：abandon 的任务分支从未合并，只有强删才清得掉（AC-045）。
 */
export function deleteBranch(repo, branch, { force = false } = {}) {
  git(['branch', force ? '-D' : '-d', branch], repo);
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

/** 同上的 --stat 摘要（committer 起草 merge commit 文案时的变更规模输入）。 */
export function diffStatAgainstBase(wtPath, baseBranch) {
  const r = git(['diff', '--stat', `${baseBranch}...HEAD`], wtPath);
  if (r.status === 0) return r.stdout;
  return git(['diff', '--stat', 'HEAD'], wtPath).stdout ?? '';
}

/** 同上的 --numstat（每行 added\tdeleted\tpath；二进制为 -\t-；H33 自动合并规模判定用）。 */
export function diffNumstatAgainstBase(wtPath, baseBranch) {
  const r = git(['diff', '--numstat', `${baseBranch}...HEAD`], wtPath);
  if (r.status === 0) return r.stdout;
  return git(['diff', '--numstat', 'HEAD'], wtPath).stdout ?? '';
}

/** 解析 --name-status 输出中出现过的全部路径（rename/copy 的旧新两侧都算；H15 锚定用）。 */
export function parseNameStatusPaths(text) {
  const files = new Set();
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    for (const col of line.split('\t').slice(1)) {
      if (col.trim() !== '') files.add(col.trim());
    }
  }
  return files;
}

/** 读 ref 上某文件内容（evidence 引用已删除/改名旧路径时锚定 base 版本用）。不存在返回 null。 */
export function showFileAtRef(wtPath, ref, file) {
  const r = git(['show', `${ref}:${file}`], wtPath);
  return r.status === 0 ? r.stdout : null;
}
