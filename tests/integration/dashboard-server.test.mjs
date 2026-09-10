// 集成：dashboard/server.mjs 作为真实 HTTP 子进程跑起来（--port 0），覆盖纯逻辑单测覆盖不到的
// 运行时行为——CONDUCTOR_ROOT 解析、监听地址行、GET 端点的 HTTP 形状、CLI 透传 spawn 的同步/
// detached 两种形态、非法输入的 400 边界。核心泳道映射/needsHuman/broken 降级/feasibility 透传
// 已在 tests/unit/dashboard-model.test.mjs 钉住，这里不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { makeEnv, REPO_ROOT, FAKE_CLAUDE } from '../helpers/env.mjs';
import { makerStep, newRouterEnv, reviewerStep, routerStep, specStep } from '../helpers/router-env.mjs';
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

function dashboardChildEnv(env, extraEnv = {}) {
  const e = {
    ...process.env,
    CONDUCTOR_ROOT: env.root,
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_SCRIPT: env.scenarioPath,
    FAKE_CLAUDE_LOG: env.logPath,
    ...extraEnv,
  };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

/** 起一个 dashboard server 子进程，解析 stdout 地址行拿到实际 baseUrl/port，测试结束自动 kill。 */
function startDashboard(t, env, extraArgs = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DASHBOARD_BIN, ...extraArgs], { env: dashboardChildEnv(env, extraEnv) });
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

/** 打开 `/api/events` SSE 连接：按 `\n\n` 切帧，支持等待某一帧满足断言的谓词；测试结束自动断开连接。 */
function openSse(t, baseUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      const frames = [];
      const waiters = [];
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(frame)) {
              waiters[i].resolve(frame);
              waiters.splice(i, 1);
            }
          }
        }
      });
      t.after(() => { try { req.destroy(); } catch { /* 已断开 */ } });
      resolve({
        res,
        frames,
        waitForFrame(pred, timeoutMs = 5000) {
          const existing = frames.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error('waitForFrame timeout')), timeoutMs);
            waiters.push({ pred, resolve: (f) => { clearTimeout(timer); res2(f); } });
          });
        },
      });
    });
    req.on('error', reject);
  });
}

/** SSE 帧（含结尾的两个 `\n\n` 已被 openSse 切掉）里的 `data: ` 行 → 解析出的 JSON 对象；无 data 行返回 null。 */
function sseData(frame) {
  const line = frame.split('\n').find((l) => l.startsWith('data: '));
  return line ? JSON.parse(line.slice('data: '.length)) : null;
}

/** 轮询 `/api/jobs` 直到目标 jobId 到达终态（ok/fail），返回该 job 记录。 */
async function waitForJobTerminal(baseUrl, jobId, timeoutMs = 6000) {
  return waitFor(async () => {
    const { body } = await getJson(baseUrl, '/api/jobs');
    const job = body.jobs.find((j) => j.id === jobId);
    return job && job.state !== 'running' ? job : null;
  }, timeoutMs);
}

// ---- AC-007：--port 0 随机端口 / host 恒 127.0.0.1 / 地址行格式 ----

test('AC-007: --port 0 用随机可用端口且互不相同，listen host 恒 127.0.0.1，地址行格式正确', async (t) => {
  const env = makeEnv(t);

  const rand1 = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const rand2 = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  assert.notEqual(rand1.port, 4400);
  assert.notEqual(rand2.port, 4400);
  assert.notEqual(rand1.port, rand2.port, '两个 --port 0 实例应各自拿到不同的随机端口');
  assert.match(rand1.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(rand1.stdoutLine, /^dashboard listening on http:\/\/127\.0\.0\.1:\d+$/);
});

// ---- AC-002/AC-008：默认端口 4400 被占用时，--port 0 实例仍正常工作（不再真实监听 4400 证明默认值） ----

test('AC-002/AC-009: 4400 被占用时，--port 0 启动的 dashboard 实例仍正常工作（不真实监听 4400）', async (t) => {
  const env = makeEnv(t);

  // 尽力自建占位监听来模拟"4400 已被占用"；若 4400 本就已被外部进程占用（真实 AC-009
  // 场景，例如常驻 dashboard），EADDRINUSE 本身已经证明前提成立，不应导致用例失败。
  const placeholder = http.createServer((req, res) => res.end('placeholder'));
  let ownsPlaceholder = false;
  await new Promise((resolve, reject) => {
    placeholder.once('error', (err) => {
      if (err.code === 'EADDRINUSE') { resolve(); return; }
      reject(err);
    });
    placeholder.once('listening', () => { ownsPlaceholder = true; resolve(); });
    placeholder.listen(4400, '127.0.0.1');
  });
  t.after(() => {
    if (!ownsPlaceholder) return undefined;
    return new Promise((resolve) => placeholder.close(() => resolve()));
  });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const board = await getJson(srv.baseUrl, '/api/board');
  assert.equal(board.status, 200);
});

// ---- AC-003/AC-004/AC-005：静态文件路由 ----

test('AC-003: GET /static/<file> 命中白名单目录内存在的文件，返回 200 与正确 Content-Type，内容与磁盘一致', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const staticDir = path.join(REPO_ROOT, 'conductor', 'dashboard', 'static');

  const cssRes = await fetch(`${srv.baseUrl}/static/tokens.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type'), /^text\/css; charset=utf-8$/);
  assert.equal(await cssRes.text(), fs.readFileSync(path.join(staticDir, 'tokens.css'), 'utf8'));

  const mjsRes = await fetch(`${srv.baseUrl}/static/view.mjs`);
  assert.equal(mjsRes.status, 200);
  assert.match(mjsRes.headers.get('content-type'), /^text\/javascript; charset=utf-8$/);
  assert.equal(await mjsRes.text(), fs.readFileSync(path.join(staticDir, 'view.mjs'), 'utf8'));
});

test('AC-004: 静态路由防路径穿越，逃逸白名单目录的请求一律 404 且不读取目录外内容', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const sanity = await fetch(`${srv.baseUrl}/static/tokens.css`);
  assert.equal(sanity.status, 200, '静态路由应先能命中白名单内的合法文件，穿越防护才有意义');

  for (const p of [
    '/static/../server.mjs',
    '/static/../../package.json',
    '/static/%2e%2e/server.mjs',
    '/static/%2e%2e%2fserver.mjs',
    '/static/%2e%2e%2f%2e%2e/package.json',
  ]) {
    const res = await fetch(`${srv.baseUrl}${p}`);
    assert.equal(res.status, 404, p);
  }
});

test('AC-005: 静态路由对白名单目录内不存在的路径 404；既有 GET / 与 /api/* 不受影响', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const sanity = await fetch(`${srv.baseUrl}/static/tokens.css`);
  assert.equal(sanity.status, 200, '静态路由应存在，才能断言"目录内不存在的路径"这一区分');

  const missing = await fetch(`${srv.baseUrl}/static/nope.css`);
  assert.equal(missing.status, 404);

  const indexRes = await fetch(`${srv.baseUrl}/`);
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get('content-type'), /text\/html/);

  const boardRes = await getJson(srv.baseUrl, '/api/board');
  assert.equal(boardRes.status, 200);
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
  for (const key of ['columns', 'legacy', 'lanes', 'done', 'failed', 'broken']) assert.ok(key in first.body, key);
  assert.deepEqual(first.body.columns.map((c) => c.column), ['ROUTING', 'AWAIT_HUMAN', 'FAILED_BOX', 'DONE']);
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
    ['awaitingKind', 'box', 'column', 'id', 'kind', 'lane', 'lastFailureType', 'legacy', 'needsHuman', 'spentUsd', 'stage', 'title', 'working'].sort(),
  );
  // 遗留 stage 名的任务不占任何新列，归 legacy 分组（AC-029）
  assert.equal(second.body.columns.every((c) => c.tasks.length === 0), true);
  assert.deepEqual(second.body.legacy.map((tk) => tk.id), [id]);
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

test('AC-002: GET /api/task/<id> 载荷 timeline 与 timelineEntries 字段并存', async (t) => {
  const env = makeEnv(t);
  const cfg = loadCfg(env.root);

  const id = 'task-20260705-115';
  env.writeTask(id, { stage: 'READY' });
  const dossierDir = path.join(cfg.dossierDir, id);
  fs.mkdirSync(dossierDir, { recursive: true });
  const timelineText = '- 2026-07-05T00:00:00.000Z stage → READY\n非法行\n';
  fs.writeFileSync(path.join(dossierDir, 'timeline.md'), timelineText);

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const detail = await getJson(srv.baseUrl, `/api/task/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.timeline, timelineText);
  assert.deepEqual(detail.body.timelineEntries, [
    { ts: '2026-07-05T00:00:00.000Z', text: 'stage → READY' },
    { ts: null, text: '非法行' },
  ]);
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

// ==== P2：GET /api/task/:id/diff（分文件 diff） ============================

function gitNumstat(repo, baseBranch, branch) {
  const out = execFileSync('git', ['-C', repo, 'diff', '--numstat', `${baseBranch}...${branch}`], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const [added, deleted, ...rest] = line.split('\t');
    return { added, deleted, path: rest.join('\t') };
  });
}

test('P2-AC-001: GET /api/task/:id/diff 的 files 路径集合/+N-N 计数与 git diff --numstat 逐项一致，非降级文件 patch 等于 git diff -- <path>', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-500';
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE' });

  execFileSync('git', ['-C', env.targetDir, 'checkout', '-b', `task/${id}`], { stdio: 'pipe' });
  fs.writeFileSync(path.join(env.targetDir, 'DIFF_NEW.md'), 'brand new file\nline 2\n');
  fs.appendFileSync(path.join(env.targetDir, 'README.md'), '追加一行用于 P2-AC-001。\n');
  execFileSync('git', ['-C', env.targetDir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'commit', '-m', 'fixture: P2-AC-001 diff'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'checkout', 'main'], { stdio: 'pipe' });

  const expected = gitNumstat(env.targetDir, 'main', `task/${id}`);
  assert.ok(expected.length >= 2, '夹具应至少产生两个改动文件');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, `/api/task/${id}/diff`);
  assert.equal(status, 200);
  assert.equal(body.cleaned, false);
  assert.deepEqual(
    body.files.map((f) => f.path).sort(),
    expected.map((e) => e.path).sort(),
  );
  for (const exp of expected) {
    const got = body.files.find((f) => f.path === exp.path);
    assert.ok(got, exp.path);
    assert.equal(got.added, Number(exp.added));
    assert.equal(got.deleted, Number(exp.deleted));
    assert.equal(got.binary, false);
    assert.equal(got.oversize, false);
    const rawPatch = execFileSync(
      'git', ['-C', env.targetDir, 'diff', `main...task/${id}`, '--', exp.path], { encoding: 'utf8' },
    );
    assert.equal(got.patch, rawPatch, `${exp.path} patch 应与 git diff -- <path> 逐字一致`);
  }
});

