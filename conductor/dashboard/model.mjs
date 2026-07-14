// dashboard/model.mjs — 纯逻辑层：泳道映射、三箱聚合、任务详情组装、CLI 结果转换。
// 只读磁盘（复用 lib/state.mjs、lib/profile.mjs、lib/feasibility-contract.mjs、lib/git.mjs
// 既有解析函数），不持久化、不缓存、不自写 option/markdown 解析。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { setupProfilePaths } from '../lib/profile.mjs';
import { validateFeasibilityDoc } from '../lib/feasibility-contract.mjs';
import { git, branchExists } from '../lib/git.mjs';
import { buildRoundsView } from './rounds.mjs';

// ---- 泳道映射（wireframes.md 屏 1 映射表，逐项一致） ----

export const LANE_ORDER = ['setup', 'feasibility', 'spec', 'maker', 'verify', 'merge'];

const STAGE_LANE = {
  NEEDS_TARGET_SETUP: 'setup',
  AWAIT_SETUP_APPROVAL: 'setup',
  NEEDS_FEASIBILITY: 'feasibility',
  AWAIT_FEASIBILITY_APPROVAL: 'feasibility',
  NEEDS_SPEC: 'spec',
  SPEC_VERIFY: 'spec',
  SPEC_FIXING: 'spec',
  AWAIT_SPEC_APPROVAL: 'spec',
  READY: 'maker',
  FIXING: 'maker',
  VERIFY: 'verify',
  AWAIT_HUMAN_MERGE: 'merge',
};

/** stage → 泳道（纯函数）。DONE/FAILED_BOX/未知 stage 返回 null（不进泳道）。 */
export function laneForStage(stage) {
  return STAGE_LANE[stage] ?? null;
}

/** 人审闸门 stage（needsHuman 判据）。 */
export const HUMAN_STAGES = [
  'AWAIT_SETUP_APPROVAL', 'AWAIT_FEASIBILITY_APPROVAL', 'AWAIT_SPEC_APPROVAL', 'AWAIT_HUMAN_MERGE',
];

// ---- 任务 id 校验（一切含 <id> 的路由的第一道闸门） ----

export const TASK_ID_RE = /^task-\d{8}-\d{3}$/;

export function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

// ---- board 聚合（AC-005/006/007/008） ----

/** box+stage → { needsHuman, working } 判定（唯一口径，board 与详情抽屉共用）。 */
function computeWorkingFlags(box, stage) {
  const lane = laneForStage(stage);
  return {
    needsHuman: box === 'queue' && HUMAN_STAGES.includes(stage),
    working: box === 'queue' && lane != null && !HUMAN_STAGES.includes(stage),
  };
}

function taskEntry(ts) {
  const stage = ts.runtime.stage;
  const lane = laneForStage(stage);
  return {
    id: ts.task.id ?? ts.id,
    kind: ts.task.kind ?? '?',
    title: ts.task.title ?? '',
    stage,
    box: ts.box,
    lane,
    ...computeWorkingFlags(ts.box, stage),
    spentUsd: ts.runtime.spent_usd ?? 0,
  };
}

export function buildBoard(cfg) {
  const broken = [];
  const laneBuckets = new Map(LANE_ORDER.map((lane) => [lane, []]));

  for (const ts of state.listTaskStates(cfg.queueDir, 'queue')) {
    if (ts.error) { broken.push({ box: ts.box, id: ts.id, error: ts.error }); continue; }
    const entry = taskEntry(ts);
    if (entry.lane == null) broken.push(entry);
    else laneBuckets.get(entry.lane).push(entry);
  }

  const done = [];
  for (const ts of state.listTaskStates(cfg.doneDir, 'done')) {
    if (ts.error) { broken.push({ box: ts.box, id: ts.id, error: ts.error }); continue; }
    done.push(taskEntry(ts));
  }

  const failed = [];
  for (const ts of state.listTaskStates(cfg.failedDir, 'failed')) {
    if (ts.error) { broken.push({ box: ts.box, id: ts.id, error: ts.error }); continue; }
    failed.push(taskEntry(ts));
  }

  return {
    lanes: LANE_ORDER.map((lane) => ({ lane, tasks: laneBuckets.get(lane) })),
    done,
    failed,
    broken,
    // 新建任务面板「高级参数」只读展示用（AC-023），非契约表格枚举字段，附加不冲突。
    config: { targetRepo: cfg.targetRepo, baseBranch: cfg.baseBranch ?? null, testCommand: cfg.testCommand ?? null },
  };
}

