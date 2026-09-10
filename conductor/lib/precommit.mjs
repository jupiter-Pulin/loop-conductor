// lib/precommit.mjs — precommit：在**合并候选**上证明「集成后的系统能构建、能启动、能通过
// 对应层级的测试」（spec §precommit / AC-011 / 017 / 018 / 048–051）。
//
// 不是「跑一条测试命令」：跑测试只证明代码在任务分支上自洽，证明不了合到 base 之后还能
// build、还能起得来。三步顺序固定 build → service → 分层测试，第一个**适用**且失败的步骤
// 决定 outcome=fail，其后的步骤记 not_run，没配置的步骤记 skipped（不影响裁决）。
//
// 三条硬边界：
//   1. 候选 worktree（detached @ B，merge --no-ff 任务分支）在 finally 必移除——它是一次性
//      的证据现场，绝不允许残留下来污染下一轮或被人误当成任务 worktree。
//   2. 服务以独立进程组启动，无论结果都在 finally 先 SIGTERM 整组、stop_grace_ms 后 SIGKILL，
//      记 stopped:true。留下的孤儿进程会占着端口，让下一个任务的 precommit 恒红。
//   3. 全局串行：`state/.precommit.lock`（复用 lib/lock.mjs 的 mkdir 原子协议，只是换个锁名）。
//      端口、数据库这类共享资源不容两个候选同时跑；等锁超时记 lock_timeout，router 可直接重试。
//
// 命令执行器、服务启动器、就绪探测、时钟、sleep 全部可注入：单测用假执行器钉步骤语义，
// 集成测试用真 git 仓与真子进程钉清理与锁。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { addDetachedWorktree, removeWorktree, git } from './git.mjs';
import { acquireLock, releaseLock, lockDirPath, isPidAlive } from './lock.mjs';
import { readPrecommitProfile, setupProfilePaths } from './profile.mjs';
import { writeJsonAtomic, readJsonIf } from './state.mjs';

/** 测试层级顺序（tier 累加的唯一来源）。 */
export const TIER_ORDER = Object.freeze(['unit', 'integration', 'e2e']);
/** 候选合并的机器文案（与轮次 commit 同属状态机产物）。 */
export const CANDIDATE_MERGE_MESSAGE = 'precommit candidate';
/** precommit 全局串行锁的锁名（state/.precommit.lock）。 */
export const PRECOMMIT_LOCK_NAME = '.precommit.lock';
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_STOP_GRACE_MS = 10_000;
export const READY_POLL_MS = 1000;
export const LOCK_POLL_MS = 1000;

