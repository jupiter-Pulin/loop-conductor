// 集成：dashboard/server.mjs 作为真实 HTTP 子进程跑起来（--port 0），覆盖纯逻辑单测覆盖不到的
// 运行时行为——CONDUCTOR_ROOT 解析、监听地址行、GET 端点的 HTTP 形状、CLI 透传 spawn 的同步/
// detached 两种形态、非法输入的 400 边界。核心泳道映射/needsHuman/broken 降级/feasibility 透传
// 已在 tests/unit/dashboard-model.test.mjs 钉住，这里不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { makeEnv, REPO_ROOT, FAKE_CLAUDE, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';
import { loadCfg } from '../../conductor/conductor.mjs';
import { setupProfilePaths } from '../../conductor/lib/profile.mjs';
import { tryAcquireTaskLock } from '../../conductor/lib/task-lock.mjs';

const DASHBOARD_BIN = path.join(REPO_ROOT, 'conductor', 'dashboard', 'server.mjs');
const LISTEN_LINE_RE = /^dashboard listening on (http:\/\/127\.0\.0\.1:(\d+))$/m;

const FEASIBILITY_MD = [
  '# Feasibility Study: dashboard sync actions fixture',
  '',
  '## 选项对比',
  '',
  '| 选项 | 描述 |',
  '| --- | --- |',
  '| O-A: 方案 A | 描述 A |',
  '| O-B: 方案 B | 描述 B |',
  '',
  '## 推荐',
  '',
  '推荐 O-B。',
  '',
  '## 开放问题',
  '',
  '（无）',
  '',
].join('\n');

function dashboardChildEnv(env) {
  const e = {
    ...process.env,
    CONDUCTOR_ROOT: env.root,
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_SCRIPT: env.scenarioPath,
    FAKE_CLAUDE_LOG: env.logPath,
  };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

/** 起一个 dashboard server 子进程，解析 stdout 地址行拿到实际 baseUrl/port，测试结束自动 kill。 */
function startDashboard(t, env, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DASHBOARD_BIN, ...extraArgs], { env: dashboardChildEnv(env) });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      const m = stdout.match(LISTEN_LINE_RE);
      if (m && !settled) {
        settled = true;
        resolve({ child, baseUrl: m[1], port: Number(m[2]), stdoutLine: m[0] });
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => { if (!settled) reject(err); });
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`dashboard 未就绪即退出（code=${code}）：${stderr}`));
    });
    t.after(() => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } });
  });
}

