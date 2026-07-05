// stages/shared.mjs — handler 间共享的副作用助手：green gate、green-gate/repair-context
// 结构化产物、maker spawn（双标记）、prompt 拼装、预算累计。转移决策一律在 decisions.mjs。
// TaskState（ts）形态：{ box, dir, id, task /*task.json*/, runtime /*runtime.json*/ }。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runClaude, runClaudeWithRetry } from '../lib/claude.mjs';
import {
  ensureWorktree, commitAll, diffAgainstBase, diffNameStatusAgainstBase, diffStatAgainstBase,
  mergeBaseWith, addDetachedWorktree, removeWorktree,
} from '../lib/git.mjs';
import { DEFAULT_TEST_GLOBS, classifyTestFileChanges, AC_TESTS_MAPPING_PATH, validateAcTestsMapping } from '../lib/test-gate.mjs';
import { readApprovedSetupProfile, setupProfilePaths } from '../lib/profile.mjs';
import * as state from '../lib/state.mjs';
import { addRunCost, canStartSpawn } from '../lib/scheduler.mjs';
import { SPEC_DOC_CONTRACT, validateSpecDoc } from '../lib/spec-contract.mjs';
import { FEASIBILITY_DOC_CONTRACT, validateFeasibilityDoc } from '../lib/feasibility-contract.mjs';
import {
  overBudget, testGateVerdict, perAcProbeVerdict, perAcGateVerdict,
  parseStrictJson, validateCommitMessage, verifierVerdictSkeleton,
  SPEC_VERIFIER_CONTRACT, VERIFIER_VERDICT_CONTRACT, COMMIT_MESSAGE_CONTRACT,
} from './decisions.mjs';

export function worktreePath(cfg, id) {
  return path.join(cfg.worktreesDir, id);
}

/** plan 的只读工具集（--tools 硬限制 + --allowedTools 免审批，spec §3.3）。 */
export const READONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** setup/spec-verifier 均是只读探索/审查。 */
export const SPEC_TOOLS = READONLY_TOOLS;

/** git 历史类只读命令（形式限定，与 VERIFIER_TOOLS 同一模式）：大仓库里理解惯例
 *  演化与真实约束靠 log/blame；绝不放行写形态 Bash——spec/feasibility agent 的 cwd 是
 *  共享的 targetRepo 本体（非 worktree），且 spec-write-guard 只拦 Write/Edit 类工具。 */
const GIT_HISTORY_TOOLS = ['Bash(git log:*)', 'Bash(git blame:*)'];

/** spec-agent：只读探索（含 git 历史）+ 受限写（直写唯一交付物 specs/<id>.md，
 *  路径白名单由 PreToolUse hook 强制，见 writeSpecAgentSettings）。 */
export const SPEC_AGENT_TOOLS = [...READONLY_TOOLS, ...GIT_HISTORY_TOOLS, 'Write', 'Edit'];

/** feasibility-agent：与 spec-agent 同构——只读探索（含 git 历史）+ 受限写
 *  （直写唯一交付物 <taskdir>/feasibility-study.md，白名单复用 spec-write-guard）。 */
export const FEASIBILITY_AGENT_TOOLS = [...READONLY_TOOLS, ...GIT_HISTORY_TOOLS, 'Write', 'Edit'];

/** verifier 工具集：纯只读 + Bash 仅 git diff / git log 形式，不放行测试/写（契约 §10）。
 *  同一集合既作 --tools（硬限制）又作 --allowedTools（免审批放行）。 */
export const VERIFIER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)'];

/** maker 不做 --tools 硬限制（全工具可见），只补 --allowedTools 免审批放行 Bash
 *  （headless 下无人审批，需要能跑测试命令与本地 git add/commit）；
 *  破坏性 git 操作已由逐轮注入的 maker-git-guard hook（见 writeMakerSettings）拦截。 */
export const MAKER_ALLOWED_TOOLS = ['Bash'];

/** worktree harness 排除（契约 §8）。exclude patterns 与 tracked 检测名分开。 */
export const HARNESS_ARTIFACTS = {
  // 写进 worktree-local .git/info/exclude 的 gitignore pattern。
  patterns: ['/.claude_review_state.json', '/.will-workflow/', '/.agent/'],
  // ls-files 检测「是否已被目标仓库追踪」用的名字（目录名直接传）。
  tracked: ['.claude_review_state.json', '.will-workflow', '.agent'],
};

export { canStartSpawn };

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
  if (res.killed !== undefined) rec.record.killed = res.killed ?? null;
  if (res.costUnknown) rec.record.cost_unknown = true;
  if (res.attempts) rec.record.attempts = res.attempts; // 瞬态重试逐次留痕
  if (!res.ok) rec.record.error = res.error ?? 'unknown';
  state.writeJson(rec.path, rec.record);
  return rec.record;
}

// ---- green gate（契约 §6）：conductor 在 worktree 里亲自跑 testCommand，只认 exit code。

