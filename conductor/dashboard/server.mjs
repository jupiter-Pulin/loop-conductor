#!/usr/bin/env node
// dashboard/server.mjs — node:http 薄层：路由、静态页、CLI 透传（同步）/ detached 后台触发。
// 无状态：任务数据每次请求现读磁盘（model.mjs），不缓存、不持久化（临时 brief 文件除外）。
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCfg, resolveRoot } from '../conductor.mjs';
import {
  isValidTaskId, buildBoard, buildTaskDetail, buildTaskDiff, formatCliMessage,
  buildSyncActionArgv, SYNC_ACTIONS, parseNewTaskId, buildNewTaskArgv,
  listActiveSpawns, buildStreamTail,
} from './model.mjs';
import { buildMetrics } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONDUCTOR_BIN = path.join(HERE, '..', 'conductor.mjs');
const INDEX_HTML = path.join(HERE, 'index.html');
const STATIC_DIR = path.join(HERE, 'static');
const STATIC_PREFIX = '/static/';
const STATIC_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function parseArgs(argv) {
  let port = 4400;
  let autoRun = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isNaN(n)) port = n;
    } else if (a === '--no-auto-run') {
      autoRun = false;
    }
  }
  return { port, autoRun };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (raw.trim() === '') return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(raw) }; } catch { return { ok: false, body: null }; }
}

/** 同步 spawn conductor 子命令：argv 数组、不经 shell、继承 server 环境变量。 */
function runConductor(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONDUCTOR_BIN, ...argv], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: String(err?.message ?? err) }));
  });
}

/** detached + unref + stdio:'ignore' 后台触发，HTTP handler 从不等待其完成。 */
function spawnDetachedConductor(argv) {
  const child = spawn(process.execPath, [CONDUCTOR_BIN, ...argv], {
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// ---- SSE 失效通知总线（P4-G1/AC-001/002/003）：只广播 { type, id? } 信号，绝不承载 board/task 数据（INV-1）。 ----

const SSE_DEBOUNCE_MS = 200;
const SSE_HEARTBEAT_MS = 15000;
const SSE_SCAN_INTERVAL_MS = 2000; // ≤3s（AC-003）

/** state/{queue,done,failed} 各任务 runtime.json 的 mtime 签名；扫描兜底模式靠签名变化判定 board-dirty。 */
function boardSignature(cfg) {
  const parts = [];
  for (const dir of [cfg.queueDir, cfg.doneDir, cfg.failedDir]) {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      let mtimeMs = -1;
      try { mtimeMs = fs.statSync(path.join(dir, name, 'runtime.json')).mtimeMs; } catch { /* 缺失即签名恒定值 */ }
      parts.push(`${dir}::${name}::${mtimeMs}`);
    }
  }
  return parts.join('|');
}

/**
 * 创建一个 SSE 变更总线：fs.watch 可用则 watch state/{queue,done,failed}（board-dirty）与
 * dossier/（按顶层 <id> 段推 task-dirty），watch 报错/不可用时降级为周期扫描（AC-003）。
 * forceScan 显式跳过 watch 直接进扫描模式，供集成测试验证降级路径。
 */
function createChangeBus(cfg, { forceScan = false } = {}) {
  const clients = new Set();
  let boardTimer = null;
  const taskTimers = new Map();
  let usingScan = false;
  const watchers = [];
  let scanTimer = null;
  let lastSignature = null;

  function broadcastEvent(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(line); } catch { /* 客户端已断开，close 回调会摘除 */ }
    }
  }

  function emitBoardDirty() {
    if (boardTimer) return;
    boardTimer = setTimeout(() => { boardTimer = null; broadcastEvent({ type: 'board-dirty' }); }, SSE_DEBOUNCE_MS);
    boardTimer.unref?.();
  }

  function emitTaskDirty(id) {
    if (taskTimers.has(id)) return;
    const timer = setTimeout(() => { taskTimers.delete(id); broadcastEvent({ type: 'task-dirty', id }); }, SSE_DEBOUNCE_MS);
    timer.unref?.();
    taskTimers.set(id, timer);
  }

  function stopWatch() {
    for (const w of watchers) { try { w.close(); } catch { /* 已关闭 */ } }
    watchers.length = 0;
  }

  function startScan() {
    if (scanTimer) return;
    lastSignature = boardSignature(cfg);
    scanTimer = setInterval(() => {
      const sig = boardSignature(cfg);
      if (sig !== lastSignature) {
        lastSignature = sig;
        emitBoardDirty();
      }
    }, SSE_SCAN_INTERVAL_MS);
    scanTimer.unref?.();
  }

  function switchToScan() {
    if (usingScan) return;
    usingScan = true;
    stopWatch();
    startScan();
  }

  function startWatch() {
    try {
      for (const dir of [cfg.queueDir, cfg.doneDir, cfg.failedDir]) {
        const w = fs.watch(dir, { recursive: true }, () => emitBoardDirty());
        w.on('error', switchToScan);
        watchers.push(w);
      }
      const dw = fs.watch(cfg.dossierDir, { recursive: true }, (evt, filename) => {
        const id = filename ? String(filename).split(path.sep)[0] : null;
        if (id && isValidTaskId(id)) emitTaskDirty(id);
        else emitBoardDirty();
      });
      dw.on('error', switchToScan);
      watchers.push(dw);
      return true;
    } catch {
      stopWatch();
      return false;
    }
  }

  if (forceScan || !startWatch()) switchToScan();

  return {
    addClient(res) { clients.add(res); },
    removeClient(res) { clients.delete(res); },
    broadcastJob(job) {
      broadcastEvent({ type: 'job', jobId: job.id, action: job.action, taskId: job.taskId, state: job.state, message: job.message });
    },
  };
}

