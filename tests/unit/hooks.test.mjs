// 单元：agent hook 脚本按 Claude Code hook 协议独立驱动（stdin JSON + 退出码）。
// write-guard：PreToolUse 写路径白名单（exit 2 = 拦截，stderr 喂回模型）。
// check-spec：Stop 契约预检（不合格 exit 2 只拦一次；stop_hook_active=true 放行给 conductor 终审）。
// maker-git-guard：PreToolUse(Bash) git 破坏性操作护栏（拦 push/不可逆，放行 commit）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'write-guard.mjs');
const CHECK = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'check-spec.mjs');
const GIT_GUARD = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'maker-git-guard.mjs');

function runHook(script, args, stdinObj) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    input: stdinObj == null ? '' : JSON.stringify(stdinObj),
  });
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GOOD_SPEC = '# spec\n\n## 验收标准\n\n- AC-001: `node --test` 全绿\n';
const BAD_SPEC = '# spec\n\n## Acceptance Criteria\n\n- AC-001: whatever\n';

// ---- write-guard ----

test('guard：写白名单路径放行（exit 0）', (t) => {
  const dir = tmpdir(t);
  const allow = path.join(dir, 'specs', 'task-1.md');
  const r = runHook(GUARD, ['--allow', allow], { tool_name: 'Write', tool_input: { file_path: allow } });
  assert.equal(r.status, 0, r.stderr);
});

test('guard：写其他路径拦截（exit 2 + 指引），Edit 同样受限', (t) => {
  const dir = tmpdir(t);
  const allow = path.join(dir, 'specs', 'task-1.md');
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    const r = runHook(GUARD, ['--allow', allow], {
      tool_name: tool,
      tool_input: { file_path: path.join(dir, 'lib', 'stats.mjs') },
    });
    assert.equal(r.status, 2, `${tool} 应被拦截`);
    assert.match(r.stderr, /本角色只允许写这些文件/);
    assert.match(r.stderr, /被拒绝的写入目标/);
  }
});

test('guard：非写工具（Read/Grep）不拦', (t) => {
  const dir = tmpdir(t);
  const allow = path.join(dir, 'specs', 'task-1.md');
  for (const tool of ['Read', 'Grep', 'Glob']) {
    const r = runHook(GUARD, ['--allow', allow], { tool_name: tool, tool_input: { file_path: '/etc/passwd' } });
    assert.equal(r.status, 0, `${tool} 不应被拦`);
  }
});

test('guard：相对路径按 stdin.cwd 解析后再比对白名单', (t) => {
  const dir = tmpdir(t);
  const allow = path.join(dir, 'specs', 'task-1.md');
  const ok = runHook(GUARD, ['--allow', allow], {
    tool_name: 'Write',
    tool_input: { file_path: path.join('specs', 'task-1.md') },
    cwd: dir,
  });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = runHook(GUARD, ['--allow', allow], {
    tool_name: 'Write',
    tool_input: { file_path: path.join('specs', 'other.md') },
    cwd: dir,
  });
  assert.equal(bad.status, 2);
});

test('guard：缺 --allow（配置错误）不拦，终审兜底在 conductor', () => {
  const r = runHook(GUARD, [], { tool_name: 'Write', tool_input: { file_path: '/anywhere' } });
  assert.equal(r.status, 0);
});

// ---- check-spec ----

test('check-spec：合格 spec → exit 0，报告 ok:true 落盘', (t) => {
  const dir = tmpdir(t);
  const spec = path.join(dir, 'spec.md');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(spec, GOOD_SPEC);
  const r = runHook(CHECK, ['--spec', spec, '--report', report], { session_id: 's1', stop_hook_active: false });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(rep.ok, true);
  assert.equal(rep.blocked, false);
  assert.equal(rep.ac_count, 1);
  assert.equal(rep.session_id, 's1');
  assert.equal(rep.source, 'stop-hook');
});

