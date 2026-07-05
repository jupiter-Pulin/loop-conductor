// dashboard/model.mjs — 纯逻辑层：泳道映射、三箱聚合、任务详情组装、CLI 结果转换。
// 只读磁盘（复用 lib/state.mjs、lib/profile.mjs、lib/feasibility-contract.mjs、lib/git.mjs
// 既有解析函数），不持久化、不缓存、不自写 option/markdown 解析。
import fs from 'node:fs';
import path from 'node:path';
import * as state from '../lib/state.mjs';
import { setupProfilePaths } from '../lib/profile.mjs';
import { validateFeasibilityDoc } from '../lib/feasibility-contract.mjs';
import { git } from '../lib/git.mjs';

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
    needsHuman: ts.box === 'queue' && HUMAN_STAGES.includes(stage),
    working: ts.box === 'queue' && lane != null && !HUMAN_STAGES.includes(stage),
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

function buildSpecReview(cfg, id) {
  const draft = path.join(cfg.specsDir, `${id}.md`);
  try {
    return { kind: 'spec', markdown: fs.readFileSync(draft, 'utf8') };
  } catch {
    return { kind: 'spec', missing: true, message: `spec 草稿缺失：${draft}` };
  }
}

function buildMergeReview(ts) {
  const branch = `task/${ts.id}`;
  const r = git(['diff', '--shortstat', `${ts.task.baseBranch}...${branch}`], ts.task.targetRepo);
  if (r.status === 0) {
    return { kind: 'merge', diffShortstat: (r.stdout || '').trim() || '(无变更)' };
  }
  return { kind: 'merge', error: (r.stderr || r.stdout || 'git diff 失败').trim() };
}

function buildReview(cfg, ts, stage) {
  if (stage === 'AWAIT_SETUP_APPROVAL') return buildSetupReview(cfg);
  if (stage === 'AWAIT_FEASIBILITY_APPROVAL') return buildFeasibilityReview(ts);
  if (stage === 'AWAIT_SPEC_APPROVAL') return buildSpecReview(cfg, ts.id);
  if (stage === 'AWAIT_HUMAN_MERGE') return buildMergeReview(ts);
  if (ts.box === 'failed') return { kind: 'failed', lastFailureType: ts.runtime.last_failure_type ?? null };
  return { kind: 'info', stage };
}

export function buildTaskDetail(cfg, id) {
  const ts = findTaskAnyBox(cfg, id);
  if (!ts) return null;
  const timeline = readTimelineText(cfg, id);
  const paths = {
    taskDir: ts.dir,
    specDraft: path.join(cfg.specsDir, `${id}.md`),
    dossierDir: state.dossierPath(cfg, id),
  };
  if (ts.error) {
    return { task: null, runtime: null, box: ts.box, lane: null, timeline, paths, review: { kind: 'broken', error: ts.error } };
  }
  const stage = ts.runtime.stage;
  return {
    task: ts.task,
    runtime: ts.runtime,
    box: ts.box,
    lane: laneForStage(stage),
    timeline,
    paths,
    review: buildReview(cfg, ts, stage),
  };
}

// ---- 写路径：CLI 透传支撑（纯函数，AC-013/014/016/017/018） ----

/** 六个同步动作端点对应的 CLI 子命令名与路由 action 一致，直接透传。 */
export const SYNC_ACTIONS = ['approve', 'approve-setup', 'approve-feasibility', 'reject', 'reject-feasibility', 'retry'];

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
