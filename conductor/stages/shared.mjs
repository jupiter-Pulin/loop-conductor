// stages/shared.mjs — handler 间共享的副作用助手：green gate、green-gate/repair-context
// 结构化产物、maker spawn（双标记）、prompt 拼装、预算累计。转移决策一律在 decisions.mjs。
// TaskState（ts）形态：{ box, dir, id, task /*task.json*/, runtime /*runtime.json*/ }。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClaudeWithRetry } from '../lib/claude.mjs';
import { ensureWorktree, commitAll, diffAgainstBase, diffNameStatusAgainstBase } from '../lib/git.mjs';
import { readApprovedSetupProfile, setupProfilePaths } from '../lib/profile.mjs';
import * as state from '../lib/state.mjs';
import { SPEC_DOC_CONTRACT, validateSpecDoc } from '../lib/spec-contract.mjs';
import { overBudget, SPEC_VERIFIER_CONTRACT, VERIFIER_VERDICT_CONTRACT } from './decisions.mjs';

export function worktreePath(cfg, id) {
  return path.join(cfg.worktreesDir, id);
}

/** plan 的只读工具集（--tools 硬限制 + --allowedTools 免审批，spec §3.3）。 */
export const READONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** setup/spec-verifier 均是只读探索/审查。 */
export const SPEC_TOOLS = READONLY_TOOLS;

/** spec-agent：只读探索 + 受限写（直写唯一交付物 specs/<id>.md，
 *  路径白名单由 PreToolUse hook 强制，见 writeSpecAgentSettings）。 */
export const SPEC_AGENT_TOOLS = [...READONLY_TOOLS, 'Write', 'Edit'];

/** verifier 工具集：纯只读 + Bash 仅 git diff / git log 形式，不放行测试/写（契约 §10）。
 *  同一集合既作 --tools（硬限制）又作 --allowedTools（免审批放行）。 */
export const VERIFIER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)'];

/** worktree harness 排除（契约 §8）。exclude patterns 与 tracked 检测名分开。 */
export const HARNESS_ARTIFACTS = {
  // 写进 worktree-local .git/info/exclude 的 gitignore pattern。
  patterns: ['/.claude_review_state.json', '/.will-workflow/', '/.agent/'],
  // ls-files 检测「是否已被目标仓库追踪」用的名字（目录名直接传）。
  tracked: ['.claude_review_state.json', '.will-workflow', '.agent'],
};

// ---- <role>-r<n>.json 案卷：所有角色（plan/maker/verifier）的 spawn 统一留档（spec §3.2）。
// started 标记先落盘（崩溃可识别），done 收尾时附原始 CLI JSON（session_id、cost 等）。