/** 跑 green gate。签名 (testCommand, cwd, opts) → { exitCode, timedOut, stdout, stderr }。 */
export function runGreenGate(testCommand, cwd, { timeoutMs = 1_800_000, killGraceMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(testCommand, {
      shell: true,
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      forceTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      forceTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (err) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode: -1, timedOut: false, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
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
    ...(fields.timedOut ? { timed_out: true } : {}),
    stdout_tail: tailBytesOf(fields.stdout, tail),
    stderr_tail: tailBytesOf(fields.stderr, tail),
    started_at: fields.startedAt,
    finished_at: fields.finishedAt,
  };
  state.writeJson(state.dossierPath(cfg, id, `green-gate-r${round}.json`), record);
  return record;
}

// ---- test gate（基线空转测试探针，docs/features/test-gate/tech-spec.md）----
// green gate 之后的第二道确定性闸：基线代码 + 当前测试（改动的测试文件叠加/删除）。
// suite 模式（v1，映射缺失/非法时的降级）：复跑 testCommand，基线仍 exit 0 ⇒ vacuous。
// per-ac 模式（映射有效）：按 maker 交付的 AC→测试映射逐条定向复跑，方向裁决
// （fail_on_baseline 基线必须红 / pass_on_baseline 基线必须绿），跳过 v1 全量复跑。
// 单侧闸门不变：只有 vacuous 会 block；guard_broken / unmapped / error 一律放行进 VERIFY。

/**
 * 读 maker 交付的 AC→测试映射（约定 2）。返回 { status:'valid'|'missing'|'invalid', errors, entries }。
 * 文件缺失 → missing；JSON 解析失败或校验不过 → invalid（唯一裁判 validateAcTestsMapping）。
 * 任何情况都不抛错、不 block（降级 suite 模式 + 留痕）。
 */
function readAcTestsMapping(wt, expectedAcIds) {
  let rawText;
  try {
    rawText = fs.readFileSync(path.join(wt, AC_TESTS_MAPPING_PATH), 'utf8');
  } catch {
    return { status: 'missing', errors: [], entries: [] };
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (e) {
    return { status: 'invalid', errors: [`JSON 解析失败：${e.message}`], entries: [] };
  }
  const check = validateAcTestsMapping(raw, expectedAcIds);
  if (!check.ok) return { status: 'invalid', errors: check.errors, entries: [] };
  return { status: 'valid', errors: [], entries: check.entries };
}

/**
 * 跑 test gate 探针并写 dossier/test-gate-r<n>.json。cfg.testGateEnabled===false 时返回 null。
 * 探针在独立 detached worktree（merge-base(baseBranch, HEAD)）内进行，绝不触碰任务
 * worktree 与 target 主 checkout；结束（含异常路径）必移除探针 worktree。
 * record 增量字段（schema_version 保持 1）：mode / mapping_status / mapping_errors / per_ac。
 */
export async function runTestGateProbe(ts, cfg, round) {
  if (cfg.testGateEnabled === false) return null;
  const id = ts.id;
  const wt = worktreePath(cfg, id);
  const globs = cfg.testGateTestGlobs ?? DEFAULT_TEST_GLOBS;
  const probeDir = path.join(cfg.worktreesDir, `${id}.test-gate`);
  const tail = cfg.greenGateOutputTailBytes;
  const startedAt = new Date().toISOString();

  // AC 枚举与 verifier 校验同源（extractAcceptanceCriteria）；映射校验唯一裁判在 lib/test-gate.mjs。
  const expectedAcIds = state.extractAcceptanceCriteria(readDossierSpec(ts, cfg)).map((a) => a.ac_id);
  const mapping = readAcTestsMapping(wt, expectedAcIds);
  const mode = mapping.status === 'valid' ? 'per-ac' : 'suite';

  const finish = (fields) => {
    const record = {
      schema_version: 1,
      round,
      command: ts.task.testCommand,
      base_branch: ts.task.baseBranch,
      base_commit: fields.baseCommit ?? null,
      overlay: { globs, copied: fields.copied ?? [], deleted: fields.deleted ?? [] },
      exit_code: fields.exitCode ?? null,
      ...(fields.timedOut ? { timed_out: true } : {}),
      verdict: fields.verdict,
      ...(fields.error ? { error: fields.error } : {}),
      mode,
      mapping_status: mapping.status,
      ...(mapping.status === 'invalid' ? { mapping_errors: mapping.errors } : {}),
      ...(mode === 'per-ac' ? { per_ac: fields.perAc ?? [] } : {}),
      stdout_tail: tailBytesOf(fields.stdout ?? '', tail),
      stderr_tail: tailBytesOf(fields.stderr ?? '', tail),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
    state.writeJson(state.dossierPath(cfg, id, `test-gate-r${round}.json`), record);
    state.appendTimeline(cfg, id, `test gate r${round}: ${record.verdict}${
      fields.error ? `（${fields.error}）`
        : mode === 'per-ac' ? `（per-ac：${(record.per_ac ?? []).map((e) => `${e.ac_id}=${e.verdict}`).join(', ')}）`
          : `（exit ${record.exit_code}${record.timed_out ? ', timed out' : ''}）`
    }`);
    return record;
  };

  // 基线提交取 merge-base（baseBranch 可能已前进），取不到退回分支名。
  const baseCommit = mergeBaseWith(wt, ts.task.baseBranch) ?? ts.task.baseBranch;
  const { copy, remove } = classifyTestFileChanges(diffNameStatusAgainstBase(wt, ts.task.baseBranch), globs);

  removeWorktree(cfg.targetRepo, probeDir); // 清掉上次崩溃可能遗留的探针 worktree（幂等）
  const added = addDetachedWorktree(cfg.targetRepo, probeDir, baseCommit);
  if (!added.ok) {
    // 探针基建失败：不 block（verdict=error），留痕供人工归因（per-AC 模式同样 fail-open）。
    return finish({ baseCommit, copied: copy, deleted: remove, verdict: 'error', error: `git worktree add failed: ${added.error}` });
  }
  try {
    for (const rel of copy) {
      const dst = path.join(probeDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(wt, rel), dst);
    }
    for (const rel of remove) fs.rmSync(path.join(probeDir, rel), { force: true });

    if (mode === 'per-ac') {
      // 逐 AC 定向探测（AC-008）：按冻结 spec 的 AC 枚举顺序执行映射条目；未映射记 unmapped。
      // 单条超时/spawn error 只判该条 error，其余条目照常执行（AC-011）。
      const byId = new Map(mapping.entries.map((e) => [e.ac_id, e]));
      const perAc = [];
      for (const acId of expectedAcIds) {
        const entry = byId.get(acId);
        if (!entry) {
          perAc.push({ ac_id: acId, verdict: 'unmapped' });
          continue;
        }
        const r = await runGreenGate(entry.command, probeDir, { timeoutMs: cfg.greenGateTimeoutMs });
        perAc.push({
          ac_id: acId,
          expect: entry.expect,
          exit_code: r.exitCode,
          timed_out: r.timedOut,
          verdict: perAcProbeVerdict(entry.expect, r.exitCode, r.timedOut),
        });
      }
      // per-AC 模式跳过 v1 全量基线复跑（省一次全量 suite 时间）：exit_code 留 null。
      return finish({ baseCommit, copied: copy, deleted: remove, perAc, verdict: perAcGateVerdict(perAc) });
    }

    const gate = await runGreenGate(ts.task.testCommand, probeDir, { timeoutMs: cfg.greenGateTimeoutMs });
    return finish({
      baseCommit,
      copied: copy,
      deleted: remove,
      exitCode: gate.exitCode,
      timedOut: gate.timedOut,
      stdout: gate.stdout,
      stderr: gate.stderr,
      verdict: testGateVerdict(gate.exitCode),
    });
  } finally {
    removeWorktree(cfg.targetRepo, probeDir);
  }
}

// ---- repair context（契约 §7）：conductor 生成的最小修复输入，绝不照抄 verifier 叙事。

/**
 * 纯函数：按来源构造 repair-context 对象（契约 §7）。
 * source==='verifier'：failed_criteria = verdict.criteria_results 里 status∈{fail,unknown} 的项；
 *                      green_gate=null；overall='fail'。
 * source==='green_gate'：failed_criteria=[]；存 green_gate_ref，不复制 green-gate tail；
 *                        prompt 层再展开摘要；instruction 改为修测试版。
 * source==='test_gate'：存 test_gate_ref（同 green_gate_ref 的去重策略）；per-ac 模式探针
 *                       （probe.mode==='per-ac'）把 vacuous 条目精确填进 failed_criteria，
 *                       suite 模式（降级）保持 v1 形态 failed_criteria=[]；
 *                       instruction 要求补/强化在基线上会失败的测试，禁止削弱换绿。
 */
export function buildRepairContext({ source, round, verdict, probe }) {
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
  if (source === 'test_gate') {
    const failed = probe?.mode === 'per-ac'
      ? (probe.per_ac ?? [])
        .filter((e) => e.verdict === 'vacuous')
        .map((e) => ({
          ac_id: e.ac_id,
          status: 'vacuous',
          reason: '映射的测试命令在基线代码上仍 exit 0，未钉住该 AC 的新行为',
        }))
      : [];
    return {
      schema_version: 1,
      round,
      source: 'test_gate',
      overall: 'fail',
      failed_criteria: failed,
      green_gate: null,
      test_gate: null,
      test_gate_ref: `test-gate-r${round}.json`,
      instruction: 'The current tests still pass on the pre-change baseline: they do not pin the new behavior the spec requires. Add or strengthen tests so at least one fails on the baseline code and passes with your change. Never weaken or delete existing tests to get green.',
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
  if (ts.task.kind !== 'feature') return 'READY';
  return ts.task.feasibility === true ? 'NEEDS_FEASIBILITY' : 'NEEDS_SPEC';
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

/** 注入 agent prompt 的打回意见上限：只保留最近 N 条，防长寿任务 prompt 无限膨胀。 */
const REJECT_NOTES_LIMIT = 10;

/**
 * 读任务目录下的打回意见文件（人类意见，CLI 只追加不清理）。
 * 为防 prompt 无限膨胀，超过 REJECT_NOTES_LIMIT 条 `- ` 列表行时只保留最近 N 条，
 * 并在开头加一行截断说明（完整历史仍在任务目录原文件里）；未超限时原样返回。
 */
function readNotesFile(ts, filename) {
  let raw;
  try { raw = fs.readFileSync(path.join(ts.dir, filename), 'utf8'); } catch { return ''; }
  const notes = raw.split('\n').filter((l) => l.startsWith('- '));
  if (notes.length <= REJECT_NOTES_LIMIT) return raw; // 未超限：原样返回，不动格式
  return [
    `（仅保留最近 ${REJECT_NOTES_LIMIT} 条打回意见，完整历史见任务目录 ${filename}）`,
    ...notes.slice(-REJECT_NOTES_LIMIT),
  ].join('\n');
}

/** spec 打回意见（cmdReject 追加）。 */
export function readRejectNotes(ts) {
  return readNotesFile(ts, 'reject_notes.md');
}

/** feasibility 打回意见（cmdRejectFeasibility 追加）。 */
export function readFeasibilityRejectNotes(ts) {
  return readNotesFile(ts, 'feasibility_reject_notes.md');
}

/** 任务 brief（cmdNew --brief 落盘的需求原文），无则空串。 */
export function readBrief(ts) {
  try { return fs.readFileSync(path.join(ts.dir, 'brief.md'), 'utf8'); } catch { return ''; }
}

/** feasibility-agent 唯一交付文件（人审前草稿）的绝对路径：随任务目录走（对齐 reject_notes）。 */
export function feasibilityDraftPath(ts) {
  return path.join(ts.dir, 'feasibility-study.md');
}

/**
 * 归档 feasibility 草稿 → <taskdir>/feasibility-archive/<label>-<ts>.md（与 archiveSpecDraft
 * 同语义：approve 冻结后 / reject 后 / 契约门废稿，绝不留双份平行文档）。无草稿返回 null。
 */
export function archiveFeasibilityDraft(ts, label = 'archived') {
  const draft = feasibilityDraftPath(ts);
  if (!fs.existsSync(draft)) return null;
  const archived = path.join(ts.dir, 'feasibility-archive', `${label}-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(draft, archived);
  return archived;
}

/** 人审裁决记录（chosen option），冻结于 dossier；无则 null。 */
export function readFeasibilityDecision(ts, cfg) {
  return state.readJsonIf(state.dossierPath(cfg, ts.id, 'feasibility-decision.json'));
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
 * 生成 maker 逐轮 settings 文件（git 护栏），落盘 dossier 留档，返回路径。
 * PreToolUse(Bash)：拦截 push 与不可逆 git 操作（maker 只改代码，commit/merge 归 conductor）。
 * 与 spec-agent settings 同理：显式 --settings 注入，不依赖 target 仓库自带设置。
 */
export function writeMakerSettings(ts, cfg, round) {
  const q = (s) => JSON.stringify(s); // 路径含空格时 shell 安全
  const guard = path.join(cfg.root, 'conductor', 'hooks', 'maker-git-guard.mjs');
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(guard)}` }],
      }],
    },
  };
  const p = state.dossierPath(cfg, ts.id, `maker-r${round}.settings.json`);
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

// ---- feasibility 交付契约（feasibility-doc/v1）：hook 护栏 + conductor 终审共用 validateFeasibilityDoc ----

/**
 * 生成 feasibility-agent 逐轮 settings 文件（hook 护栏），落盘 dossier 留档，返回路径。
 * PreToolUse：写路径白名单复用 spec-write-guard（只放行 <taskdir>/feasibility-study.md）；
 * Stop：契约预检（check-feasibility.mjs，同一份裁判代码），结果写
 * feasibility-check-r<n>.hook.json。显式 --settings 注入，不依赖 target 仓库自带设置。
 */
export function writeFeasibilityAgentSettings(ts, cfg, round) {
  const q = (s) => JSON.stringify(s); // 路径含空格时 shell 安全
  const docPath = feasibilityDraftPath(ts);
  const guard = path.join(cfg.root, 'conductor', 'hooks', 'spec-write-guard.mjs');
  const check = path.join(cfg.root, 'conductor', 'hooks', 'check-feasibility.mjs');
  const hookReport = state.dossierPath(cfg, ts.id, `feasibility-check-r${round}.hook.json`);
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(guard)} --allow ${q(docPath)}` }],
      }],
      Stop: [{
        hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(check)} --doc ${q(docPath)} --report ${q(hookReport)}` }],
      }],
    },
  };
  const p = state.dossierPath(cfg, ts.id, `feasibility-agent-r${round}.settings.json`);
  state.writeJson(p, settings);
  return p;
}

