// stages/shared.mjs — handler 间共享的副作用助手：green gate、green-gate/repair-context
// 结构化产物、maker spawn（双标记）、prompt 拼装、预算累计。转移决策一律在 decisions.mjs。
// TaskState（ts）形态：{ box, dir, id, task /*task.json*/, runtime /*runtime.json*/ }。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClaudeWithRetry } from '../lib/claude.mjs';
import { ensureWorktree, commitAll, diffAgainstBase } from '../lib/git.mjs';
import * as state from '../lib/state.mjs';
import { overBudget } from './decisions.mjs';

export function worktreePath(cfg, id) {
  return path.join(cfg.worktreesDir, id);
}

/** plan 的只读工具集（--tools 硬限制 + --allowedTools 免审批，spec §3.3）。 */
export const READONLY_TOOLS = ['Read', 'Grep', 'Glob'];

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

/** 写 started 标记。返回 { path, record } 供 finishSpawnRecord 收尾。 */
export function startSpawnRecord(cfg, id, role, round, extra = {}) {
  const p = state.dossierPath(cfg, id, `${role}-r${round}.json`);
  const record = { role, round, started: new Date().toISOString(), ...extra };
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
 * source==='green_gate'：failed_criteria=[]；green_gate=紧凑摘要 {command,exit_code,stdout_tail,stderr_tail}
 *                        （tail 受 tailBytes 约束）；instruction 改为修测试版。
 */
export function buildRepairContext({ source, round, verdict, greenGate, tailBytes }) {
  if (source === 'green_gate') {
    const gg = greenGate ?? {};
    return {
      schema_version: 1,
      round,
      source: 'green_gate',
      overall: 'fail',
      failed_criteria: [],
      green_gate: {
        command: gg.command,
        exit_code: gg.exit_code,
        stdout_tail: tailBytesOf(gg.stdout_tail, tailBytes),
        stderr_tail: tailBytesOf(gg.stderr_tail, tailBytes),
      },
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

/** maker 冷启动 prompt；fullDossier=true 时附最新 repair-context（仍不含 verify-r<n>.md 叙事）。 */
export function buildMakerColdPrompt(ts, cfg, round, { fullDossier = false } = {}) {
  const parts = [];
  parts.push(readAgentPrompt(cfg, 'maker-agent.md'));
  parts.push(`# 任务 ${ts.id}（第 ${round} 轮）`);
  parts.push(`# Spec（dossier/${ts.id}/spec.md，唯一契约）\n\n${readDossierSpec(ts, cfg)}`);
  if (fullDossier) {
    // 冷启动修复（miss 阶梯后段）：嵌入最新 repair-context JSON（结构化），绝不嵌叙事。
    const ctx = readLatestRepairContext(ts, cfg);
    if (ctx) {
      parts.push(
        '# 修复上下文（repair-context，唯一修复依据；只动失败/未知 AC，保持已通过项不变）\n\n' +
        `\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``,
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

/**
 * maker repair prompt（FIXING，resume）：spec + 最新 repair-context JSON（直接内嵌）。
 * 绝不含 verify-r<n>.md 叙事。
 */
export function buildMakerRepairPrompt(ts, cfg, round) {
  const ctx = readLatestRepairContext(ts, cfg);
  const parts = [];
  parts.push(readAgentPrompt(cfg, 'maker-agent.md'));
  parts.push(`# 任务 ${ts.id} 修复（第 ${round} 轮）`);
  parts.push(`# Spec（dossier/${ts.id}/spec.md，唯一契约）\n\n${readDossierSpec(ts, cfg)}`);
  if (ctx) {
    parts.push(
      '# 修复上下文（repair-context，唯一修复依据；只动失败/未知 AC 或修绿测试，保持已通过项不变）\n\n' +
      `\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``,
    );
  }
  parts.push(
    `# 指令\n在当前 worktree 做最小修复，确保 \`${ts.task.testCommand}\` 全绿。` +
    ' 只依据上面的 repair-context，不要参考任何人读叙事。conductor 会亲自复跑测试。',
  );
  return parts.filter(Boolean).join('\n\n');
}

/**
 * verifier prompt（契约 §10）：嵌 spec + worktree diff + AC 枚举 + 严格 schema 指令。
 * acList = [{ ac_id, text }]（conductor 枚举 spec 得到）。不喂 maker self-report。
 */
export function buildVerifierPrompt(ts, cfg, round, acList) {
  const id = ts.id;
  const wt = worktreePath(cfg, id);
  const base = ts.task.baseBranch;
  const diff = diffAgainstBase(wt, base);
  const acEnum = acList.map((a) => `${a.ac_id}: ${a.text}`).join('\n');
  return [
    readAgentPrompt(cfg, 'verifier-agent.md'),
    `# 任务 ${id} 验收（第 ${round} 轮）`,
    `# Spec（唯一契约）\n\n${readDossierSpec(ts, cfg)}`,
    `# 验收标准枚举（必须逐条裁决，ac_id 必须与此处完全一致，无缺无多）\n\n${acEnum}`,
    `# Worktree diff（git diff ${base}...HEAD）\n\n\`\`\`diff\n${diff}\n\`\`\``,
    '# 指令\n只做静态对照：diff 是否满足上面每一条验收标准。可用 Read/Grep/Glob 与 `git diff` / `git log`' +
    ' 进一步只读检查；不许跑测试，不许改文件。\n' +
    '你的最终回复必须是且仅是严格 JSON（不带任何其他文字、不要 Markdown 围栏外的内容），形如：\n' +
    '```json\n' +
    JSON.stringify(
      {
        schema_version: 1,
        round,
        overall: 'pass|fail',
        criteria_results: [
          {
            ac_id: 'AC-001',
            status: 'pass|fail|unknown',
            reason: '本条裁决的依据（非空）',
            evidence: [
              { type: 'source', file: 'path/to/file', start_line: 1, end_line: 1, summary: '该处证据摘要' },
            ],
          },
        ],
        non_ac_findings: [],
      },
      null,
      2,
    ) +
    '\n```\n' +
    '规则：每条 AC 有且仅有一个条目；overall=pass 当且仅当每条都是 pass；pass/fail 至少 1 条 evidence，' +
    'unknown 可空 evidence 但 reason 必须非空；evidence 行号从 1 开始且 end_line>=start_line。\n' +
    `conductor 会把它落盘为 dossier/${id}/verify-r${round}.verdict.json，并且只信该文件。`,
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