// ---- 任务详情（AC-009/010/011/012） ----

function findTaskAnyBox(cfg, id) {
  for (const [box, dir] of [['queue', cfg.queueDir], ['failed', cfg.failedDir], ['done', cfg.doneDir]]) {
    const taskDirPath = path.join(dir, id);
    if (fs.existsSync(path.join(taskDirPath, 'task.json'))) {
      try {
        return state.readTaskState(taskDirPath, box);
      } catch (e) {
        return { box, dir: taskDirPath, id, error: e.message };
      }
    }
  }
  return null;
}

function readTimelineText(cfg, id) {
  try { return fs.readFileSync(state.dossierPath(cfg, id, 'timeline.md'), 'utf8'); } catch { return ''; }
}

// ---- timeline 原文 → 结构化条目（AC-001） ----

const TIMELINE_LINE_RE = /^-\s+(\S+)\s+([\s\S]*)$/;

/** timeline.md 原文（appendTimeline 的 `- <ISO时间戳> <正文>` 格式）→ [{ ts, text }]。
 *  不符合格式的行保留原文、ts 置 null；不丢弃、不抛错。 */
export function parseTimeline(text) {
  if (!text) return [];
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const m = line.match(TIMELINE_LINE_RE);
      if (m && !Number.isNaN(Date.parse(m[1]))) return { ts: m[1], text: m[2] };
      return { ts: null, text: line };
    });
}

function buildSetupReview(cfg) {
  const draft = setupProfilePaths(cfg).draft;
  try {
    return { kind: 'setup', markdown: fs.readFileSync(draft, 'utf8') };
  } catch {
    return { kind: 'setup', missing: true, message: `setup profile 草稿缺失：${draft}` };
  }
}

function buildFeasibilityReview(ts) {
  const draft = path.join(ts.dir, 'feasibility-study.md');
  let md = null;
  try { md = fs.readFileSync(draft, 'utf8'); } catch { /* 缺失也是一种状态 */ }
  if (md == null) {
    return { kind: 'feasibility', missing: true, message: `feasibility 草稿缺失：${draft}`, options: [] };
  }
  // 不自写 O-X 解析：options 原样透传 validateFeasibilityDoc 的枚举结果。
  return { kind: 'feasibility', markdown: md, options: validateFeasibilityDoc(md).options };
}

// ---- verify / spec-verify 最新轮 verdict 面板（AC-005/006/007/008/009）：
// 「最新轮」= dossier 内实际存在的 verify-r<N>.verdict.json / spec-verify-r<N>.verdict.json 里 N 最大者，
// 不信 runtime.current_round（done/failed/probe 任务可能无该字段或与磁盘不符）。

function latestRoundFile(dir, re) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let maxN = 0;
  for (const n of names) {
    const m = n.match(re);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return maxN > 0 ? maxN : null;
}

const VERIFY_VERDICT_RE = /^verify-r(\d+)\.verdict\.json$/;
const SPEC_VERIFY_VERDICT_RE = /^spec-verify-r(\d+)\.verdict\.json$/;

