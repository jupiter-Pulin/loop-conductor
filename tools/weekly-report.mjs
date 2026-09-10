#!/usr/bin/env node
// tools/weekly-report.mjs — 周窗口运行报告（传感层，fable-loop E21/H27）。
// 只读聚合 state/{queue,done,failed} + dossier/，数字全部机械产出，模型不参与计算。
// 窗口归属双源：events.jsonl 的 ts（准）∪ dossier 轮次 JSON 的 mtime（兜底，legacy 任务无事件流）。
// 用法：node tools/weekly-report.mjs [--json] [--since 7d|ISO] [--until ISO] [--slack] [--dry-run] [--channel C..] [root]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStats } from './dossier-stats.mjs';
import { sendSlackMessage, loadSlackEnv } from './slack-notify.mjs';
import { updateSignatures, renderSignatureSummary } from './signatures.mjs';

// 角色成本文件名：旧五闸的六个角色 + 新状态机的 router / spec / spec-plan / maker / reviewer
// （包 maker 带 `-P-xxx` 段，P2b 才会出现）。`precommit-r<n>.json` 不在此列：它没有 agent、
// cost 恒 0，计入只会在成本盘上多一行 0。
const ROLE_FILE_RE = /^(setup|feasibility-agent|spec-agent|spec-verifier|spec-plan|spec|router|maker|verifier|committer|reviewer)(?:-P-\d{3})?-r(\d+)\.json$/;

function readJsonIf(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function readEventsWithTs(dossierDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dossierDir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const ms = Date.parse(ev.ts);
      if (Number.isFinite(ms)) events.push({ ...ev, _ms: ms });
    } catch { /* 半行截断忽略 */ }
  }
  return events;
}

/** 解析 --since：'7d'/'24h' 相对量或 ISO 时间。 */
export function parseSince(spec, untilMs) {
  if (!spec) return untilMs - 7 * 86400_000;
  const rel = String(spec).match(/^(\d+)([dh])$/);
  if (rel) return untilMs - Number(rel[1]) * (rel[2] === 'd' ? 86400_000 : 3600_000);
  const abs = Date.parse(spec);
  if (Number.isFinite(abs)) return abs;
  throw new Error(`--since 无法解析：${spec}（支持 7d / 24h / ISO 时间）`);
}

