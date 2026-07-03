// 集成：bugfix 快乐路径 new → run（READY→VERIFY→AWAIT_HUMAN_MERGE）→ merge 归档。
// 全程 fake-claude，零 token。verifier 返回 per-AC 严格 JSON verdict（覆盖 AC-001/AC-002）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, promptOf, resumeIdOf, verifierStep, DEFAULT_BUGFIX_SPEC } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

test('bugfix 快乐路径直达 AWAIT_HUMAN_MERGE，merge 后归档', (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  env.setScenario([
    { // call 0: maker 首轮——真实修掉预埋 bug（green gate 是 conductor 亲自跑的）
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-maker-1',
      cost: 0.10,
      result: '已修复 median 偶数分支',
    },
    // call 1: verifier——严格 per-AC JSON 裁决，两条 AC 全 pass → overall pass
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }, { cost: 0.05, session_id: 'sess-verifier-1' }),
  ]);

  // new
  const created = env.run('new', '--kind', 'bugfix', '--title', 'median 偶数分支错误');
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/task-\d{8}-\d{3}/)?.[0];
  assert.ok(id, `new 输出应含任务 id：${created.stdout}`);
  assert.equal(env.findTask(id).runtime.stage, 'READY'); // bugfix 初始 READY

  // bugfix 人类工作流：new 后填 spec.md 的两条验收标准（→ AC-001/AC-002）。
  env.writeQueueSpec(id, DEFAULT_BUGFIX_SPEC);

  // task.json 字节快照（用于 merge 前断言不可变）
  const taskBytesAtCreate = env.taskJsonBytes(id);

  // run：drain 直达人类闸门
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE');
  assert.equal(after.runtime.maker_miss_count, 0);
  assert.equal(after.runtime.verifier_invalid_count, 0);
  assert.equal(after.runtime.maker_session_id, 'sess-maker-1');
  assert.equal(after.runtime.current_round, 1);
  assert.ok(Math.abs(after.runtime.spent_usd - 0.15) < 1e-9, `spent_usd 应累计 0.15，实际 ${after.runtime.spent_usd}`);

  // task.json 跨 stage byte-for-byte 不变（AC-002）
  assert.deepEqual(env.taskJsonBytes(id), taskBytesAtCreate, 'task.json 推进 stage 后字节不变');

  // 案卷完整：所有角色 spawn 都有 <role>-r<n>.json，内含原始 CLI JSON
  assert.ok(fs.existsSync(env.dossier(id, 'spec.md')), 'dossier/spec.md（bugfix 验收标准冻结）');
  const marker = env.readJson(env.dossier(id, 'maker-r1.json'));
  assert.ok(marker.started && marker.done, 'maker-r1 双标记齐全');
  assert.equal(marker.session_id, 'sess-maker-1');
  assert.equal(marker.raw.session_id, 'sess-maker-1', 'maker 案卷留档原始 CLI JSON');
  assert.equal(marker.raw.total_cost_usd, 0.10);

  // green gate pass 也写 green-gate-r1.json（AC-004）
  const gate = env.readJson(env.dossier(id, 'green-gate-r1.json'));
  assert.equal(gate.schema_version, 1);
  assert.equal(gate.round, 1);
  assert.equal(gate.exit_code, 0, 'green gate pass exit 0');
  assert.equal(gate.command, 'node --test');
  assert.equal(gate.cwd, path.join('worktrees', id), 'cwd 写成相对仓库根的 worktrees/<id>');
  assert.ok('stdout_tail' in gate && 'stderr_tail' in gate);

  const vrec = env.readJson(env.dossier(id, 'verifier-r1.json'));
  assert.ok(vrec.started && vrec.done, 'verifier-r1 双标记齐全');
  assert.equal(vrec.raw.session_id, 'sess-verifier-1', 'verifier 案卷留档原始 CLI JSON');

  // per-AC verdict 落盘：overall pass + 两条 AC（AC-008）
  const verdict = env.readJson(env.dossier(id, 'verify-r1.verdict.json'));
  assert.equal(verdict.schema_version, 1);
  assert.equal(verdict.overall, 'pass');
  assert.deepEqual(verdict.criteria_results.map((c) => c.ac_id).sort(), ['AC-001', 'AC-002']);
  assert.ok(verdict.criteria_results.every((c) => c.status === 'pass'));
  // 人读叙事单独落 verify-r1.md
  assert.ok(fs.existsSync(env.dossier(id, 'verify-r1.md')), 'verifier 叙事单独落 verify-r1.md');
  assert.ok(fs.existsSync(env.dossier(id, 'timeline.md')));

  // spawn 形态：maker 在 worktree + acceptEdits（不带 --tools，全工具集）；
  // verifier --tools 硬限制只读集 + --allowedTools 免审批同一集合，无 Write/测试权限
  const calls = env.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].cwd.endsWith(path.join('worktrees', id)), 'maker cwd 是任务 worktree');
  assert.ok(calls[0].argv.includes('acceptEdits'));
  assert.equal(calls[0].argv.includes('--tools'), false, 'maker 不做工具集硬限制');
  assert.ok(calls[0].argv.includes('--max-turns'), 'maker spawn 带 --max-turns');
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--output-format') + 1], 'json');
  assert.equal(resumeIdOf(calls[0]), null);
  const READONLY = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*)';
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--tools') + 1], READONLY, 'verifier --tools 硬限制');
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--allowedTools') + 1], READONLY, 'verifier --allowedTools 免审批');
  assert.ok(!READONLY.includes('Write'));
  assert.ok(calls[1].argv.includes('--max-turns'), 'verifier spawn 带 --max-turns');
  // verifier prompt 引用程序级 verdict contract、含 AC 枚举与 worktree diff
  const vprompt = promptOf(calls[1]);
  assert.ok(vprompt.includes('verifier-verdict/v1'), 'verifier prompt 引用 verdict contract');
  assert.ok(vprompt.includes('AC-001') && vprompt.includes('AC-002'), 'verifier prompt 含 AC 枚举');
  assert.ok(vprompt.includes('diff'), 'verifier prompt 含 worktree diff');

  // status 表
  const status = env.run('status');
  assert.match(status.stdout, /AWAIT_HUMAN_MERGE/);
  assert.match(status.stdout, new RegExp(id));
  assert.match(status.stdout, /INVAL/, 'status 表含 INVAL 列');

  // merge：终点闸门
  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  const archived = env.findTask(id);
  assert.equal(archived.box, 'done');
  assert.equal(archived.runtime.stage, 'DONE');
  // target 主分支拿到修复
  const merged = fs.readFileSync(path.join(env.root, 'target', 'lib', 'stats.mjs'), 'utf8');
  assert.ok(merged.includes('(s[mid - 1] + s[mid]) / 2'), 'main 分支已包含修复');
  // worktree 清理
  assert.ok(!fs.existsSync(path.join(env.root, 'worktrees', id)), 'worktree 已移除');
});

test('status 在空队列上正常工作', (t) => {
  const env = makeEnv(t);
  const r = env.run('status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ID\s+KIND\s+STAGE/);
  assert.match(r.stdout, /\(no tasks\)/);
});