/** 最新轮 verify-r<N>.verdict.json → 逐 AC 裁决面板；缺失/损坏均不抛错，降级为 { missing } / { corrupt }。 */
function buildVerdictPanel(cfg, id) {
  const dir = state.dossierPath(cfg, id);
  const round = latestRoundFile(dir, VERIFY_VERDICT_RE);
  if (round == null) return { missing: true };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, `verify-r${round}.verdict.json`), 'utf8'));
  } catch {
    return { corrupt: true };
  }
  if (
    !parsed || typeof parsed !== 'object'
    || (parsed.overall !== 'pass' && parsed.overall !== 'fail')
    || !Array.isArray(parsed.criteria_results)
  ) {
    return { corrupt: true };
  }
  const criteria = parsed.criteria_results.map((c) => ({
    ac_id: c?.ac_id ?? null,
    status: c?.status ?? null,
    reason: c?.reason ?? null,
    evidence: Array.isArray(c?.evidence)
      ? c.evidence.map((e) => ({
        file: e?.file ?? null, start_line: e?.start_line ?? null, end_line: e?.end_line ?? null,
        type: e?.type ?? null, summary: e?.summary ?? null,
      }))
      : [],
  }));
  let reportMarkdown = '';
  try { reportMarkdown = fs.readFileSync(path.join(dir, `verify-r${round}.md`), 'utf8'); } catch { /* 人读报告缺失不抛错 */ }
  return { round, overall: parsed.overall, criteria, reportMarkdown };
}

/** 最新轮 spec-verify-r<N>.verdict.json → spec 机器审面板；同上降级策略。 */
function buildSpecVerifyPanel(cfg, id) {
  const dir = state.dossierPath(cfg, id);
  const round = latestRoundFile(dir, SPEC_VERIFY_VERDICT_RE);
  if (round == null) return { missing: true };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, `spec-verify-r${round}.verdict.json`), 'utf8'));
  } catch {
    return { corrupt: true };
  }
  if (
    !parsed || typeof parsed !== 'object'
    || (parsed.overall !== 'pass' && parsed.overall !== 'fail')
    || typeof parsed.summary !== 'string'
    || !Array.isArray(parsed.findings)
  ) {
    return { corrupt: true };
  }
  const findings = parsed.findings.map((f) => ({
    severity: f?.severity ?? null, audience: f?.audience ?? null,
    issue: f?.issue ?? null, recommendation: f?.recommendation ?? null,
  }));
  let reportMarkdown = '';
  try { reportMarkdown = fs.readFileSync(path.join(dir, `spec-verify-r${round}.md`), 'utf8'); } catch { /* 人读报告缺失不抛错 */ }
  return { round, overall: parsed.overall, summary: parsed.summary, findings, reportMarkdown };
}

function buildSpecReview(cfg, id) {
  const draft = path.join(cfg.specsDir, `${id}.md`);
  const specVerify = buildSpecVerifyPanel(cfg, id);
  try {
    return { kind: 'spec', markdown: fs.readFileSync(draft, 'utf8'), specVerify };
  } catch {
    return { kind: 'spec', missing: true, message: `spec 草稿缺失：${draft}`, specVerify };
  }
}

function buildMergeReview(cfg, ts) {
  const branch = `task/${ts.id}`;
  const r = git(['diff', '--shortstat', `${ts.task.baseBranch}...${branch}`], ts.task.targetRepo);
  const verdict = buildVerdictPanel(cfg, ts.id);
  if (r.status === 0) {
    return { kind: 'merge', diffShortstat: (r.stdout || '').trim() || '(无变更)', verdict };
  }
  return { kind: 'merge', error: (r.stderr || r.stdout || 'git diff 失败').trim(), verdict };
}

function buildReview(cfg, ts, stage) {
  if (stage === 'AWAIT_SETUP_APPROVAL') return buildSetupReview(cfg);
  if (stage === 'AWAIT_FEASIBILITY_APPROVAL') return buildFeasibilityReview(ts);
  if (stage === 'AWAIT_SPEC_APPROVAL') return buildSpecReview(cfg, ts.id);
  if (stage === 'AWAIT_HUMAN_MERGE') return buildMergeReview(cfg, ts);
  if (ts.box === 'failed') {
    return { kind: 'failed', lastFailureType: ts.runtime.last_failure_type ?? null, verdict: buildVerdictPanel(cfg, ts.id) };
  }
  if (ts.box === 'done') return { kind: 'done', verdict: buildVerdictPanel(cfg, ts.id) };
  return { kind: 'info', stage };
}