test('P2-AC-002: 超 verifierDiffMaxBytes 的文件降级 oversize:true/patch:null 但保留计数；二进制文件 binary:true/patch:null', async (t) => {
  const env = makeEnv(t, { config: { verifierDiffMaxBytes: 80 } });
  const id = 'task-20260705-501';
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE' });

  execFileSync('git', ['-C', env.targetDir, 'checkout', '-b', `task/${id}`], { stdio: 'pipe' });
  const bigLines = Array.from({ length: 30 }, (_, i) => `line ${i} 足够长以撑大 unified diff 字节数`).join('\n');
  fs.writeFileSync(path.join(env.targetDir, 'OVERSIZE.md'), `${bigLines}\n`);
  fs.writeFileSync(path.join(env.targetDir, 'BINARY.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 253, 0, 0]));
  execFileSync('git', ['-C', env.targetDir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'commit', '-m', 'fixture: P2-AC-002 oversize + binary'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'checkout', 'main'], { stdio: 'pipe' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, `/api/task/${id}/diff`);
  assert.equal(status, 200);
  assert.equal(body.cleaned, false);

  const big = body.files.find((f) => f.path === 'OVERSIZE.md');
  assert.ok(big, 'OVERSIZE.md 应出现在 files 中');
  assert.equal(big.oversize, true);
  assert.equal(big.patch, null);
  assert.ok(big.added > 0, '超限文件仍应带 +N 计数');

  const bin = body.files.find((f) => f.path === 'BINARY.bin');
  assert.ok(bin, 'BINARY.bin 应出现在 files 中');
  assert.equal(bin.binary, true);
  assert.equal(bin.patch, null);
});

test('P2-AC-003: task/<id> 分支不存在或已清理时返回 200 { cleaned:true, files:[] }，绝不 500', async (t) => {
  const env = makeEnv(t);

  const noBranchId = 'task-20260705-502';
  env.writeTask(noBranchId, { stage: 'AWAIT_HUMAN_MERGE' }); // 从未创建 task/<id> 分支

  const doneId = 'task-20260705-503';
  env.writeTask(doneId, { stage: 'READY' });
  const doneDir = path.join(env.root, 'state', 'done', doneId);
  fs.mkdirSync(doneDir, { recursive: true });
  fs.renameSync(path.join(env.root, 'state', 'queue', doneId, 'task.json'), path.join(doneDir, 'task.json'));
  fs.renameSync(path.join(env.root, 'state', 'queue', doneId, 'runtime.json'), path.join(doneDir, 'runtime.json'));
  fs.rmSync(path.join(env.root, 'state', 'queue', doneId), { recursive: true, force: true });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const noBranchRes = await getJson(srv.baseUrl, `/api/task/${noBranchId}/diff`);
  assert.equal(noBranchRes.status, 200);
  assert.deepEqual(noBranchRes.body, { cleaned: true, files: [] });

  const doneRes = await getJson(srv.baseUrl, `/api/task/${doneId}/diff`);
  assert.equal(doneRes.status, 200);
  assert.deepEqual(doneRes.body, { cleaned: true, files: [] });

  const badId = await getJson(srv.baseUrl, '/api/task/not-a-task-id/diff');
  assert.equal(badId.status, 400);

  const notFound = await getJson(srv.baseUrl, '/api/task/task-20260101-999/diff');
  assert.equal(notFound.status, 404);
});

test('P3-AC-002: GET /api/task/:id/diff 对含中文文件名与 rename 的真实 git fixture 输出正确路径与 patch', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260713-500';
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE' });

  const renamedPath = 'lib/stats-renamed.mjs';
  const chinesePath = '中文文件名.md';

  execFileSync('git', ['-C', env.targetDir, 'checkout', '-b', `task/${id}`], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'mv', 'lib/stats.mjs', renamedPath], { stdio: 'pipe' });
  fs.appendFileSync(path.join(env.targetDir, renamedPath), '\n// P3-AC-002 rename fixture 追加一行\n');
  fs.writeFileSync(path.join(env.targetDir, chinesePath), '中文文件名 fixture 内容\n第二行\n');
  execFileSync('git', ['-C', env.targetDir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'commit', '-m', 'fixture: P3-AC-002 rename + 中文文件名'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'checkout', 'main'], { stdio: 'pipe' });

  // 用真实 git 校验夹具确实触发了 rename 检测（否则这条测试本身没验证到 rename 场景）。
  const nameStatus = execFileSync(
    'git', ['-C', env.targetDir, 'diff', '--name-status', `main...task/${id}`], { encoding: 'utf8' },
  );
  assert.match(nameStatus, /^R\d+\t/m, 'git 应把该改动识别为 rename');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, `/api/task/${id}/diff`);
  assert.equal(status, 200);
  assert.equal(body.cleaned, false);

  const paths = body.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [chinesePath, renamedPath].sort(), 'files 路径集合应为新路径本身，既无残留旧路径也无 "old => new" 合并伪路径');
  for (const p of paths) assert.doesNotMatch(p, /=>/, `${p} 不应是 "old => new" 合并伪路径`);

  const renamed = body.files.find((f) => f.path === renamedPath);
  assert.ok(renamed, 'rename 后的新路径应出现在 files 中');
  assert.match(renamed.status, /^R/, 'rename 文件的 status 应以 R 开头');
  assert.equal(renamed.binary, false);
  assert.ok(renamed.patch && renamed.patch.length > 0, 'rename 文件的 patch 不应为空');
  assert.match(renamed.patch, /rename from lib\/stats\.mjs/);
  assert.match(renamed.patch, new RegExp(`rename to ${renamedPath.replace('.', '\\.')}`));
  assert.match(renamed.patch, /P3-AC-002 rename fixture 追加一行/, 'rename 文件的 patch 应含真实新增内容，而非伪造的整文件新增');

  const chinese = body.files.find((f) => f.path === chinesePath);
  assert.ok(chinese, '中文文件名应以真实未转义路径出现在 files 中');
  assert.equal(chinese.binary, false);
  assert.ok(chinese.patch && chinese.patch.length > 0, '中文文件名文件的 patch 不应为空');
  assert.match(chinese.patch, new RegExp(`\\+\\+\\+ b/${chinesePath}`), 'patch 头部应含真实未转义的中文路径');
  assert.match(chinese.patch, /中文文件名 fixture 内容/);
});