// ---- 小工具 ----

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 取字符串末尾 maxBytes 字节（与 shared.mjs 的 tail 口径一致）。 */
export function tailBytesOf(str, maxBytes) {
  const s = String(str ?? '');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return s;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

function secondsOf(ms) {
  const s = (Number(ms) || 0) / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/** 失败输出里最像「原因」的那一行（summary 的 `<首行>`）。 */
export function firstFailureLine(tail) {
  const lines = String(tail ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '(无输出)';
  const marked = lines.find((l) => /^(not ok\b|✖|✗|×|FAIL\b|Error:|error:|error\b)/i.test(l) || /\bfailed\b/i.test(l));
  return (marked ?? lines[lines.length - 1]).slice(0, 200);
}

/**
 * 测试输出里的 pass / fail 计数（node:test 的 `# pass 41` / `ℹ pass 41`，以及同形态的
 * 其它 runner）。解析不出返回 null——summary 退化成「ok 用时」，绝不编造数字。
 */
export function parseTestCounts(tail) {
  const text = String(tail ?? '');
  const grab = (word) => {
    const m = text.match(new RegExp(`(?:^|\\n)[^\\S\\n]*(?:[#ℹ][^\\S\\n]*)?${word}[:\\s]+(\\d+)`, 'i'));
    return m ? Number(m[1]) : null;
  };
  const pass = grab('pass');
  const fail = grab('fail');
  if (pass == null && fail == null) return null;
  return { pass: pass ?? 0, fail: fail ?? 0, total: (pass ?? 0) + (fail ?? 0) };
}

// ---- 步骤骨架 ----

/**
 * 按 profile 与 tier 排出本次要走的步骤（顺序固定 build → service → 分层测试）。
 * tier 决定测试步的**范围**：unit 只跑 unit，integration 跑 unit+integration，e2e 跑三层；
 * 范围内没配命令的层进 skipped_tiers（记录在案，不影响已执行步骤的裁决）。
 */
export function stepPlan(profile, tier) {
  const normalizedTier = TIER_ORDER.includes(tier) ? tier : TIER_ORDER[0];
  const tiers = TIER_ORDER.slice(0, TIER_ORDER.indexOf(normalizedTier) + 1);
  const steps = [
    { step: 'build', command: profile?.build ?? null, service: null },
    { step: 'service', command: profile?.service?.start ?? null, service: profile?.service ?? null },
    ...tiers.map((t) => ({ step: t, command: profile?.[t] ?? null, service: null })),
  ];
  return {
    tier: normalizedTier,
    steps,
    tiers,
    skipped_tiers: tiers.filter((t) => !profile?.[t]),
  };
}

function blankStep(planned, status) {
  const base = {
    step: planned.step,
    command: planned.command ?? null,
    status,
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
    tail: '',
  };
  if (planned.step === 'service') return { ...base, ready_ms: null, pid: null, stopped: false };
  return base;
}

/** 全体 not_run 的步骤表（候选冲突与 lock_timeout 用：三步都没轮到跑）。 */
export function blankSteps(plan, status = 'not_run') {
  return plan.steps.map((s) => blankStep(s, status));
}

// ---- summary ----

function serviceFailReason(step) {
  if (step.timed_out) return `就绪超时 ${secondsOf(step.duration_ms)}`;
  if (step.exit_code != null) return `进程退出 ${step.exit_code}: ${firstFailureLine(step.tail)}`;
  return firstFailureLine(step.tail);
}

function stepPhrase(step) {
  if (step.status === 'skipped') return `${step.step} skipped`;
  if (step.status === 'not_run') return `${step.step} not_run`;
  if (step.step === 'build') {
    return step.status === 'ok'
      ? `build ok ${secondsOf(step.duration_ms)}`
      : `build fail: ${step.timed_out ? `超时 ${secondsOf(step.duration_ms)}` : firstFailureLine(step.tail)}`;
  }
  if (step.step === 'service') {
    return step.status === 'ok'
      ? `service ready ${secondsOf(step.ready_ms)}`
      : `service fail: ${serviceFailReason(step)}`;
  }
  const counts = parseTestCounts(step.tail);
  if (step.status === 'ok') {
    return counts ? `${step.step} ${counts.pass}/${counts.total} ok` : `${step.step} ok ${secondsOf(step.duration_ms)}`;
  }
  const reason = step.timed_out ? `超时 ${secondsOf(step.duration_ms)}` : firstFailureLine(step.tail);
  return counts && counts.fail > 0 ? `${step.step} ${counts.fail} fail: ${reason}` : `${step.step} fail: ${reason}`;
}

/**
 * 内核生成的 summary（AC-051）：`build ok 42s；service ready 3.1s；unit 41/41 ok；integration 2 fail: <首行>`。
 * prefix 用于候选冲突这类「没轮到跑任何一步」的前情，附在最前面。
 */
export function summarizeSteps(steps, { prefix = null } = {}) {
  const parts = (steps ?? []).map(stepPhrase);
  return [prefix, ...parts].filter(Boolean).join('；');
}

// ---- 记录（与 agent 记录同构，字段面由 log-contract.mjs 裁判）----

/**
 * 合成 `precommit-r<n>.json`。字段面必须与 log-contract.mjs 的 PRECOMMIT_FIELDS 逐字一致
 * ——多一个字段就是 product: invalid，router 会读到一条不携带契约语义的记录。
 */
export function composePrecommitRecord({
  tier, outcome, summary, steps, skippedTiers = [], conflictFiles = [],
  baseSha = null, headSha = null, candidateSha = null,
}) {
  return {
    role: 'precommit',
    outcome,
    tier,
    summary,
    cost_usd: 0,
    base_sha: baseSha,
    head_sha: headSha,
    candidate_sha: candidateSha,
    steps,
    skipped_tiers: skippedTiers,
    conflict_files: conflictFiles,
  };
}

// ---- 默认执行器（可注入替换）----

/**
 * 跑一条命令（shell + 独立进程组 + 超时 SIGTERM→SIGKILL），
 * 另支持 env 叠加。不复用 shared.mjs 是为了不让 lib 反向依赖 stages（且 shared.mjs 在 P3 会瘦身）。
 */
export function defaultRunCommand(command, cwd, { timeoutMs = 1_800_000, killGraceMs = 10_000, env = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: true,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let forceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
      forceTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已消失 */ }
      }, killGraceMs);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (c) => stdout.push(Buffer.from(c)));
    child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode: -1, timedOut: false, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        exitCode: timedOut ? null : code ?? -1,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/** HTTP 就绪探测：2xx 即就绪。任何错误（连不上、超时、非 2xx）都只是「还没好」。 */
export function defaultHttpProbe(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      const mod = url.startsWith('https:') ? https : http;
      req = mod.get(url, { agent: false, timeout: timeoutMs }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.resume(); // 必须排空，否则 socket 不释放
        res.on('end', () => finish(ok));
        res.on('error', () => finish(ok));
      });
    } catch {
      finish(false);
      return;
    }
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

