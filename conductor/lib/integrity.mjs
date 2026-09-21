// lib/integrity.mjs — 有执行能力的 agent（maker / worker:sandbox / worker:write）跑完之后的机械核对。
//
// Bash 是任意执行：没有 OS 沙盒时，write-guard 之类的 hook 管不到 `echo … > 文件`。所以内核不靠
// 「它应该不会去动」，而是在派出前给必须不变的东西拍快照，跑完后逐个核对：
//   - 获批的冻结 spec、人闸裁决、摘要及其原文快照；
//   - 本轮之前的全部历史案卷（spawn 记录、log、判决台账、报告、precommit 记录、委派台账）；
//   - 内核策略面：conductor.config.json、agents/ 下的 prompt、conductor/ 下的内核代码、目标仓 profile；
//   - 任务的 task.json / brief.md。
// 被改、被删 → 用快照内容还原（只对 ≤ 512KB 的文件留内容，其余只留哈希、能发现不能还原）；
// 凭空多出来的、不属于本轮任何派出的案卷文件（伪造的别的角色记录）→ 移进 quarantine/ 隔离。
// 每一处都记成一条 violation 交回内核：写事件、进记录、开 help 闸由调用方决定。
//
// 这是**事后核对 + 还原**，不是隔离：它保证越权写入不会悄悄生效，不保证越权写入发生不了。
// 要后者请开 workerSandbox（宿主运行时的 OS 沙盒）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setupProfilePaths } from './profile.mjs';

const KEEP_CONTENT_MAX = 512 * 1024;

/** 带轮次号的案卷文件：`<base>-r<n>.<suffix>`。 */
const ROUND_FILE_RE = /-r(\d+)\.[A-Za-z0-9.]+$/;

/** 内核自己会随时新建 / 追加的案卷文件（不算伪造）。 */
const KERNEL_OWNED = new Set(['timeline.md', 'events.jsonl', 'router-state.json', 'router-notes.json', 'merge-intent.json']);
const KERNEL_OWNED_DIRS = new Set(['digest', 'views', 'router-notes', 'quarantine', 'attempts', '.lock']);
/** 其中这几个目录的内容会被 router / reviewer 当作依据读取：执行角色改了、加了都要管。 */
const PROTECTED_SUBDIRS = Object.freeze(['digest', 'router-notes', 'views']);

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursive(dir, { maxDepth = 6 } = {}, depth = 0, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth && e.name !== 'node_modules' && e.name !== '.git') listFilesRecursive(p, { maxDepth }, depth + 1, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

function capture(files, p) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { return; }
  files.set(p, { sha: sha(buf), content: buf.length <= KEEP_CONTENT_MAX ? buf : null });
}

/**
 * 派出前拍快照。
 *   round —— 本次派出的轮次号：轮次 < round 的案卷文件都是不可变历史。
 */
export function snapshotProtected(cfg, ts, { round }) {
  const id = ts.id;
  const dossier = path.join(cfg.dossierDir, id);
  const files = new Map();
  let names = [];
  try { names = fs.readdirSync(dossier, { withFileTypes: true }); } catch { /* 首轮还没有案卷目录 */ }

  for (const e of names) {
    if (!e.isFile()) continue;
    const p = path.join(dossier, e.name);
    if (e.name === 'spec.md' || /^human-r\d+\.json$/.test(e.name)) { capture(files, p); continue; }
    if (e.name.endsWith('.stream.jsonl')) continue; // 原始流很大且只增，不进快照
    const m = e.name.match(ROUND_FILE_RE);
    if (m && Number(m[1]) < round) capture(files, p);
  }
  // 内核 / router 专属的子目录与文件：执行角色一个都不该碰。摘要被换掉 = router 被喂了假索引；
  // 工作记忆被改 = router 的计划被劫持。全部拍快照，跑完后新增的也按伪造处理（见 verifyProtected）。
  const ownedBefore = new Set();
  for (const sub of PROTECTED_SUBDIRS) {
    for (const p of listFilesRecursive(path.join(dossier, sub))) { capture(files, p); ownedBefore.add(p); }
  }
  capture(files, path.join(dossier, 'router-notes.json'));

  for (const name of ['task.json', 'brief.md']) capture(files, path.join(ts.dir, name));

  // 内核策略面
  capture(files, path.join(cfg.root, 'conductor.config.json'));
  for (const p of listFilesRecursive(path.join(cfg.root, 'agents'))) capture(files, p);
  for (const p of listFilesRecursive(path.join(cfg.root, 'conductor'))) if (p.endsWith('.mjs')) capture(files, p);
  try {
    const targetRepo = ts.task?.targetRepo ?? cfg.targetRepo;
    capture(files, setupProfilePaths({ ...cfg, targetRepo }).meta);
  } catch { /* profile 解析失败不该拦住派出 */ }

  const existing = new Set(names.filter((e) => e.isFile()).map((e) => e.name));
  return { id, dossier, round, files, existing, ownedBefore };
}

