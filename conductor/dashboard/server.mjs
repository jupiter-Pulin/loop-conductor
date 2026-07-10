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
  isValidTaskId, buildBoard, buildTaskDetail, formatCliMessage,
  buildSyncActionArgv, SYNC_ACTIONS, parseNewTaskId, buildNewTaskArgv,
} from './model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONDUCTOR_BIN = path.join(HERE, '..', 'conductor.mjs');
const INDEX_HTML = path.join(HERE, 'index.html');

function parseArgs(argv) {
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

async function handleMerge(id, res) {
  const result = await runConductor(['merge', id]);
  const ok = result.exitCode === 0;
  sendJson(res, 200, { ok, exitCode: result.exitCode, message: formatCliMessage(result) });
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

export function createDashboardServer(cfg, { autoRun = true } = {}) {
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

      if (req.method === 'GET' && url.pathname === '/api/board') {
        sendJson(res, 200, buildBoard(cfg));
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

      if (parts[0] === 'api' && parts[1] === 'task' && parts.length === 4 && req.method === 'POST') {
        const id = parts[2];
        const action = parts[3];
        if (!isValidTaskId(id)) { sendJson(res, 400, { error: 'invalid task id' }); return; }
        if (action === 'merge') { await handleMerge(id, res); return; }
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
  const server = createDashboardServer(cfg, { autoRun });
  server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    console.log(`dashboard listening on http://127.0.0.1:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDashboardServer();
}
