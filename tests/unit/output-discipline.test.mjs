// verifier/spec-verifier 输出纪律：buildVerifierPrompt / buildSpecVerifierPrompt 的拼装层
// 指令必须明确「第一个字符必须是 { / 最后一个字符必须是 }」并禁止任何前后缀文字与围栏，
// agents/verifier-agent.md、agents/spec-verifier-agent.md 的角色 prompt 同等钉死（双重防线）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildVerifierPrompt, buildSpecVerifierPrompt } from '../../conductor/stages/shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** 最小 worktree：单提交 git 仓库，跑在 main 分支上（buildVerifierPrompt 要跑 git diff）。 */
function makeMinimalWorktree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
}

/** 造一套跑 buildVerifierPrompt / buildSpecVerifierPrompt 所需的最小 cfg + ts。 */
function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-discipline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'verifier-agent.md'), '# verifier stub\n');
  fs.writeFileSync(path.join(agentsDir, 'spec-verifier-agent.md'), '# spec verifier stub\n');

  const worktreesDir = path.join(root, 'worktrees');
  const id = 'task-20260704-999';
  makeMinimalWorktree(path.join(worktreesDir, id));

  const cfg = {
    agentsDir,
    worktreesDir,
    dossierDir: path.join(root, 'dossier'),
    specsDir: path.join(root, 'specs'),
    targetRepo: path.join(root, 'worktrees', id),
    targetProfilesDir: path.join(root, 'target-profiles'),
    verifierDiffMaxBytes: 1_000_000,
  };
  const ts = {
    id,
    dir: path.join(root, 'taskdir'), // 无 spec.md：ensureDossierSpec 走兜底最小 spec
    task: { kind: 'bugfix', baseBranch: 'main', testCommand: 'node --test', title: 'stub' },
    runtime: {},
  };
  return { cfg, ts };
}

test('buildVerifierPrompt：输出纪律明确首字符 { / 尾字符 }，禁止前后缀与围栏', (t) => {
  const { cfg, ts } = makeFixture(t);
  const prompt = buildVerifierPrompt(ts, cfg, 1, [{ ac_id: 'AC-001', text: 'stub ac' }]);
  assert.match(prompt, /第一个字符必须是\s*`?\{/, '必须明确首字符是 {');
  assert.match(prompt, /最后一个字符必须是\s*`?\}/, '必须明确尾字符是 }');
  assert.match(prompt, /不得有任何字符/, '必须禁止 { 之前与 } 之后出现任何字符');
  assert.match(prompt, /围栏/, '必须点名禁止 Markdown 围栏');
  assert.match(prompt, /机械拒收/, '必须说明违规输出会被机械拒收');
});

test('buildSpecVerifierPrompt：输出纪律明确首字符 { / 尾字符 }，禁止前后缀与围栏', (t) => {
  const { cfg, ts } = makeFixture(t);
  const prompt = buildSpecVerifierPrompt(ts, cfg, 1);
  assert.match(prompt, /第一个字符必须是\s*`?\{/, '必须明确首字符是 {');
  assert.match(prompt, /最后一个字符必须是\s*`?\}/, '必须明确尾字符是 }');
  assert.match(prompt, /不得有任何字符/, '必须禁止 { 之前与 } 之后出现任何字符');
  assert.match(prompt, /围栏/, '必须点名禁止 Markdown 围栏');
  assert.match(prompt, /机械拒收/, '必须说明违规输出会被机械拒收');
});

test('agents/verifier-agent.md：含输出纪律段，语义覆盖首尾字符/禁止前置叙事/机械拒收', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'verifier-agent.md'), 'utf8');
  assert.match(md, /输出纪律/, '必须有输出纪律段');
  assert.match(md, /第一个字符必须是\s*`?\{/);
  assert.match(md, /最后一个字符必须是\s*`?\}/);
  assert.match(md, /围栏/);
  assert.match(md, /机械拒收/);
});

test('agents/spec-verifier-agent.md：含输出纪律段，语义覆盖首尾字符/禁止前置叙事/机械拒收', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'spec-verifier-agent.md'), 'utf8');
  assert.match(md, /输出纪律/, '必须有输出纪律段');
  assert.match(md, /第一个字符必须是\s*`?\{/);
  assert.match(md, /最后一个字符必须是\s*`?\}/);
  assert.match(md, /围栏/);
  assert.match(md, /机械拒收/);
});
