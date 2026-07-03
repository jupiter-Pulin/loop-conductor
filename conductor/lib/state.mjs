// lib/state.mjs — 任务目录（task.json 不可变 + runtime.json 可变）的唯一读写点，
// 加上 dossier 工具与 spec 正文解析。零依赖，纯 JSON + Markdown 段抽取。
import fs from 'node:fs';
import path from 'node:path';

// 合法任务目录名：task-YYYYMMDD-NNN（8 位日期 + 3 位序号）。
const TASK_DIR_RE = /^task-\d{8}-\d{3}$/;

// ---- 任务目录布局：state/<box>/<id>/{task.json,runtime.json,spec.md} ----

/** 任务目录路径（boxDir 已是 state/<box>）。 */
export function taskDir(boxDir, id) {
  return path.join(boxDir, id);
}

/**
 * 读任务目录 → TaskState：{ box, dir, id, task, runtime }。
 * task.json 或 runtime.json 任一缺失/坏 JSON 都抛错（视为目录损坏）。
 */
export function readTaskState(dir, box) {
  const taskP = path.join(dir, 'task.json');
  const runtimeP = path.join(dir, 'runtime.json');
  let task;
  let runtime;
  try {
    task = JSON.parse(fs.readFileSync(taskP, 'utf8'));
  } catch (e) {
    throw new Error(`task.json 缺失或损坏：${taskP}（${e.message}）`);
  }
  try {
    runtime = JSON.parse(fs.readFileSync(runtimeP, 'utf8'));
  } catch (e) {
    throw new Error(`runtime.json 缺失或损坏：${runtimeP}（${e.message}）`);
  }
  return { box, dir, id: task.id, task, runtime };
}

/** 刷新 updated_at 并写 ts.dir/runtime.json（runtime 写入是「提交点」）。 */
export function saveRuntime(ts) {
  ts.runtime.updated_at = new Date().toISOString();
  const p = path.join(ts.dir, 'runtime.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(ts.runtime, null, 2)}\n`);
}

/**
 * 新建任务目录：mkdir <boxDir>/<task.id>，写 task.json + runtime.json，
 * 可选写 spec.md 草稿（bugfix 用）。
 */
export function writeNewTask(boxDir, task, runtime, { specDraft } = {}) {
  const dir = taskDir(boxDir, task.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  if (specDraft != null) {
    fs.writeFileSync(path.join(dir, 'spec.md'), specDraft);
  }
  return dir;
}

/**
 * 列出某 box 下的全部 TaskState（按目录名排序，确定性）。
 * 坏任务目录不抛断流程：以 { box, dir, id, error } 形态返回，供 status 标注。
 */
export function listTaskStates(boxDir, box) {
  return listTaskDirNames(boxDir).map((name) => {
    const dir = path.join(boxDir, name);
    try {
      return readTaskState(dir, box);
    } catch (e) {
      return { box, dir, id: name, error: e.message };
    }
  });
}

/** 仅返回合法任务目录名（排序），供 nextId / 遍历用。 */
export function listTaskDirNames(boxDir) {
  let entries;
  try { entries = fs.readdirSync(boxDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && TASK_DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** 返回旧单文件布局的任务 .md 路径数组（task-*.md），用于告警跳过、绝不当新任务。 */
export function findLegacyTaskFiles(boxDir) {
  let names;
  try { names = fs.readdirSync(boxDir); } catch { return []; }
  return names
    .filter((n) => n.startsWith('task-') && n.endsWith('.md'))
    .sort()
    .map((n) => path.join(boxDir, n));
}

// ---- spec 正文解析（## 段抽取、追加） ----

/** 抽取正文 `## <title>` 段（到下一个 ## 或文末），找不到返回 null。 */
export function extractSection(body, title) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(`## ${title}`));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** 往 `## <title>` 段追加文本；段不存在则在文末新建。 */
export function appendToSection(body, title, text) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(`## ${title}`));
  if (start === -1) {
    return `${String(body ?? '').trimEnd()}\n\n## ${title}\n\n${text}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const before = lines.slice(0, end).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trimEnd();
  return `${before}\n\n${text}\n${after ? `\n${after}\n` : ''}`;
}

/** AC 段的规范标题（spec-doc 契约钉死此标题，同义标题一律不认）。 */
export const AC_SECTION_TITLE = '验收标准';

/**
 * AC 枚举（无兜底版）：spec 正文 → [{ ac_id, text }]，取不到任何条目返回 []。
 * 1. 取 `## 验收标准` 段；2. 逐条列表项（^\s*-\s+，去复选框前缀）；
 * 3. 含 AC-(\d+) → 归一 AC-###；否则按位置赋 AC-00N（1 基）。
 * 契约门（lib/spec-contract.mjs）与 conductor 共用此函数，保证两侧一个口径。
 */
export function enumerateAcceptanceCriteria(specMd) {
  const section = extractSection(specMd, AC_SECTION_TITLE);
  const items = [];
  if (section != null) {
    for (const raw of section.split('\n')) {
      const m = raw.match(/^\s*-\s+(.*)$/);
      if (!m) continue;
      // 去掉 [ ] / [x] 复选框前缀。
      const text = m[1].replace(/^\[[ xX]\]\s*/, '').trim();
      if (text === '') continue;
      items.push(text);
    }
  }
  return items.map((text, idx) => {
    const tagged = text.match(/AC-(\d+)/);
    const ac_id = tagged
      ? `AC-${String(Number(tagged[1])).padStart(3, '0')}`
      : `AC-${String(idx + 1).padStart(3, '0')}`;
    return { ac_id, text };
  });
}

/**
 * AC 枚举（带兜底，契约 §4）：feature 档草稿已被契约门保证非空；
 * 兜底单条仅服务 bugfix 人写最小 spec / 历史任务。
 */
export function extractAcceptanceCriteria(specMd) {
  const items = enumerateAcceptanceCriteria(specMd);
  if (items.length === 0) {
    return [{ ac_id: 'AC-001', text: '满足 spec.md 全部要求且 testCommand 全绿' }];
  }
  return items;
}

// ---- dossier 工具（案卷是 agent 间唯一通信媒介） ----

export function dossierPath(cfg, id, ...rest) {
  return path.join(cfg.dossierDir, id, ...rest);
}

export function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

export function writeFileEnsured(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 事件日志，人类排查用。conductor 追加，永不改写历史；状态决策绝不解析它。 */
export function appendTimeline(cfg, id, msg) {
  const p = dossierPath(cfg, id, 'timeline.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `- ${new Date().toISOString()} ${msg}\n`);
}

// ---- 状态转移（先产物后状态的「最后一步」） ----

/**
 * 写 stage 字段并落盘 runtime；FAILED_BOX 则把整个任务目录 rename 到 failedDir，
 * 并更新 ts.dir/ts.box。extra 先合并进 runtime（如 last_failure_type）。
 */
export function transitionState(ts, cfg, nextStage, note, extra = {}) {
  Object.assign(ts.runtime, extra, { stage: nextStage });
  saveRuntime(ts);
  if (nextStage === 'FAILED_BOX' && ts.box !== 'failed') {
    const dest = taskDir(cfg.failedDir, ts.id);
    if (dest !== ts.dir) {
      fs.mkdirSync(cfg.failedDir, { recursive: true });
      fs.renameSync(ts.dir, dest);
      ts.dir = dest;
      ts.box = 'failed';
    }
  }
  appendTimeline(cfg, ts.id, `stage → ${nextStage}${note ? ` (${note})` : ''}`);
}