/** 该角色下一轮编号：扫描 dossier 里已有的 <role>-r<n>.json 取 max+1。 */
export function nextRoleRound(cfg, id, role) {
  let names = [];
  try { names = fs.readdirSync(state.dossierPath(cfg, id)); } catch { /* dossier 尚未创建 */ }
  let max = 0;
  const re = new RegExp(`^${role}-r(\\d+)\\.json$`);
  for (const n of names) {
    const m = n.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 写 started 标记。返回 { path, record } 供 finishSpawnRecord 收尾。
 * 同轮重 spawn（如 verifier/spec-verifier 协议失败后重试）不覆盖丢失上一次留档：
 * 旧记录（剥离其自身 superseded 字段，避免嵌套）追加进新记录的 superseded 数组。
 * 不影响 markerStatus（它只看 started/done/abandoned）。
 */
export function startSpawnRecord(cfg, id, role, round, extra = {}) {
  const p = state.dossierPath(cfg, id, `${role}-r${round}.json`);
  const record = { role, round, started: new Date().toISOString(), ...extra };
  const prev = state.readJsonIf(p);
  if (prev) {
    const { superseded: prevChain, ...prevRest } = prev;
    record.superseded = [...(prevChain ?? []), prevRest];
  }
  state.writeJson(p, record);
  return { path: p, record };
}

/** 写 done 标记 + 原始 CLI JSON（raw）。 */
export function finishSpawnRecord(rec, res) {
  rec.record.done = new Date().toISOString();
  rec.record.ok = res.ok;
  rec.record.session_id = res.sessionId;
  rec.record.cost_usd = res.costUsd;
  rec.record.raw = res.raw ?? null; // 原始 CLI JSON 留档，不经转述
  if (res.attempts) rec.record.attempts = res.attempts; // 瞬态重试逐次留痕
  if (!res.ok) rec.record.error = res.error ?? 'unknown';
  state.writeJson(rec.path, rec.record);
  return rec.record;
}

// ---- green gate（契约 §6）：conductor 在 worktree 里亲自跑 testCommand，只认 exit code。

/** 跑 green gate。签名 (testCommand, cwd) → { exitCode, stdout, stderr }。 */
export function runGreenGate(testCommand, cwd) {
  const r = spawnSync(testCommand, {
    shell: true,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 取字符串末尾 maxBytes 字节（按 UTF-8 字节口径，repair context 的 tail 上限用）。 */
function tailBytesOf(str, maxBytes) {
  const s = String(str ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // 从末尾切 maxBytes 字节，再以 'utf8' 解码（可能截断一个多字节字符，无害）。
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

/**
 * 写 green-gate-r<n>.json（契约 §6）。pass 与 fail 都写。
 * fields = { command, exitCode, stdout, stderr, startedAt, finishedAt }。
 * cwd 写成相对仓库根的 worktrees/<id>（可读性）。返回落盘的 record。
 */
export function writeGreenGateResult(cfg, id, round, fields, tailBytes) {
  const tail = tailBytes ?? cfg.greenGateOutputTailBytes;
  const record = {
    schema_version: 1,
    round,
    command: fields.command,
    cwd: path.join('worktrees', id),
    exit_code: fields.exitCode,
    stdout_tail: tailBytesOf(fields.stdout, tail),
    stderr_tail: tailBytesOf(fields.stderr, tail),
    started_at: fields.startedAt,
    finished_at: fields.finishedAt,
  };
  state.writeJson(state.dossierPath(cfg, id, `green-gate-r${round}.json`), record);
  return record;
}

// ---- repair context（契约 §7）：conductor 生成的最小修复输入，绝不照抄 verifier 叙事。

/**
 * 纯函数：按来源构造 repair-context 对象（契约 §7）。
 * source==='verifier'：failed_criteria = verdict.criteria_results 里 status∈{fail,unknown} 的项；
 *                      green_gate=null；overall='fail'。
 * source==='green_gate'：failed_criteria=[]；存 green_gate_ref，不复制 green-gate tail；
 *                        prompt 层再展开摘要；instruction 改为修测试版。
 */
export function buildRepairContext({ source, round, verdict }) {
  if (source === 'green_gate') {
    return {
      schema_version: 1,
      round,
      source: 'green_gate',
      overall: 'fail',
      failed_criteria: [],
      green_gate: null,
      green_gate_ref: `green-gate-r${round}.json`,
      instruction: 'Fix the failing tests so the test command exits 0. Keep unrelated code intact.',
    };
  }
  // source === 'verifier'
  const failed = (verdict?.criteria_results ?? [])
    .filter((c) => c.status === 'fail' || c.status === 'unknown')
    .map((c) => ({ ac_id: c.ac_id, status: c.status, reason: c.reason, evidence: c.evidence }));
  return {
    schema_version: 1,
    round,
    source: 'verifier',
    overall: 'fail',
    failed_criteria: failed,
    green_gate: null,
    instruction: 'Repair only the failed or unknown acceptance criteria. Keep passing criteria intact.',
  };
}

/** 写 repair-context-r<n>.json，返回落盘的 ctx。 */
export function writeRepairContext(cfg, id, round, ctx) {
  state.writeJson(state.dossierPath(cfg, id, `repair-context-r${round}.json`), ctx);
  return ctx;
}

// ---- 配置/成本/收箱 ----

export function readAgentPrompt(cfg, name) {
  try { return fs.readFileSync(path.join(cfg.agentsDir, name), 'utf8'); } catch { return ''; }
}

export function entryStageAfterSetup(ts) {
  return ts.task.kind === 'feature' ? 'NEEDS_SPEC' : 'READY';
}

export function readSetupProfileMarkdown(cfg) {
  return readApprovedSetupProfile(cfg)?.markdown ?? '';
}

export function readFeasibilityContext(ts, cfg) {
  for (const p of [
    state.dossierPath(cfg, ts.id, 'feasibility-study.md'),
    path.join(ts.dir, 'feasibility-study.md'),
  ]) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* optional */ }
  }
  return '';
}

/** 注入 spec-agent prompt 的打回意见上限：只保留最近 N 条，防长寿任务 prompt 无限膨胀。 */
const REJECT_NOTES_LIMIT = 10;

/**
 * 读任务目录 reject_notes.md（人类打回意见，cmdReject 只追加不清理）。
 * 为防 prompt 无限膨胀，超过 REJECT_NOTES_LIMIT 条 `- ` 列表行时只保留最近 N 条，
 * 并在开头加一行截断说明（完整历史仍在任务目录原文件里）；未超限时原样返回。
 */
export function readRejectNotes(ts) {
  let raw;
  try { raw = fs.readFileSync(path.join(ts.dir, 'reject_notes.md'), 'utf8'); } catch { return ''; }
  const notes = raw.split('\n').filter((l) => l.startsWith('- '));
  if (notes.length <= REJECT_NOTES_LIMIT) return raw; // 未超限：原样返回，不动格式
  return [
    `（仅保留最近 ${REJECT_NOTES_LIMIT} 条打回意见，完整历史见任务目录 reject_notes.md）`,
    ...notes.slice(-REJECT_NOTES_LIMIT),
  ].join('\n');
}

/** spec-agent 唯一交付文件（feature 人审前草稿）的绝对路径。 */
export function specDraftPath(cfg, id) {
  return path.join(cfg.specsDir, `${id}.md`);
}

function readSpecDraft(ts, cfg) {
  try { return fs.readFileSync(specDraftPath(cfg, ts.id), 'utf8'); } catch { return ''; }
}

// ---- spec 交付契约（spec-doc/v1）：hook 护栏 + conductor 终审共用 validateSpecDoc ----

/**
 * 生成 spec-agent 逐轮 settings 文件（hook 护栏），落盘 dossier 留档，返回路径。
 * PreToolUse：写路径白名单（只放行 specs/<id>.md）；Stop：契约预检（同一份裁判代码），
 * 检查结果写 spec-check-r<n>.hook.json（沙箱内证据）。显式 --settings 注入，
 * 不依赖 target 仓库自带的 .claude/settings.json（不可信、不可控）。
 */
export function writeSpecAgentSettings(ts, cfg, round) {
  const q = (s) => JSON.stringify(s); // 路径含空格时 shell 安全
  const specPath = specDraftPath(cfg, ts.id);
  const guard = path.join(cfg.root, 'conductor', 'hooks', 'spec-write-guard.mjs');
  const check = path.join(cfg.root, 'conductor', 'hooks', 'check-spec.mjs');
  const hookReport = state.dossierPath(cfg, ts.id, `spec-check-r${round}.hook.json`);
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(guard)} --allow ${q(specPath)}` }],
      }],
      Stop: [{
        hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(check)} --spec ${q(specPath)} --report ${q(hookReport)}` }],
      }],
    },
  };
  const p = state.dossierPath(cfg, ts.id, `spec-agent-r${round}.settings.json`);
  state.writeJson(p, settings);
  return p;
}