/**
 * 跑完后核对并还原。
 *   expectedBases —— 本轮（及其自动续接轮）合法派出的产物基名集合，如 `worker-a-1`、`maker`。
 * 返回 violations: [{ path, kind: 'modified' | 'deleted' | 'forged', restored }]。
 */
export function verifyProtected(snapshot, { expectedBases = [] } = {}) {
  const violations = [];
  for (const [p, before] of snapshot.files) {
    let now = null;
    try { now = fs.readFileSync(p); } catch { /* 被删 */ }
    if (now != null && sha(now) === before.sha) continue;
    let restored = false;
    if (before.content != null) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, before.content);
        restored = true;
      } catch { /* 还原不了也要如实上报 */ }
    }
    violations.push({ path: p, kind: now == null ? 'deleted' : 'modified', restored });
  }

  // 凭空出现的案卷文件：不属于内核、不属于本轮任何合法派出 → 隔离。
  let names = [];
  try { names = fs.readdirSync(snapshot.dossier, { withFileTypes: true }); } catch { /* 无案卷 */ }
  const bases = new Set(expectedBases);
  for (const e of names) {
    if (e.isDirectory()) continue;
    if (snapshot.existing.has(e.name) || KERNEL_OWNED.has(e.name)) continue;
    const m = e.name.match(/^(.*)-r(\d+)\.[A-Za-z0-9.]+$/);
    const legit = m != null && Number(m[2]) >= snapshot.round
      && (bases.has(m[1]) || m[1] === 'dispatch' || m[1] === 'digest' || m[1] === 'digest-check' || m[1] === 'router');
    if (legit) continue;
    const src = path.join(snapshot.dossier, e.name);
    const destDir = path.join(snapshot.dossier, 'quarantine');
    let restored = false;
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(src, path.join(destDir, `${Date.now()}-${e.name}`));
      restored = true;
    } catch { /* 隔离失败也要上报 */ }
    violations.push({ path: src, kind: 'forged', restored });
  }

  // 受保护子目录里凭空多出来的文件（伪造的摘要 / 工作记忆快照 / diff 视图）：同样隔离。
  // 同一任务内，内核自己往这些目录写东西（digest 生成、router 轮次）从不与执行角色的派出同时发生。
  for (const sub of PROTECTED_SUBDIRS) {
    for (const p of listFilesRecursive(path.join(snapshot.dossier, sub))) {
      if (snapshot.ownedBefore?.has(p)) continue;
      let restored = false;
      try {
        const destDir = path.join(snapshot.dossier, 'quarantine');
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(p, path.join(destDir, `${Date.now()}-${sub}-${path.basename(p)}`));
        restored = true;
      } catch { /* 隔离失败也要上报 */ }
      violations.push({ path: p, kind: 'forged', restored });
    }
  }
  return violations;
}

export { KERNEL_OWNED_DIRS, PROTECTED_SUBDIRS };
