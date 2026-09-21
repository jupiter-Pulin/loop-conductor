// lib/assignment-contract.mjs — router 的一次委派（assignment）长什么样：零 IO 的程序级契约。
//
// router 用 `dispatch` 动作一次派出 1..N 个 assignment。每个 assignment 必须说清五件事——
// 本轮目的、输入依据、授权范围、预期产物、完成条件——内核把它们**逐字**注入接收者的 prompt，
// 而不是只留在一行路由理由里。内核不理解这些文字，只校格式与几条机械规则。
//
// 权限不由文字决定，由 `profile` 决定（按真实副作用分三档，见 lib/agent-settings.mjs）：
//   read    —— 静态只读：无 Bash，只能写自己的 report 与 log。调查 / 设计 / 诊断 / 局部检查。
//   sandbox —— 临时实验：可执行命令，但 cwd 是用毕即弃的 scratch worktree，产物**不并入产品**。
//              装依赖、跑测试、codegen 都会写盘联网起进程，所以它们属于这一档而不是 read。
//   write   —— 产品代码修改：在任务分支（或自己的子分支）上改代码，内核负责 commit 与集成。
// `intent` 只是给人和 router 自己看的目的标签，不改变权限。

export const PROFILES = Object.freeze(['read', 'sandbox', 'write']);
export const INTENTS = Object.freeze(['investigate', 'experiment', 'design', 'implement', 'diagnose', 'fix', 'check']);

export const MAX_ASSIGNMENTS_PER_DISPATCH = 8;
export const KEY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const KEY_MAX = 24;
const TEXT_MAX = 2000;
const TITLE_MAX = 120;

const FIELDS = Object.freeze([
  'key', 'profile', 'intent', 'title', 'purpose', 'inputs', 'scope', 'deliverables', 'done_when',
  'paths', 'acs', 'continue_from',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v, max) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

/** key 会进文件名与分支名（worker-<key>-r<n>.json / task/<id>--<key>）：必须无歧义、文件系统安全。 */
export function isValidKey(key) {
  return typeof key === 'string' && key.length <= KEY_MAX && KEY_RE.test(key) && !/(?:^|-)r\d+$/.test(key);
}

/**
 * 校验 router log 里的 `assignments`。返回错误字符串数组（空 = 合格）。
 */
export function validateAssignments(assignments) {
  const errors = [];
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return ['dispatch 必须带非空的 assignments 数组'];
  }
  if (assignments.length > MAX_ASSIGNMENTS_PER_DISPATCH) {
    errors.push(`assignments 一次最多 ${MAX_ASSIGNMENTS_PER_DISPATCH} 个（实际 ${assignments.length}）：更多的工作放到后续轮次`);
  }
  const seen = new Set();
  assignments.forEach((a, i) => {
    const where = `assignments[${i}]`;
    if (!isPlainObject(a)) { errors.push(`${where} 必须是对象`); return; }
    for (const k of Object.keys(a)) {
      if (!FIELDS.includes(k)) errors.push(`${where} 未知字段：${k}（只接受 ${FIELDS.join(' / ')}）`);
    }
    if (!isValidKey(a.key)) {
      errors.push(`${where}.key 非法：${JSON.stringify(a.key)}（小写字母开头，[a-z0-9-]，≤ ${KEY_MAX} 字符，不得以 r<数字> 结尾）`);
    } else if (seen.has(a.key)) {
      errors.push(`${where}.key 重复：${a.key}`);
    }
    if (typeof a.key === 'string') seen.add(a.key);
    if (!PROFILES.includes(a.profile)) errors.push(`${where}.profile 取值非法：${JSON.stringify(a.profile)}（${PROFILES.join(' | ')}）`);
    if (!INTENTS.includes(a.intent)) errors.push(`${where}.intent 取值非法：${JSON.stringify(a.intent)}（${INTENTS.join(' | ')}）`);
    if (!text(a.title, TITLE_MAX)) errors.push(`${where}.title 必填，≤ ${TITLE_MAX} 字符`);
    for (const f of ['purpose', 'scope', 'deliverables', 'done_when']) {
      if (!text(a[f], TEXT_MAX)) errors.push(`${where}.${f} 必填，≤ ${TEXT_MAX} 字符`);
    }
    if (!Array.isArray(a.inputs) || a.inputs.length === 0 || a.inputs.length > 20 || a.inputs.some((s) => !text(s, 300))) {
      errors.push(`${where}.inputs 必填：1–20 条输入依据（原文引用 / 产物路径 / AC 编号），每条 ≤ 300 字符`);
    }
    if (Object.hasOwn(a, 'paths')) {
      if (a.profile !== 'write') errors.push(`${where}.paths 只对 profile=write 有意义`);
      if (!Array.isArray(a.paths) || a.paths.length === 0 || a.paths.length > 40 || a.paths.some((s) => !text(s, 200))) {
        errors.push(`${where}.paths 须为 1–40 条路径 / glob，每条 ≤ 200 字符`);
      } else if (a.paths.some((s) => s.startsWith('/') || s.split('/').includes('..'))) {
        errors.push(`${where}.paths 必须是仓库内相对路径（不得以 / 开头或含 ..）`);
      }
    }
    if (Object.hasOwn(a, 'acs')
      && (!Array.isArray(a.acs) || a.acs.length > 60 || a.acs.some((s) => typeof s !== 'string' || !/^(?:AC|B)-\d+$/.test(s)))) {
      errors.push(`${where}.acs 须为相关 AC 编号数组（仅供参考：子任务完成不等于 AC 通过）`);
    }
    if (Object.hasOwn(a, 'continue_from') && !(Number.isInteger(a.continue_from) && a.continue_from > 0)) {
      errors.push(`${where}.continue_from 须为要续接的那一轮的轮次号（正整数）`);
    }
  });
  return errors;
}