test('check-spec：不合格 → exit 2 阻断，stderr 给出契约错误，报告 blocked:true', (t) => {
  const dir = tmpdir(t);
  const spec = path.join(dir, 'spec.md');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(spec, BAD_SPEC);
  const r = runHook(CHECK, ['--spec', spec, '--report', report], { session_id: 's1', stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /契约检查未通过/);
  assert.match(r.stderr, /验收标准/);
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(rep.ok, false);
  assert.equal(rep.blocked, true);
});

test('check-spec：stop_hook_active=true 时只拦一次即放行（exit 0），报告如实记录', (t) => {
  const dir = tmpdir(t);
  const spec = path.join(dir, 'spec.md');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(spec, BAD_SPEC);
  const r = runHook(CHECK, ['--spec', spec, '--report', report], { session_id: 's1', stop_hook_active: true });
  assert.equal(r.status, 0, '已拦过一次仍不合格：放行给 conductor 终审');
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(rep.ok, false);
  assert.equal(rep.blocked, false);
  assert.equal(rep.stop_hook_active, true);
});

test('check-spec：交付文件未写入也是契约失败（exit 2）', (t) => {
  const dir = tmpdir(t);
  const spec = path.join(dir, 'never-written.md');
  const report = path.join(dir, 'report.json');
  const r = runHook(CHECK, ['--spec', spec, '--report', report], { stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /缺失或为空/);
});

// ---- maker-git-guard ----

function bashCall(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

test('git-guard：拦截 push 与不可逆操作（exit 2 + 指引）', () => {
  const denied = [
    'git push',
    'git push --force origin main',
    'git -C /some/dir push origin HEAD',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git checkout -- lib/stats.mjs',
    'git checkout .',
    'git restore lib/stats.mjs',
    'git branch -D task/x',
    'git stash drop',
    'git filter-branch --all',
    'npm test && git push',
    'sh -c "git push origin main"',
  ];
  for (const command of denied) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 2, `应拦截：${command}`);
    assert.match(r.stderr, /maker-git-guard 拦截/, command);
    // 拦截提示必须给出认可的替代路径（真实事故：3 个任务 4 次 denial 全是想恢复误改文件，
    // 旧提示只说「改用非破坏性方式」没给做法，每次白烧一轮）
    assert.match(r.stderr, /git show HEAD:/, `拦截提示应含单文件恢复替代做法：${command}`);
  }
});

test('git-guard：放行本地 commit、只读 git 与普通命令', () => {
  const allowed = [
    'git status',
    'git add -A && git commit -m "fix median"',
    'git diff main...HEAD',
    'git log --oneline -5',
    'git restore --staged lib/stats.mjs',
    'node --test',
    'ls -la',
  ];
  for (const command of allowed) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 0, `不应拦截：${command}（stderr: ${r.stderr}）`);
  }
});

test('git-guard：引号内字面 "git push" 不误报（commit message）', () => {
  const r = runHook(GIT_GUARD, [], bashCall('git commit -m "do not git push from agents"'));
  assert.equal(r.status, 0, r.stderr);
});

test('git-guard：命令替换 $(...) / 反引号内的 git 调用被拦截（含双引号内替换）', () => {
  const denied = [
    'echo $(git push)',
    'echo `git push origin main`',
    'git commit -m "$(git push)"',
  ];
  for (const command of denied) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 2, `应拦截：${command}`);
    assert.match(r.stderr, /maker-git-guard 拦截/, command);
  }
});

test('git-guard：单引号内的 $(...) 是字面量，不展开不误报', () => {
  const r = runHook(GIT_GUARD, [], bashCall("git commit -m '$(git push)'"));
  assert.equal(r.status, 0, r.stderr);
});

test('git-guard：checkout -f/--force 变体被拦截；-b 建分支与普通切换分支放行', () => {
  const denied = ['git checkout -f', 'git checkout --force main', 'git checkout -xf'];
  for (const command of denied) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 2, `应拦截：${command}`);
    assert.match(r.stderr, /maker-git-guard 拦截/, command);
  }
  const allowed = ['git checkout -b feature', 'git checkout main'];
  for (const command of allowed) {
    const r = runHook(GIT_GUARD, [], bashCall(command));
    assert.equal(r.status, 0, `不应拦截：${command}（stderr: ${r.stderr}）`);
  }
});

test('git-guard：非 Bash 工具与空命令不拦', () => {
  for (const input of [
    { tool_name: 'Write', tool_input: { file_path: '/x' } },
    { tool_name: 'Bash', tool_input: {} },
  ]) {
    const r = runHook(GIT_GUARD, [], input);
    assert.equal(r.status, 0);
  }
});