/** 就绪判据：ready.url（2xx）或 ready.command（exit 0），二选一。 */
export async function defaultProbeReady({ ready, cwd, env, timeoutMs = 5000, runCommand = defaultRunCommand }) {
  if (ready?.url) return defaultHttpProbe(ready.url, timeoutMs);
  if (ready?.command) {
    const r = await runCommand(ready.command, cwd, { timeoutMs, env });
    return r.exitCode === 0;
  }
  return false;
}

/**
 * 以独立进程组启动服务，stdout/stderr 落 logPath 并留 tail。返回句柄：
 *   { pid, exited, exitCode, tail(), stop(graceMs) }
 * stop：先 SIGTERM 整个进程组，graceMs 后 SIGKILL；调用方在 finally 必调。
 */
export function defaultStartService({ command, cwd, env = null, logPath = null, tailBytes = 12000, sleep = defaultSleep }) {
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');
  }
  const chunks = [];
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;
  const waiters = [];

  const child = spawn(command, {
    shell: true,
    cwd,
    detached: true,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (chunk) => {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    if (logPath) {
      try { fs.appendFileSync(logPath, buf); } catch { /* 日志写不进不该拖垮服务判定 */ }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const settle = () => {
    exited = true;
    while (waiters.length) waiters.pop()();
  };
  child.on('error', (err) => { spawnError = String(err); exitCode = -1; settle(); });
  child.on('exit', (code, signal) => { exitCode = code ?? null; exitSignal = signal ?? null; settle(); });

  const waitExit = (ms) => new Promise((resolve) => {
    if (exited) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    waiters.push(() => { clearTimeout(timer); resolve(); });
  });

  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch {
      try { child.kill(signal); } catch { /* 已消失 */ }
    }
  };

  return {
    pid: child.pid ?? null,
    get exited() { return exited; },
    get exitCode() { return exitCode; },
    get exitSignal() { return exitSignal; },
    tail() {
      const text = Buffer.concat(chunks).toString('utf8') + (spawnError ? `\n${spawnError}` : '');
      return tailBytesOf(text, tailBytes);
    },
    async stop(graceMs = DEFAULT_STOP_GRACE_MS) {
      if (!exited) {
        killGroup('SIGTERM');
        await waitExit(graceMs);
      }
      if (!exited) {
        killGroup('SIGKILL');
        await waitExit(2000);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      await sleep(0);
      return true;
    },
  };
}

// ---- 三步 ----

async function runServiceStep({
  planned, entry, cwd, tailBytes, serviceLogPath,
  startService, probeReady, sleep, now, onServiceStart,
}) {
  const spec = planned.service ?? {};
  const readyTimeoutMs = Number.isFinite(spec.ready_timeout_ms) ? spec.ready_timeout_ms : DEFAULT_READY_TIMEOUT_MS;
  const env = spec.env ?? null;
  const startedAt = now();
  const handle = startService({
    command: planned.command,
    cwd,
    env,
    logPath: serviceLogPath,
    tailBytes,
    sleep,
  });
  entry.pid = handle.pid ?? null;
  if (onServiceStart) onServiceStart(handle.pid ?? null);

  const deadline = startedAt + readyTimeoutMs;
  const maxPolls = Math.ceil(readyTimeoutMs / READY_POLL_MS) + 5; // 防注入时钟不前进时空转
  let ready = false;
  for (let i = 0; i < maxPolls; i++) {
    if (handle.exited) break;
    if (await probeReady({ ready: spec.ready, cwd, env, timeoutMs: Math.min(5000, readyTimeoutMs) })) {
      ready = true;
      break;
    }
    if (now() >= deadline) break;
    await sleep(READY_POLL_MS);
  }

  entry.duration_ms = Math.max(0, now() - startedAt);
  if (ready && !handle.exited) {
    entry.status = 'ok';
    entry.ready_ms = entry.duration_ms;
    entry.tail = tailBytesOf(handle.tail(), tailBytes);
    return { entry, handle, ok: true };
  }
  entry.status = 'fail';
  entry.ready_ms = null;
  if (handle.exited) {
    entry.exit_code = handle.exitCode;
  } else {
    entry.timed_out = true;
  }
  entry.tail = tailBytesOf(handle.tail(), tailBytes);
  return { entry, handle, ok: false };
}

/**
 * 跑三步并返回 { steps, outcome, summary, skipped_tiers, service_pid }。
 * 服务在测试步期间保持运行，无论结果都在 finally 按 stop_grace_ms 终止整个进程组并记 stopped:true。
 */
export async function runPrecommitSteps({
  profile,
  tier,
  cwd,
  timeoutMs = 1_800_000,
  tailBytes = 12_000,
  serviceLogPath = null,
  runCommand = defaultRunCommand,
  startService = defaultStartService,
  probeReady = defaultProbeReady,
  sleep = defaultSleep,
  now = () => Date.now(),
  onServiceStart = null,
} = {}) {
  const plan = stepPlan(profile, tier);
  const steps = [];
  let failed = false;
  let serviceHandle = null;
  let serviceEntry = null;
  let servicePid = null;

  try {
    for (const planned of plan.steps) {
      if (!planned.command) { // 未配置：skipped，不影响裁决
        steps.push(blankStep(planned, 'skipped'));
        continue;
      }
      if (failed) { // 前面已经红了：其后步骤一律 not_run
        steps.push(blankStep(planned, 'not_run'));
        continue;
      }
      const entry = blankStep(planned, 'ok');
      if (planned.step === 'service') {
        const res = await runServiceStep({
          planned, entry, cwd, tailBytes, serviceLogPath,
          startService, probeReady, sleep, now,
          onServiceStart: (pid) => { servicePid = pid; if (onServiceStart) onServiceStart(pid); },
        });
        serviceHandle = res.handle;
        serviceEntry = entry;
        if (!res.ok) failed = true;
        steps.push(entry);
        continue;
      }
      const startedAt = now();
      // 测试步不叠加 service.env：env 是 service 段的键，测试命令要环境变量就写在命令里。
      const r = await runCommand(planned.command, cwd, { timeoutMs });
      entry.duration_ms = Math.max(0, now() - startedAt);
      entry.exit_code = r.exitCode ?? null;
      entry.timed_out = Boolean(r.timedOut);
      const out = String(r.stdout ?? '');
      const err = String(r.stderr ?? '');
      // 两股输出之间补一个换行：否则 stderr 首行会粘在 stdout 末行上，首行摘要与签名都跟着错。
      entry.tail = tailBytesOf(err === '' || out === '' || out.endsWith('\n') ? `${out}${err}` : `${out}\n${err}`, tailBytes);
      entry.status = !entry.timed_out && r.exitCode === 0 ? 'ok' : 'fail';
      if (entry.status === 'fail') failed = true;
      steps.push(entry);
    }
  } finally {
    if (serviceHandle) {
      const graceMs = Number.isFinite(profile?.service?.stop_grace_ms)
        ? profile.service.stop_grace_ms
        : DEFAULT_STOP_GRACE_MS;
      try {
        await serviceHandle.stop(graceMs);
      } catch { /* 终止失败也要把 stopped 记下来，让人看得见 */ }
      if (serviceEntry) {
        serviceEntry.stopped = true;
        serviceEntry.tail = tailBytesOf(serviceHandle.tail(), tailBytes);
      }
    }
  }

  return {
    steps,
    outcome: failed ? 'fail' : 'ok',
    summary: summarizeSteps(steps),
    skipped_tiers: plan.skipped_tiers,
    tier: plan.tier,
    service_pid: servicePid,
  };
}

// ---- 全局串行锁 ----

export function precommitLockDir(stateDir) {
  return lockDirPath(stateDir, PRECOMMIT_LOCK_NAME);
}

async function killPidTree(pid, graceMs, sleep) {
  const signalBoth = (sig) => {
    try { process.kill(-pid, sig); } catch { /* 可能不是进程组长 */ }
    try { process.kill(pid, sig); } catch { /* 已消失 */ }
  };
  signalBoth('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await sleep(100);
  }
  if (isPidAlive(pid)) {
    signalBoth('SIGKILL');
    await sleep(100);
  }
}

/**
 * 残锁接管（AC-050）：持有者 pid 已死时，先把锁里记着的服务 pid 终止掉再让 acquireLock 自愈。
 * 顺序不能反——先抢锁再杀服务的话，新候选会撞上旧候选还占着的端口。
 */
export async function takeoverStaleService(stateDir, { sleep = defaultSleep, graceMs = DEFAULT_STOP_GRACE_MS } = {}) {
  const info = readJsonIf(path.join(precommitLockDir(stateDir), 'info.json'));
  if (info == null) return null;
  if (isPidAlive(Number(info.pid))) return null; // 持有者还活着：正常占用，不是残锁
  const servicePid = Number(info.service_pid);
  if (!Number.isInteger(servicePid) || servicePid <= 0 || !isPidAlive(servicePid)) return null;
  await killPidTree(servicePid, graceMs, sleep);
  return servicePid;
}

/** 锁内容：持有者 pid + 服务 pid（服务起来后原地更新）。 */
function writeLockInfo(stateDir, fields) {
  const p = path.join(precommitLockDir(stateDir), 'info.json');
  const prev = readJsonIf(p) ?? {};
  try { writeJsonAtomic(p, { ...prev, ...fields }); } catch { /* 锁已被释放：无害 */ }
}

/**
 * 等锁。返回 { acquired, waited_ms, takeover_pid }。超过 timeoutMs 仍拿不到 → acquired:false，
 * 调用方据此写 lock_timeout 记录（router 可直接重试，不必开人闸）。
 */
export async function acquirePrecommitLock({
  stateDir, taskId = null, timeoutMs = 1_800_000, sleep = defaultSleep, now = () => Date.now(), pollMs = LOCK_POLL_MS,
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let takeoverPid = null;
  for (;;) {
    const killed = await takeoverStaleService(stateDir, { sleep });
    if (killed != null) takeoverPid = killed;
    const r = acquireLock(stateDir, { name: PRECOMMIT_LOCK_NAME });
    if (r.acquired) {
      writeLockInfo(stateDir, {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        task_id: taskId,
        service_pid: null,
      });
      return { acquired: true, waited_ms: Math.max(0, now() - startedAt), takeover_pid: takeoverPid };
    }
    if (now() >= deadline) {
      return { acquired: false, waited_ms: Math.max(0, now() - startedAt), takeover_pid: takeoverPid };
    }
    await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
  }
}

export function releasePrecommitLock(stateDir) {
  releaseLock(stateDir, PRECOMMIT_LOCK_NAME);
}

// ---- 候选 worktree ----

export function candidateWorktreePath(cfg, id) {
  return path.join(cfg.worktreesDir, `${id}.precommit`);
}

export function precommitRecordPath(dossierDir, round) {
  return path.join(dossierDir, `precommit-r${round}.json`);
}

export function precommitServiceLogPath(dossierDir, round) {
  return path.join(dossierDir, `precommit-r${round}.service.log`);
}

function revParse(repo, ref) {
  const r = git(['rev-parse', ref], repo);
  return r.status === 0 ? r.stdout.trim() : null;
}

function conflictFilesOf(wt) {
  const r = git(['diff', '--name-only', '--diff-filter=U'], wt);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * 建候选：detached @ B 的一次性 worktree，再 merge --no-ff 任务分支。
 * 冲突 → 先记 conflict_files 再 merge --abort（顺序不能反：abort 之后就查不到了）。
 */
function buildCandidate(repo, wtPath, baseSha, taskBranch) {
  if (fs.existsSync(wtPath)) {
    // 上次崩溃的残留：先按 worktree 注销，再硬删目录（崩在 add 之前的残渣不是合法 worktree，
    // `git worktree remove` 对它无能为力，而目录一旦存在 `worktree add` 就直接失败）。
    removeWorktree(repo, wtPath);
    fs.rmSync(wtPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const added = addDetachedWorktree(repo, wtPath, baseSha);
  if (!added.ok) return { ok: false, error: added.error, conflict_files: [] };
  const merged = git(['merge', '--no-ff', '-m', CANDIDATE_MERGE_MESSAGE, taskBranch], wtPath);
  if (merged.status !== 0) {
    const conflicts = conflictFilesOf(wtPath);
    git(['merge', '--abort'], wtPath);
    return {
      ok: false,
      conflict_files: conflicts,
      error: conflicts.length > 0 ? null : (merged.stderr || merged.stdout || '').trim(),
    };
  }
  return { ok: true, conflict_files: [], candidate_sha: revParse(wtPath, 'HEAD') };
}

// ---- 入口 ----

function writeRecord(dossierDir, round, record) {
  fs.mkdirSync(dossierDir, { recursive: true });
  writeJsonAtomic(precommitRecordPath(dossierDir, round), record);
  return record;
}

function resolveProfile({ profile, setupProfileJson, cfg, targetRepo, task }) {
  if (profile !== undefined && profile !== null) return profile;
  let json = setupProfileJson;
  if (json === undefined) {
    const paths = setupProfilePaths({ targetRepo, targetProfilesDir: cfg.targetProfilesDir });
    json = readJsonIf(paths.meta);
  }
  return readPrecommitProfile(json, task);
}

/**
 * 跑一次 precommit 并落盘 `dossier/<id>/precommit-r<n>.json`。永不抛错：任何失败都是一条记录。
 *
 * 必给：cfg（含 worktreesDir / dossierDir / stateDir / targetProfilesDir 与三个超时）、id、round、tier。
 * 可给：task（testCommand 回落与 targetRepo / baseBranch 快照）、targetRepo / baseBranch / taskBranch、
 *       profile（跳过读盘）、以及全部注入项（runCommand / startService / probeReady / sleep / now）。
 */
export async function runPrecommit({
  cfg,
  id = null, // 省略时取 task.id：调用方手上通常只有一份 task 快照
  task = null,
  round = 1,
  tier = 'unit',
  targetRepo = null,
  baseBranch = null,
  taskBranch = null,
  dossierDir = null,
  stateDir = null,
  worktreePath = null,
  profile = undefined,
  setupProfileJson = undefined,
  stepTimeoutMs = null,
  lockTimeoutMs = null,
  tailBytes = null,
  runCommand = defaultRunCommand,
  startService = defaultStartService,
  probeReady = defaultProbeReady,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const taskId = id ?? task?.id ?? null;
  const repo = targetRepo ?? task?.targetRepo ?? cfg.targetRepo;
  const base = baseBranch ?? task?.baseBranch ?? cfg.baseBranch ?? 'main';
  const branch = taskBranch ?? `task/${taskId}`;
  const dossier = dossierDir ?? path.join(cfg.dossierDir, String(taskId));
  const stDir = stateDir ?? cfg.stateDir;
  const wtPath = worktreePath ?? candidateWorktreePath(cfg, taskId);
  const stepTimeout = stepTimeoutMs ?? cfg.precommitStepTimeoutMs ?? cfg.greenGateTimeoutMs ?? 1_800_000;
  const lockTimeout = lockTimeoutMs ?? cfg.precommitLockTimeoutMs ?? 1_800_000;
  const tailCap = tailBytes ?? cfg.greenGateOutputTailBytes ?? 12_000;

  const resolvedProfile = resolveProfile({ profile, setupProfileJson, cfg, targetRepo: repo, task });
  const plan = stepPlan(resolvedProfile, tier);
  const headSha = revParse(repo, branch);
  const baseSha = revParse(repo, base);

  const failRecord = (summary, extra = {}) => writeRecord(dossier, round, composePrecommitRecord({
    tier: plan.tier,
    outcome: 'fail',
    summary,
    steps: blankSteps(plan, 'not_run'),
    skippedTiers: [],
    baseSha,
    headSha,
    ...extra,
  }));

  if (headSha == null || baseSha == null) {
    const missing = headSha == null ? branch : base;
    return failRecord(`分支不存在：${missing}`);
  }

  const lock = await acquirePrecommitLock({ stateDir: stDir, taskId, timeoutMs: lockTimeout, sleep, now });
  if (!lock.acquired) return failRecord('lock_timeout');

  try {
    const candidate = buildCandidate(repo, wtPath, baseSha, branch);
    if (!candidate.ok) {
      const prefix = candidate.conflict_files.length > 0
        ? `合并候选与 base 冲突：${candidate.conflict_files.join(', ')}`
        : `合并候选建不起来：${candidate.error ?? 'unknown'}`;
      return writeRecord(dossier, round, composePrecommitRecord({
        tier: plan.tier,
        outcome: 'fail',
        summary: summarizeSteps(blankSteps(plan, 'not_run'), { prefix }),
        steps: blankSteps(plan, 'not_run'),
        skippedTiers: [],
        conflictFiles: candidate.conflict_files,
        baseSha,
        headSha,
      }));
    }

    const result = await runPrecommitSteps({
      profile: resolvedProfile,
      tier: plan.tier,
      cwd: wtPath,
      timeoutMs: stepTimeout,
      tailBytes: tailCap,
      serviceLogPath: precommitServiceLogPath(dossier, round),
      runCommand,
      startService,
      probeReady,
      sleep,
      now,
      onServiceStart: (pid) => writeLockInfo(stDir, { service_pid: pid }),
    });

    return writeRecord(dossier, round, composePrecommitRecord({
      tier: result.tier,
      outcome: result.outcome,
      summary: result.summary,
      steps: result.steps,
      skippedTiers: result.skipped_tiers,
      conflictFiles: [],
      baseSha,
      headSha,
      candidateSha: candidate.candidate_sha ?? null,
    }));
  } catch (err) {
    // 内核不抛错：precommit 的任何意外都只是「这一轮红了」的一条记录，router 照常决策。
    return failRecord(`precommit 内部错误：${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  } finally {
    try { removeWorktree(repo, wtPath); } catch { /* 候选必须消失；删不掉时下次 run 会再清 */ }
    fs.rmSync(wtPath, { recursive: true, force: true });
    releasePrecommitLock(stDir);
  }
}
