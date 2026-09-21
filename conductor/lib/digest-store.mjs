// lib/digest-store.mjs — 摘要的落盘布局与「当前这版 spec 的摘要能不能用」的判定。
//
// 布局（全部在 dossier/<id>/digest/ 下，文件名按 spec 内容哈希取，不按路径）：
//   <sha12>.json       —— 摘要 agent 写的摘要本体。内核**只读不改**。
//   <sha12>.meta.json  —— 内核写的元数据：来源版本、prompt 哈希、模型、逐次尝试与校验结果。
//
// 判定永远是现算的：每次要用摘要，都拿盘上的摘要对**此刻**的 spec 原文重跑一遍机械校验。
// meta 里的 valid 只是留档，不是依据——人在闸上改了 spec、或摘要文件被动过，现算都能发现。
// 因此「过期摘要」「引用失效的摘要」不可能被当成有效摘要交给 router。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic, enumerateAcceptanceCriteria } from './state.mjs';
import { shortSha } from './spec-version.mjs';
import { validateDigestText } from './digest-contract.mjs';

export const DEFAULT_DIGEST_MAX_ATTEMPTS = 3;

export function digestDir(cfg, id) {
  return path.join(cfg.dossierDir, id, 'digest');
}

export function digestPath(cfg, id, specSha) {
  return path.join(digestDir(cfg, id), `${shortSha(specSha)}.json`);
}

export function digestMetaPath(cfg, id, specSha) {
  return path.join(digestDir(cfg, id), `${shortSha(specSha)}.meta.json`);
}

/**
 * 该版本 spec 原文的快照（内核写，摘要的引用坐标系）。草稿之后会被归档、冻结、甚至被人继续改，
 * 而摘要里的行号引用只对**这一版**成立——留一份按哈希命名的快照，引用就永远能回到原文，
 * 文件怎么搬家都不影响。读取方必须用 sha 复核（readDigestSource）。
 */
export function digestSourcePath(cfg, id, specSha) {
  return path.join(digestDir(cfg, id), `${shortSha(specSha)}.source.md`);
}

export function writeDigestSource(cfg, id, spec) {
  const p = digestSourcePath(cfg, id, spec.sha256);
  if (readIf(p) !== spec.text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, spec.text);
  }
  return p;
}

/** 快照原文；不存在或哈希对不上（被动过）返回 null。 */
export function readDigestSource(cfg, id, specSha) {
  const text = readIf(digestSourcePath(cfg, id, specSha));
  if (text == null) return null;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex') === specSha ? text : null;
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 固定 prompt 的指纹：摘要是按哪一版 prompt 生成的，要能追溯。 */
export function digestPromptSha(cfg) {
  const text = readIf(path.join(cfg.root, 'agents', 'digest-agent.md')) ?? '';
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestMaxAttempts(cfg) {
  const n = Number(cfg?.digestMaxAttempts);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DIGEST_MAX_ATTEMPTS;
}

export function readDigestMeta(cfg, id, specSha) {
  const meta = readJsonIf(digestMetaPath(cfg, id, specSha));
  return {
    schema_version: 1,
    spec_sha256: specSha,
    attempts: [],
    valid: false,
    ...(meta ?? {}),
    attempts: Array.isArray(meta?.attempts) ? meta.attempts : [],
  };
}

export function writeDigestMeta(cfg, id, specSha, meta) {
  writeJsonAtomic(digestMetaPath(cfg, id, specSha), meta);
  return meta;
}

/**
 * 当前这版 spec 的摘要状态（现算）。spec = spec-version.mjs::currentSpec 的返回值。
 *   valid     —— 摘要在盘上且对当前原文通过机械校验
 *   missing   —— 这一版还没有摘要（新 spec / 人改过 spec / 升级前的任务）
 *   invalid   —— 有文件但不合格（errors 附原因），还有重试额度
 *   exhausted —— 尝试次数用完仍不合格：降级，router 直接读原文（显式可见，不是静默）
 */
export function digestStateFor(cfg, id, spec) {
  if (spec == null) return { state: 'none', path: null, digest: null, errors: [], meta: null, attempts: 0 };
  const p = digestPath(cfg, id, spec.sha256);
  const meta = readDigestMeta(cfg, id, spec.sha256);
  const attempts = meta.attempts.length;
  const raw = readIf(p);
  const max = digestMaxAttempts(cfg);
  if (raw == null) {
    return { state: attempts >= max ? 'exhausted' : 'missing', path: p, digest: null, errors: [], meta, attempts };
  }
  const acIds = enumerateAcceptanceCriteria(spec.text).map((a) => a.ac_id);
  const check = validateDigestText(raw, { specText: spec.text, specSha: spec.sha256, acIds });
  if (check.ok) return { state: 'valid', path: p, digest: check.digest, errors: [], meta, attempts, stats: check.stats };
  return { state: attempts >= max ? 'exhausted' : 'invalid', path: p, digest: null, errors: check.errors, meta, attempts };
}

/** 人要求重做（`conductor digest <id> --force`）：旧摘要归档，尝试计数清零。旧文件不删。 */
export function resetDigest(cfg, id, specSha) {
  const p = digestPath(cfg, id, specSha);
  const stamp = Date.now();
  if (fs.existsSync(p)) fs.renameSync(p, `${p}.replaced-${stamp}`);
  const metaP = digestMetaPath(cfg, id, specSha);
  if (fs.existsSync(metaP)) fs.renameSync(metaP, `${metaP}.replaced-${stamp}`);
}
