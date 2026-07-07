// lib/failure-signature.mjs — 绿门失败签名：三层稳定锚点（结构/测试身份/错误词）的哈希，
// 供 decisions.mjs 的连续性判断（sameSignatureStreak）与短路策略使用。纯函数，零 IO。
// 归一化在抽取前进行：剥 ANSI、耗时/时间戳/十六进制地址/PID 占位符化、折叠空白——
// 同一失败两轮的易变噪声（耗时数字、绝对路径前缀等）不得改变 hash。
import crypto from 'node:crypto';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DURATION_PAREN_RE = /\(\s*\d+(?:\.\d+)?\s*m?s\s*\)/g; // node:test 输出的 "(12.34ms)" 耗时
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const HEX_ADDR_RE = /\b0x[0-9a-fA-F]+\b/g;
const PID_RE = /\bpid[:=]?\s*\d+\b/gi;

function basenameOf(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? '');
}

function normalize(text) {
  let s = String(text ?? '');
  s = s.replace(ANSI_RE, '');
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(DURATION_PAREN_RE, '');
  s = s.replace(ISO_TS_RE, '<TS>');
  s = s.replace(HEX_ADDR_RE, '<HEX>');
  s = s.replace(PID_RE, 'pid <PID>');
  s = s.replace(/[ \t]+/g, ' ');
  return s.split('\n').map((l) => l.trim()).join('\n');
}

const TEST_AT_RE = /^test at (\S+):\d+:\d+$/;
const FAIL_MARK_RE = /^✖ (.+)$/;
const FAILING_HEADER = 'failing tests:';

/**
 * 失败测试身份集合：node:test 输出里 `test at <file>:<line>` 紧邻其后的 `✖ <测试名>` 行，
 * 文件部分归一为 basename。排序去重，格式 `<basename> :: <测试名>`（无法配对文件时退化为纯测试名）。
 */
function extractFailingTests(normalizedText) {
  const seen = new Set();
  let pendingFile = null;
  for (const raw of normalizedText.split('\n')) {
    const line = raw.trim();
    const testAt = line.match(TEST_AT_RE);
    if (testAt) { pendingFile = basenameOf(testAt[1]); continue; }
    const fail = line.match(FAIL_MARK_RE);
    if (fail) {
      const name = fail[1].trim();
      if (name === FAILING_HEADER) continue; // "✖ failing tests:" 是分节标题，非测试项
      seen.add(pendingFile ? `${pendingFile} :: ${name}` : name);
      pendingFile = null;
    }
  }
  return [...seen].sort();
}

const ERRNO_RE = /\bE[A-Z]{4,}\b/g;
const MODULE_RE = /Cannot find module '([^']+)'/g;
const ADDR_IN_USE_RE = /address already in use (\S+)/g;

/** 错误词层：白名单正则抽稳定 token（errno / Cannot find module / address already in use），排序去重。 */
function extractErrorTokens(normalizedText) {
  const tokens = new Set();
  for (const m of normalizedText.matchAll(ERRNO_RE)) tokens.add(m[0]);
  for (const m of normalizedText.matchAll(MODULE_RE)) tokens.add(`Cannot find module '${basenameOf(m[1])}'`);
  for (const m of normalizedText.matchAll(ADDR_IN_USE_RE)) tokens.add(`address already in use ${m[1]}`);
  return [...tokens].sort();
}

/**
 * 纯函数：green-gate-r<n>.json 记录 → { hash, failingTests[], errorTokens[] }。
 * hash = sha256(L1 结构层 command/exit_code/timed_out + L2 失败测试身份 + L3 错误词)。
 * 同一失败的两份记录（噪声不同：耗时/时间戳/路径前缀/ANSI）产出相同 hash；
 * 失败测试集合不同或错误 token 不同则 hash 不同。
 */
export function buildSignature(gateRecord) {
  const command = gateRecord?.command ?? null;
  const exitCode = gateRecord?.exit_code ?? null;
  const timedOut = Boolean(gateRecord?.timed_out);
  const normalized = normalize(`${gateRecord?.stdout_tail ?? ''}\n${gateRecord?.stderr_tail ?? ''}`);
  const failingTests = extractFailingTests(normalized);
  const errorTokens = extractErrorTokens(normalized);
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    command, exitCode, timedOut, failingTests, errorTokens,
  })).digest('hex');
  return { hash, failingTests, errorTokens };
}

/** 环境类错误码枚举（不对称设计：签名宁可偏细，唯环境类判定主动偏粗，避免误判代码类为环境类）。 */
export const ENV_FAILURE_ERRNOS = [
  'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EACCES', 'ENOSPC', 'EPERM', 'ENETUNREACH', 'ENOENT',
];

/** 签名是否属于环境类失败：errorTokens 命中环境枚举即 true；纯断言失败（无环境 token）为 false。 */
export function isEnvFailureSignature(sig) {
  const tokens = sig?.errorTokens ?? [];
  return tokens.some((t) => ENV_FAILURE_ERRNOS.includes(t));
}