// ==== P4：SSE 失效通知（AC-001/002/003） ============================

test('P4-AC-001: GET /api/events 响应头为 text/event-stream，连接建立即写出心跳注释行，且不立即关闭', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const sse = await openSse(t, srv.baseUrl);
  assert.match(sse.res.headers['content-type'], /text\/event-stream/);
  const first = await sse.waitForFrame((f) => f.startsWith(':'));
  assert.match(first, /^:/);
  assert.equal(sse.res.complete, false, '连接建立后不应立即关闭');
});

test('P4-AC-002: state/queue 变更推 board-dirty，dossier/<id> 变更推 task-dirty；事件体只含 type(+id)，不含 board/task 数据（INV-1）', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const sse = await openSse(t, srv.baseUrl);
  await sse.waitForFrame((f) => f.startsWith(':')); // 先确认已连上再触发变更

  const id = 'task-20260713-800';
  env.writeTask(id, { stage: 'READY' });

  const boardFrame = await sse.waitForFrame((f) => sseData(f)?.type === 'board-dirty');
  assert.deepEqual(Object.keys(sseData(boardFrame)).sort(), ['type']);

  fs.mkdirSync(env.dossier(id), { recursive: true });
  fs.writeFileSync(
    env.dossier(id, 'maker-r1.json'),
    JSON.stringify({ role: 'maker', round: 1, started: '2026-07-13T00:00:00.000Z' }),
  );

  const taskFrame = await sse.waitForFrame((f) => sseData(f)?.type === 'task-dirty');
  const taskData = sseData(taskFrame);
  assert.deepEqual(Object.keys(taskData).sort(), ['id', 'type']);
  assert.equal(taskData.id, id);
});

test('P4-AC-003: DASHBOARD_FORCE_SCAN=1 强制降级为周期扫描时仍在数秒内推送 board-dirty，连接保持存活', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run'], { DASHBOARD_FORCE_SCAN: '1' });
  const sse = await openSse(t, srv.baseUrl);
  await sse.waitForFrame((f) => f.startsWith(':'));

  const id = 'task-20260713-801';
  env.writeTask(id, { stage: 'READY' });

  const boardFrame = await sse.waitForFrame((f) => sseData(f)?.type === 'board-dirty', 6000);
  assert.ok(boardFrame);
  assert.equal(sse.res.complete, false, '扫描降级路径下连接也应保持存活');
});

// ==== P4：实时活动面（AC-005） ============================

test('P4-AC-005: GET /api/activity 无活跃任务时返回 200 { active: [] }', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, '/api/activity');
  assert.equal(status, 200);
  assert.deepEqual(body, { active: [] });
});

test('P4-AC-005: GET /api/activity 对新鲜 stream.jsonl 产出活跃条目，形状与 model 层一致', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260713-810';
  env.writeTask(id, { stage: 'READY' });
  const dossierDir = env.dossier(id);
  fs.mkdirSync(dossierDir, { recursive: true });
  fs.writeFileSync(path.join(dossierDir, 'maker-r1.json'), JSON.stringify({ role: 'maker', round: 1, started: new Date().toISOString() }));
  fs.writeFileSync(path.join(dossierDir, 'maker-r1.stream.jsonl'), '{}\n');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const { status, body } = await getJson(srv.baseUrl, '/api/activity');
  assert.equal(status, 200);
  assert.equal(body.active.length, 1);
  assert.equal(body.active[0].taskId, id);
  assert.equal(body.active[0].role, 'maker');
  assert.equal(body.active[0].round, 1);
  assert.equal(typeof body.active[0].lastActivity, 'string');
});

// ==== P4：stream tail（AC-008） ============================