/**
 * conductor 契约门（权威终审）：读 feasibility-agent 直写的草稿，跑 validateFeasibilityDoc，
 * 结果落盘 feasibility-check-r<n>.json（source=conductor）。返回 { ok, errors, options }。
 * Stop hook 只是快反馈层——是否真跑过、跑的结果如何，conductor 一律不采信，这里重新裁。
 */
export function runFeasibilityContractGate(ts, cfg, round) {
  let md = null;
  try { md = fs.readFileSync(feasibilityDraftPath(ts), 'utf8'); } catch { /* 未写入也是契约失败 */ }
  const check = validateFeasibilityDoc(md);
  state.writeJson(state.dossierPath(cfg, ts.id, `feasibility-check-r${round}.json`), {
    schema_version: 1,
    contract: FEASIBILITY_DOC_CONTRACT.id,
    round,
    source: 'conductor',
    ok: check.ok,
    errors: check.errors,
    options: check.options,
  });
  return check;
}

/** 最近一次 feasibility 契约门失败记录（喂给下一轮 feasibility-agent prompt），无则 null。 */
export function readLatestFeasibilityContractErrors(ts, cfg) {
  const dir = state.dossierPath(cfg, ts.id);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let maxN = 0;
  for (const n of names) {
    const m = n.match(/^feasibility-check-r(\d+)\.json$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (maxN === 0) return null;
  const rec = state.readJsonIf(state.dossierPath(cfg, ts.id, `feasibility-check-r${maxN}.json`));
  if (!rec || rec.ok !== false) return null;
  return { round: rec.round, errors: rec.errors };
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

/**
 * feasibility-agent prompt：角色前導 + brief + profile + 打回意见/契约错误 + 交付契约。
 * 与 spec-agent 同模式：直写唯一交付物，hook 快反馈 + conductor 契约门终审。
 */
export function buildFeasibilityPrompt(ts, cfg, round) {
  const setup = readSetupProfileMarkdown(cfg) || '(no approved setup profile found)';
  const brief = readBrief(ts);
  const rejectNotes = readFeasibilityRejectNotes(ts);
  const contractFail = readLatestFeasibilityContractErrors(ts, cfg);
  const docPath = feasibilityDraftPath(ts);
  const parts = [
    readAgentPrompt(cfg, 'feasibility-agent.md'),
    `# 任务 ${ts.id}（feasibility-agent r${round}）`,
    `标题：${ts.task.title ?? '(untitled)'}\nkind：${ts.task.kind}`,
    `# 任务 brief\n\n${brief.trim() || '(无 brief：需求仅有上面的标题；未知项如实写进开放问题段，不要脑补需求)'}`,
    `# Approved setup profile\n\n${setup}`,
  ];
  if (rejectNotes.trim()) {
    parts.push(`# Human reject notes（上一稿被人审打回的原因，本稿必须逐条回应）\n\n${rejectNotes}`);
  }
  if (contractFail) {
    parts.push(
      `# Feasibility 契约门失败反馈（r${contractFail.round}，上一轮交付未过 ${FEASIBILITY_DOC_CONTRACT.id}，必须全部修复）\n\n` +
      `\`\`\`json\n${JSON.stringify(contractFail, null, 2)}\n\`\`\``,
    );
  }
  parts.push(
    `# 交付方式（${FEASIBILITY_DOC_CONTRACT.id}）\n` +
    `用 Write 工具把完整 feasibility 决策 memo 写入唯一交付文件（绝对路径）：${docPath}\n` +
    `必须包含逐字标题的三段：「## ${FEASIBILITY_DOC_CONTRACT.optionSectionTitle}」` +
    '（每个 option 以稳定 ID 开头，形如 `O-A`/`O-B`，表格行首格或列表项皆可，至少 ' +
    `${FEASIBILITY_DOC_CONTRACT.minOptions} 个、编号不得重复）、` +
    `「## ${FEASIBILITY_DOC_CONTRACT.recommendationSectionTitle}」（必须点名已枚举的 option ID）、` +
    `「## ${FEASIBILITY_DOC_CONTRACT.openQuestionsSectionTitle}」（每条带 safe default，确实没有时写「（无）」）。` +
    ' Stop hook 会用与 conductor 终审同一份脚本校验该文件，不合格会被要求当场修复；' +
    'conductor 收货时会再次终审，不采信口头汇报。最终回复只需一句话确认，不要粘贴 memo 全文。',
  );
  parts.push(
    '# 指令\n实地探索 target 仓库后，把完整决策 memo 写入上面的交付文件。' +
    ' 人审会按 option ID 点名选择；你的证据质量与 option 划分直接决定后续 spec 的方向正确性。',
  );
  return parts.filter(Boolean).join('\n\n');
}

/** 渲染人审 option 裁决段（spec-agent / spec-verifier prompt 共用）。 */
function renderFeasibilityDecisionSection(decision) {
  return [
    `chosen_option: ${decision.chosen_option}`,
    decision.notes ? `人审补充约束：${decision.notes}` : null,
    '（完整 option 定义见上面的 Feasibility context；spec 不得偏离已选 option 及其约束。）',
  ].filter(Boolean).join('\n');
}

export function buildSpecAgentPrompt(ts, cfg, round, { mode = 'draft' } = {}) {
  const setup = readSetupProfileMarkdown(cfg) || '(no approved setup profile found)';
  const feasibility = readFeasibilityContext(ts, cfg) || '(no feasibility-study context yet; placeholder for future feasibility-study agent)';
  const brief = readBrief(ts);
  const decision = readFeasibilityDecision(ts, cfg);
  const rejectNotes = readRejectNotes(ts);
  const history = readSpecReviewHistory(ts, cfg);
  const ctx = readLatestSpecRepairContext(ts, cfg);
  const contractFail = readLatestSpecContractErrors(ts, cfg);
  const specPath = specDraftPath(cfg, ts.id);
  const parts = [
    readAgentPrompt(cfg, 'spec-agent.md'),
    `# 任务 ${ts.id}（spec-agent r${round}, mode=${mode}, epoch=${ts.runtime.spec_epoch ?? 1})`,
    `标题：${ts.task.title ?? '(untitled)'}\nkind：${ts.task.kind}`,
    brief.trim() ? `# 任务 brief\n\n${brief}` : '',
    `# Approved setup profile\n\n${setup}`,
    `# Feasibility context\n\n${feasibility}`,
    decision ? `# 已选 option（人审裁决，spec 必须与之一致）\n\n${renderFeasibilityDecisionSection(decision)}` : '',
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
  const brief = readBrief(ts);
  const decision = readFeasibilityDecision(ts, cfg);
  const spec = readSpecDraft(ts, cfg);
  const history = readSpecReviewHistory(ts, cfg);
  return [
    readAgentPrompt(cfg, 'spec-verifier-agent.md'),
    `# 任务 ${ts.id} spec 审查（spec round ${round}）`,
    brief.trim() ? `# 任务 brief\n\n${brief}` : '',
    `# Approved setup profile\n\n${setup}`,
    `# Feasibility context\n\n${feasibility}`,
    decision ? `# 已选 option（人审裁决，spec 偏离即 blocker）\n\n${renderFeasibilityDecisionSection(decision)}` : '',
    history.trim() ? `# Prior spec-verifier reports\n\n${history}` : '',
    `# Spec draft under review\n\n${spec}`,
    `# Verdict contract\n${SPEC_VERIFIER_CONTRACT.id} ` +
    `(schema_version=${SPEC_VERIFIER_CONTRACT.schemaVersion})。`,
    '# JSON 字段\n必须包含 schema_version、round、overall、summary、human_report、spec_agent_feedback、findings。' +
    ' findings 每项含 severity(blocker|major|minor)、audience(human|spec-agent|both)、issue、recommendation。',
    '# 输出纪律（协议要求，机械校验，不可违反）\n' +
    '最终回复的第一个字符必须是 `{`，最后一个字符必须是 `}`；`{` 之前与 `}` 之后不得有任何字符——' +
    '不要输出解释文字、总结、Markdown 代码围栏（包括 ```json）、空行或提示语。' +
    '探索与推理过程留在工具调用轮次里，不要出现在最终回复中。' +
    '不合规输出会被机械拒收，并烧掉一次重试预算。',
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
export function addCost(ts, costUsd, cfg = null) {
  const next = (ts.runtime.spent_usd ?? 0) + (costUsd ?? 0);
  ts.runtime.spent_usd = Math.round(next * 1e6) / 1e6;
  if (cfg) addRunCost(cfg, costUsd);
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

/** prompt 层展开 green_gate_ref / test_gate_ref；存储层保持去重，兼容旧 ctx.green_gate 形态。 */
function repairContextForPrompt(ts, cfg, ctx) {
  if (!ctx) return ctx;
  if (ctx.source === 'green_gate' && ctx.green_gate_ref) {
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
  if (ctx.source === 'test_gate' && ctx.test_gate_ref) {
    const tg = state.readJsonIf(state.dossierPath(cfg, ts.id, ctx.test_gate_ref));
    if (!tg) return ctx;
    return {
      ...ctx,
      test_gate: {
        command: tg.command,
        base_commit: tg.base_commit,
        exit_code: tg.exit_code,
        overlay: tg.overlay,
        // per-AC 模式增量摘要（记录缺这些字段时展开为 undefined，JSON 序列化自然省略）
        mode: tg.mode,
        mapping_status: tg.mapping_status,
        per_ac: tg.per_ac,
        stdout_tail: tg.stdout_tail,
        stderr_tail: tg.stderr_tail,
      },
    };
  }
  return ctx;
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
  // 当轮 test gate 探针记录存在时嵌入机械事实段（去 stdout/stderr tail，防 prompt 膨胀）；
  // 缺失（testGateEnabled=false / 探针未跑）时不加该段。
  const probe = state.readJsonIf(state.dossierPath(cfg, id, `test-gate-r${round}.json`));
  let probeSection = null;
  if (probe) {
    const { stdout_tail: _stdout, stderr_tail: _stderr, ...mechanical } = probe;
    probeSection = '# Test gate 探针结果（conductor 机械事实，审计测试证明力时以此为锚）\n\n' +
      `\`\`\`json\n${JSON.stringify(mechanical, null, 2)}\n\`\`\``;
  }
  return [
    readAgentPrompt(cfg, 'verifier-agent.md'),
    `# 任务 ${id} 验收（第 ${round} 轮）`,
    `# Spec（唯一契约）\n\n${readDossierSpec(ts, cfg)}`,
    `# 验收标准枚举（必须逐条裁决，ac_id 必须与此处完全一致，无缺无多）\n\n${acEnum}`,
    diffSection,
    probeSection,
    `# Verdict contract\n${VERIFIER_VERDICT_CONTRACT.id} ` +
    `(schema_version=${VERIFIER_VERDICT_CONTRACT.schemaVersion})；唯一程序级校验在 ` +
    '`conductor/stages/decisions.mjs::validateVerifierVerdict`（该文件不在你的 worktree 内，' +
    '以下字段骨架由该契约生成，字段名必须逐字一致；`a|b` 表示枚举取值，round 固定为本轮）：\n\n' +
    `\`\`\`json\n${JSON.stringify(verifierVerdictSkeleton(round), null, 2)}\n\`\`\``,
    '# 指令\n只做静态对照：diff 是否满足上面每一条验收标准。可用 Read/Grep/Glob 与 `git diff` / `git log`' +
    ' 进一步只读检查；不许跑测试，不许改文件。\n' +
    '# 输出纪律（协议要求，机械校验，不可违反）\n' +
    '最终回复的第一个字符必须是 `{`，最后一个字符必须是 `}`；`{` 之前与 `}` 之后不得有任何字符——' +
    '不要输出任何说明、总结、Markdown 代码围栏（包括 ```json）、空行或提示语。' +
    '探索、推理、自我核对都必须留在工具调用轮次里，不要出现在最终回复中；最终回复只能是符合 verdict contract 的严格 JSON。' +
    '不合规输出会被机械拒收，并烧掉一次重试预算。\n' +
    `conductor 会把合法 verdict 落盘为 dossier/${id}/verify-r${round}.verdict.json，并且只信该文件。`,
  ].filter(Boolean).join('\n\n');
}

// ---- committer 提案（agent 提案，conductor 裁决——与 verifier verdict 同模式） ----

/** git-conventions skill（commit/分支规范）的仓库内路径：committer prompt 的唯一规范源。 */
export const GIT_CONVENTIONS_SKILL_PATH = path.join('.claude', 'skills', 'git-conventions', 'SKILL.md');

/** committer prompt：角色前導 + 规范全文 + 冻结 spec AC 枚举 + diff --stat + 严格 JSON 交付契约。 */
export function buildCommitterPrompt(ts, cfg, acList, diffStat) {
  let conventions = '';
  try {
    conventions = fs.readFileSync(path.join(cfg.root, GIT_CONVENTIONS_SKILL_PATH), 'utf8');
  } catch { /* 规范文件缺失时靠角色 prompt 底线 */ }
  const acEnum = acList.map((a) => `${a.ac_id}: ${a.text}`).join('\n');
  const { types, subjectMaxLen, bodyLineMaxLen } = COMMIT_MESSAGE_CONTRACT;
  return [
    readAgentPrompt(cfg, 'committer-agent.md'),
    `# 任务 ${ts.id} merge 提交文案（kind=${ts.task.kind}）\n标题：${ts.task.title ?? '(untitled)'}`,
    conventions ? `# Git 提交规范（git-conventions skill 全文）\n\n${conventions}` : '',
    `# 冻结 spec 验收标准\n\n${acEnum}`,
    `# 变更规模（git diff --stat ${ts.task.baseBranch}...HEAD）\n\n\`\`\`\n${diffStat}\`\`\``,
    `# 交付契约（${COMMIT_MESSAGE_CONTRACT.id}）\n` +
    '最终回复必须是且仅是严格 JSON：{"subject": "...", "body": "..."}。' +
    `subject 逐字匹配 \`type(scope)?: 描述\`（type ∈ {${types.join('|')}}，描述 ≤${subjectMaxLen} 字符，禁 WIP）；` +
    `body 非空、每行 ≤${bodyLineMaxLen} 字符。唯一程序级校验在 ` +
    '`conductor/stages/decisions.mjs::validateCommitMessage`，不合格会被要求重出，两次不合格降级机器文案。',
  ].filter(Boolean).join('\n\n');
}

/**
 * committer 提案：spawn 便宜小 agent（可配 models.committer）起草 merge commit 文案，
 * validateCommitMessage 终审；invalid 重试一次（prompt 附错误反馈），再不过返回 null——
 * 调用方降级机器文案（fail-open，与映射非法降级 suite 同一伦理：格式问题绝不 block 交付）。
 * 轮次 commit 不受影响：merge 仍 --no-ff，任务分支的 maker r<n> 颗粒度原样保留。
 */
export async function runCommitterProposal(ts, cfg) {
  const id = ts.id;
  if (budgetExceeded(ts, cfg)) {
    state.appendTimeline(cfg, id, 'committer 提案跳过（budget exceeded），merge 用机器文案');
    return null;
  }
  const wt = worktreePath(cfg, id);
  const acList = state.extractAcceptanceCriteria(readDossierSpec(ts, cfg));
  let prompt = buildCommitterPrompt(ts, cfg, acList, diffStatAgainstBase(wt, ts.task.baseBranch));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const streamFile = state.dossierPath(cfg, id, `committer-r${attempt}.stream.jsonl`);
    const rec = startSpawnRecord(cfg, id, 'committer', attempt, {
      stream_file: path.relative(cfg.root, streamFile),
    });
    const res = await runClaude({
      cwd: wt,
      prompt,
      maxTurns: 4, // 纯文案起草：给只读工具但不需要长会话
      model: cfg.models?.committer ?? null,
      tools: READONLY_TOOLS,
      allowedTools: READONLY_TOOLS,
      streamFile,
      inactivityTimeoutMs: cfg.inactivityTimeoutMs,
      wallClockMs: cfg.spawnWallClockMs,
    });
    finishSpawnRecord(rec, res);
    addCost(ts, res.costUsd);
    state.saveRuntime(ts);
    const check = validateCommitMessage(parseStrictJson(res.result));
    if (check.ok) {
      state.appendTimeline(cfg, id, `committer 提案 a${attempt} 有效：${check.subject}`);
      return `${check.subject}\n\n${check.body}`;
    }
    state.appendTimeline(cfg, id, `committer 提案 a${attempt} invalid：${check.errors.join('; ')}`);
    prompt += `\n\n# 上一轮提案校验失败（必须全部修复后重出）\n${check.errors.map((e) => `- ${e}`).join('\n')}`;
  }
  state.appendTimeline(cfg, id, 'committer 提案两次 invalid，merge 降级机器文案');
  return null;
}

// ---- maker spawn（双标记 + 预算累计） ----

/**
 * spawn 一轮 maker，带双标记（started/done）与预算累计。
 * mode==='resume' 失败时自动降级为冷启动（coldPrompt），阶梯顺延。
 * 不在此 ensureWorktree / 不在此跑 green gate（handler 负责）；wt 由 handler 传入。
 * 返回 claude 调用结果（降级后为冷启动结果）。
 */
export async function runMakerRound(ts, cfg, round, { mode, prompt, coldPrompt, wt }) {
  const id = ts.id;
  const streamFile = state.dossierPath(cfg, id, `maker-r${round}.stream.jsonl`);
  const settings = writeMakerSettings(ts, cfg, round); // git 护栏，逐轮留档
  const rec = startSpawnRecord(cfg, id, 'maker', round, {
    mode,
    stream_file: path.relative(cfg.root, streamFile),
  }); // started 先落盘：此后崩溃可被识别
  state.appendTimeline(cfg, id, `maker r${round} spawn (${mode})`);

  const common = {
    cwd: wt,
    permissionMode: 'acceptEdits',
    allowedTools: MAKER_ALLOWED_TOOLS,
    maxTurns: cfg.maxTurns,
    model: cfg.models?.maker ?? null,
    settings,
    streamFile,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    wallClockMs: cfg.spawnWallClockMs,
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
    res = await runClaudeWithRetry({ ...common, resume: ts.runtime.maker_session_id, prompt }, retryOpts);
    if (!res.ok && !res.retriesExhausted) {
      rec.record.resume_failed = true;
      rec.record.mode = 'cold-degraded';
      state.writeJson(rec.path, rec.record);
      state.appendTimeline(cfg, id, `maker r${round} resume 失败（${res.error ?? 'unknown'}）→ 降级冷启动`);
      res = await runClaudeWithRetry({ ...common, prompt: coldPrompt ?? prompt }, retryOpts);
    }
  } else {
    res = await runClaudeWithRetry({ ...common, prompt }, retryOpts);
  }
  if (res.retriesExhausted) {
    state.appendTimeline(cfg, id, `maker r${round} transient retries exhausted`);
  }
  if (res.costUnknown) {
    state.appendTimeline(cfg, id, `maker r${round} cost unknown; spent_usd uses lower-bound accounting`);
  }

  const marker = finishSpawnRecord(rec, res); // done 标记收尾 + 原始 CLI JSON 留档

  if (res.sessionId) ts.runtime.maker_session_id = res.sessionId;
  addCost(ts, res.costUsd, cfg);
  state.saveRuntime(ts); // 产物（cost/session）先落盘，stage 仍未动
  state.appendTimeline(cfg, id, `maker r${round} done (ok=${res.ok}, cost=$${res.costUsd})`);

  // maker 产出固化为 commit：green gate / verifier diff / merge 都以 commit 为准。
  // exclude 已在 ensureWorktree 时装好，git add -A 不会 stage harness artifact。
  commitAll(wt, `task ${id}: maker r${round} (${marker.mode})`);
  return res;
}