function handleEvents(req, res, changeBus) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n'); // 连接建立即发一行心跳注释（AC-001）
  changeBus.addClient(res);
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* 客户端已断开 */ } }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const cleanup = () => { clearInterval(heartbeat); changeBus.removeClient(res); };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- merge/retry 异步 job（P4-G4/AC-009/010/011）：立即 202+jobId，job 只存内存，完成后经 SSE 推 job 事件。 ----

const ASYNC_ACTIONS = ['merge', 'retry'];
const jobs = new Map(); // jobId -> { id, action, taskId, state:'running'|'ok'|'fail', message }
const runningJobKeys = new Set(); // `${taskId}:${action}`，同任务同动作互斥
let jobSeq = 0;

function jobKey(taskId, action) { return `${taskId}:${action}`; }

function jobPublic(job) {
  return { id: job.id, action: job.action, taskId: job.taskId, state: job.state, message: job.message };
}

function buildAsyncActionArgv(action, id) {
  return [action, id];
}

/** 立即注册 job 并 detach 出 runConductor；成功/失败均只在完成后更新 job 并经 SSE 推送。 */
function startJob(cfg, action, id, changeBus, autoRun) {
  const key = jobKey(id, action);
  if (runningJobKeys.has(key)) return null;
  jobSeq += 1;
  const job = { id: `job-${jobSeq}`, action, taskId: id, state: 'running', message: null };
  jobs.set(job.id, job);
  runningJobKeys.add(key);
  runConductor(buildAsyncActionArgv(action, id)).then((result) => {
    job.state = result.exitCode === 0 ? 'ok' : 'fail';
    job.message = formatCliMessage(result);
    runningJobKeys.delete(key);
    // merge 历来不触发后台 run（committer 舞步已在 conductor 内完成推进）；仅 retry 沿用旧同步语义。
    if (job.state === 'ok' && autoRun && action === 'retry') spawnDetachedConductor(['run']);
    changeBus.broadcastJob(job);
  });
  return job;
}

function handleAsyncAction(cfg, id, action, res, changeBus, autoRun) {
  const job = startJob(cfg, action, id, changeBus, autoRun);
  if (!job) { sendJson(res, 409, { error: `job already running: ${action} ${id}` }); return; }
  sendJson(res, 202, { jobId: job.id });
}

async function handleSyncAction(cfg, id, action, req, res, autoRun) {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  const argv = buildSyncActionArgv(action, id, parsed.body);
  const result = await runConductor(argv);
  const ok = result.exitCode === 0;
  if (ok && autoRun) spawnDetachedConductor(['run']);
  sendJson(res, 200, { ok, exitCode: result.exitCode, message: formatCliMessage(result) });
}

// ---- 在编辑器里打开任务 worktree（人审跳 VS Code）：只 spawn 编辑器，不落任何状态、不动任务。 ----

/** detached spawn 一个编辑器进程；1.5s 内未退出视为已启动（编辑器常驻不算失败），
 *  提前退出则以 exitCode 判定。ENOENT 等 spawn 失败返回 started:false。 */
function spawnEditorProcess(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.unref(); resolve({ started: true, exitCode: null }); }, 1500);
    timer.unref?.();
    child.on('error', () => { clearTimeout(timer); resolve({ started: false, exitCode: null }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ started: true, exitCode: code ?? 1 }); });
  });
}

function editorLaunchOk(r) { return r.started && (r.exitCode === null || r.exitCode === 0); }

/** 打开 worktrees/<id>：默认 `code <dir>`，darwin 下回退 `open -a "Visual Studio Code"`；
 *  DASHBOARD_EDITOR_CMD 可整体覆盖编辑器命令（也是测试钩子）。 */
async function openWorktreeInEditor(cfg, id) {
  const dir = path.join(cfg.worktreesDir, id);
  let stat = null;
  try { stat = fs.statSync(dir); } catch { /* 不存在走统一文案 */ }
  if (!stat || !stat.isDirectory()) {
    return { ok: false, message: `worktree 不存在或已清理：${dir}（任务已合并归档，或尚未进入 maker 阶段）` };
  }
  const override = process.env.DASHBOARD_EDITOR_CMD;
  if (override) {
    const r = await spawnEditorProcess(override, [dir]);
    return editorLaunchOk(r)
      ? { ok: true, message: `已用 ${override} 打开 ${dir}` }
      : { ok: false, message: `${override} 启动失败（exitCode=${r.exitCode}）` };
  }
  if (editorLaunchOk(await spawnEditorProcess('code', [dir]))) {
    return { ok: true, message: `已在 VS Code 打开 ${dir}` };
  }
  if (process.platform === 'darwin' && editorLaunchOk(await spawnEditorProcess('open', ['-a', 'Visual Studio Code', dir]))) {
    return { ok: true, message: `已在 VS Code 打开 ${dir}` };
  }
  return { ok: false, message: '找不到 code 命令：在 VS Code 里执行「Shell Command: Install \'code\' command in PATH」后重试' };
}