test('P4-AC-008: GET /api/task/:id/stream-tail 非法 id 400；任务/文件缺失 200 { lines: [] }；合法内容返回解析行', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260713-811';
  env.writeTask(id, { stage: 'READY' });
  const dossierDir = env.dossier(id);
  fs.mkdirSync(dossierDir, { recursive: true });
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello from stream tail' }] } });
  fs.writeFileSync(path.join(dossierDir, 'maker-r1.stream.jsonl'), `${line}\n`);

  const noStreamId = 'task-20260713-812';
  env.writeTask(noStreamId, { stage: 'READY' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const badId = await getJson(srv.baseUrl, '/api/task/not-a-task-id/stream-tail');
  assert.equal(badId.status, 400);

  const missingRes = await getJson(srv.baseUrl, `/api/task/${noStreamId}/stream-tail`);
  assert.equal(missingRes.status, 200);
  assert.deepEqual(missingRes.body, { lines: [] });

  const okRes = await getJson(srv.baseUrl, `/api/task/${id}/stream-tail`);
  assert.equal(okRes.status, 200);
  assert.deepEqual(okRes.body, { lines: ['hello from stream tail'] });
});

// ---- AC-013/AC-014：四个同步动作 argv 透传 + 非零退出/锁忙以 200+ok:false 呈现 ----

/** 驱动一个任务到指定人闸，返回 id。gate ∈ {spec, merge, help}。 */
function driveToGate(env, id, gate) {
  const specBody = ['# spec 草稿', '', '## 验收标准', '', '- AC-001: `node --test` 全绿', ''].join('\n');
  if (gate === 'spec') {
    env.setScenario([routerStep('spec'), specStep(specBody, { specPath: path.join(env.root, 'specs', `${id}.md`) })]);
  } else if (gate === 'merge') {
    env.setScenario([
      routerStep('maker'), makerStep(),
      routerStep('review'), reviewerStep(),
      routerStep('precommit', { tier: 'unit' }),
      routerStep('merge'),
    ]);
  } else {
    env.setScenario([routerStep('human', { summary: '请人裁决' })]);
  }
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.awaiting.kind, gate);
}

test('AC-013/AC-014: 四个同步动作 spawn CLI 并同步回传；retry 已 job 化（P4-AC-014③）；遗留任务与锁忙均 200 且 ok:false', async (t) => {
  const { env, id: specId } = newRouterEnv(t);
  const cfg = loadCfg(env.root);
  driveToGate(env, specId, 'spec');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  // approve：spec 闸冻结 → ROUTING
  const approveRes = await postJson(srv.baseUrl, `/api/task/${specId}/approve`, { notes: '按最小改动做' });
  assert.equal(approveRes.status, 200);
  assert.deepEqual(Object.keys(approveRes.body).sort(), ['exitCode', 'message', 'ok'].sort());
  assert.equal(approveRes.body.ok, true);
  assert.equal(approveRes.body.exitCode, 0);
  assert.match(approveRes.body.message, /spec 已冻结/);
  assert.equal(env.findTask(specId).runtime.spec_approved, true);

  // resume：help 闸恢复；notes 透传成 --notes
  env.appendScenario([routerStep('human', { summary: '再问一次别的' })]);
  assert.equal(env.run('run').status, 0);
  const resumeRes = await postJson(srv.baseUrl, `/api/task/${specId}/resume`, { notes: '我在 worktree 里改好了' });
  assert.equal(resumeRes.body.ok, true);
  assert.match(resumeRes.body.message, /→ ROUTING/);
  const humanRecord = env.readJson(env.dossier(specId, 'human-r2.json'));
  assert.equal(humanRecord.decision, 'resumed');
  assert.equal(humanRecord.notes, '我在 worktree 里改好了');

  // reject：必须带 notes，缺了就是 CLI 非零退出（200 + ok:false）
  const { env: env2, id: rejectId } = newRouterEnv(t);
  driveToGate(env2, rejectId, 'spec');
  const srv2 = await startDashboard(t, env2, ['--port', '0', '--no-auto-run']);
  const noNotes = await postJson(srv2.baseUrl, `/api/task/${rejectId}/reject`, {});
  assert.equal(noNotes.status, 200, 'CLI 非零退出也应 200，而非 5xx');
  assert.equal(noNotes.body.ok, false);
  assert.equal(noNotes.body.exitCode, 1);
  assert.match(noNotes.body.message, /--notes/);
  const rejectRes = await postJson(srv2.baseUrl, `/api/task/${rejectId}/reject`, { notes: '验证方式写得不清楚' });
  assert.equal(rejectRes.body.ok, true);
  assert.match(rejectRes.body.message, /已打回/);
  assert.equal(env2.findTask(rejectId).runtime.stage, 'ROUTING');

  // abandon：queue 任务 → FAILED_BOX(abandoned)
  const abandonRes = await postJson(srv2.baseUrl, `/api/task/${rejectId}/abandon`, {});
  assert.equal(abandonRes.body.ok, true);
  assert.equal(env2.findTask(rejectId).runtime.last_failure_type, 'abandoned');

  // retry 是 job 化的异步动作：立即 202，终态经 /api/jobs 查
  const retryJobRes = await postJson(srv2.baseUrl, `/api/task/${rejectId}/retry`, {});
  assert.equal(retryJobRes.status, 202, 'retry 应立即 202，不再同步等待（P4-AC-014③）');
  assert.ok(retryJobRes.body.jobId && typeof retryJobRes.body.jobId === 'string');
  const retryJob = await waitForJobTerminal(srv2.baseUrl, retryJobRes.body.jobId);
  assert.equal(retryJob.state, 'ok');
  assert.equal(env2.findTask(rejectId).runtime.stage, 'ROUTING');

  // 锁忙：per-task 锁被别人持有时 200 + ok:false，任务不动
  const lock = tryAcquireTaskLock(cfg, specId);
  assert.equal(lock.acquired, true);
  try {
    const busyRes = await postJson(srv.baseUrl, `/api/task/${specId}/approve`, {});
    assert.equal(busyRes.status, 200);
    assert.equal(busyRes.body.ok, false);
    assert.match(busyRes.body.message, /任务正被推进/);
  } finally {
    lock.release();
  }
});

test('AC-013: 遗留任务的动作按钮已从 SYNC_ACTIONS 删除；硬 POST 也只得到 200 + ok:false，状态零变化', async (t) => {
  const env = makeEnv(t);
  const legacyId = 'task-20260705-149';
  env.writeTask(legacyId, { stage: 'AWAIT_SPEC_APPROVAL' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  for (const gone of ['approve-setup', 'approve-feasibility', 'reject-feasibility', 'approve-scope', 'reject-scope', 'merge']) {
    const res = await postJson(srv.baseUrl, `/api/task/${legacyId}/${gone}`, {});
    assert.equal(res.status, 400, `${gone} 应已不是合法动作`);
  }
  const approveRes = await postJson(srv.baseUrl, `/api/task/${legacyId}/approve`, {});
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.ok, false);
  assert.match(approveRes.body.message, /legacy task, not operable by this conductor/);
  assert.equal(env.findTask(legacyId).runtime.stage, 'AWAIT_SPEC_APPROVAL');
});

// ---- AC-015：同步动作成功后 detached 后台触发 run（不阻塞响应）；--no-auto-run 跳过 ----

test('AC-015: 同步动作 exitCode=0 后，server 后台触发一次 conductor run，响应不等待其完成', async (t) => {
  const { env, id } = newRouterEnv(t, { config: { spawnRetries: 0 } });
  driveToGate(env, id, 'spec');
  env.appendScenario([
    { delayMs: 800, ...routerStep('maker') },
    makerStep(),
    routerStep('human', { summary: '后台 run 跑完就停这儿' }),
  ]);

  const srv = await startDashboard(t, env, ['--port', '0']); // 默认 autoRun=true

  const startedAt = Date.now();
  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve`, {});
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.body.ok, true);
  assert.ok(elapsedMs < 700, `响应应在后台 router 完成（含 800ms 延时）之前返回，实际耗时 ${elapsedMs}ms`);

  await waitFor(() => env.findTask(id)?.runtime.awaiting?.kind === 'help', 8000);
});

test('AC-015: --no-auto-run 启动时，同步动作成功后不触发后台 run', async (t) => {
  const { env, id } = newRouterEnv(t);
  driveToGate(env, id, 'spec');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve`, {});
  assert.equal(res.body.ok, true);

  await new Promise((r) => setTimeout(r, 500));
  const after = env.findTask(id);
  assert.equal(after.runtime.spec_approved, true, 'CLI 动作本身的效果应生效');
  assert.equal(after.runtime.stage, 'ROUTING', '未触发 run，stage 停在 ROUTING');
  assert.equal(env.calls().length, 2, '只有 driveToGate 那两次 spawn');
});