/** 单任务的窗口视角：活动时间戳、窗口成本（按角色）、shadow/anchors 收账、停靠时长。 */
function collectTaskWindow(root, t, { sinceMs, untilMs, nowMs }) {
  const dossierDir = path.join(root, 'dossier', t.id);
  const events = readEventsWithTs(dossierDir);

  const activityMs = events.map((e) => e._ms);
  const costByRole = {};
  let windowCost = 0;
  const shadow = { rounds: 0, acs: 0, agreed: 0, disagreements: [], high_risk: 0 };
  const anchors = { rounds: 0, hard: 0, soft: 0 };
  const guard = { rounds: 0, files: 0 };

  let entries = [];
  try {
    entries = fs.readdirSync(dossierDir);
  } catch { /* dossier 缺失容错 */ }

  for (const name of entries.sort()) {
    const p = path.join(dossierDir, name);
    let m;
    if ((m = name.match(ROLE_FILE_RE))) {
      let ms = null;
      try {
        ms = fs.statSync(p).mtimeMs;
      } catch { /* 竞态删除容错 */ }
      if (ms !== null) {
        activityMs.push(ms);
        if (ms >= sinceMs && ms < untilMs) {
          const cost = readJsonIf(p)?.cost_usd ?? 0;
          const role = m[1];
          costByRole[role] = round6((costByRole[role] ?? 0) + cost);
          windowCost = round6(windowCost + cost);
        }
      }
    } else if ((m = name.match(/^verify-r(\d+)\.shadow-compare\.json$/))) {
      let ms = null;
      try {
        ms = fs.statSync(p).mtimeMs;
      } catch { /* 同上 */ }
      if (ms === null || ms < sinceMs || ms >= untilMs) continue;
      const c = readJsonIf(p);
      const ag = c?.agreement;
      if (!ag) continue;
      shadow.rounds++;
      shadow.acs += ag.total_acs ?? 0;
      shadow.agreed += ag.agreed ?? 0;
      shadow.high_risk += ag.high_risk_count ?? 0;
      for (const d of ag.disagreements ?? []) {
        shadow.disagreements.push({ task: t.id, round: Number(m[1]), ac: d.ac_id, main: d.main, shadow: d.shadow, high_risk: d.high_risk === true });
      }
    } else if (/^verify-r\d+\.evidence-anchors\.json$/.test(name)) {
      let ms = null;
      try {
        ms = fs.statSync(p).mtimeMs;
      } catch { /* 同上 */ }
      if (ms === null || ms < sinceMs || ms >= untilMs) continue;
      const a = readJsonIf(p);
      if (!a) continue;
      anchors.rounds++;
      anchors.hard += a.hard?.length ?? a.hard_count ?? 0;
      anchors.soft += a.soft?.length ?? a.soft_count ?? 0;
    } else if (/^verify-r\d+\.test-change-guard\.json$/.test(name)) {
      let ms = null;
      try {
        ms = fs.statSync(p).mtimeMs;
      } catch { /* 同上 */ }
      if (ms === null || ms < sinceMs || ms >= untilMs) continue;
      const g = readJsonIf(p);
      if (!g) continue;
      guard.rounds++;
      guard.files += (g.modified?.length ?? 0) + (g.deleted?.length ?? 0) + (g.renamed?.length ?? 0);
    }
  }

  const inWindow = activityMs.filter((ms) => ms >= sinceMs && ms < untilMs);
  const firstEver = activityMs.length ? Math.min(...activityMs) : null;

  // 停靠时长：最后一次 stage 事件（准）→ 兜底 runtime.json mtime。
  let stageSinceMs = null;
  const stageEvents = events.filter((e) => e.type === 'stage');
  if (stageEvents.length) {
    stageSinceMs = stageEvents[stageEvents.length - 1]._ms;
  } else {
    try {
      stageSinceMs = fs.statSync(path.join(root, 'state', t.box, t.id, 'runtime.json')).mtimeMs;
    } catch { /* 容错 */ }
  }

  const doneInWindow = events.some((e) => e.type === 'stage' && e.stage === 'DONE' && e._ms >= sinceMs && e._ms < untilMs)
    || (t.stage === 'DONE' && inWindow.length > 0);

  // 新状态机的窗口内事件计数（旧任务恒为 0，两类混装互不干扰）。
  const inWin = (e) => e._ms >= sinceMs && e._ms < untilMs;
  const router = {
    decisions: events.filter((e) => e.type === 'router_decision' && inWin(e)).length,
    action_rejected: events.filter((e) => e.type === 'action_rejected' && inWin(e)).length,
    help_gates: events.filter((e) => e.type === 'human_gate_opened' && e.kind === 'help' && inWin(e)).length,
    spec_gates: events.filter((e) => e.type === 'human_gate_opened' && e.kind === 'spec' && inWin(e)).length,
    merge_gates: events.filter((e) => e.type === 'human_gate_opened' && e.kind === 'merge' && inWin(e)).length,
    fuse_tripped: events.filter((e) => e.type === 'fuse_tripped' && inWin(e)).length,
    budget_exhausted: events.filter((e) => e.type === 'budget_exhausted' && inWin(e)).length,
    rate_limited: events.filter((e) => e.type === 'rate_limited' && inWin(e)).length,
    version_gate_blocks: events.filter((e) => (e.type === 'main_moved' || e.type === 'stale_review') && inWin(e)).length,
  };

  return {
    active: inWindow.length > 0,
    new_in_window: firstEver !== null && firstEver >= sinceMs && firstEver < untilMs,
    done_in_window: doneInWindow,
    window_cost_usd: windowCost,
    cost_by_role: costByRole,
    shadow,
    anchors,
    guard,
    await_aging_days: t.stage?.startsWith('AWAIT_') && stageSinceMs !== null
      ? round2((nowMs - stageSinceMs) / 86400_000)
      : null,
    has_events: events.length > 0,
    router,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function pct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : 'n/a';
}

/** 主聚合：窗口内活跃任务的吞吐/成本/质量/开关收账/待人动作。 */
export function collectWeekly(root, { sinceMs, untilMs, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) throw new Error('collectWeekly 需要 sinceMs/untilMs');
  const { tasks } = collectStats(root);

  const rows = tasks.map((t) => ({ ...t, win: collectTaskWindow(root, t, { sinceMs, untilMs, nowMs }) }));
  const active = rows.filter((r) => r.win.active);

  const byKind = {};
  for (const r of active.filter((x) => x.win.done_in_window)) {
    byKind[r.kind ?? 'unknown'] = (byKind[r.kind ?? 'unknown'] ?? 0) + 1;
  }

  const costByRole = {};
  for (const r of active) {
    for (const [role, c] of Object.entries(r.win.cost_by_role)) {
      costByRole[role] = round6((costByRole[role] ?? 0) + c);
    }
  }

  const makerR1 = active.flatMap((r) => r.maker_rounds.filter((x) => x.round === 1));
  const withCommitter = active.filter((r) => r.committer_valid_attempt !== null || r.committer_degraded);
  const failureTypes = {};
  for (const r of active) {
    if (r.last_failure_type) failureTypes[r.last_failure_type] = (failureTypes[r.last_failure_type] ?? 0) + 1;
  }

  const shadow = { rounds: 0, acs: 0, agreed: 0, disagreements: [], high_risk: 0 };
  const anchors = { rounds: 0, hard: 0, soft: 0 };
  const guard = { rounds: 0, files: 0 };
  for (const r of active) {
    shadow.rounds += r.win.shadow.rounds;
    shadow.acs += r.win.shadow.acs;
    shadow.agreed += r.win.shadow.agreed;
    shadow.high_risk += r.win.shadow.high_risk;
    shadow.disagreements.push(...r.win.shadow.disagreements);
    anchors.rounds += r.win.anchors.rounds;
    anchors.hard += r.win.anchors.hard;
    anchors.soft += r.win.anchors.soft;
    guard.rounds += r.win.guard.rounds;
    guard.files += r.win.guard.files;
  }

  // 待人动作：AWAIT_* 停靠任务；若该任务本身带 shadow 分歧 → merge 前必看。
  const attention = [];
  for (const r of rows.filter((x) => x.stage?.startsWith('AWAIT_'))) {
    const disagreements = r.win.shadow.disagreements;
    // 新状态机只有一个 AWAIT_HUMAN；闸别写进 stage 文本，人一眼看出在等哪道闸。
    const gate = r.is_router ? (r.human_gates.find((g) => !g.decision)?.kind ?? null) : null;
    attention.push({
      type: 'await',
      task: r.id,
      stage: gate ? `${r.stage}(${gate})` : r.stage,
      gate_kind: gate,
      aging_days: r.win.await_aging_days,
      spent_usd: r.spent_usd,
      shadow_disagreements: disagreements.map((d) => `${d.ac} ${d.main}→${d.shadow}`),
    });
  }
  attention.sort((a, b) => (b.shadow_disagreements.length - a.shadow_disagreements.length) || (b.aging_days ?? 0) - (a.aging_days ?? 0));

  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    throughput: {
      active: active.length,
      new: active.filter((r) => r.win.new_in_window).length,
      done: active.filter((r) => r.win.done_in_window).length,
      done_by_kind: byKind,
      failed_box: rows.filter((r) => r.box === 'failed').length,
    },
    cost: { window_total_usd: round6(Object.values(costByRole).reduce((s, c) => s + c, 0)), by_role: costByRole },
    quality: {
      maker_r1_total: makerR1.length,
      maker_r1_max_turns_cutoff: makerR1.filter((x) => x.subtype === 'error_max_turns').length,
      maker_rounds_with_continuation: active.flatMap((r) => r.maker_rounds).filter((x) => x.max_turns_continuations > 0).length,
      tasks_needing_r2plus: active.filter((r) => r.maker_rounds.some((x) => x.round >= 2)).length,
      committer_valid_a1: withCommitter.filter((r) => r.committer_valid_attempt === 1).length,
      committer_with_proposal: withCommitter.length,
      committer_degraded: withCommitter.filter((r) => r.committer_degraded).length,
      verifier_invalid_files: active.reduce((s, r) => s + r.verifier_invalid_files, 0),
      test_gate_vacuous: active.reduce((s, r) => s + r.test_gates.filter((g) => g.verdict === 'vacuous').length, 0),
    },
    // 新状态机的窗口口径（旧任务对这些计数恒贡献 0）：router 轮次与被拒动作、三种人闸、
    // 三条收箱线、版本规则拦下的 merge 申请，以及 reviewer / precommit 的成败。
    router: (() => {
      const routerActive = active.filter((r) => r.is_router);
      const sum = (k) => active.reduce((s, r) => s + (r.win.router[k] ?? 0), 0);
      const precommits = routerActive.flatMap((r) => r.precommit_rounds);
      const agents = routerActive.flatMap((r) => r.agent_records);
      return {
        tasks: routerActive.length,
        decisions: sum('decisions'),
        action_rejected: sum('action_rejected'),
        spec_gates: sum('spec_gates'),
        merge_gates: sum('merge_gates'),
        help_gates: sum('help_gates'),
        fuse_tripped: sum('fuse_tripped'),
        budget_exhausted: sum('budget_exhausted'),
        rate_limited: sum('rate_limited'),
        version_gate_blocks: sum('version_gate_blocks'),
        reviewer_rounds: agents.filter((a) => a.role === 'reviewer').length,
        reviewer_fails: agents.filter((a) => a.role === 'reviewer' && a.outcome === 'fail').length,
        precommit_runs: precommits.length,
        precommit_fails: precommits.filter((p) => p.outcome === 'fail').length,
      };
    })(),
    switches: {
      evidence_anchors: anchors,
      shadow,
      test_change_guard: guard,
      tasks_with_events: active.filter((r) => r.win.has_events).length,
    },
    failure_types: failureTypes,
    attention,
    tasks: rows.filter((r) => r.win.active || r.stage?.startsWith('AWAIT_')).map((r) => ({
      id: r.id,
      box: r.box,
      kind: r.kind,
      stage: r.stage,
      active: r.win.active,
      new_in_window: r.win.new_in_window,
      done_in_window: r.win.done_in_window,
      window_cost_usd: r.win.window_cost_usd,
      spent_usd: r.spent_usd,
      await_aging_days: r.win.await_aging_days,
    })),
  };
}