/** `/static/<rel>` → 磁盘绝对路径；逃逸白名单目录 STATIC_DIR 一律返回 null（供 404）。 */
function resolveStaticFile(pathname) {
  const rawRel = pathname.slice(STATIC_PREFIX.length);
  let rel;
  try { rel = decodeURIComponent(rawRel); } catch { return null; }
  const resolved = path.resolve(STATIC_DIR, rel);
  if (resolved !== STATIC_DIR && !resolved.startsWith(STATIC_DIR + path.sep)) return null;
  return resolved;
}

function serveStatic(res, pathname) {
  const filePath = resolveStaticFile(pathname);
  if (!filePath) { sendJson(res, 404, { error: 'not found' }); return; }
  let stat;
  try { stat = fs.statSync(filePath); } catch { sendJson(res, 404, { error: 'not found' }); return; }
  if (!stat.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
  const contentType = STATIC_CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(data);
}

async function handleNewTask(req, res, autoRun) {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  const { kind, title, brief, feasibility } = parsed.body ?? {};
  if (kind !== 'bugfix' && kind !== 'feature') { sendJson(res, 400, { error: 'kind must be bugfix or feature' }); return; }
  if (typeof title !== 'string' || title.trim() === '') { sendJson(res, 400, { error: 'title is required' }); return; }

  let briefPath = null;
  if (typeof brief === 'string' && brief.trim() !== '') {
    briefPath = path.join(
      os.tmpdir(),
      `dashboard-brief-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.md`,
    );
    fs.writeFileSync(briefPath, brief);
  }
  try {
    const argv = buildNewTaskArgv({ kind, title, briefPath, feasibility: feasibility === true });
    const result = await runConductor(argv);
    const ok = result.exitCode === 0;
    if (ok && autoRun) spawnDetachedConductor(['run']);
    sendJson(res, 200, { ok, exitCode: result.exitCode, message: formatCliMessage(result), id: parseNewTaskId(result.stdout) });
  } finally {
    if (briefPath) fs.rm(briefPath, { force: true }, () => {});
  }
}

export function createDashboardServer(cfg, { autoRun = true, forceScan = false } = {}) {
  const changeBus = createChangeBus(cfg, { forceScan });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith(STATIC_PREFIX)) {
        serveStatic(res, url.pathname);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        handleEvents(req, res, changeBus);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/board') {
        sendJson(res, 200, buildBoard(cfg));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        sendJson(res, 200, buildMetrics(cfg));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/activity') {
        sendJson(res, 200, { active: listActiveSpawns(cfg) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: [...jobs.values()].map(jobPublic) });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 3 && req.method === 'GET') {
        const id = parts[2];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        const detail = buildTaskDetail(cfg, id);
        if (!detail) { sendJson(res, 404, { error: `task not found: ${id}` }); return; }
        sendJson(res, 200, detail);
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 4 && parts[3] === 'diff' && req.method === 'GET') {
        const id = parts[2];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        const diff = buildTaskDiff(cfg, id);
        if (!diff) { sendJson(res, 404, { error: `task not found: ${id}` }); return; }
        sendJson(res, 200, diff);
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 4 && parts[3] === 'stream-tail' && req.method === 'GET') {
        const id = parts[2];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        sendJson(res, 200, { lines: buildStreamTail(cfg, id) });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 4 && parts[3] === 'open-editor' && req.method === 'POST') {
        const id = parts[2];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        sendJson(res, 200, await openWorktreeInEditor(cfg, id));
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 4 && req.method === 'POST') {
        const id = parts[2];
        const action = parts[3];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        if (ASYNC_ACTIONS.includes(action)) { handleAsyncAction(cfg, id, action, res, changeBus, autoRun); return; }
        if (!SYNC_ACTIONS.includes(action)) { sendJson(res, 400, { error: `unknown action: ${action}` }); return; }
        await handleSyncAction(cfg, id, action, req, res, autoRun);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/new-task') {
        await handleNewTask(req, res, autoRun);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.stack ?? err) });
    }
  });
}

export function startDashboardServer(argv = process.argv.slice(2)) {
  const { port, autoRun } = parseArgs(argv);
  const cfg = loadCfg(resolveRoot());
  const forceScan = process.env.DASHBOARD_FORCE_SCAN === '1';
  const server = createDashboardServer(cfg, { autoRun, forceScan });
  server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    console.log(`dashboard listening on http://127.0.0.1:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDashboardServer();
}