export function buildTaskDetail(cfg, id) {
  const ts = findTaskAnyBox(cfg, id);
  if (!ts) return null;
  const timeline = readTimelineText(cfg, id);
  const timelineEntries = parseTimeline(timeline);
  const paths = {
    taskDir: ts.dir,
    specDraft: path.join(cfg.specsDir, `${id}.md`),
    dossierDir: state.dossierPath(cfg, id),
  };
  const rounds = buildRoundsView(cfg, id);
  if (ts.error) {
    return {
      task: null, runtime: null, box: ts.box, lane: null, needsHuman: false, working: false,
      timeline, timelineEntries, paths, review: { kind: 'broken', error: ts.error }, rounds,
    };
  }
  const stage = ts.runtime.stage;
  return {
    task: ts.task,
    runtime: ts.runtime,
    box: ts.box,
    lane: laneForStage(stage),
    ...computeWorkingFlags(ts.box, stage),
    timeline,
    timelineEntries,
    paths,
    review: buildReview(cfg, ts, stage),
    rounds,
  };
}

// ---- merge 分文件 diff（AC-001/002/003）：只读 git diff，绝不抛错、绝不 500。 ----

/** `-z` 输出 → NUL 分隔的字段数组（丢弃末尾 NUL 产生的尾随空字符串）。 */
function splitNulRecords(text) {
  const parts = (text ?? '').split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** `git diff --numstat -z` 输出 → { path, oldPath, added, deleted, binary }[]。
 *  `-z` 禁用路径引号转义，非 ASCII/含引号路径原样输出真实字节；rename 记录的第三字段为空，
 *  紧跟的两个 NUL 字段分别是旧路径与新路径（而非 tab 输出里的 "old => new" 合并伪路径）。 */
function parseDiffNumstat(text) {
  const tokens = splitNulRecords(text);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const [addedRaw, deletedRaw, inlinePath] = tokens[i].split('\t');
    const binary = addedRaw === '-' || deletedRaw === '-';
    const added = binary ? 0 : (Number(addedRaw) || 0);
    const deleted = binary ? 0 : (Number(deletedRaw) || 0);
    if (inlinePath === '') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      out.push({ path: newPath, oldPath, added, deleted, binary });
    } else {
      out.push({ path: inlinePath, oldPath: null, added, deleted, binary });
    }
  }
  return out;
}

/** `git diff --name-status -z` 输出 → 新路径 → 首字母状态（A/M/D/R/C…）的映射；
 *  rename/copy 记录是「状态 + 旧路径 + 新路径」三个 NUL 字段，取新路径为 key。 */
function parseDiffNameStatus(text) {
  const tokens = splitNulRecords(text);
  const statusByPath = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const letter = (tokens[i] || '?')[0];
    if (letter === 'R' || letter === 'C') {
      statusByPath.set(tokens[i + 2], letter);
      i += 2;
    } else {
      statusByPath.set(tokens[i + 1], letter);
      i += 1;
    }
  }
  return statusByPath;
}

/** merge 审查视图的分文件 diff：与 `git diff baseBranch...task/<id>` 逐项一致；分支缺失/git 失败降级为 cleaned 空态。 */
export function buildTaskDiff(cfg, id) {
  const ts = findTaskAnyBox(cfg, id);
  if (!ts) return null;
  if (ts.error) return { cleaned: true, files: [] };

  const branch = `task/${id}`;
  const repo = ts.task.targetRepo;
  const baseBranch = ts.task.baseBranch;
  if (!branchExists(repo, branch)) return { cleaned: true, files: [] };

  // -z 让 --numstat/--name-status 按 NUL 切分、不转义路径；core.quotePath=false 同样让
  // 逐文件 patch 正文里的 `diff --git a/... b/...` 头部对非 ASCII/引号路径原样输出。
  // -M 显式开启 rename 检测，不依赖仓库 diff.renames 配置默认值（AC-012）。
  const quotePathOff = ['-c', 'core.quotePath=false'];
  const numstat = git([...quotePathOff, 'diff', '-M', '--numstat', '-z', `${baseBranch}...${branch}`], repo);
  if (numstat.status !== 0) return { cleaned: true, files: [] };
  const nameStatus = git([...quotePathOff, 'diff', '-M', '--name-status', '-z', `${baseBranch}...${branch}`], repo);
  const statusByPath = parseDiffNameStatus(nameStatus.status === 0 ? nameStatus.stdout : '');

  const files = parseDiffNumstat(numstat.stdout).map((entry) => {
    const status = statusByPath.get(entry.path) ?? 'M';
    if (entry.binary) {
      return { path: entry.path, status, added: 0, deleted: 0, binary: true, oversize: false, patch: null };
    }
    // rename 需要新旧两侧路径同传，否则 pathspec 只命中新路径会把 patch 退化成纯 "new file" 伪造内容。
    const pathArgs = entry.oldPath != null ? ['--', entry.oldPath, entry.path] : ['--', entry.path];
    const patchResult = git([...quotePathOff, 'diff', '-M', `${baseBranch}...${branch}`, ...pathArgs], repo);
    const patch = patchResult.stdout ?? '';
    const oversize = Buffer.byteLength(patch, 'utf8') > cfg.verifierDiffMaxBytes;
    return {
      path: entry.path, status, added: entry.added, deleted: entry.deleted,
      binary: false, oversize, patch: oversize ? null : patch,
    };
  });
  return { cleaned: false, files };
}

