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
 * 删分支。默认 `-d`（已合并才删得掉）；`{ force: true }` 用 `-D`：abandon 的任务分支从未合并，
 * 只有强删才清得掉（AC-045）。失败不抛，返回 `{ ok: false, error }`——被别的 worktree checkout
 * 着的分支删不掉是常事，调用方据此如实报账，绝不把它算进「已清理」。
 */
export function deleteBranch(repo, branch, { force = false } = {}) {
  const r = git(['branch', force ? '-D' : '-d', branch], repo);
  if (r.status === 0) return { ok: true, error: null };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
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

/** 同上的 --stat 摘要（P2b 方案模式的 spec prompt 要它当变更规模输入）。 */
export function diffStatAgainstBase(wtPath, baseBranch) {
  const r = git(['diff', '--stat', `${baseBranch}...HEAD`], wtPath);
  if (r.status === 0) return r.stdout;
  return git(['diff', '--stat', 'HEAD'], wtPath).stdout ?? '';
}

// ---- 委派（dispatch）用到的几个小件：全部幂等，失败不抛（返回 { ok, error }）除非另有说明 ----

export function headOf(wtOrRepo, ref = 'HEAD') {
  const r = git(['rev-parse', '--verify', '--quiet', ref], wtOrRepo);
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

/** ref 指向的 tree 哈希：判断「代码到底变没变」用它，不用 commit 哈希（空提交会变 commit 不变 tree）。 */
export function treeOf(wtOrRepo, ref = 'HEAD') {
  return headOf(wtOrRepo, `${ref}^{tree}`);
}

export function isDirty(wt) {
  const r = git(['status', '--porcelain'], wt);
  return r.status === 0 && r.stdout.trim() !== '';
}

/** 有改动才提交（委派不产生空提交）；返回提交后的 HEAD，没有改动返回 null。 */
export function commitIfDirty(wt, message) {
  if (!isDirty(wt)) return null;
  gitOk(['add', '-A'], wt);
  const r = git(['commit', '-m', message, '--no-verify'], wt);
  if (r.status !== 0) throw new Error(`git commit failed (cwd=${wt}): ${(r.stderr || r.stdout || '').trim()}`);
  return headOf(wt);
}

/** a 是不是 b 的祖先（含相等）：「这个分支是否已经集成进任务分支」的事实判据，恢复流程靠它避免重复集成。 */
export function isAncestor(repo, a, b) {
  if (!a || !b) return false;
  return git(['merge-base', '--is-ancestor', a, b], repo).status === 0;
}

export function changedFilesBetween(repo, from, to) {
  if (!from || !to) return [];
  const r = git(['diff', '--name-only', `${from}..${to}`], repo);
  return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** 是否正卡在一次没做完的 merge 里（runner 崩在集成中途的残留）。 */
export function mergeInProgress(wt) {
  return git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], wt).status === 0;
}

/**
 * 在 wt（任务 worktree，检出着任务分支）里把 branch 合进来。冲突 → 记下冲突文件、`merge --abort`
 * 还原现场，返回 { ok:false, conflict_files }；任务分支不留半合并状态。
 */
export function mergeInto(wt, branch, message) {
  if (mergeInProgress(wt)) git(['merge', '--abort'], wt);
  const r = git(['merge', '--no-ff', '--no-edit', '-m', message, branch], wt);
  if (r.status === 0) return { ok: true, head: headOf(wt), conflict_files: [] };
  const u = git(['diff', '--name-only', '--diff-filter=U'], wt);
  const files = u.status === 0 ? u.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  git(['merge', '--abort'], wt);
  return { ok: false, head: headOf(wt), conflict_files: files, error: (r.stderr || r.stdout || '').trim().slice(0, 400) };
}

/** 在 commit 上（重）建一个 detached worktree：先清掉同路径的残留。 */
export function recreateDetachedWorktree(repo, wtPath, commit) {
  removeWorktree(repo, wtPath);
  fs.rmSync(wtPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  return addDetachedWorktree(repo, wtPath, commit);
}

/**
 * 为一个并行的 write 委派准备独立 worktree：分支 `branch` 从 startPoint 起。
 * 同名分支已存在时：已经并入任务分支的直接重置到 startPoint；还有没并入的提交（上次冲突留下的）
 * 先改名归档（`<branch>--r<tag>`）再重建——旧工作留着给人和 router 参考，绝不悄悄丢。
 */
export function prepareBranchWorktree(repo, wtPath, branch, startPoint, { excludePatterns = [], archiveTag = 'old', mergedInto = null } = {}) {
  removeWorktree(repo, wtPath);
  fs.rmSync(wtPath, { recursive: true, force: true });
  if (branchExists(repo, branch)) {
    const tip = headOf(repo, `refs/heads/${branch}`);
    const merged = mergedInto ? isAncestor(repo, tip, mergedInto) : false;
    if (!merged) git(['branch', '-M', branch, `${branch}--r${archiveTag}`], repo);
    else git(['branch', '-D', branch], repo);
  }
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  gitOk(['worktree', 'add', '-b', branch, wtPath, startPoint], repo);
  if (excludePatterns.length > 0) installWorktreeExcludes(wtPath, excludePatterns);
  return wtPath;
}
