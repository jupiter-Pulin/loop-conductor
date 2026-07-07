// lib/codex.mjs — Codex CLI（`codex exec`）薄封装：verifier shadow 实验的候选后端。
// 与 claude.mjs 同构但刻意更简：shadow 是 best-effort 观测，不做瞬态重试阶梯、不做
// inactivity 监控——失败就记 shadow 失败证据，绝不影响主链路（契约见 stages/verify.mjs 挂点）。
// 为什么是 `codex exec` 而不是 codex MCP server：conductor 是无头 CLI 编排器，MCP 接入
// 需要内嵌 JSON-RPC client；`codex exec` 是同一引擎的非交互形态，支持 --json 事件流、
// -s read-only 只读沙箱、-C 工作目录、-o 最终回复落文件，与 spawn claude 的形态一致。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export function codexBin() {
  return process.env.CODEX_BIN || 'codex';
}

/**
 * codex exec 参数拼装。恒定：--json（JSONL 事件流）、--color never、--skip-git-repo-check
 * （task worktree 是 git worktree，防误判）、`-` 表示 prompt 走 stdin（同 claude.mjs，防超 argv 上限）。
 */
export function buildCodexExecArgs({ cwd = null, model = null, sandbox = 'read-only', outputLastMessage = null } = {}) {
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-s', sandbox];
  if (cwd) args.push('-C', cwd);
  if (model) args.push('-m', model);
  if (outputLastMessage) args.push('-o', outputLastMessage);
  args.push('-');
  return args;
}

/**
 * 跑一次 codex exec。返回 { ok, exitCode, result, durationMs, usage, error, spawnError }。
 * result 优先取 -o 落盘的最终回复文件；事件流原样追加到 streamFile（shadow 证据）。
 * usage：从 JSONL 事件里捞最后一个 .usage 对象（token 计数；codex 不报 USD，成本对照用 token+时长）。
 */
export async function runCodexExec({
  prompt,
  cwd,
  model = null,
  sandbox = 'read-only',
  outputLastMessage,
  streamFile = null,
  timeoutMs = 1800000,
}) {
  const args = buildCodexExecArgs({ cwd, model, sandbox, outputLastMessage });
  const startedMs = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, exitCode: null, result: null, durationMs: 0, usage: null, error: String(err), spawnError: true });
      return;
    }
    let settled = false;
    let stderrTail = '';
    let usage = null;
    let killed = false;
    const streamFd = streamFile ? fs.openSync(streamFile, 'a') : null;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 10000).unref();
    }, timeoutMs);
    timer.unref?.();

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (streamFd != null) { try { fs.closeSync(streamFd); } catch { /* 忽略 */ } }
      resolve(out);
    };

    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, result: null, durationMs: Date.now() - startedMs, usage: null, error: String(err), spawnError: true });
    });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      const s = String(chunk);
      if (streamFd != null) { try { fs.writeSync(streamFd, s); } catch { /* 流证据尽力而为 */ } }
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const u = ev?.usage ?? ev?.msg?.usage ?? ev?.info?.usage ?? null;
          if (u && typeof u === 'object') usage = u;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000);
    });

    child.on('close', (code) => {
      let result = null;
      if (outputLastMessage) {
        try { result = fs.readFileSync(outputLastMessage, 'utf8'); } catch { /* 保持 null */ }
      }
      const ok = code === 0 && result != null;
      finish({
        ok,
        exitCode: code,
        result,
        durationMs: Date.now() - startedMs,
        usage,
        killed: killed || null,
        error: ok ? null : (killed ? `codex exec killed by timeout ${timeoutMs}ms` : (stderrTail.trim() || `codex exec exited ${code} with no last message`)),
        spawnError: false,
      });
    });

    child.stdin.on('error', () => { /* 子进程早退时 EPIPE，close 分支统一收尾 */ });
    child.stdin.end(prompt);
  });
}