// ---- 实时活动面（P4-AC-004/005）：等价 conductor.mjs::latestActiveSpawn 的多任务版，纯只读。 ----

/** 活跃判据的新鲜度阈值：stream.jsonl mtime 距今超过此值不算活跃。 */
export const ACTIVITY_FRESHNESS_MS = 120000;

const SPAWN_ROUND_RE = /^(setup|feasibility-agent|spec-agent|spec-verifier|maker|verifier)-r(\d+)\.json$/;

/** 单任务 dossier 内「已 started 未 done」的记录，按 started 倒序取最新一条；无则 null。 */
function latestStartedSpawn(dossierDir) {
  let names = [];
  try { names = fs.readdirSync(dossierDir); } catch { return null; }
  const started = [];
  for (const n of names) {
    const m = n.match(SPAWN_ROUND_RE);
    if (!m) continue;
    const rec = state.readJsonIf(path.join(dossierDir, n));
    if (!rec?.started || rec.done) continue;
    started.push({ role: rec.role ?? m[1], round: rec.round ?? Number(m[2]), started: rec.started });
  }
  if (started.length === 0) return null;
  started.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return started[0];
}

/**
 * queue 各任务的活跃 agent 扫描（P4-AC-004）：以最新「已 started 未 done」记录对应的
 * `<role>-r<N>.stream.jsonl` mtime 判活跃（阈值 ACTIVITY_FRESHNESS_MS 内）；目录缺失/记录损坏/
 * mtime 超阈值/stream 文件缺失的任务一律跳过而非抛错，绝不产出该任务的条目。
 */
export function listActiveSpawns(cfg) {
  const active = [];
  const now = Date.now();
  for (const ts of state.listTaskStates(cfg.queueDir, 'queue')) {
    if (ts.error) continue;
    const dossierDir = state.dossierPath(cfg, ts.id);
    const spawn = latestStartedSpawn(dossierDir);
    if (!spawn) continue;
    const streamFile = path.join(dossierDir, `${spawn.role}-r${spawn.round}.stream.jsonl`);
    let mtimeMs;
    try { mtimeMs = fs.statSync(streamFile).mtimeMs; } catch { continue; }
    if (now - mtimeMs > ACTIVITY_FRESHNESS_MS) continue;
    active.push({ taskId: ts.id, role: spawn.role, round: spawn.round, lastActivity: new Date(mtimeMs).toISOString() });
  }
  return active;
}

// ---- stream tail（P4-AC-006/007/008）：定长尾窗只读，绝不整文件读入内存，绝不因旧句柄读到过期内容 ----

/** stream tail 只读窗口的最大字节数（尾部）。 */
export const STREAM_TAIL_MAX_BYTES = 65536;

/** 按路径重开读取文件末尾 maxBytes 字节；起点落在文件中段时丢弃首个不完整行的前缀字节。
 *  路径缺失/为空返回 ''；每次调用独立 open/close，不持有跨调用句柄（AC-007 的 tail -F 语义靠这个保证）。 */