// ---- AC-016：merge 闸批准是同步动作（approve），失败真实回传；retry 的 job 失败态同理 ----

test('AC-016: merge 闸 approve 同步回传真实结果；版本规则不满足时 200 + ok:false 且任务回 ROUTING', async (t) => {
  const { env, id } = newRouterEnv(t);
  driveToGate(env, id, 'merge');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  // base 往前走一步 → precommit 基线过期，approve 必须被版本规则拒
  fs.writeFileSync(path.join(env.targetDir, 'BASE_MOVED.md'), 'base moved\n');
  execFileSync('git', ['-C', env.targetDir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', env.targetDir, 'commit', '-m', 'base moved'], { stdio: 'pipe' });

  const refused = await postJson(srv.baseUrl, `/api/task/${id}/approve`, {});
  assert.equal(refused.status, 200, 'CLI 非零退出也应 200，而非 5xx');
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.message, /need_precommit=true/);
  assert.equal(env.findTask(id).runtime.stage, 'ROUTING', '被版本规则拒 → 回 ROUTING');
});

test('P4-AC-014①: retry 的 job 失败态经 GET /api/jobs 为 fail 且 message 含 stderr；任务保持原状', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260705-160';
  env.writeRouterTask(id, { stage: 'FAILED_BOX', lastFailureType: 'crashed' }); // 不是可恢复类型
  fs.mkdirSync(path.join(env.root, 'state', 'failed'), { recursive: true });
  fs.renameSync(path.join(env.root, 'state', 'queue', id), path.join(env.root, 'state', 'failed', id));

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const startedAt = Date.now();
  const res = await postJson(srv.baseUrl, `/api/task/${id}/retry`, {});
  assert.equal(res.status, 202, 'retry 立即 202，不同步等待子进程');
  assert.ok(res.body.jobId && typeof res.body.jobId === 'string');
  assert.ok(Date.now() - startedAt < 500, '响应不应等待 conductor retry 子进程完成');

  const job = await waitForJobTerminal(srv.baseUrl, res.body.jobId);
  assert.equal(job.state, 'fail', '不可恢复的失败类型必须真实失败而非恒 ok');
  assert.match(job.message, /不是可恢复类型/, 'fail 态 message 应携带子进程 stderr 文本');

  const after = env.findTask(id);
  assert.equal(after.box, 'failed');
  assert.equal(after.runtime.stage, 'FAILED_BOX', '任务保持原状');
});

// ---- AC-003：merge 闸 approve 成功后不该把队列里其它任务连带跑起来 ----

test('AC-003: merge 闸 approve 成功 → 任务归档 done；--no-auto-run 下队列里其它任务不被连带触发', async (t) => {
  const { env, id } = newRouterEnv(t, { config: { spawnRetries: 0 } });
  driveToGate(env, id, 'merge');

  // probe 任务留在 ROUTING：若后台 run 被 spawn，它会被拿去问 router（调用 fake-claude）。
  const probeId = 'task-20260705-162';
  env.writeRouterTask(probeId);

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const callsBefore = env.calls().length;

  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, res.body.message);

  await waitFor(() => env.findTask(id)?.box === 'done', 4000);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(env.calls().length, callsBefore, 'probe 任务的 fake-claude 不应被调用');
  assert.equal(env.findTask(probeId).runtime.stage, 'ROUTING', '不连带推进队列里其它任务');
});

// ---- P4-AC-010/011：job SSE 推送 + 同任务同动作并发 409 ----

test('P4-AC-010: job 完成经 SSE 推送 type:job 事件，字段与 GET /api/jobs 记录一致', async (t) => {
  const env = makeEnv(t, { config: { spawnRetries: 0 } });
  const id = 'task-20260705-163';
  env.writeRouterTask(id, { stage: 'FAILED_BOX', lastFailureType: 'abandoned' });
  fs.mkdirSync(path.join(env.root, 'state', 'failed'), { recursive: true });
  fs.renameSync(path.join(env.root, 'state', 'queue', id), path.join(env.root, 'state', 'failed', id));

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const sse = await openSse(t, srv.baseUrl);
  await sse.waitForFrame((f) => f.startsWith(':'));

  const res = await postJson(srv.baseUrl, `/api/task/${id}/retry`, {});
  assert.equal(res.status, 202);
  const jobId = res.body.jobId;

  const jobFrame = await sse.waitForFrame((f) => sseData(f)?.type === 'job' && sseData(f).jobId === jobId);
  const jobEvent = sseData(jobFrame);
  const jobsRes = await getJson(srv.baseUrl, '/api/jobs');
  const recorded = jobsRes.body.jobs.find((j) => j.id === jobId);
  assert.equal(jobEvent.state, recorded.state);
  assert.equal(jobEvent.action, recorded.action);
  assert.equal(jobEvent.taskId, recorded.taskId);
  assert.equal(jobEvent.message, recorded.message);
});

test('P4-AC-011: 同任务同动作已有 running job 时再次 POST 返回 409，不新登记第二个 job；不同任务不受影响', async (t) => {
  const env = makeEnv(t);
  const busyId = 'task-20260705-164';
  env.writeRouterTask(busyId, { stage: 'FAILED_BOX', lastFailureType: 'crashed' }); // retry 会失败但仍占用 running 一段时间
  const otherId = 'task-20260705-165';
  env.writeRouterTask(otherId, { stage: 'FAILED_BOX', lastFailureType: 'abandoned' });
  fs.mkdirSync(path.join(env.root, 'state', 'failed'), { recursive: true });
  for (const id of [busyId, otherId]) {
    fs.renameSync(path.join(env.root, 'state', 'queue', id), path.join(env.root, 'state', 'failed', id));
  }

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const first = await postJson(srv.baseUrl, `/api/task/${busyId}/retry`, {});
  assert.equal(first.status, 202);
  const second = await postJson(srv.baseUrl, `/api/task/${busyId}/retry`, {});
  assert.equal(second.status, 409, '同任务同动作已有 running job 时应 409');

  const otherTask = await postJson(srv.baseUrl, `/api/task/${otherId}/retry`, {});
  assert.equal(otherTask.status, 202, '不同任务不应被同任务的 running job 挡住');

  await waitForJobTerminal(srv.baseUrl, first.body.jobId);
  const jobsRes = await getJson(srv.baseUrl, '/api/jobs');
  const retryJobs = jobsRes.body.jobs.filter((j) => j.taskId === busyId && j.action === 'retry');
  assert.equal(retryJobs.length, 1, '409 不应新登记第二个 job');
});

