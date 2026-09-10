#!/usr/bin/env node
// fake-service — precommit 的 service 步测试替身：一个监听随机端口的最小 HTTP 服务，
// 三种模式覆盖 spec 要求的三条路径（AC-049）。真 target 仓库的服务千奇百怪，这里只需要
// 「就绪 / 崩溃 / 永不就绪」三种可观察行为，以及一个能被进程组信号杀干净的进程树。
//
// 环境变量：
//   FAKE_SERVICE_MODE=ready|crash|never  默认 ready
//   FAKE_SERVICE_PORT=<n>                指定端口（默认 0 = 随机；ready.url 形态的测试用）
//   FAKE_SERVICE_PORT_FILE=<path>        实际监听端口写到该文件（ready.command 形态的测试用）
//   FAKE_SERVICE_READY_DELAY_MS=<ms>     ready 模式下多久之后才回 2xx（默认 0）
//   FAKE_SERVICE_CRASH_AFTER_MS=<ms>     crash 模式下多久之后退出（默认 200）
//   FAKE_SERVICE_EXIT_CODE=<n>           crash 的退出码（默认 3）
//   FAKE_SERVICE_CHILD_PID_FILE=<path>   另起一个空转子进程并把它的 pid 写到该文件
//                                        （验证 SIGTERM 打到的是整个进程组，不是光杆父进程）
//   FAKE_SERVICE_IGNORE_SIGTERM=1        装死：逼出 stop_grace_ms 之后的 SIGKILL 升级
//
// 就绪探针模式：`node fake-service.mjs --probe <portFile>` —— 读端口文件并 GET /health，
// 2xx 退 0，其余退 1。供 profile 的 `ready.command` 直接引用，不依赖 curl。
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);

// ---- 探针模式 ----
if (process.argv[2] === '--probe') {
  const portFile = process.argv[3];
  let port = null;
  try { port = Number(fs.readFileSync(portFile, 'utf8').trim()); } catch { /* 还没起来 */ }
  if (!Number.isInteger(port) || port <= 0) process.exit(1);
  const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: 3000 }, (res) => {
    res.resume();
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
  req.on('timeout', () => { req.destroy(); process.exit(1); });
  req.on('error', () => process.exit(1));
} else {
  const mode = process.env.FAKE_SERVICE_MODE ?? 'ready';
  const readyDelayMs = num(process.env.FAKE_SERVICE_READY_DELAY_MS, 0);
  const crashAfterMs = num(process.env.FAKE_SERVICE_CRASH_AFTER_MS, 200);
  const exitCode = num(process.env.FAKE_SERVICE_EXIT_CODE, 3);
  const startedAt = Date.now();

  if (process.env.FAKE_SERVICE_IGNORE_SIGTERM === '1') {
    process.on('SIGTERM', () => { process.stdout.write('fake-service: 收到 SIGTERM，装死不退\n'); });
    process.on('SIGINT', () => { /* 同上 */ });
  }

  // 子进程：只为证明清理打的是整个进程组。它自己不监听任何东西。
  if (process.env.FAKE_SERVICE_CHILD_PID_FILE) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_SERVICE_CHILD_PID_FILE, String(child.pid));
    process.stdout.write(`fake-service: child pid ${child.pid}\n`);
  }

  const isReady = () => mode === 'ready' && Date.now() - startedAt >= readyDelayMs;

  const server = http.createServer((req, res) => {
    if (isReady()) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('starting');
    }
  });

  server.listen(num(process.env.FAKE_SERVICE_PORT, 0), '127.0.0.1', () => {
    const { port } = server.address();
    if (process.env.FAKE_SERVICE_PORT_FILE) fs.writeFileSync(process.env.FAKE_SERVICE_PORT_FILE, String(port));
    process.stdout.write(`fake-service: listening on ${port} mode=${mode}\n`);
    process.stderr.write(`fake-service: stderr 也要落进 service.log\n`);
  });

  if (mode === 'crash') {
    setTimeout(() => {
      process.stderr.write(`fake-service: 就绪前崩溃，exit ${exitCode}\n`);
      process.exit(exitCode);
    }, crashAfterMs);
  }
}