async function getJson(baseUrl, p) {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(baseUrl, p, payload) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function postRaw(baseUrl, p, rawBody) {
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', body: rawBody });
  return { status: res.status, body: await res.json() };
}

async function waitFor(fn, timeoutMs = 4000, stepMs = 30) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---- AC-002：默认端口 / --port 覆盖 / --port 0 随机端口 / host 恒 127.0.0.1 / 地址行格式 ----

test('AC-002: 默认端口 4400，--port 0 用随机可用端口且互不相同，listen host 恒 127.0.0.1', async (t) => {
  const env = makeEnv(t);

  const defaultSrv = await startDashboard(t, env, ['--no-auto-run']);
  assert.equal(defaultSrv.port, 4400);
  assert.equal(defaultSrv.baseUrl, 'http://127.0.0.1:4400');
  assert.match(defaultSrv.stdoutLine, /^dashboard listening on http:\/\/127\.0\.0\.1:4400$/);
  const board = await getJson(defaultSrv.baseUrl, '/api/board');
  assert.equal(board.status, 200);
  defaultSrv.child.kill('SIGTERM');

  const rand1 = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const rand2 = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  assert.notEqual(rand1.port, 4400);
  assert.notEqual(rand2.port, 4400);
  assert.notEqual(rand1.port, rand2.port, '两个 --port 0 实例应各自拿到不同的随机端口');
  assert.match(rand1.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

// ---- AC-001：loadCfg(resolveRoot()) 读写作用于 CONDUCTOR_ROOT 指向的根目录 ----

test('AC-001: server 经 CONDUCTOR_ROOT 解析配置，读写作用于该根目录下的任务数据', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-101';
  env.writeTask(id, { stage: 'READY' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, '/api/board');
  assert.equal(status, 200);
  const makerLane = body.lanes.find((l) => l.lane === 'maker');
  assert.ok(makerLane.tasks.some((tk) => tk.id === id), 'board 应反映 CONDUCTOR_ROOT 指向根目录里的任务');
});

// ---- AC-005：board 聚合形状 + 泳道固定顺序 + 无跨请求缓存 ----

test('AC-005: GET /api/board 泳道固定顺序、契约字段齐全，每次请求现读磁盘无缓存', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const first = await getJson(srv.baseUrl, '/api/board');
  assert.equal(first.status, 200);
  for (const key of ['lanes', 'done', 'failed', 'broken']) assert.ok(key in first.body, key);
  assert.deepEqual(first.body.lanes.map((l) => l.lane), ['setup', 'feasibility', 'spec', 'maker', 'verify', 'merge']);
  assert.deepEqual(first.body.done, []);
  assert.deepEqual(first.body.failed, []);
  assert.equal(first.body.lanes.find((l) => l.lane === 'maker').tasks.length, 0);

  const id = 'task-20260705-102';
  env.writeTask(id, { stage: 'READY', spent: 1.234 });

  const second = await getJson(srv.baseUrl, '/api/board');
  const entry = second.body.lanes.find((l) => l.lane === 'maker').tasks.find((tk) => tk.id === id);
  assert.ok(entry, '新写入的任务应在下一次请求中现读到（无跨请求缓存）');
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['box', 'id', 'kind', 'lane', 'needsHuman', 'spentUsd', 'stage', 'title', 'working'].sort(),
  );
  assert.equal(entry.box, 'queue');
  assert.equal(entry.stage, 'READY');
  assert.equal(entry.needsHuman, false);
  assert.equal(entry.working, true);
  assert.equal(entry.spentUsd, 1.234);
});

// ---- AC-009/AC-010：任务详情结构 + setup/spec review 全文与缺失提示 + 404 ----

test('AC-009/AC-010: GET /api/task/<id> 结构完整；setup/spec review 全文正确装载；404', async (t) => {
  const env = makeEnv(t);
  const cfg = loadCfg(env.root);

  const setupId = 'task-20260705-110';
  env.writeTask(setupId, { stage: 'AWAIT_SETUP_APPROVAL' });
  const draftPaths = setupProfilePaths(cfg);
  fs.mkdirSync(draftPaths.dir, { recursive: true });
  fs.writeFileSync(draftPaths.draft, '# Setup Profile Draft\n\n- test: node --test\n');

  const specId = 'task-20260705-112';
  env.writeTask(specId, { kind: 'feature', stage: 'AWAIT_SPEC_APPROVAL' });
  fs.mkdirSync(cfg.specsDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.specsDir, `${specId}.md`), '# spec 草稿\n\n## 验收标准\n\n- AC-001 …\n');

  const specMissingId = 'task-20260705-113';
  env.writeTask(specMissingId, { kind: 'feature', stage: 'AWAIT_SPEC_APPROVAL' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const setupDetail = await getJson(srv.baseUrl, `/api/task/${setupId}`);
  assert.equal(setupDetail.status, 200);
  assert.equal(setupDetail.body.box, 'queue');
  assert.equal(setupDetail.body.lane, 'setup');
  assert.equal(setupDetail.body.timeline, '');
  assert.ok(setupDetail.body.paths.taskDir && setupDetail.body.paths.specDraft && setupDetail.body.paths.dossierDir);
  assert.equal(setupDetail.body.review.kind, 'setup');
  assert.equal(setupDetail.body.review.markdown, '# Setup Profile Draft\n\n- test: node --test\n');

  const specDetail = await getJson(srv.baseUrl, `/api/task/${specId}`);
  assert.equal(specDetail.status, 200);
  assert.equal(specDetail.body.review.kind, 'spec');
  assert.match(specDetail.body.review.markdown, /AC-001/);

  const specMissingDetail = await getJson(srv.baseUrl, `/api/task/${specMissingId}`);
  assert.equal(specMissingDetail.status, 200);
  assert.equal(specMissingDetail.body.review.missing, true);
  assert.ok(specMissingDetail.body.review.message);

  const notFound = await getJson(srv.baseUrl, '/api/task/task-20260101-999');
  assert.equal(notFound.status, 404);
  assert.ok(notFound.body.error);
});

test('AC-010: setup profile 草稿缺失时 review 给出缺失提示，接口仍 200', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-120';
  env.writeTask(id, { stage: 'AWAIT_SETUP_APPROVAL' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const detail = await getJson(srv.baseUrl, `/api/task/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.review.kind, 'setup');
  assert.equal(detail.body.review.missing, true);
  assert.ok(detail.body.review.message);
});

// ---- AC-012：merge review 的只读 git diff --shortstat，成功与失败两路 ----

test('AC-012: AWAIT_HUMAN_MERGE 详情 review 含 git diff --shortstat；无有效分支时给可读错误，仍 200', async (t) => {
  const env = makeEnv(t);

  const okId = 'task-20260705-130';
  env.writeTask(okId, { stage: 'AWAIT_HUMAN_MERGE' });
  execFileSync('git', ['-C', env.targetDir, 'checkout', '-b', `task/${okId}`], { stdio: 'pipe' });
  fs.writeFileSync(path.join(env.targetDir, 'DASHBOARD_AC012.md'), 'fixture change for AC-012\n');
  execFileSync('git', ['-C', env.targetDir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'commit', '-m', 'fixture: AC-012 diff'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'checkout', 'main'], { stdio: 'pipe' });

  const failId = 'task-20260705-131';
  env.writeTask(failId, { stage: 'AWAIT_HUMAN_MERGE' }); // task/<id> 分支不存在

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const okDetail = await getJson(srv.baseUrl, `/api/task/${okId}`);
  assert.equal(okDetail.status, 200);
  assert.equal(okDetail.body.review.kind, 'merge');
  assert.match(okDetail.body.review.diffShortstat, /file/);

  const failDetail = await getJson(srv.baseUrl, `/api/task/${failId}`);
  assert.equal(failDetail.status, 200);
  assert.equal(failDetail.body.review.kind, 'merge');
  assert.ok(failDetail.body.review.error, 'git diff 失败应给出可读错误文本');
});

// ---- AC-013/AC-014：六个同步动作 argv 透传 + 非零退出/锁忙以 200+ok:false 呈现 ----

test('AC-013/AC-014: 六个同步动作 spawn CLI 并同步回传；非法 option 与锁忙均 200 且 ok:false', async (t) => {
  const env = makeEnv(t);
  const cfg = loadCfg(env.root);

  const approveId = 'task-20260705-140';
  env.writeTask(approveId, { stage: 'AWAIT_SPEC_APPROVAL' });

  const rejectId = 'task-20260705-141';
  env.writeTask(rejectId, { stage: 'AWAIT_SPEC_APPROVAL' });

  const feasApproveId = 'task-20260705-142';
  const feasApproveDir = env.writeTask(feasApproveId, { kind: 'feature', stage: 'AWAIT_FEASIBILITY_APPROVAL' });
  fs.writeFileSync(path.join(feasApproveDir, 'feasibility-study.md'), FEASIBILITY_MD);

  const feasInvalidId = 'task-20260705-143';
  const feasInvalidDir = env.writeTask(feasInvalidId, { kind: 'feature', stage: 'AWAIT_FEASIBILITY_APPROVAL' });
  fs.writeFileSync(path.join(feasInvalidDir, 'feasibility-study.md'), FEASIBILITY_MD);

  const feasRejectId = 'task-20260705-144';
  const feasRejectDir = env.writeTask(feasRejectId, { kind: 'feature', stage: 'AWAIT_FEASIBILITY_APPROVAL' });
  fs.writeFileSync(path.join(feasRejectDir, 'feasibility-study.md'), FEASIBILITY_MD);

  const setupId = 'task-20260705-145';
  env.writeTask(setupId, { stage: 'AWAIT_SETUP_APPROVAL' });
  const draftPaths = setupProfilePaths(cfg);
  fs.mkdirSync(draftPaths.dir, { recursive: true });
  fs.writeFileSync(draftPaths.draft, '# Setup Profile Draft\n');

  const retryId = 'task-20260705-146';
  env.writeTask(retryId, { stage: 'READY' });

  const busyId = 'task-20260705-147';
  env.writeTask(busyId, { stage: 'AWAIT_SPEC_APPROVAL' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const approveRes = await postJson(srv.baseUrl, `/api/task/${approveId}/approve`, {});
  assert.equal(approveRes.status, 200);
  assert.deepEqual(Object.keys(approveRes.body).sort(), ['exitCode', 'message', 'ok'].sort());
  assert.equal(approveRes.body.ok, true);
  assert.equal(approveRes.body.exitCode, 0);
  assert.match(approveRes.body.message, /approval=approved/);
  assert.equal(env.findTask(approveId).runtime.approval, 'approved');

  const rejectRes = await postJson(srv.baseUrl, `/api/task/${rejectId}/reject`, { notes: '需要更清晰的验证方式' });
  assert.equal(rejectRes.body.ok, true);
  assert.match(rejectRes.body.message, /approval=rejected/);
  const rejectNotes = fs.readFileSync(path.join(env.root, 'state', 'queue', rejectId, 'reject_notes.md'), 'utf8');
  assert.match(rejectNotes, /需要更清晰的验证方式/);

  const feasApproveRes = await postJson(srv.baseUrl, `/api/task/${feasApproveId}/approve-feasibility`, { option: 'O-B', notes: '按 O-B 走' });
  assert.equal(feasApproveRes.body.ok, true);
  assert.match(feasApproveRes.body.message, /feasibility_approval=approved/);
  assert.match(feasApproveRes.body.message, /option=O-B/);
  const feasApproved = env.findTask(feasApproveId);
  assert.equal(feasApproved.runtime.chosen_option, 'O-B');
  assert.equal(feasApproved.runtime.feasibility_decision_notes, '按 O-B 走');

  const feasInvalidRes = await postJson(srv.baseUrl, `/api/task/${feasInvalidId}/approve-feasibility`, { option: 'O-Z' });
  assert.equal(feasInvalidRes.status, 200, 'CLI 非零退出也应 200，而非 5xx');
  assert.equal(feasInvalidRes.body.ok, false);
  assert.equal(feasInvalidRes.body.exitCode, 1);
  assert.match(feasInvalidRes.body.message, /不在草稿枚举/);
  assert.notEqual(env.findTask(feasInvalidId).runtime.feasibility_approval, 'approved', '拒绝后任务保持原状');

  const feasRejectRes = await postJson(srv.baseUrl, `/api/task/${feasRejectId}/reject-feasibility`, { notes: '证据不足' });
  assert.equal(feasRejectRes.body.ok, true);
  assert.match(feasRejectRes.body.message, /feasibility_approval=rejected/);
  const feasRejectNotes = fs.readFileSync(path.join(feasRejectDir, 'feasibility_reject_notes.md'), 'utf8');
  assert.match(feasRejectNotes, /证据不足/);

  const setupRes = await postJson(srv.baseUrl, `/api/task/${setupId}/approve-setup`, {});
  assert.equal(setupRes.body.ok, true);
  assert.match(setupRes.body.message, /setup_approval=approved/);

  const retryRes = await postJson(srv.baseUrl, `/api/task/${retryId}/retry`, {});
  assert.equal(retryRes.body.ok, true);
  assert.equal(env.findTask(retryId).runtime.stage, 'READY');

  const lock = tryAcquireTaskLock(cfg, busyId);
  assert.equal(lock.acquired, true);
  try {
    const busyRes = await postJson(srv.baseUrl, `/api/task/${busyId}/approve`, {});
    assert.equal(busyRes.status, 200);
    assert.equal(busyRes.body.ok, false);
    assert.match(busyRes.body.message, /任务正被推进/);
  } finally {
    lock.release();
  }
});

// ---- AC-015：同步动作成功后 detached 后台触发 run（不阻塞响应）；--no-auto-run 跳过 ----

test('AC-015: 同步动作 exitCode=0 后，server 后台触发一次 conductor run，响应不等待其完成', async (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 0 } });
  const id = 'task-20260705-150';
  env.writeTask(id, { stage: 'AWAIT_SETUP_APPROVAL' });
  const cfg = loadCfg(env.root);
  const draftPaths = setupProfilePaths(cfg);
  fs.mkdirSync(draftPaths.dir, { recursive: true });
  fs.writeFileSync(draftPaths.draft, '# Setup Profile Draft\n\n- test: node --test\n');
  env.setScenario([
    {
      delayMs: 800,
      actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }],
      session_id: 'sess-maker-ac015',
      cost: 0.05,
      result: '已修复',
    },
    verifierStep(1, { 'AC-001': 'pass', 'AC-002': 'pass' }),
  ]);

  const srv = await startDashboard(t, env, ['--port', '0']); // 默认 autoRun=true

  const startedAt = Date.now();
  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve-setup`, {});
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.body.ok, true);
  assert.ok(elapsedMs < 500, `响应应在后台 maker 完成（含 800ms 延时）之前返回，实际耗时 ${elapsedMs}ms`);

  await waitFor(() => env.findTask(id)?.runtime.stage === 'AWAIT_HUMAN_MERGE', 6000);
});

test('AC-015: --no-auto-run 启动时，同步动作成功后不触发后台 run', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-151';
  env.writeTask(id, { stage: 'AWAIT_SETUP_APPROVAL' });
  const cfg = loadCfg(env.root);
  const draftPaths = setupProfilePaths(cfg);
  fs.mkdirSync(draftPaths.dir, { recursive: true });
  fs.writeFileSync(draftPaths.draft, '# Setup Profile Draft\n\n- test: node --test\n');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve-setup`, {});
  assert.equal(res.body.ok, true);

  await new Promise((r) => setTimeout(r, 500));
  const after = env.findTask(id);
  assert.equal(after.runtime.setup_approval, 'approved', 'CLI 动作本身的效果应生效');
  assert.equal(after.runtime.stage, 'AWAIT_SETUP_APPROVAL', '未触发 run，stage 不应推进');
});

// ---- AC-016：merge 走 detached 后台，立即返回，后台失败不改变任务状态 ----

test('AC-016: POST .../merge 立即返回「已触发」；无有效分支时后台 merge 失败但任务保持原状', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-160';
  // spent_usd >= 默认 budgetUsd=5：committer 提案 fail-open 直接跳过，merge 失败路径不依赖 fake-claude。
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE', spent: 6 });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const startedAt = Date.now();
  const res = await postJson(srv.baseUrl, `/api/task/${id}/merge`, {});
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /已触发/);
  assert.ok(elapsedMs < 300, 'merge 端点不应同步等待 merge 完成');

  await new Promise((r) => setTimeout(r, 800)); // 给后台 merge 尝试并失败留出时间
  const after = env.findTask(id);
  assert.equal(after.box, 'queue');
  assert.equal(after.runtime.stage, 'AWAIT_HUMAN_MERGE', '无 task/<id> 分支，后台 merge 应失败，任务保持原状');
});

// ---- AC-017：new-task 透传 CLI + brief 临时文件生命周期 + id 解析 + feasibility 显式布尔 ----

test('AC-017: POST /api/new-task 透传 CLI，brief 临时文件用后即删，id 解析，feasibility 显式布尔', async (t) => {
  const env = makeEnv(t);
  env.writeApprovedSetupProfile();
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const briefPrefix = `dashboard-brief-${srv.child.pid}-`;

  const bugfixRes = await postJson(srv.baseUrl, '/api/new-task', {
    kind: 'bugfix', title: 'dashboard 新建 bugfix 用例', brief: 'AC-017 brief 原文 marker',
  });
  assert.equal(bugfixRes.status, 200);
  assert.equal(bugfixRes.body.ok, true);
  assert.match(bugfixRes.body.id, /^task-\d{8}-\d{3}$/);
  assert.match(bugfixRes.body.message, /编辑该目录的 spec\.md/);

  await waitFor(() => !fs.readdirSync(os.tmpdir()).some((n) => n.startsWith(briefPrefix)), 1000);

  const bugfixTask = env.findTask(bugfixRes.body.id);
  assert.equal(bugfixTask.task.kind, 'bugfix');
  assert.equal('feasibility' in bugfixTask.task, false, 'bugfix 不应带 feasibility 字段');

  const featureRes = await postJson(srv.baseUrl, '/api/new-task', {
    kind: 'feature', title: 'dashboard 新建 feature 用例', brief: '', feasibility: true,
  });
  assert.equal(featureRes.body.ok, true);
  const featureTask = env.findTask(featureRes.body.id);
  assert.equal(featureTask.task.feasibility, true);
  assert.equal(featureTask.runtime.stage, 'NEEDS_FEASIBILITY');

  const featureNoFeasRes = await postJson(srv.baseUrl, '/api/new-task', {
    kind: 'feature', title: 'dashboard 新建 feature（不走 feasibility）',
  });
  assert.equal(featureNoFeasRes.body.ok, true);
  const featureNoFeasTask = env.findTask(featureNoFeasRes.body.id);
  assert.equal(featureNoFeasTask.task.feasibility, false);
  assert.equal(featureNoFeasTask.runtime.stage, 'NEEDS_SPEC');
});

// ---- AC-018：非法 id / 未知 action / 缺字段 / 非法 JSON body 均 400，不 spawn ----

test('AC-018: 非法 id / 未知 action / 缺字段 / 非法 JSON body 均 400，任务状态不变', async (t) => {
  const env = makeEnv(t);
  const validId = 'task-20260705-170';
  env.writeTask(validId, { stage: 'AWAIT_SPEC_APPROVAL' });
  const before = env.findTask(validId).runtime;

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const badGet = await getJson(srv.baseUrl, '/api/task/not-a-task-id');
  assert.equal(badGet.status, 400);

  const badPost = await postJson(srv.baseUrl, '/api/task/not-a-task-id/approve', {});
  assert.equal(badPost.status, 400);

  const unknownAction = await postJson(srv.baseUrl, `/api/task/${validId}/unknown-action`, {});
  assert.equal(unknownAction.status, 400);
  assert.match(unknownAction.body.error, /unknown action/);

  const missingKind = await postJson(srv.baseUrl, '/api/new-task', { title: '缺 kind' });
  assert.equal(missingKind.status, 400);

  const missingTitle = await postJson(srv.baseUrl, '/api/new-task', { kind: 'bugfix' });
  assert.equal(missingTitle.status, 400);

  const badJsonSync = await postRaw(srv.baseUrl, `/api/task/${validId}/approve`, '{not json');
  assert.equal(badJsonSync.status, 400);

  const badJsonNewTask = await postRaw(srv.baseUrl, '/api/new-task', '{not json');
  assert.equal(badJsonNewTask.status, 400);

  const after = env.findTask(validId).runtime;
  assert.deepEqual(after, before, '全部非法请求均在 spawn 前拒绝，任务状态不应变化');
});
