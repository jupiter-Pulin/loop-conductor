// 静态：仓库里没有任何执行 `git push` 的代码路径（AC-006 / Invariant 1）。
//
// 两道断言，各管一件事：
//   1) 执行形态（`git(['push'…`、`spawn('git', ['push'…`、shell 串里的 `git push`）在
//      conductor/ tools/ .claude/ 下**一处都不许有**——包括护栏文件自己；
//   2) 「git push」这四个字出现在哪些文件里必须在白名单内——新文件一提到它就得先解释为什么。
// 单靠 grep 关键词会被护栏与文档的正当提及淹没，所以拆成「执行形态」与「提及」两层。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/env.mjs';

const SCANNED_DIRS = ['conductor', 'tools', '.claude'];

/** 允许出现「git push」字样的文件 → 为什么允许。除此之外一处都不许提。 */
const MENTION_ALLOWLIST = new Map([
  [path.join('conductor', 'hooks', 'maker-git-guard.mjs'), '护栏本身必须认识 git push 才拦得住它'],
  [path.join('.claude', 'skills', 'git-conventions', 'SKILL.md'), '给人读的分支/提交规范文档，不是代码路径'],
]);

/** 真正会把 push 发出去的形态。任何文件命中都是硬失败。 */
const EXECUTION_PATTERNS = [
  /\bgit(?:Ok)?\(\s*\[\s*['"`]push['"`]/,                       // lib/git.mjs 风格的 git(['push', …])
  /['"`]git['"`]\s*,\s*\[\s*['"`]push['"`]/,                    // spawnSync('git', ['push', …])
  /(?:spawn|exec|execSync|execFile|execFileSync|spawnSync)\([^)]*['"`][^'"`]*git\s+push/, // shell 串
  /^\s*git\s+push\b/m,                                          // 脚本里独立成行的 git push
];

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function scannedFiles() {
  const out = [];
  for (const d of SCANNED_DIRS) out.push(...walk(path.join(REPO_ROOT, d)));
  return out; // 本测试自己不在扫描面内：它必须写出这些形态才能拦住它们
}

test('AC-006：conductor / tools / .claude 下没有任何执行 git push 的形态', () => {
  const hits = [];
  for (const file of scannedFiles()) {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const re of EXECUTION_PATTERNS) {
      if (re.test(body)) hits.push(`${path.relative(REPO_ROOT, file)} 命中 ${re}`);
    }
  }
  assert.deepEqual(hits, [], `发现执行 git push 的代码路径：\n${hits.join('\n')}`);
});

test('AC-006：提到「git push」的文件必须在白名单内', () => {
  const mentions = [];
  for (const file of scannedFiles()) {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (/git\s+push|\bpush\b.{0,12}\bremote\b/i.test(body)) mentions.push(path.relative(REPO_ROOT, file));
  }
  const unexpected = mentions.filter((m) => !MENTION_ALLOWLIST.has(m));
  assert.deepEqual(
    unexpected, [],
    `这些文件提到了 git push 但不在白名单里（新增 push 相关代码请先说明理由）：\n${unexpected.join('\n')}`,
  );
});

test('AC-006：router 的工具集不含 Bash，maker 的 git 护栏仍拦 push', async () => {
  const { ROLE_TOOLS } = await import('../../conductor/lib/agent-settings.mjs');
  assert.deepEqual([...ROLE_TOOLS.router], ['Write']);
  for (const role of ['spec', 'reviewer']) {
    assert.ok(!ROLE_TOOLS[role].includes('Bash'), `${role} 不得有裸 Bash`);
  }
  const guard = fs.readFileSync(path.join(REPO_ROOT, 'conductor', 'hooks', 'maker-git-guard.mjs'), 'utf8');
  assert.match(guard, /case 'push':/, 'git 护栏必须显式认出 push 子命令');
});
