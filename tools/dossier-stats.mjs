#!/usr/bin/env node
// tools/dossier-stats.mjs — 跨任务失败分布/成本/轮次聚合（fable-loop 研究量尺）。
// 只读 state/{queue,done,failed} + dossier/，不依赖 conductor 运行时；输出 Markdown 摘要或 --json。
// 用途：每轮优化实验后一条命令拿到基线对比（截断率、返工率、committer 提案通过率、失败类型分布），
// 不用重新人肉挖 dossier（fable-loop-STATE.md §4 H12）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_DIR_RE = /^task-\d{8}-\d{3}$/;

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listTaskIds(boxDir) {
  try {
    return fs.readdirSync(boxDir).filter((n) => TASK_DIR_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** 读 dossier/<id>/events.jsonl（H17 结构化事件流）。缺失返回 []；半行截断逐行容错。 */
function readEvents(dossierDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dossierDir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* 截断残行忽略 */ }
  }
  return events;
}

/** 收集单任务：state 快照 + dossier 轮次证据。缺文件一律容错（历史任务布局可能不全）。 */
export function collectTask(root, box, id) {
  const stateDir = path.join(root, 'state', box, id);
  const dossierDir = path.join(root, 'dossier', id);
  const task = readJsonIf(path.join(stateDir, 'task.json')) ?? {};
  const runtime = readJsonIf(path.join(stateDir, 'runtime.json')) ?? {};

  const makerRounds = [];
  const verifierRounds = [];
  const testGates = [];
  const committerAttempts = [];
  let verifierInvalidFiles = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(dossierDir);
  } catch { /* dossier 缺失（如 parked/极早期任务） */ }

  for (const name of entries.sort()) {
    let m;
    if ((m = name.match(/^maker-r(\d+)\.json$/))) {
      const rec = readJsonIf(path.join(dossierDir, name)) ?? {};
      makerRounds.push({
        round: Number(m[1]),
        mode: rec.mode ?? null,
        ok: rec.ok ?? null,
        cost_usd: rec.cost_usd ?? 0,
        subtype: rec.raw?.subtype ?? null,
        max_turns_continuations: rec.max_turns_continuations ?? 0,
        resume_failed: rec.resume_failed === true,
      });
    } else if ((m = name.match(/^verify-r(\d+)\.verdict\.json$/))) {
      const v = readJsonIf(path.join(dossierDir, name)) ?? {};
      verifierRounds.push({ round: Number(m[1]), overall: v.overall ?? null });
    } else if (/^verify-r\d+\.invalid-a\d+\.json$/.test(name)) {
      verifierInvalidFiles++;
    } else if ((m = name.match(/^test-gate-r(\d+)\.json$/))) {
      const g = readJsonIf(path.join(dossierDir, name)) ?? {};
      testGates.push({ round: Number(m[1]), mode: g.mode ?? null, verdict: g.verdict ?? null });
    } else if ((m = name.match(/^committer-r(\d+)\.json$/))) {
      const rec = readJsonIf(path.join(dossierDir, name)) ?? {};
      committerAttempts.push({ attempt: Number(m[1]), subtype: rec.raw?.subtype ?? null, cost_usd: rec.cost_usd ?? 0 });
    }
  }

  // committer 提案有效性：优先读结构化事件流（H17，events.jsonl）；legacy 任务（无事件文件
  // 或无 committer 事件）回退 timeline 文案 grep（E8 口径，保持历史 11 任务可比）。
  let committerValidAttempt = null;
  let committerDegraded = false;
  let sawCommitterEvents = false;
  for (const ev of readEvents(dossierDir)) {
    if (ev.type === 'committer_attempt') {
      sawCommitterEvents = true;
      if (ev.outcome === 'valid' && committerValidAttempt === null) committerValidAttempt = ev.attempt ?? null;
    } else if (ev.type === 'committer_degraded') {
      sawCommitterEvents = true;
      committerDegraded = true;
    }
  }
  if (!sawCommitterEvents) {
    try {
      const timeline = fs.readFileSync(path.join(dossierDir, 'timeline.md'), 'utf8');
      const valid = timeline.match(/committer 提案 a(\d+) 有效/);
      if (valid) committerValidAttempt = Number(valid[1]);
      committerDegraded = timeline.includes('降级机器文案');
    } catch { /* timeline 缺失 */ }
  }

  return {
    id,
    box,
    kind: task.kind ?? null,
    stage: runtime.stage ?? null,
    last_failure_type: runtime.last_failure_type ?? null,
    maker_miss_count: runtime.maker_miss_count ?? 0,
    spent_usd: runtime.spent_usd ?? 0,
    maker_rounds: makerRounds,
    verifier_rounds: verifierRounds,
    verifier_invalid_files: verifierInvalidFiles,
    test_gates: testGates,
    committer_attempts: committerAttempts,
    committer_valid_attempt: committerValidAttempt,
    committer_degraded: committerDegraded,
  };
}