/** 人读 Markdown 全文。 */
export function renderMarkdown(rep) {
  const L = [];
  const day = (iso) => iso.slice(0, 10);
  L.push(`# loop-conductor 周报（${day(rep.window.since)} → ${day(rep.window.until)}）`);
  L.push('');
  L.push('## 吞吐');
  L.push('');
  const kinds = Object.entries(rep.throughput.done_by_kind).map(([k, v]) => `${k} ${v}`).join(' / ') || '无';
  L.push(`- 活跃 ${rep.throughput.active}，新增 ${rep.throughput.new}，完成 ${rep.throughput.done}（${kinds}），failed 箱 ${rep.throughput.failed_box}`);
  L.push('');
  L.push('## 成本（窗口内轮次入账）');
  L.push('');
  const roles = Object.entries(rep.cost.by_role).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} $${v}`).join('，') || '无';
  L.push(`- 合计 $${rep.cost.window_total_usd}（${roles}）`);
  L.push('');
  L.push('## 质量');
  L.push('');
  const q = rep.quality;
  L.push(`- maker r1 截断 ${q.maker_r1_max_turns_cutoff}/${q.maker_r1_total}（${pct(q.maker_r1_max_turns_cutoff, q.maker_r1_total)}），续跑使用 ${q.maker_rounds_with_continuation} 轮，需 r2+ 任务 ${q.tasks_needing_r2plus}`);
  L.push(`- committer a1 一次通过 ${q.committer_valid_a1}/${q.committer_with_proposal}，降级 ${q.committer_degraded}；verifier 协议 invalid ${q.verifier_invalid_files}；vacuous 拦截 ${q.test_gate_vacuous}`);
  L.push('');
  const r = rep.router;
  if (r && r.tasks > 0) {
    L.push('## 新状态机（router，窗口内）');
    L.push('');
    L.push(`- ${r.tasks} 个任务；router 决策 ${r.decisions} 次，被内核拒 ${r.action_rejected} 次`);
    L.push(`- 人闸：spec×${r.spec_gates}，merge×${r.merge_gates}，help×${r.help_gates}；版本规则拦下的 merge 申请 ${r.version_gate_blocks} 次`);
    L.push(`- reviewer ${r.reviewer_rounds} 轮（fail ${r.reviewer_fails}）；precommit ${r.precommit_runs} 次（fail ${r.precommit_fails}）`);
    L.push(`- 收箱：限额 ${r.rate_limited}，保险丝 ${r.fuse_tripped}，预算 ${r.budget_exhausted}`);
    L.push('');
  }
  L.push('## 开关收账（观测开关本窗口产出）');
  L.push('');
  const s = rep.switches;
  L.push(`- evidence anchors：${s.evidence_anchors.rounds} 轮，hard ${s.evidence_anchors.hard} / soft ${s.evidence_anchors.soft}`);
  L.push(`- codex shadow：${s.shadow.rounds} 轮 / ${s.shadow.acs} AC，一致 ${s.shadow.agreed}，分歧 ${s.shadow.disagreements.length}（high-risk ${s.shadow.high_risk}）`);
  for (const d of s.shadow.disagreements) {
    L.push(`  - ${d.task} r${d.round} ${d.ac}：main=${d.main} → shadow=${d.shadow}${d.high_risk ? '（high-risk）' : ''}`);
  }
  L.push(`- 测试改动守卫：命中 ${s.test_change_guard.rounds} 轮 / ${s.test_change_guard.files} 个既有测试文件`);
  L.push(`- 事件流覆盖：${s.tasks_with_events}/${rep.throughput.active} 活跃任务有 events.jsonl`);
  L.push('');
  const ft = Object.entries(rep.failure_types).map(([k, v]) => `${k}×${v}`).join('，');
  if (ft) {
    L.push(`## 失败类型（窗口）`);
    L.push('');
    L.push(`- ${ft}`);
    L.push('');
  }
  L.push('## 待你动作');
  L.push('');
  if (!rep.attention.length) L.push('- 无停靠任务');
  for (const a of rep.attention) {
    const flag = a.shadow_disagreements.length ? ` ⚠️ shadow 分歧 ${a.shadow_disagreements.join('、')} — merge 前必看` : '';
    L.push(`- ${a.task} 停 ${a.stage} ${a.aging_days ?? '?'} 天（$${a.spent_usd}）${flag}`);
  }
  L.push('');
  return L.join('\n');
}