// ---- 并行写入的声明路径重叠检查（机械、保守） ----

/** glob → 第一个通配符之前的字面前缀，按路径段截断：`packages/chains/**` → ['packages','chains']。 */
export function literalPrefixSegments(glob) {
  const s = String(glob ?? '').replace(/^\.\//, '');
  const cut = s.search(/[*?[{]/);
  const literal = cut === -1 ? s : s.slice(0, cut);
  const segs = literal.split('/');
  if (cut !== -1) segs.pop(); // 通配符所在的那一段不完整，丢掉
  return segs.filter((x) => x !== '');
}

function prefixOverlap(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true; // 一方是另一方的路径前缀（含空前缀 = 整仓）→ 可能写到同一处
}

/**
 * 同一次 dispatch 里并行的 write assignment 之间，声明路径是否可能重叠。
 * 保守判定：宁可误报重叠让 router 串行，也不放过一次共享写入。声明不重叠并不证明语义独立，
 * 那是 router 的判断与最终整体 review 的事。
 * 返回冲突描述数组（空 = 可并行）。
 */
export function writePathConflicts(assignments) {
  const writers = (assignments ?? []).filter((a) => a?.profile === 'write');
  if (writers.length < 2) return [];
  const out = [];
  for (const w of writers) {
    if (!Array.isArray(w.paths) || w.paths.length === 0) {
      out.push(`${w.key} 没有声明 paths：同一轮并行多个 write 时每个都必须声明写入范围`);
    }
  }
  if (out.length > 0) return out;
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      for (const pa of writers[i].paths) {
        for (const pb of writers[j].paths) {
          if (prefixOverlap(literalPrefixSegments(pa), literalPrefixSegments(pb))) {
            out.push(`${writers[i].key}(${pa}) 与 ${writers[j].key}(${pb}) 的写入范围可能重叠：串行派出，或收窄 paths`);
          }
        }
      }
    }
  }
  return out;
}

/** 实际改动的文件里，哪些落在声明 paths 之外（只报告，不判失败：越界由 router 与整体 review 判断）。 */
export function filesOutsideDeclared(changedFiles, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const prefixes = paths.map(literalPrefixSegments);
  return (changedFiles ?? []).filter((f) => {
    const segs = String(f).split('/');
    return !prefixes.some((p) => p.every((seg, i) => segs[i] === seg));
  });
}