function readTailText(filePath, maxBytes) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const idx = text.indexOf('\n');
      text = idx === -1 ? '' : text.slice(idx + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

/** 单行 stream-json 事件 → 可读文本行数组（覆盖 assistant 文本增量 + 工具调用名两类）；
 *  无法识别/损坏的行静默跳过，不抛错（INV-4）。 */
function readableLinesFromEvent(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'assistant') return [];
  const content = parsed.message?.content;
  if (Array.isArray(content)) {
    const out = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') out.push(block.text);
      else if (block?.type === 'tool_use' && block.name) out.push(`[tool] ${block.name}`);
    }
    return out;
  }
  if (typeof parsed.message === 'string') return [parsed.message];
  return [];
}

/** NDJSON 尾窗文本 → 可读文本行数组；逐行独立解析，单行损坏不连累其它行。 */
export function parseStreamTailLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    out.push(...readableLinesFromEvent(parsed));
  }
  return out;
}

/** stream.jsonl 路径 → 尾窗解析出的可读文本行数组；文件缺失/空均返回 []（AC-006/007）。 */
export function readStreamTail(filePath, maxBytes = STREAM_TAIL_MAX_BYTES) {
  const text = readTailText(filePath, maxBytes);
  if (text == null) return [];
  return parseStreamTailLines(text);
}

const STREAM_FILE_RE = /^(setup|feasibility-agent|spec-agent|spec-verifier|maker|verifier)-r(\d+)\.stream\.jsonl$/;

/** dossier 目录内 mtime 最新的 stream.jsonl 文件路径；目录缺失/无匹配文件返回 null。 */
function latestStreamFilePath(dossierDir) {
  let names = [];
  try { names = fs.readdirSync(dossierDir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!STREAM_FILE_RE.test(name)) continue;
    const p = path.join(dossierDir, name);
    let mtimeMs;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs) best = { path: p, mtimeMs };
  }
  return best ? best.path : null;
}

/** 任务 id → 其 dossier 内最近活跃 stream 文件的尾窗文本行（`GET /api/task/:id/stream-tail` 支撑）；
 *  任务/dossier/stream 文件缺失均返回 []，不抛错。 */
export function buildStreamTail(cfg, id) {
  const file = latestStreamFilePath(state.dossierPath(cfg, id));
  if (!file) return [];
  return readStreamTail(file);
}

// ---- 写路径：CLI 透传支撑（纯函数，AC-013/014/016/017/018） ----

/** 五个同步动作端点对应的 CLI 子命令名与路由 action 一致，直接透传（merge/retry 已 job 化，见 P4）。 */
export const SYNC_ACTIONS = ['approve', 'approve-setup', 'approve-feasibility', 'reject', 'reject-feasibility'];

/** body.option / body.notes → argv 数组（不经 shell）。未知子命令自身会忽略多余 flag。 */
export function buildSyncActionArgv(action, id, body = {}) {
  const argv = [action, id];
  if (typeof body?.option === 'string' && body.option !== '') argv.push('--option', body.option);
  if (typeof body?.notes === 'string' && body.notes !== '') argv.push('--notes', body.notes);
  return argv;
}

/** CLI 子进程结果 → 用户可读提示：成功取 stdout，失败取 stderr（缺失兜底另一路）。 */
export function formatCliMessage(result) {
  const primary = result.exitCode === 0 ? result.stdout : result.stderr;
  const fallback = result.exitCode === 0 ? result.stderr : result.stdout;
  const text = (primary && primary.trim()) || (fallback && fallback.trim()) || '';
  return text !== '' ? text : '(no output)';
}

/** `conductor new` stdout 里 `id: <id>` 行解析新任务 id；无匹配返回 null。 */
export function parseNewTaskId(stdout) {
  const m = String(stdout ?? '').match(/^id:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

/** kind=feature 显式传 --feasibility 或 --feasibility false；bugfix 不传（AC-017）。 */
export function buildNewTaskArgv({ kind, title, briefPath, feasibility }) {
  const argv = ['new', '--kind', kind, '--title', title];
  if (briefPath) argv.push('--brief', briefPath);
  if (kind === 'feature') {
    if (feasibility === true) argv.push('--feasibility');
    else argv.push('--feasibility', 'false');
  }
  return argv;
}