/** Slack 短摘要（一条消息放得下的密度；全文留本地/--json）。 */
export function renderDigest(rep) {
  const day = (iso) => iso.slice(5, 10);
  const q = rep.quality;
  const s = rep.switches;
  const kinds = Object.entries(rep.throughput.done_by_kind).map(([k, v]) => `${k} ${v}`).join('/') || '-';
  const L = [];
  L.push(`📊 loop-conductor 周报 ${day(rep.window.since)} → ${day(rep.window.until)}`);
  L.push(`吞吐: 活跃 ${rep.throughput.active} · 新增 ${rep.throughput.new} · 完成 ${rep.throughput.done}(${kinds}) · failed ${rep.throughput.failed_box}`);
  L.push(`成本: 窗口 $${rep.cost.window_total_usd}`);
  L.push(`质量: r1截断 ${q.maker_r1_max_turns_cutoff}/${q.maker_r1_total} · 续跑 ${q.maker_rounds_with_continuation} · committer a1 ${q.committer_valid_a1}/${q.committer_with_proposal} · invalid ${q.verifier_invalid_files}`);
  L.push(`哨卫: anchors hard ${s.evidence_anchors.hard}/soft ${s.evidence_anchors.soft} · shadow ${s.shadow.acs}AC 分歧 ${s.shadow.disagreements.length}(high-risk ${s.shadow.high_risk})`);
  const acts = rep.attention.slice(0, 5);
  if (acts.length) {
    L.push(`⚠️ 待你动作:`);
    for (const a of acts) {
      const flag = a.shadow_disagreements.length ? ` — shadow 分歧 ${a.shadow_disagreements.join('、')}，merge 前必看` : '';
      L.push(`• ${a.task} 停 ${a.stage} ${a.aging_days ?? '?'}d${flag}`);
    }
  } else {
    L.push(`✅ 无停靠任务`);
  }
  return L.join('\n');
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const rootArg = args.find((a, i) => !a.startsWith('--') && args[i - 1]?.startsWith('--') !== true && !['--since', '--until', '--channel'].includes(args[i - 1]));
  const root = rootArg
    ? path.resolve(rootArg)
    : (process.env.CONDUCTOR_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

  const untilMs = flag('--until') ? Date.parse(flag('--until')) : Date.now();
  const sinceMs = parseSince(flag('--since'), untilMs);
  const rep = collectWeekly(root, { sinceMs, untilMs });

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(rep)}\n`);
  }

  // E26/H31 签名台账（weekly-report 是唯一写入方）：--signatures 才更新；--dry-run 时跳过写。
  // --resolve <sig>=<E#> 关联修复（可多个）。台账默认 reports/signatures.json，--signatures-path 覆盖。
  let sigSummary = null;
  if (args.includes('--signatures') && !args.includes('--dry-run')) {
    const resolves = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--resolve' && args[i + 1]?.includes('=')) {
        const [sig, eid] = args[i + 1].split('=');
        resolves[sig] = eid;
      }
    }
    const ledgerPath = flag('--signatures-path') ?? path.join(root, 'reports', 'signatures.json');
    const res = updateSignatures(root, ledgerPath, { nowMs: untilMs, resolves });
    sigSummary = renderSignatureSummary(res);
    process.stdout.write(`\n## 签名台账（${ledgerPath}）\n\n${sigSummary}\n`);
  }

  if (args.includes('--slack')) {
    let digest = renderDigest(rep);
    if (sigSummary) digest += `\n${sigSummary}`;
    if (args.includes('--dry-run')) {
      process.stdout.write(`\n--- Slack digest（dry-run，未发送）---\n${digest}\n`);
    } else {
      const env = loadSlackEnv(root);
      const res = await sendSlackMessage({
        token: env.token,
        channel: flag('--channel') ?? env.channel,
        text: digest,
      });
      if (res.ok) {
        process.stdout.write(`\nSlack 已发送：channel=${res.channel} ts=${res.ts}\n`);
      } else {
        process.stderr.write(`\nSlack 发送失败：${res.error}\n`);
        process.exitCode = 1;
      }
    }
  }
}
