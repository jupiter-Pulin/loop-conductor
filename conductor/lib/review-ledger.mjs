// lib/review-ledger.mjs — reviewer 的逐条 AC 判决台账：大 diff、多 AC 的整体 review 可以分轮判完。
//
// 为什么需要它：短 log 的 summary 上限 2000 字符，40 多条 AC 每条一行就放不下；reviewer 单次会话
// 也可能在判完之前撞上限。以前这两种情况都只能「整份作废重来」或「缩短输出漏判」。现在：
//   - reviewer 把每条判决增量写进 `reviewer-r<n>.verdicts.json`（完整保存，不受短 log 长度限制）；
//   - 内核按**版本**合并台账：只有 `head_sha`（任务分支 HEAD）与 `spec_sha`（获批 spec 版本）都与
//     当前一致的轮次才算数——代码或 spec 变了，旧判决一条都不沿用，只留作诊断；
//   - 覆盖率由内核对照「冻结 spec 枚举出的全部 AC」机械计算：没判的就是没判（remaining），
//     reviewer 说自己 ok 也没用；全部判过且全部 pass 才解除 need_review，merge 资格不会提前打开。
//
// 判决的语义对错是 reviewer 的独立判断，内核不理解也不复核；内核只保证「判的是哪一版、判全了没有」。
//
// 本模块读盘（判决文件）但不写盘，绝不抛错。

import fs from 'node:fs';
import path from 'node:path';

export const VERDICTS_MAX_BYTES = 400_000;
export const VERDICT_VALUES = Object.freeze(['pass', 'fail']);
const AC_ID_RE = /^(?:AC|B)-\d+$/;
const TEXT_MAX = 800;
const TIER_ORDER = { unit: 1, integration: 2, e2e: 3 };

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 判决文件内容 → { ok, errors, verdicts }。不合格的条目被丢弃并记错，合格的照用（增量写到一半也能用）。 */
export function parseVerdicts(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, errors: ['判决文件缺失或为空'], verdicts: [] };
  if (Buffer.byteLength(raw, 'utf8') > VERDICTS_MAX_BYTES) {
    return { ok: false, errors: [`判决文件超过 ${VERDICTS_MAX_BYTES} 字节`], verdicts: [] };
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: [`判决文件不是合法 JSON：${e.message}`], verdicts: [] };
  }
  if (!isPlainObject(obj) || !Array.isArray(obj.verdicts)) {
    return { ok: false, errors: ['判决文件必须是 {"verdicts":[…]}'], verdicts: [] };
  }
  const errors = [];
  const verdicts = [];
  obj.verdicts.forEach((v, i) => {
    const where = `verdicts[${i}]`;
    if (!isPlainObject(v)) { errors.push(`${where} 必须是对象`); return; }
    if (typeof v.ac !== 'string' || !AC_ID_RE.test(v.ac)) { errors.push(`${where}.ac 非法：${JSON.stringify(v.ac)}`); return; }
    if (!VERDICT_VALUES.includes(v.verdict)) { errors.push(`${where}.verdict 必须是 pass | fail`); return; }
    const evidence = typeof v.evidence === 'string' ? v.evidence.trim().slice(0, TEXT_MAX) : '';
    if (evidence === '') { errors.push(`${where}（${v.ac}）缺 evidence：pass 写钉住它的测试 / 代码位置，fail 写 文件:行号 与原因`); return; }
    verdicts.push({
      ac: v.ac,
      verdict: v.verdict,
      evidence,
      note: typeof v.note === 'string' && v.note.trim() !== '' ? v.note.trim().slice(0, TEXT_MAX) : null,
    });
  });
  return { ok: errors.length === 0, errors, verdicts };
}

export function verdictsFileName(round) {
  return `reviewer-r${round}.verdicts.json`;
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * 当前版本（H + specSha）上的 review 覆盖情况。
 *   dossierDir —— dossier/<id>
 *   records    —— composeRecords 的输出（reviewer 记录带内核盖章的 head_sha / spec_sha）
 *   acIds      —— 冻结 spec 枚举出的全部 AC 编号
 * 返回 {
 *   rounds: [参与合并的轮次], judged: { [ac]: {verdict, evidence, note, round} },
 *   fails: [ac…], remaining: [ac…], unknown: [台账里出现但 spec 没有的编号],
 *   complete, allPass, tier, errors: [{round, errors}]
 * }
 */
export function reviewCoverage({ dossierDir, records, head, specSha = null, acIds = [] }) {
  const expected = new Set(acIds);
  const judged = {};
  const unknown = new Set();
  const rounds = [];
  const errors = [];
  let tier = null;

  const matching = (records ?? [])
    .filter((r) => r?.role === 'reviewer' && head != null && r.head_sha === head && (r.spec_sha ?? null) === (specSha ?? null))
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0));

  for (const rec of matching) {
    if (rec.product === 'ok' && rec.tier && (TIER_ORDER[rec.tier] ?? 0) > (TIER_ORDER[tier] ?? 0)) tier = rec.tier;
    const raw = readIf(path.join(dossierDir, verdictsFileName(rec.round)));
    if (raw == null) continue;
    const parsed = parseVerdicts(raw);
    if (parsed.errors.length > 0) errors.push({ round: rec.round, errors: parsed.errors });
    if (parsed.verdicts.length === 0) continue;
    rounds.push(rec.round);
    for (const v of parsed.verdicts) {
      if (!expected.has(v.ac)) { unknown.add(v.ac); continue; }
      judged[v.ac] = { verdict: v.verdict, evidence: v.evidence, note: v.note, round: rec.round }; // 同版本内后判覆盖先判
    }
  }

  const remaining = acIds.filter((a) => !Object.hasOwn(judged, a));
  const fails = acIds.filter((a) => judged[a]?.verdict === 'fail');
  const complete = acIds.length > 0 && remaining.length === 0;
  return {
    rounds,
    judged,
    fails,
    remaining,
    unknown: [...unknown],
    complete,
    allPass: complete && fails.length === 0,
    tier,
    errors,
  };
}

/** 事实段里的一行人话：judged 30/42，fail 2（AC-007, AC-013），未判 12：AC-031 … */
export function renderCoverage(cov, total) {
  if (cov == null) return '';
  const judgedN = Object.keys(cov.judged).length;
  const parts = [`已判 ${judgedN}/${total}`];
  parts.push(`fail ${cov.fails.length}${cov.fails.length > 0 ? `（${cov.fails.join(', ')}）` : ''}`);
  if (cov.remaining.length > 0) {
    const shown = cov.remaining.slice(0, 30).join(', ');
    parts.push(`未判 ${cov.remaining.length}：${shown}${cov.remaining.length > 30 ? ' …' : ''}`);
  }
  if (cov.unknown.length > 0) parts.push(`台账里有 spec 不存在的编号（已忽略）：${cov.unknown.join(', ')}`);
  if (cov.rounds.length > 0) parts.push(`来自 reviewer r${cov.rounds.join(' / r')}`);
  return parts.join('；');
}