// ---- AC-017：new-task 透传 CLI + brief 临时文件生命周期 + id 解析 + feasibility 显式布尔 ----

test('AC-017/AC-019: POST /api/new-task 字段为 title/brief/repo/base-branch，任务落 ROUTING；profile 缺 precommit 段时把样例原样带回前端', async (t) => {
  const env = makeEnv(t);
  env.writePrecommitProfile({ unit: 'node --test' });
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const briefPrefix = `dashboard-brief-${srv.child.pid}-`;

  const res = await postJson(srv.baseUrl, '/api/new-task', {
    title: 'dashboard 新建任务用例',
    brief: '把 median 的偶数分支改成取中间两数平均。marker-AC-017',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.id, /^task-\d{8}-\d{3}$/);

  await waitFor(() => !fs.readdirSync(os.tmpdir()).some((n) => n.startsWith(briefPrefix)), 1000);

  const created = env.findTask(res.body.id);
  assert.equal(created.runtime.stage, 'ROUTING');
  assert.equal('kind' in created.task, false, '新建单不再有 kind');
  assert.equal('feasibility' in created.task, false, '新建单不再有 feasibility');
  assert.equal(created.runtime.spec_approved, false);
  assert.equal(created.runtime.awaiting, null);
  assert.match(fs.readFileSync(path.join(created.dir, 'brief.md'), 'utf8'), /marker-AC-017/);

  // repo / base branch 透传到 CLI
  const withRepo = await postJson(srv.baseUrl, '/api/new-task', {
    title: '显式 repo 与 base 分支', brief: 'brief 正文', repo: env.targetDir, baseBranch: 'main',
  });
  assert.equal(withRepo.body.ok, true);
  const withRepoTask = env.findTask(withRepo.body.id);
  assert.equal(withRepoTask.task.targetRepo, env.targetDir);
  assert.equal(withRepoTask.task.baseBranch, 'main');

  // 必填字段：title / brief 缺一即 400，且不落任何任务
  assert.equal((await postJson(srv.baseUrl, '/api/new-task', { brief: 'x' })).status, 400);
  assert.equal((await postJson(srv.baseUrl, '/api/new-task', { title: 't' })).status, 400);
  assert.equal((await postJson(srv.baseUrl, '/api/new-task', { title: 't', brief: '   ' })).status, 400);
});

test('AC-019: profile 缺 precommit 段时 /api/new-task 返回 ok:false，message 含含 build/service/unit/integration/e2e 全键的样例', async (t) => {
  const env = makeEnv(t); // 没有 writePrecommitProfile：目标仓完全没有 setup-profile.json
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const res = await postJson(srv.baseUrl, '/api/new-task', { title: '缺 profile', brief: 'brief 正文' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  for (const key of ['build', 'service', 'unit', 'integration', 'e2e']) {
    assert.ok(res.body.message.includes(key), `样例应含 ${key} 键：${res.body.message}`);
  }
  assert.equal(res.body.id, null);
});

// ==== P5：GET /api/metrics（AC-009） ============================

test('AC-009: GET /api/metrics 空仓库返回良构空结构而非 500；写入 done 任务后现读反映，不产生磁盘写入', async (t) => {
  const env = makeEnv(t);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const emptyRes = await getJson(srv.baseUrl, '/api/metrics');
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.body.isEmpty, true);
  assert.deepEqual(emptyRes.body.totals.taskCount, { done: 0, failed: 0 });
  assert.deepEqual(emptyRes.body.table, []);
  assert.equal(emptyRes.body.totals.spentPercentiles.p50, null);
  for (const key of ['totals', 'yield', 'durations', 'table', 'isEmpty']) assert.ok(key in emptyRes.body, key);

  const id = 'task-20260713-820';
  const doneDir = path.join(env.root, 'state', 'done', id);
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, 'task.json'), JSON.stringify({
    schema_version: 1, id, kind: 'bugfix', title: 't', repo: 'target', targetRepo: env.targetDir,
    baseBranch: 'main', testCommand: 'node --test', created_at: '2026-07-13T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(doneDir, 'runtime.json'), JSON.stringify({
    schema_version: 1, stage: 'DONE', maker_miss_count: 0, verifier_invalid_count: 0, spent_usd: 3,
    approval: null, maker_session_id: null, current_round: 0, last_failure_type: null,
    updated_at: '2026-07-13T00:00:00.000Z',
  }));
  const dossierDir = env.dossier(id);
  fs.mkdirSync(dossierDir, { recursive: true });
  fs.writeFileSync(path.join(dossierDir, 'maker-r1.json'), JSON.stringify({ role: 'maker', round: 1, ok: true, cost_usd: 0.5 }));
  fs.writeFileSync(path.join(dossierDir, 'verify-r1.verdict.json'), JSON.stringify({
    schema_version: 1, round: 1, overall: 'pass',
    criteria_results: [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }], non_ac_findings: [],
  }));

  const filledRes = await getJson(srv.baseUrl, '/api/metrics');
  assert.equal(filledRes.status, 200);
  assert.equal(filledRes.body.isEmpty, false);
  assert.equal(filledRes.body.totals.taskCount.done, 1);
  assert.equal(filledRes.body.totals.totalSpentUsd, 3);
  assert.equal(filledRes.body.table.length, 1);
  assert.equal(filledRes.body.table[0].id, id);
  assert.equal(filledRes.body.table[0].spentUsd, 3);
  assert.equal(filledRes.body.yield.firstPassRate.value, 1);

  const doneDirEntriesAfter = fs.readdirSync(doneDir).sort();
  assert.deepEqual(doneDirEntriesAfter, ['runtime.json', 'task.json'], 'GET /api/metrics 不应在任务目录留下任何写入痕迹');
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

// ---- P6：POST /api/task/:id/open-editor —— 人审从 dashboard 直达编辑器里的 worktree ----

test('P6: open-editor 非法 id 400；worktree 缺失 200 ok:false 且文案指明清理；存在时经 DASHBOARD_EDITOR_CMD 启动并 ok:true', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260719-901';
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE' });
  fs.mkdirSync(env.worktree(id), { recursive: true });

  const missingId = 'task-20260719-902';
  env.writeTask(missingId, { stage: 'AWAIT_HUMAN_MERGE' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run'], { DASHBOARD_EDITOR_CMD: '/usr/bin/true' });

  const badId = await postJson(srv.baseUrl, '/api/task/not-a-task-id/open-editor', {});
  assert.equal(badId.status, 400);

  const missing = await postJson(srv.baseUrl, `/api/task/${missingId}/open-editor`, {});
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, false);
  assert.match(missing.body.message, /worktree 不存在或已清理/);

  const ok = await postJson(srv.baseUrl, `/api/task/${id}/open-editor`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true, `应经 DASHBOARD_EDITOR_CMD 启动成功：${ok.body.message}`);
});

test('P6: DASHBOARD_EDITOR_CMD 指向不存在的命令时 200 ok:false（spawn ENOENT 不 500）', async (t) => {
  const env = makeEnv(t);
  const id = 'task-20260719-903';
  env.writeTask(id, { stage: 'AWAIT_HUMAN_MERGE' });
  fs.mkdirSync(env.worktree(id), { recursive: true });
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run'], { DASHBOARD_EDITOR_CMD: '/nonexistent-editor-cmd-p6' });
  const res = await postJson(srv.baseUrl, `/api/task/${id}/open-editor`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
});

// ==== 新状态机（router conductor）：四列看板 + 通用人闸页 + legacy 兼容（AC-023/029/043） ====

const ROUTER_SPEC_BODY = [
  '# median 偶数分支返回错误',
  '',
  '## 验收标准',
  '',
  '- AC-001: median([1,2,3,4]) 返回 2.5',
  '- AC-002: node --test 全绿',
  '',
  '## 待决问题',
  '',
  '| 问题 | safe default | 影响 |',
  '| --- | --- | --- |',
  '| 是否同时改 mode？ | 不改 | 另选会扩大范围 |',
  '',
].join('\n');

/** 把任务推到 AWAIT_HUMAN(spec)。 */
function driveToSpecGate(env, id) {
  env.setScenario([
    routerStep('spec', { summary: '新能力且改接口，先出 spec 交人审' }),
    specStep(ROUTER_SPEC_BODY, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
  ]);
  const r = env.run('run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(env.readRuntime(id).awaiting.kind, 'spec');
}

/** 把任务推到 AWAIT_HUMAN(merge)（无 spec 的直做路径）。 */
function driveToMergeGate(env, id) {
  env.setScenario([
    routerStep('maker', { summary: 'brief 即 spec，直接实现' }),
    makerStep(),
    routerStep('review', { summary: 'maker 报全绿，整体冷审' }),
    reviewerStep(),
    routerStep('precommit', { tier: 'unit', summary: 'review 全 pass，跑 unit' }),
    routerStep('merge', { summary: '版本规则满足，申请合并' }),
  ]);
  const r = env.run('run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(env.readRuntime(id).awaiting.kind, 'merge');
}

/** 把任务推到 AWAIT_HUMAN(help)（router 主动求助）。 */
function driveToHelpGate(env, id) {
  env.setScenario([routerStep('human', { summary: 'AC-001 与仓库现状冲突，请裁决取哪一边' })]);
  const r = env.run('run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(env.readRuntime(id).awaiting.kind, 'help');
}

test('AC-029/043: 四列看板按 stage 分列，AWAIT_HUMAN 卡片带 awaiting.kind', async (t) => {
  const { env, id } = newRouterEnv(t);
  driveToHelpGate(env, id);
  // 同一仓库里再放一个遗留 stage 名的旧任务
  env.writeTask('task-20260705-900', { stage: 'READY' });

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const board = await getJson(srv.baseUrl, '/api/board');
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.columns.map((c) => c.column), ['ROUTING', 'AWAIT_HUMAN', 'FAILED_BOX', 'DONE']);

  const gateCol = board.body.columns.find((c) => c.column === 'AWAIT_HUMAN').tasks;
  assert.deepEqual(gateCol.map((e) => e.id), [id]);
  assert.equal(gateCol[0].awaitingKind, 'help');
  assert.equal(gateCol[0].needsHuman, true);

  // 旧任务归 legacy 分组，同时仍在旧泳道里；不占任何新列、不进 broken（AC-029）
  assert.deepEqual(board.body.legacy.map((e) => e.id), ['task-20260705-900']);
  assert.ok(board.body.lanes.find((l) => l.lane === 'maker').tasks.some((e) => e.id === 'task-20260705-900'));
  assert.deepEqual(board.body.broken, []);
});

test('AC-043: spec 闸页渲染 kind/summary/refs + spec 全文与待决问题；approve 按钮走 POST 与 CLI 同效', async (t) => {
  const { env, id } = newRouterEnv(t, { brief: '给 stats 增加 percentile 能力，涉及新接口。\n' });
  driveToSpecGate(env, id);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const detail = await getJson(srv.baseUrl, `/api/task/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.review.kind, 'human');
  assert.equal(detail.body.review.gate.kind, 'spec');
  assert.equal(detail.body.review.gate.requestedBy, 'kernel');
  assert.ok(detail.body.review.gate.summary);
  assert.ok(detail.body.review.gate.refs.some((r) => r.includes(`${id}.md`)), `refs 应含 spec 草稿：${detail.body.review.gate.refs}`);
  assert.equal(detail.body.review.spec.markdown, ROUTER_SPEC_BODY);
  assert.ok(detail.body.review.spec.pendingQuestions.startsWith('## 待决问题'));
  assert.deepEqual(detail.body.review.actions, ['approve', 'reject']);
  // P2 恒无方案：不渲染方案表，也不显示 --no-packages
  assert.equal(detail.body.review.packages, null);
  assert.equal(detail.body.review.showNoPackages, false);

  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve`, { notes: '按 A 做，不再拆细' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, res.body.message);

  // 与 CLI `approve <id> --notes` 同效：冻结 spec、spec_approved、回 ROUTING、notes 进 human 记录
  const rt = env.readRuntime(id);
  assert.equal(rt.stage, 'ROUTING');
  assert.equal(rt.spec_approved, true);
  assert.equal(rt.awaiting, null);
  assert.ok(env.exists(env.dossier(id, 'spec.md')));
  const human = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.equal(human.decision, 'approved');
  assert.equal(human.notes, '按 A 做，不再拆细');
});

test('AC-043: spec 闸 reject 缺 notes 时 200 但 ok:false，任务留在闸上（按钮语义等同 CLI）', async (t) => {
  const { env, id } = newRouterEnv(t, { brief: '给 stats 增加 percentile 能力。\n' });
  driveToSpecGate(env, id);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const res = await postJson(srv.baseUrl, `/api/task/${id}/reject`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /--notes/);
  assert.equal(env.readRuntime(id).awaiting.kind, 'spec');

  const ok = await postJson(srv.baseUrl, `/api/task/${id}/reject`, { notes: 'AC-002 与现有 Non-goal 冲突' });
  assert.equal(ok.body.ok, true, ok.body.message);
  assert.equal(env.readRuntime(id).stage, 'ROUTING');
  assert.equal(env.readJson(env.dossier(id, 'human-r1.json')).decision, 'rejected');
});

test('AC-043: merge 闸页渲染最近 reviewer 记录与 precommit 三步；approve --message 走 POST 与 CLI 同效', async (t) => {
  const { env, id } = newRouterEnv(t);
  driveToMergeGate(env, id);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const detail = await getJson(srv.baseUrl, `/api/task/${id}`);
  assert.equal(detail.body.review.gate.kind, 'merge');
  assert.deepEqual(detail.body.review.actions, ['approve', 'reject']);
  assert.equal(detail.body.review.reviewer.role, 'reviewer');
  assert.equal(detail.body.review.reviewer.outcome, 'ok');
  assert.equal(detail.body.review.precommit.outcome, 'ok');
  const steps = detail.body.review.precommit.steps.map((s) => s.step);
  assert.ok(steps.includes('unit'), `precommit 三步应含 unit：${steps}`);
  for (const s of detail.body.review.precommit.steps) {
    assert.ok('status' in s && 'duration_ms' in s && 'tail' in s, `每步要有 status/用时/tail：${JSON.stringify(s)}`);
  }
  assert.ok(detail.body.review.diffShortstat, 'merge 闸应带 diff shortstat');
  // 记录列表与内核事实随详情一起给出（新任务）
  assert.equal(detail.body.isRouterTask, true);
  assert.ok(detail.body.records.some((r) => r.role === 'router'));
  assert.ok(detail.body.facts.text.includes('need_precommit=false'));
  assert.ok(detail.body.events.some((e) => e.type === 'human_gate_opened'));

  const res = await postJson(srv.baseUrl, `/api/task/${id}/approve`, { message: `task ${id}: 人给的文案` });
  assert.equal(res.body.ok, true, res.body.message);
  const done = env.findTask(id);
  assert.equal(done.box, 'done');
  assert.equal(done.runtime.stage, 'DONE');
  const subject = execFileSync('git', ['-C', env.targetDir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
  assert.equal(subject, `task ${id}: 人给的文案`);
});

test('AC-043: help 闸页只给 resume；resume 走 POST 与 CLI 同效（notes 进记录，不豁免版本规则）', async (t) => {
  const { env, id } = newRouterEnv(t);
  driveToHelpGate(env, id);
  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);

  const detail = await getJson(srv.baseUrl, `/api/task/${id}`);
  assert.equal(detail.body.review.gate.kind, 'help');
  assert.equal(detail.body.review.gate.requestedBy, 'router');
  assert.deepEqual(detail.body.review.actions, ['resume']);

  const res = await postJson(srv.baseUrl, `/api/task/${id}/resume`, { notes: '已在 worktree 里改好冲突' });
  assert.equal(res.body.ok, true, res.body.message);
  const rt = env.readRuntime(id);
  assert.equal(rt.stage, 'ROUTING');
  assert.equal(rt.awaiting, null);
  const human = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.equal(human.decision, 'resumed');
  assert.equal(human.notes, '已在 worktree 里改好冲突');
  assert.ok(env.events(id).some((e) => e.type === 'human_intervened'));
});

test('AC-029: 遗留 stage 名 + 遗留产物（verify verdict / spec-verify / test-gate）照常渲染详情，不报错', async (t) => {
  const { env } = newRouterEnv(t);
  const legacyId = 'task-20260705-901';
  env.writeTask(legacyId, { stage: 'AWAIT_HUMAN_MERGE' });
  const dossier = path.join(env.root, 'dossier', legacyId);
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'maker-r1.json'), JSON.stringify({ ok: true, cost_usd: 2.5, raw: { num_turns: 8 } }));
  fs.writeFileSync(path.join(dossier, 'test-gate-r1.json'), JSON.stringify({ verdict: 'ok', mode: 'per-ac' }));
  fs.writeFileSync(path.join(dossier, 'green-gate-r1.json'), JSON.stringify({ exit_code: 0, stdout_tail: 'pass 41' }));
  fs.writeFileSync(path.join(dossier, 'verify-r1.verdict.json'), JSON.stringify({
    overall: 'pass', criteria_results: [{ ac_id: 'AC-001', status: 'pass', reason: 'ok', evidence: [] }],
  }));
  fs.writeFileSync(path.join(dossier, 'spec-verify-r1.verdict.json'), JSON.stringify({
    overall: 'pass', summary: 'spec 可审', findings: [],
  }));
  fs.writeFileSync(path.join(dossier, 'spec-verify-r1.md'), '# spec verify 报告\n');

  const srv = await startDashboard(t, env, ['--port', '0', '--no-auto-run']);
  const detail = await getJson(srv.baseUrl, `/api/task/${legacyId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.isRouterTask, false);
  assert.deepEqual(detail.body.records, []);
  assert.equal(detail.body.facts, null);
  assert.equal(detail.body.review.kind, 'merge');
  assert.equal(detail.body.review.verdict.overall, 'pass');
  assert.equal(detail.body.rounds.rounds[0].testGate.verdict, 'ok');
  assert.equal(detail.body.rounds.rounds[0].greenGate.pass, true);

  const board = await getJson(srv.baseUrl, '/api/board');
  assert.deepEqual(board.body.legacy.map((e) => e.id), [legacyId]);
  assert.deepEqual(board.body.broken, []);

  const metrics = await getJson(srv.baseUrl, '/api/metrics');
  assert.equal(metrics.status, 200);
});

test('AC-023: dashboard 的 auto-run 不把 FAILED_BOX 任务搬出来（限额卡片给重置时刻）', async (t) => {
  const { env, id } = newRouterEnv(t);
  // 先造一个已收箱的限额任务，resets_at 已过（人还没 retry，就不该被任何自动路径搬走）
  const boxedId = 'task-20260910-777';
  const resetsAt = Math.floor(Date.now() / 1000) - 3600;
  env.writeRouterTask(boxedId, {
    stage: 'FAILED_BOX',
    lastFailureType: 'rate_limited',
    rateLimit: { type: 'five_hour', resets_at: resetsAt, hit_at: '2026-09-10T00:00:00.000Z', resume_stage: 'ROUTING' },
  });
  fs.renameSync(path.join(env.root, 'state', 'queue', boxedId), path.join(env.root, 'state', 'failed', boxedId));
  const before = fs.readFileSync(path.join(env.root, 'state', 'failed', boxedId, 'runtime.json'), 'utf8');

  // auto-run 打开：一次成功的同步动作会触发后台 conductor run
  env.setScenario([routerStep('abandon', { summary: '无法继续，收箱' })]);
  const srv = await startDashboard(t, env, ['--port', '0']);

  const res = await postJson(srv.baseUrl, `/api/task/${id}/abandon`, {});
  assert.equal(res.body.ok, true, res.body.message);
  // 等后台 run 真的跑过一轮（queue 已空，run 会立刻结束）
  await waitFor(() => fs.existsSync(path.join(env.root, 'state', 'failed', id)), 8000);

  const after = fs.readFileSync(path.join(env.root, 'state', 'failed', boxedId, 'runtime.json'), 'utf8');
  assert.equal(after, before, 'auto-run 不得改动 FAILED_BOX 任务的 runtime');
  assert.equal(env.findTask(boxedId).box, 'failed');

  const detail = await getJson(srv.baseUrl, `/api/task/${boxedId}`);
  assert.equal(detail.body.review.kind, 'failed');
  assert.equal(detail.body.review.lastFailureType, 'rate_limited');
  assert.equal(detail.body.review.rateLimit.resets_at, resetsAt);
});
