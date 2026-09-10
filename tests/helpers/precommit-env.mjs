// precommit 集成测试的共享夹具：真 git 仓 + 真 worktree + 真子进程。
// 与 env.mjs 的区别：这里不驱动 conductor 子命令，直接调 lib/precommit.mjs——
// 被测的是「候选建得对、步骤跑得对、锁与进程清得干净」，不需要整条状态机在场。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initTargetRepo } from './target-fixture.mjs';
import { setupProfilePaths } from '../../conductor/lib/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const FAKE_SERVICE = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-service.mjs');

/** 候选合并后才为真的断言：偶数中位数取平均（预埋 bug 下必红）。 */
export const UNIT_CHECKS_FIX = `node -e 'import("./lib/stats.mjs").then(m => process.exit(m.median([1,2,3,4]) === 2.5 ? 0 : 1))'`;
export const CMD_OK = `node -e 'process.exit(0)'`;
export const CMD_FAIL = `node -e 'console.error("boom: 构建挂了"); process.exit(2)'`;

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
}

/**
 * 建一个自带 target 仓的临时 conductor 根目录。
 * 返回 { root, cfg, id, targetRepo, dossierDir, ... } 与若干造场景的助手。
 */
export function makePrecommitEnv(t, { id = 'task-20260910-001', cfgOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-it-'));
  for (const d of ['state', 'dossier', 'worktrees', 'target-profiles', 'specs']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const targetRepo = path.join(root, 'target');
  initTargetRepo(targetRepo);

  const cfg = {
    root,
    targetRepo,
    baseBranch: 'main',
    stateDir: path.join(root, 'state'),
    dossierDir: path.join(root, 'dossier'),
    worktreesDir: path.join(root, 'worktrees'),
    targetProfilesDir: path.join(root, 'target-profiles'),
    specsDir: path.join(root, 'specs'),
    greenGateOutputTailBytes: 12_000,
    greenGateTimeoutMs: 60_000,
    precommitStepTimeoutMs: 60_000,
    precommitLockTimeoutMs: 5_000,
    ...cfgOverrides,
  };

  const taskBranch = `task/${id}`;
  const api = {
    root,
    cfg,
    id,
    targetRepo,
    taskBranch,
    dossierDir: path.join(root, 'dossier', id),
    candidateWorktree: path.join(root, 'worktrees', `${id}.precommit`),

    /** 任务快照（runPrecommit 的 task 入参形态）。 */
    task(over = {}) {
      return { id, targetRepo, baseBranch: 'main', testCommand: 'node --test', ...over };
    },

    /**
     * 在 base HEAD 上开任务分支并落一次提交。write = { <相对路径>: 内容 }。
     * 用临时 worktree 建，主 checkout 始终留在 main（与生产一致）。
     */
    commitOnTaskBranch(write, message = 'task branch work') {
      const wt = path.join(root, 'worktrees', `${id}.build`);
      const exists = git(targetRepo, 'branch', '--list', taskBranch).trim() !== '';
      execFileSync('git', ['-C', targetRepo, 'worktree', 'add', ...(exists ? [wt, taskBranch] : ['-b', taskBranch, wt, 'main'])], { stdio: 'pipe' });
      for (const [rel, content] of Object.entries(write)) {
        const p = path.join(wt, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      git(wt, 'add', '-A');
      git(wt, 'commit', '-m', message);
      const sha = git(wt, 'rev-parse', 'HEAD').trim();
      execFileSync('git', ['-C', targetRepo, 'worktree', 'remove', '--force', wt], { stdio: 'pipe' });
      return sha;
    },

    /** base 分支自己往前走一步（候选冲突与 base 前进的场景）。 */
    commitOnBase(write, message = 'base moved') {
      for (const [rel, content] of Object.entries(write)) {
        const p = path.join(targetRepo, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      git(targetRepo, 'add', '-A');
      git(targetRepo, 'commit', '-m', message);
      return git(targetRepo, 'rev-parse', 'HEAD').trim();
    },

    sha(ref) {
      return git(targetRepo, 'rev-parse', ref).trim();
    },

    /** 写 target-profiles/<key>/setup-profile.json（走 runPrecommit 的读盘路径）。 */
    writeSetupProfile(precommit) {
      const paths = setupProfilePaths(cfg);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.meta, `${JSON.stringify({
        schema_version: 1, profile_key: paths.key, targetRepo, approved: true, precommit,
      }, null, 2)}\n`);
      return paths.meta;
    },

    record(round = 1) {
      return JSON.parse(fs.readFileSync(path.join(root, 'dossier', id, `precommit-r${round}.json`), 'utf8'));
    },

    serviceLog(round = 1) {
      const p = path.join(root, 'dossier', id, `precommit-r${round}.service.log`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    },

    stepOf(record, step) {
      return record.steps.find((s) => s.step === step);
    },

    statusMap(record) {
      return Object.fromEntries(record.steps.map((s) => [s.step, s.status]));
    },

    /** 目标仓库现存 worktree 列表（断言候选已移除）。 */
    worktrees() {
      return git(targetRepo, 'worktree', 'list').trim().split('\n');
    },
  };

  t.after(() => {
    try { execFileSync('git', ['-C', targetRepo, 'worktree', 'prune'], { stdio: 'pipe' }); } catch { /* 仓库可能已删 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return api;
}

/** 等待条件成立（最多 timeoutMs），用于「进程真的没了」这类异步断言。 */
export async function waitFor(fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** pid 是否还活着（测试侧的判定，不依赖被测代码）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