/** 全库聚合：逐任务明细 + 系统级汇总（研究基线用的比率都在 summary 里）。 */
export function collectStats(root) {
  const tasks = [];
  for (const box of ['queue', 'done', 'failed']) {
    for (const id of listTaskIds(path.join(root, 'state', box))) {
      tasks.push(collectTask(root, box, id));
    }
  }

  const makerAll = tasks.flatMap((t) => t.maker_rounds);
  const makerR1 = makerAll.filter((r) => r.round === 1);
  const failureTypes = {};
  for (const t of tasks) {
    if (t.last_failure_type) failureTypes[t.last_failure_type] = (failureTypes[t.last_failure_type] ?? 0) + 1;
  }
  const withCommitter = tasks.filter(
    (t) => t.committer_attempts.length > 0 || t.committer_valid_attempt !== null || t.committer_degraded,
  );

  const summary = {
    tasks_total: tasks.length,
    tasks_by_box: {
      queue: tasks.filter((t) => t.box === 'queue').length,
      done: tasks.filter((t) => t.box === 'done').length,
      failed: tasks.filter((t) => t.box === 'failed').length,
    },
    failure_types: failureTypes,
    maker: {
      rounds_total: makerAll.length,
      r1_total: makerR1.length,
      r1_max_turns_cutoff: makerR1.filter((r) => r.subtype === 'error_max_turns').length,
      rounds_with_continuation: makerAll.filter((r) => r.max_turns_continuations > 0).length,
      cold_degraded: makerAll.filter((r) => r.mode === 'cold-degraded' || r.resume_failed).length,
      tasks_needing_r2plus: tasks.filter((t) => t.maker_rounds.some((r) => r.round >= 2)).length,
      cost_usd: round6(makerAll.reduce((s, r) => s + (r.cost_usd ?? 0), 0)),
    },
    verifier: {
      rounds_total: tasks.reduce((s, t) => s + t.verifier_rounds.length, 0),
      fails: tasks.reduce((s, t) => s + t.verifier_rounds.filter((r) => r.overall === 'fail').length, 0),
      invalid_files: tasks.reduce((s, t) => s + t.verifier_invalid_files, 0),
    },
    test_gate: {
      vacuous: tasks.reduce((s, t) => s + t.test_gates.filter((g) => g.verdict === 'vacuous').length, 0),
      per_ac_rounds: tasks.reduce((s, t) => s + t.test_gates.filter((g) => g.mode === 'per-ac').length, 0),
    },
    committer: {
      merges_with_proposal: withCommitter.length,
      valid_a1: withCommitter.filter((t) => t.committer_valid_attempt === 1).length,
      degraded: withCommitter.filter((t) => t.committer_degraded).length,
    },
    spent_usd_total: round6(tasks.reduce((s, t) => s + (t.spent_usd ?? 0), 0)),
  };
  return { tasks, summary };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function pct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : 'n/a';
}