/**
 * conductor 契约门（权威终审）：读 spec-agent 直写的 specs/<id>.md，跑 validateSpecDoc，
 * 结果落盘 spec-check-r<n>.json（source=conductor）。返回 { ok, errors, acs }。
 * Stop hook 只是快反馈层——是否真跑过、跑的结果如何，conductor 一律不采信，这里重新裁。
 */
export function runSpecContractGate(ts, cfg, round) {
  let md = null;
  try { md = fs.readFileSync(specDraftPath(cfg, ts.id), 'utf8'); } catch { /* 未写入也是契约失败 */ }
  const check = validateSpecDoc(md);
  state.writeJson(state.dossierPath(cfg, ts.id, `spec-check-r${round}.json`), {
    schema_version: 1,
    contract: SPEC_DOC_CONTRACT.id,
    round,
    source: 'conductor',
    ok: check.ok,
    errors: check.errors,
    acs: check.acs,
  });
  return check;
}

/** 最近一次 conductor 契约门失败记录（喂给下一轮 spec-agent prompt），无则 null。 */
export function readLatestSpecContractErrors(ts, cfg) {
  const dir = state.dossierPath(cfg, ts.id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let maxN = 0;
  for (const n of names) {
    const m = n.match(/^spec-check-r(\d+)\.json$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (maxN === 0) return null;
  const rec = state.readJsonIf(state.dossierPath(cfg, ts.id, `spec-check-r${maxN}.json`));
  if (!rec || rec.ok !== false) return null;
  return { round: rec.round, errors: rec.errors };
}

function readSpecReviewHistory(ts, cfg, limit = 4) {
  let names = [];
  try { names = fs.readdirSync(state.dossierPath(cfg, ts.id)); } catch { return ''; }
  const reports = names
    .filter((n) => /^spec-verify-r\d+\.md$/.test(n))
    .sort((a, b) => Number(a.match(/r(\d+)/)?.[1] ?? 0) - Number(b.match(/r(\d+)/)?.[1] ?? 0))
    .slice(-limit)
    .map((n) => {
      const body = fs.readFileSync(state.dossierPath(cfg, ts.id, n), 'utf8');
      return `## ${n}\n\n${body}`;
    });
  return reports.join('\n\n');
}

function readLatestSpecRepairContext(ts, cfg) {
  const dir = state.dossierPath(cfg, ts.id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let maxN = 0;
  for (const n of names) {
    const m = n.match(/^spec-repair-context-r(\d+)\.json$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (maxN === 0) return null;
  return state.readJsonIf(state.dossierPath(cfg, ts.id, `spec-repair-context-r${maxN}.json`));
}

export function buildSetupPrompt(ts, cfg) {
  return [
    readAgentPrompt(cfg, 'setup-agent.md'),
    `# Target repo\n${cfg.targetRepo}`,
    `# Task that triggered setup\n${ts.id}: ${ts.task.title ?? '(untitled)'} (${ts.task.kind})`,
    `# Configured test command\n${ts.task.testCommand}`,
    '# 指令\n只读探索当前 target 仓库，输出 repo 级 setup profile Markdown 全文。不要输出 JSON 或包装。',
  ].filter(Boolean).join('\n\n');
}

export function buildSpecAgentPrompt(ts, cfg, round, { mode = 'draft' } = {}) {
  const setup = readSetupProfileMarkdown(cfg) || '(no approved setup profile found)';
  const feasibility = readFeasibilityContext(ts, cfg) || '(no feasibility-study context yet; placeholder for future feasibility-study agent)';
  const rejectNotes = readRejectNotes(ts);
  const history = readSpecReviewHistory(ts, cfg);
  const ctx = readLatestSpecRepairContext(ts, cfg);
  const contractFail = readLatestSpecContractErrors(ts, cfg);
  const specPath = specDraftPath(cfg, ts.id);
  const parts = [
    readAgentPrompt(cfg, 'spec-agent.md'),
    `# 任务 ${ts.id}（spec-agent r${round}, mode=${mode}, epoch=${ts.runtime.spec_epoch ?? 1})`,
    `标题：${ts.task.title ?? '(untitled)'}\nkind：${ts.task.kind}`,
    `# Approved setup profile\n\n${setup}`,
    `# Feasibility context\n\n${feasibility}`,
  ];
  if (rejectNotes.trim()) parts.push(`# Human reject notes\n\n${rejectNotes}`);
  if (ctx) {
    parts.push(`# Spec repair context\n\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``);
  }
  if (contractFail) {
    parts.push(
      `# Spec 契约门失败反馈（r${contractFail.round}，上一轮交付未过 ${SPEC_DOC_CONTRACT.id}，必须全部修复）\n\n` +
      `\`\`\`json\n${JSON.stringify(contractFail, null, 2)}\n\`\`\``,
    );
  }
  if (history.trim()) parts.push(`# Prior spec-verifier reports\n\n${history}`);
  if (mode === 'repair') {
    parts.push(`# Current spec draft\n\n${readSpecDraft(ts, cfg)}`);
  }
  parts.push(
    `# 交付方式（${SPEC_DOC_CONTRACT.id}）\n` +
    `用 Write 工具把完整 spec Markdown 写入唯一交付文件（绝对路径）：${specPath}\n` +
    `spec 必须包含标题逐字为「## ${SPEC_DOC_CONTRACT.acSectionTitle}」的段落（不接受同义标题），` +
    '每条验收标准写成 `- AC-xxx: 可验证描述` 列表项，编号不得重复。' +
    ' Stop hook 会用与 conductor 终审同一份脚本校验该文件，不合格会被要求当场修复；' +
    'conductor 收货时会再次终审，不采信口头汇报。最终回复只需一句话确认，不要粘贴 spec 全文。',
  );
  parts.push(
    '# 指令\n把完整 spec 写入上面的交付文件。' +
    ' 如果这是修复轮，只修 spec-verifier / 契约门指出的缺陷；如果这是冷启动重写，吸收历史报告但不要照抄失败稿。',
  );
  return parts.filter(Boolean).join('\n\n');
}

export function buildSpecVerifierPrompt(ts, cfg, round) {
  const setup = readSetupProfileMarkdown(cfg) || '(no approved setup profile found)';
  const feasibility = readFeasibilityContext(ts, cfg) || '(no feasibility-study context yet; placeholder for future feasibility-study agent)';
  const spec = readSpecDraft(ts, cfg);
  const history = readSpecReviewHistory(ts, cfg);
  return [
    readAgentPrompt(cfg, 'spec-verifier-agent.md'),
    `# 任务 ${ts.id} spec 审查（spec round ${round}）`,
    `# Approved setup profile\n\n${setup}`,
    `# Feasibility context\n\n${feasibility}`,
    history.trim() ? `# Prior spec-verifier reports\n\n${history}` : '',
    `# Spec draft under review\n\n${spec}`,
    `# Verdict contract\n${SPEC_VERIFIER_CONTRACT.id} ` +
    `(schema_version=${SPEC_VERIFIER_CONTRACT.schemaVersion})；最终回复必须是严格 JSON，不要 Markdown 围栏。`,
    '# JSON 字段\n必须包含 schema_version、round、overall、summary、human_report、spec_agent_feedback、findings。' +
    ' findings 每项含 severity(blocker|major|minor)、audience(human|spec-agent|both)、issue、recommendation。',
  ].filter(Boolean).join('\n\n');
}

export function writeSpecRepairContext(cfg, id, round, verdict) {
  const ctx = {
    schema_version: 1,
    round,
    source: 'spec_verifier',
    overall: 'fail',
    human_report: verdict.human_report,
    spec_agent_feedback: verdict.spec_agent_feedback,
    findings: verdict.findings,
    instruction: 'Repair the spec draft only. Preserve useful accepted content and address every blocker/major finding.',
  };
  state.writeJson(state.dossierPath(cfg, id, `spec-repair-context-r${round}.json`), ctx);
  return ctx;
}

export function renderSpecVerifyReport(verdict) {
  const findings = (verdict.findings ?? [])
    .map((f, i) => `${i + 1}. [${f.severity}/${f.audience}] ${f.issue}\n   Recommendation: ${f.recommendation}`)
    .join('\n');
  return [
    `# Spec Verify Report r${verdict.round}`,
    '',
    `Overall: ${verdict.overall}`,
    '',
    '## Summary',
    '',
    verdict.summary,
    '',
    '## Human Report',
    '',
    verdict.human_report,
    '',
    '## Spec Agent Feedback',
    '',
    verdict.spec_agent_feedback,
    '',
    '## Findings',
    '',
    findings || '(none)',
    '',
  ].join('\n');
}

/**
 * 渲染 verifier verdict 的人读报告（verify-r<n>.md）。round 用 conductor 自己推导的
 * 轮次（makerRound），不信 verdict.round。逐条 AC（含 pass）都渲染 status/reason 与
 * evidence，便于人工核对；报告纯供人读，绝不回喂任何 agent prompt。
 */
export function renderVerifyReport(verdict, round) {
  const criteria = (verdict.criteria_results ?? [])
    .map((c) => {
      const lines = [
        `### ${c.ac_id}: ${c.status}`,
        '',
        `Reason: ${c.reason}`,
      ];
      const evidence = (c.evidence ?? [])
        .map((ev) => `- ${ev.file}:${ev.start_line}-${ev.end_line} (${ev.type}) ${ev.summary}`)
        .join('\n');
      if (evidence) lines.push('', 'Evidence:', '', evidence);
      return lines.join('\n');
    })
    .join('\n\n');
  const findings = (verdict.non_ac_findings ?? [])
    .map((f, i) => `${i + 1}. ${typeof f === 'string' ? f : JSON.stringify(f)}`)
    .join('\n');
  return [
    `# Verify Report r${round}`,
    '',
    `Overall: ${verdict.overall}`,
    '',
    '## Criteria',
    '',
    criteria || '(none)',
    '',
    '## Non-AC Findings',
    '',
    findings || '(none)',
    '',
  ].join('\n');
}

export function archiveSpecDraft(cfg, id, label = 'archived') {
  const draft = path.join(cfg.specsDir, `${id}.md`);
  if (!fs.existsSync(draft)) return null;
  const archived = path.join(cfg.specsDir, 'archive', `${id}-${label}-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(draft, archived);
  return archived;
}

export function setupDraftPath(cfg) {
  return setupProfilePaths(cfg).draft;
}

/** 成本累计写进 ts.runtime.spent_usd（不落盘，交给 saveRuntime/transitionState）。 */
export function addCost(ts, costUsd) {
  const next = (ts.runtime.spent_usd ?? 0) + (costUsd ?? 0);
  ts.runtime.spent_usd = Math.round(next * 1e6) / 1e6;
}

export function budgetExceeded(ts, cfg) {
  return overBudget(ts.runtime.spent_usd ?? 0, cfg.budgetUsd);
}

/**
 * 收箱：transitionState→FAILED_BOX，设 last_failure_type，console.error。
 * extra 合并进 runtime（阶梯耗尽时要把递增后的 maker_miss_count 一并落盘，否则 timeline 与
 * runtime 不一致：timeline 记 miss 3，runtime 却停在 2）。
 */
export function failToBox(ts, cfg, reason, failureType = null, extra = {}) {
  console.error(`[${ts.id}] → FAILED_BOX: ${reason}`);
  state.transitionState(ts, cfg, 'FAILED_BOX', reason, { last_failure_type: failureType, ...extra });
  return { changed: true };
}

/**
 * 任务的 dossier spec.md（verifier 与 maker 的契约面）。缺失时冻结生成（幂等）。
 * bugfix 从 ts.dir/spec.md 取（无则兜底）；feature 从已冻结 dossier 或 specs/<id>.md。
 */
export function ensureDossierSpec(ts, cfg) {
  const specPath = state.dossierPath(cfg, ts.id, 'spec.md');
  if (fs.existsSync(specPath)) return specPath;
  let content = null;
  if (ts.task.kind === 'feature') {
    const draft = path.join(cfg.specsDir, `${ts.id}.md`);
    if (fs.existsSync(draft)) content = fs.readFileSync(draft, 'utf8');
  } else {
    // bugfix：人类编辑的 state/queue/<id>/spec.md 草稿就是 spec 来源
    const draft = path.join(ts.dir, 'spec.md');
    if (fs.existsSync(draft)) content = fs.readFileSync(draft, 'utf8');
  }
  if (content === null) {
    // 兜底：既无 feature 草稿也无 bugfix 草稿时给最小 spec（仍含 ## 验收标准）。
    content = `# ${ts.task.title ?? ts.id}\n\n## 验收标准\n\n- 满足任务要求且 testCommand 全绿\n`;
  }
  state.writeFileEnsured(specPath, content);
  state.appendTimeline(cfg, ts.id, 'spec frozen → dossier/spec.md');
  return specPath;
}

function readDossierSpec(ts, cfg) {
  const p = ensureDossierSpec(ts, cfg);
  return fs.readFileSync(p, 'utf8');
}

// ---- prompt builders（契约 §7 §10） ----

/** maker 冷启动 prompt；fullDossier=true 时附最新 repair-context（仍不含 verify-r<n>.md 人读报告）。 */
export function buildMakerColdPrompt(ts, cfg, round, { fullDossier = false } = {}) {
  const parts = [];
  parts.push(readAgentPrompt(cfg, 'maker-agent.md'));
  parts.push(`# 任务 ${ts.id}（第 ${round} 轮）`);
  parts.push(`# Spec（dossier/${ts.id}/spec.md，唯一契约）\n\n${readDossierSpec(ts, cfg)}`);
  if (fullDossier) {
    // 冷启动修复（miss 阶梯后段）：嵌入最新 repair-context JSON（结构化），绝不嵌叙事。
    const ctx = readLatestRepairContext(ts, cfg);
    if (ctx) {
      const promptCtx = repairContextForPrompt(ts, cfg, ctx);
      parts.push(
        '# 修复上下文（repair-context，唯一修复依据；只动失败/未知 AC，保持已通过项不变）\n\n' +
        `\`\`\`json\n${JSON.stringify(promptCtx, null, 2)}\n\`\`\``,
      );
    }
  }
  parts.push(
    `# 指令\n当前目录是任务 worktree。按 Spec 实现/修复，确保测试命令 \`${ts.task.testCommand}\` 全绿。` +
    ' conductor 会亲自复跑测试（green gate），不采信叙述。',
  );
  return parts.filter(Boolean).join('\n\n');
}

/** 读「最新」repair-context（编号最大的 repair-context-r<n>.json），无则 null。 */
function readLatestRepairContext(ts, cfg) {
  const dir = state.dossierPath(cfg, ts.id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let maxN = 0;
  for (const n of names) {
    const m = n.match(/^repair-context-r(\d+)\.json$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (maxN === 0) return null;
  return state.readJsonIf(state.dossierPath(cfg, ts.id, `repair-context-r${maxN}.json`));
}

/** prompt 层展开 green_gate_ref；存储层保持去重，兼容旧 ctx.green_gate 形态。 */
function repairContextForPrompt(ts, cfg, ctx) {
  if (!ctx || ctx.source !== 'green_gate' || !ctx.green_gate_ref) return ctx;
  const gg = state.readJsonIf(state.dossierPath(cfg, ts.id, ctx.green_gate_ref));
  if (!gg) return ctx;
  return {
    ...ctx,
    green_gate: {
      command: gg.command,
      exit_code: gg.exit_code,
      stdout_tail: gg.stdout_tail,
      stderr_tail: gg.stderr_tail,
    },
  };
}

/**
 * maker repair prompt（FIXING，resume）：spec + 最新 repair-context JSON（直接内嵌）。
 * 绝不含 verify-r<n>.md 人读报告。
 */
export function buildMakerRepairPrompt(ts, cfg, round) {
  const ctx = readLatestRepairContext(ts, cfg);
  const parts = [];
  parts.push(readAgentPrompt(cfg, 'maker-agent.md'));
  parts.push(`# 任务 ${ts.id} 修复（第 ${round} 轮）`);
  parts.push(`# Spec（dossier/${ts.id}/spec.md，唯一契约）\n\n${readDossierSpec(ts, cfg)}`);
  if (ctx) {
    const promptCtx = repairContextForPrompt(ts, cfg, ctx);
    parts.push(
      '# 修复上下文（repair-context，唯一修复依据；只动失败/未知 AC 或修绿测试，保持已通过项不变）\n\n' +
      `\`\`\`json\n${JSON.stringify(promptCtx, null, 2)}\n\`\`\``,
    );
  }
  parts.push(
    `# 指令\n在当前 worktree 做最小修复，确保 \`${ts.task.testCommand}\` 全绿。` +
    ' 只依据上面的 repair-context，不要参考任何人读叙事。conductor 会亲自复跑测试。',
  );
  return parts.filter(Boolean).join('\n\n');
}

/**
 * verifier prompt（契约 §10）：嵌 spec + worktree diff + AC 枚举 + contract id。
 * acList = [{ ac_id, text }]（conductor 枚举 spec 得到）。不喂 maker self-report。
 * diff 超 cfg.verifierDiffMaxBytes 时降级：只嵌 name-status 变更清单 + 按文件自查指令
 * （verifier 工具集本就有 Bash(git diff:*)），防大 diff 撑爆 verifier 上下文。
 */
export function buildVerifierPrompt(ts, cfg, round, acList) {
  const id = ts.id;
  const wt = worktreePath(cfg, id);
  const base = ts.task.baseBranch;
  const diff = diffAgainstBase(wt, base);
  const acEnum = acList.map((a) => `${a.ac_id}: ${a.text}`).join('\n');
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  const diffSection = diffBytes <= cfg.verifierDiffMaxBytes
    ? `# Worktree diff（git diff ${base}...HEAD）\n\n\`\`\`diff\n${diff}\n\`\`\``
    : `# Worktree diff（未内嵌：diff 共 ${diffBytes} 字节，超过上限 ${cfg.verifierDiffMaxBytes} 字节，降级为变更文件清单）\n\n` +
      `变更文件清单（git diff --name-status ${base}...HEAD）：\n\n\`\`\`\n${diffNameStatusAgainstBase(wt, base)}\`\`\`\n\n` +
      `请对清单中每个文件用 \`git diff ${base}...HEAD -- <file>\` 只读自查其改动，再逐条裁决验收标准。`;
  return [
    readAgentPrompt(cfg, 'verifier-agent.md'),
    `# 任务 ${id} 验收（第 ${round} 轮）`,
    `# Spec（唯一契约）\n\n${readDossierSpec(ts, cfg)}`,
    `# 验收标准枚举（必须逐条裁决，ac_id 必须与此处完全一致，无缺无多）\n\n${acEnum}`,
    diffSection,
    `# Verdict contract\n${VERIFIER_VERDICT_CONTRACT.id} ` +
    `(schema_version=${VERIFIER_VERDICT_CONTRACT.schemaVersion})；唯一程序级校验在 ` +
    '`conductor/stages/decisions.mjs::validateVerifierVerdict`，本 prompt 不复制 schema。',
    '# 指令\n只做静态对照：diff 是否满足上面每一条验收标准。可用 Read/Grep/Glob 与 `git diff` / `git log`' +
    ' 进一步只读检查；不许跑测试，不许改文件。\n' +
    '最终回复必须是且仅是符合 verdict contract 的严格 JSON；不要输出解释文字、不要 Markdown 围栏。\n' +
    `conductor 会把合法 verdict 落盘为 dossier/${id}/verify-r${round}.verdict.json，并且只信该文件。`,
  ].filter(Boolean).join('\n\n');
}

// ---- maker spawn（双标记 + 预算累计） ----

/**
 * spawn 一轮 maker，带双标记（started/done）与预算累计。
 * mode==='resume' 失败时自动降级为冷启动（coldPrompt），阶梯顺延。
 * 不在此 ensureWorktree / 不在此跑 green gate（handler 负责）；wt 由 handler 传入。
 * 返回 claude 调用结果（降级后为冷启动结果）。
 */
export function runMakerRound(ts, cfg, round, { mode, prompt, coldPrompt, wt }) {
  const id = ts.id;
  const rec = startSpawnRecord(cfg, id, 'maker', round, { mode }); // started 先落盘：此后崩溃可被识别
  state.appendTimeline(cfg, id, `maker r${round} spawn (${mode})`);

  const common = {
    cwd: wt,
    permissionMode: 'acceptEdits',
    maxTurns: cfg.maxTurns,
    model: cfg.models?.maker ?? null,
  };
  // 瞬态重试参数来自 config；每次重试在 timeline 留痕（attempt 序号 + status）
  const retryOpts = {
    retries: cfg.spawnRetries,
    backoffMs: cfg.spawnBackoffMs,
    onRetry: ({ attempt, status }) =>
      state.appendTimeline(cfg, id, `maker r${round} transient retry attempt ${attempt} (status=${status ?? 'spawn-error'})`),
  };
  let res;
  if (mode === 'resume') {
    res = runClaudeWithRetry({ ...common, resume: ts.runtime.maker_session_id, prompt }, retryOpts);
    if (!res.ok && !res.retriesExhausted) {
      rec.record.resume_failed = true;
      rec.record.mode = 'cold-degraded';
      state.writeJson(rec.path, rec.record);
      state.appendTimeline(cfg, id, `maker r${round} resume 失败（${res.error ?? 'unknown'}）→ 降级冷启动`);
      res = runClaudeWithRetry({ ...common, prompt: coldPrompt ?? prompt }, retryOpts);
    }
  } else {
    res = runClaudeWithRetry({ ...common, prompt }, retryOpts);
  }
  if (res.retriesExhausted) {
    state.appendTimeline(cfg, id, `maker r${round} transient retries exhausted`);
  }

  const marker = finishSpawnRecord(rec, res); // done 标记收尾 + 原始 CLI JSON 留档

  if (res.sessionId) ts.runtime.maker_session_id = res.sessionId;
  addCost(ts, res.costUsd);
  state.saveRuntime(ts); // 产物（cost/session）先落盘，stage 仍未动
  state.appendTimeline(cfg, id, `maker r${round} done (ok=${res.ok}, cost=$${res.costUsd})`);

  // maker 产出固化为 commit：green gate / verifier diff / merge 都以 commit 为准。
  // exclude 已在 ensureWorktree 时装好，git add -A 不会 stage harness artifact。
  commitAll(wt, `task ${id}: maker r${round} (${marker.mode})`);
  return res;
}
