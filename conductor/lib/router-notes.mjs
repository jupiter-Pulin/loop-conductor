// lib/router-notes.mjs — router 的可恢复工作记忆（`dossier/<id>/router-notes.json`）。
//
// router 每轮都是冷启动的新会话，跨轮能带走的只有它自己写下来的东西。这份文件由 router 重写、
// 内核做三件机械的事：
//   1. 校格式与大小（≤ 24KB）。`facts` 的每一条必须带 `source`——没有出处的只能放 `hypotheses`；
//      于是「有来源的事实」与「模型的推测」在结构上就是分开的。内核不核对出处是否真实（那是语义），
//      只保证 router 自己说不清来源的东西进不了 facts。执行事实另由内核在事实段里独立渲染，
//      两者永远不混：prompt 里工作记忆段的标题写明「未经内核验证」。
//   2. 逐轮留快照（`router-notes/r<n>.json`）：被改写、被压缩掉的内容都找得回来。
//   3. 写坏了就还原成上一份合格快照（坏的那份另存为 `.invalid.json`），并在事实段里告诉 router。
//      这不算 router 失效——它的决策 log 仍然有效，只是这轮的记忆更新没生效。
// 未完成的委派、未判完的 AC、已批准的约束与人的裁决不依赖这份记忆：它们每轮都由内核从案卷重新渲染，
// router 的记忆丢了、写错了，这些也不会丢。

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './state.mjs';

export const NOTES_SCHEMA = 'router-notes/v1';
export const NOTES_MAX_BYTES = 24_000;
const TOP = Object.freeze(['schema', 'objective', 'facts', 'hypotheses', 'questions', 'plan', 'changelog']);
const QUESTION_STATUS = Object.freeze(['open', 'answered', 'escalated']);
const PLAN_STATUS = Object.freeze(['todo', 'active', 'done', 'dropped']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v, max) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

export function validateNotesText(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, errors: ['工作记忆为空'] };
  if (Buffer.byteLength(raw, 'utf8') > NOTES_MAX_BYTES) {
    return { ok: false, errors: [`工作记忆超过 ${NOTES_MAX_BYTES} 字节：压缩它——细节留在产物里，这里只留结论与出处`] };
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, errors: [`工作记忆不是合法 JSON：${e.message}`] }; }
  if (!isPlainObject(obj)) return { ok: false, errors: ['工作记忆必须是 JSON 对象'] };
  const errors = [];
  for (const k of Object.keys(obj)) if (!TOP.includes(k)) errors.push(`未知字段：${k}`);
  if (obj.schema !== NOTES_SCHEMA) errors.push(`schema 必须为 ${JSON.stringify(NOTES_SCHEMA)}`);
  if (obj.objective != null && !str(obj.objective, 600)) errors.push('objective 须为 ≤ 600 字符的字符串');
  const each = (field, fn) => {
    if (obj[field] == null) return;
    if (!Array.isArray(obj[field])) { errors.push(`${field} 须为数组`); return; }
    obj[field].forEach((item, i) => {
      if (!isPlainObject(item)) { errors.push(`${field}[${i}] 须为对象`); return; }
      fn(item, `${field}[${i}]`);
    });
  };
  each('facts', (f, w) => {
    if (!str(f.text, 600)) errors.push(`${w}.text 必填，≤ 600 字符`);
    if (!str(f.source, 300)) errors.push(`${w}.source 必填：facts 必须带出处（spec 行号 / 产物文件 / kernel）；没有出处的放 hypotheses`);
  });
  each('hypotheses', (h, w) => {
    if (!str(h.text, 600)) errors.push(`${w}.text 必填，≤ 600 字符`);
    if (h.verify_by != null && !str(h.verify_by, 400)) errors.push(`${w}.verify_by 须为 ≤ 400 字符的字符串`);
  });
  each('questions', (q, w) => {
    if (!str(q.text, 600)) errors.push(`${w}.text 必填，≤ 600 字符`);
    if (!QUESTION_STATUS.includes(q.status)) errors.push(`${w}.status 取值非法（${QUESTION_STATUS.join(' | ')}）`);
  });
  each('plan', (p, w) => {
    if (!str(p.key, 40)) errors.push(`${w}.key 必填`);
    if (!str(p.title, 200)) errors.push(`${w}.title 必填，≤ 200 字符`);
    if (!PLAN_STATUS.includes(p.status)) errors.push(`${w}.status 取值非法（${PLAN_STATUS.join(' | ')}）`);
    if (p.depends_on != null && (!Array.isArray(p.depends_on) || p.depends_on.some((d) => typeof d !== 'string'))) errors.push(`${w}.depends_on 须为字符串数组`);
    if (p.note != null && !str(p.note, 400)) errors.push(`${w}.note 须为 ≤ 400 字符的字符串`);
  });
  each('changelog', (c, w) => {
    if (!Number.isInteger(c.round)) errors.push(`${w}.round 须为整数`);
    if (!str(c.why, 400)) errors.push(`${w}.why 必填，≤ 400 字符`);
  });
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: errors.slice(0, 20) };
}

function snapshotDir(notesPath) {
  return path.join(path.dirname(notesPath), 'router-notes');
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function latestSnapshot(notesPath) {
  let names = [];
  try { names = fs.readdirSync(snapshotDir(notesPath)); } catch { return null; }
  const rounds = names.map((n) => n.match(/^r(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  return rounds.length > 0 ? path.join(snapshotDir(notesPath), `r${rounds[0]}.json`) : null;
}

/**
 * router 一轮结束后调用：合格且有变化 → 留快照；不合格 → 还原上一份合格快照。
 * 返回 { status: 'unchanged' | 'saved' | 'restored' | 'absent', errors }。
 */
export function settleNotes(notesPath, round) {
  const raw = readIf(notesPath);
  if (raw == null) return { status: 'absent', errors: [] };
  const last = latestSnapshot(notesPath);
  const lastRaw = last ? readIf(last) : null;
  if (raw === lastRaw) return { status: 'unchanged', errors: [] };
  const check = validateNotesText(raw);
  fs.mkdirSync(snapshotDir(notesPath), { recursive: true });
  if (check.ok) {
    fs.writeFileSync(path.join(snapshotDir(notesPath), `r${round}.json`), raw);
    return { status: 'saved', errors: [] };
  }
  fs.writeFileSync(path.join(snapshotDir(notesPath), `r${round}.invalid.json`), raw);
  if (lastRaw != null) writeFileAtomic(notesPath, lastRaw);
  else fs.rmSync(notesPath, { force: true });
  return { status: 'restored', errors: check.errors };
}

/** 注入 router prompt 的工作记忆原文（只给合格的；不合格的上一轮已被 settleNotes 还原）。 */
export function readNotesForPrompt(notesPath) {
  const raw = readIf(notesPath);
  if (raw == null) return '';
  return validateNotesText(raw).ok ? raw.trim() : '';
}
