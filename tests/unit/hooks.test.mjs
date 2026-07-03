// 单元：spec-agent 的两个 hook 脚本按 Claude Code hook 协议独立驱动（stdin JSON + 退出码）。
// spec-write-guard：PreToolUse 写路径白名单（exit 2 = 拦截，stderr 喂回模型）。
// check-spec：Stop 契约预检（不合格 exit 2 只拦一次；stop_hook_active=true 放行给 conductor 终审）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'spec-write-guard.mjs');
const CHECK = path.resolve(HERE, '..', '..', 'conductor', 'hooks', 'check-spec.mjs');

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

// ---- spec-write-guard ----

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
    assert.match(r.stderr, /只允许写入唯一交付文件/);
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