/** Markdown 渲染（人读）；机器消费走 --json。 */
export function renderMarkdown({ tasks, summary }) {
  const lines = [];
  lines.push('# dossier 统计');
  lines.push('');
  lines.push(`任务：${summary.tasks_total}（queue ${summary.tasks_by_box.queue} / done ${summary.tasks_by_box.done} / failed ${summary.tasks_by_box.failed}）；累计花费 $${summary.spent_usd_total}`);
  lines.push('');
  lines.push('## 系统级比率（实验基线对照用）');
  lines.push('');
  lines.push(`- maker r1 max-turns 截断率：${summary.maker.r1_max_turns_cutoff}/${summary.maker.r1_total}（${pct(summary.maker.r1_max_turns_cutoff, summary.maker.r1_total)}）`);
  lines.push(`- maker 续跑使用轮数：${summary.maker.rounds_with_continuation}/${summary.maker.rounds_total}；cold-degraded：${summary.maker.cold_degraded}`);
  lines.push(`- 需要 r2+ 的任务：${summary.maker.tasks_needing_r2plus}/${summary.tasks_total}（${pct(summary.maker.tasks_needing_r2plus, summary.tasks_total)}）`);
  lines.push(`- verifier：${summary.verifier.rounds_total} 轮（fail ${summary.verifier.fails}，协议 invalid 留档 ${summary.verifier.invalid_files}）`);
  lines.push(`- test gate：vacuous 拦截 ${summary.test_gate.vacuous} 次，per-AC 模式 ${summary.test_gate.per_ac_rounds} 轮`);
  lines.push(`- committer：a1 一次通过 ${summary.committer.valid_a1}/${summary.committer.merges_with_proposal}（${pct(summary.committer.valid_a1, summary.committer.merges_with_proposal)}），降级 ${summary.committer.degraded}`);
  const ft = Object.entries(summary.failure_types).map(([k, v]) => `${k}×${v}`).join('，') || '（无）';
  lines.push(`- 失败类型分布：${ft}`);
  lines.push('');
  lines.push('## 逐任务');
  lines.push('');
  lines.push('| id | box | kind | maker 轮 | 截断腿 | verifier | committer | $ | 失败类型 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of tasks) {
    const cuts = t.maker_rounds.filter((r) => r.subtype === 'error_max_turns').length;
    const ver = t.verifier_rounds.map((r) => r.overall?.[0] ?? '?').join('') || '-';
    const com = t.committer_valid_attempt ? `a${t.committer_valid_attempt}` : (t.committer_degraded ? 'degraded' : '-');
    lines.push(`| ${t.id} | ${t.box} | ${t.kind ?? '-'} | ${t.maker_rounds.length} | ${cuts} | ${ver} | ${com} | ${t.spent_usd} | ${t.last_failure_type ?? '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 解析 argv 得到 `{ taskId, taskIdInvalid, asJson, root }`。
 * `--task` 的值先于 root 位置参数被消费，避免 id 被误当作 root（见 spec「当前 root 位置参数的陷阱」）。
 * `--task` 缺值或其后紧跟 `--` 开头 flag 时 `taskIdInvalid = true`，`taskId` 不设。
 */
export function parseArgs(argv) {
  const args = [...argv];
  const taskIdx = args.indexOf('--task');
  let taskId;
  let taskIdInvalid = false;
  if (taskIdx !== -1) {
    const val = args[taskIdx + 1];
    if (val === undefined || val.startsWith('--')) {
      taskIdInvalid = true;
      args.splice(taskIdx, 1);
    } else {
      taskId = val;
      args.splice(taskIdx, 2);
    }
  }
  const asJson = args.includes('--json');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = rootArg
    ? path.resolve(rootArg)
    : (process.env.CONDUCTOR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  return { taskId, taskIdInvalid, asJson, root };
}

/** 任务 id 所在的箱（queue/done/failed），三处均无则 null。 */
export function findTaskBox(root, id) {
  for (const box of ['queue', 'done', 'failed']) {
    if (fs.existsSync(path.join(root, 'state', box, id))) return box;
  }
  return null;
}

/** 复用 collectTask 选中单任务；未找到返回 null。不做独立于 collectStats 的重复聚合。 */
export function selectTask(root, id) {
  const box = findTaskBox(root, id);
  if (!box) return null;
  return collectTask(root, box, id);
}

/** 单任务详情：沿用逐任务表既有字段，逐行「字段: 值」呈现（见 spec AC-002）。 */
export function renderTaskDetail(t) {
  const cuts = t.maker_rounds.filter((r) => r.subtype === 'error_max_turns').length;
  const ver = t.verifier_rounds.map((r) => r.overall?.[0] ?? '?').join('') || '-';
  const com = t.committer_valid_attempt ? `a${t.committer_valid_attempt}` : (t.committer_degraded ? 'degraded' : '-');
  return [
    `id: ${t.id}`,
    `box: ${t.box}`,
    `kind: ${t.kind ?? '-'}`,
    `maker 轮次数: ${t.maker_rounds.length}`,
    `截断腿数: ${cuts}`,
    `verifier: ${ver}`,
    `committer: ${com}`,
    `成本(spent_usd): ${t.spent_usd}`,
    `失败类型: ${t.last_failure_type ?? '-'}`,
  ].join('\n');
}

/** CLI 入口：纯函数，argv → `{ code, stdout, stderr }`，供单测断言退出码/流向。 */
export function runCli(argv) {
  const { taskId, taskIdInvalid, asJson, root } = parseArgs(argv);
  if (taskIdInvalid) {
    return { code: 1, stdout: '', stderr: '--task 需要一个任务 id 参数\n' };
  }
  if (taskId) {
    const task = selectTask(root, taskId);
    if (!task) {
      return { code: 1, stdout: '', stderr: `任务 ${taskId} 在 queue/done/failed 三处均未找到\n` };
    }
    const out = asJson ? `${JSON.stringify(task, null, 2)}\n` : `${renderTaskDetail(task)}\n`;
    return { code: 0, stdout: out, stderr: '' };
  }
  const stats = collectStats(root);
  const out = asJson ? `${JSON.stringify(stats, null, 2)}\n` : `${renderMarkdown(stats)}\n`;
  return { code: 0, stdout: out, stderr: '' };
}

// ---- CLI：node tools/dossier-stats.mjs [--json] [--task <id>] [root]（root 缺省 = 本仓库根 / CONDUCTOR_ROOT） ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
