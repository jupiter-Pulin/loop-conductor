#!/usr/bin/env node
// codex-shadow：用真实 buildVerifierPrompt 重建历史验收现场（E9 / H-verifier-cost）。
// 用法：node build-shadow-prompt.mjs <taskId> <round> <makerSha> <tmpRoot>
// 输出（stdout JSON）：{ prompt_path, worktree, fork_sha, diff_bytes, ac_count }
// 保真说明：prompt 生成走 conductor 同一代码路径（shared.mjs::buildVerifierPrompt），
// 唯一差异是 worktree 由 makerSha 临时检出、baseBranch 用 fork 点 SHA 代替分支名——
// `git diff <fork>...HEAD` 与当年 `git diff <base>...HEAD` 的 merge-base 语义一致。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildVerifierPrompt } from '../../../../conductor/stages/shared.mjs';
import { extractAcceptanceCriteria } from '../../../../conductor/lib/state.mjs';

const [taskId, roundStr, makerSha, tmpRoot] = process.argv.slice(2);
if (!taskId || !roundStr || !makerSha || !tmpRoot) {
  console.error('usage: build-shadow-prompt.mjs <taskId> <round> <makerSha> <tmpRoot>');
  process.exit(1);
}
const round = Number(roundStr);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outDir = path.dirname(fileURLToPath(import.meta.url));

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// fork 点：沿 first-parent 往上走，跳过本任务的轮次 commit，第一个非本任务 commit 即分叉点
let fork = makerSha;
for (let i = 0; i < 50; i++) {
  const subject = git(['show', '-s', '--format=%s', fork]).trim();
  if (!subject.startsWith(`task ${taskId}:`)) break;
  fork = git(['rev-parse', `${fork}^`]).trim();
}

// 影子 worktree：检出 makerSha（detached，不碰任务分支）
const caseDir = path.join(tmpRoot, `${taskId}-r${round}`);
fs.mkdirSync(caseDir, { recursive: true });
const wt = path.join(caseDir, taskId);
git(['worktree', 'add', '--detach', wt, makerSha]);

const cfg = {
  worktreesDir: caseDir,
  agentsDir: path.join(repoRoot, 'agents'),
  dossierDir: path.join(repoRoot, 'dossier'),
  verifierDiffMaxBytes: 200000,
};
const ts = { id: taskId, task: { baseBranch: fork } };
const spec = fs.readFileSync(path.join(repoRoot, 'dossier', taskId, 'spec.md'), 'utf8');
const acList = extractAcceptanceCriteria(spec);
const prompt = buildVerifierPrompt(ts, cfg, round, acList);

const promptPath = path.join(outDir, `${taskId}-r${round}.prompt.md`);
fs.writeFileSync(promptPath, prompt);
const diffBytes = Buffer.byteLength(git(['diff', `${fork}...HEAD`], wt), 'utf8');
process.stdout.write(`${JSON.stringify({
  prompt_path: promptPath,
  worktree: wt,
  fork_sha: fork,
  maker_sha: git(['rev-parse', makerSha]).trim(),
  diff_bytes: diffBytes,
  ac_count: acList.length,
  prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
}, null, 2)}\n`);
