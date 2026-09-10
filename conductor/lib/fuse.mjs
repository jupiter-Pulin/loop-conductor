// lib/fuse.mjs — 保险丝（AC-024）：不数步数，数「无进展」。
//
// 每条失败记录压成一个签名；同一 `(role, package)` 上连续 fuseStreak 条签名相同 →
// 收箱 FAILED_BOX(fuse_no_progress)。正经工作每轮改变事实（改了别的文件、挂了别的用例、
// 换了 tier），死循环不改变——这根保险丝因此不会误杀正经花费，只杀原地打转。
//
// 签名口径（spec §保险丝 逐字）：
//   precommit —— 失败步骤名 + 命令 + failure-signature.mjs::buildSignature(tail)
//   reviewer  —— tier + 排序后的 fail AC 编号 + 各 fail 首行
//   maker     —— (package, outcome, summary 首行)
//
// 两处「无签名」的判定（spec 未逐字规定，取「连续 3 次同因失败停止」的标题口径）：
//   - precommit 记录没有 status=fail 的步（候选冲突、lock_timeout、以及 outcome=ok）→ null。
//     没有失败步就没有「同因」可比；lock_timeout 是别的任务占着锁，不是本任务无进展。
//   - reviewer outcome=ok → null（reviewer 的签名整个由 fail 行构成，全 pass 时无内容）。
//   maker 反之：spec 把 outcome 写进了 maker 的签名式，ok 记录照样参与——连续三轮同一句
//   「已完成」而整体 review 一直不过，正是要拦的那种打转。
//
// 零 IO 纯函数：入参是 records.mjs::composeRecords 的输出，不读盘、不写盘、不抛错。

import crypto from 'node:crypto';
import { buildSignature } from './failure-signature.mjs';

/** 参与保险丝的角色（router / spec / human 不参与：它们不是「重复失败」的载体）。 */
export const FUSE_ROLES = Object.freeze(['precommit', 'reviewer', 'maker']);

/** reviewer summary 里的一条 fail 行：`AC-002 fail src/x.mjs:40 <原因>`（无 spec 时编号为 B-00x）。 */
const REVIEWER_FAIL_RE = /^((?:AC|B)-\d+)\s+fail\b/;

function hash16(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function firstLine(text) {
  if (typeof text !== 'string') return '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/** 逐行抽 fail 项，按 AC 编号排序去重（同一 AC 多行只取首行——「各 fail 首行」）。 */
function reviewerFailLines(summary) {
  const byId = new Map();
  for (const raw of String(summary ?? '').split('\n')) {
    const line = raw.trim();
    const m = line.match(REVIEWER_FAIL_RE);
    if (m && !byId.has(m[1])) byId.set(m[1], line);
  }
  return [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function precommitSignature(rec) {
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const failed = steps.find((s) => s?.status === 'fail');
  if (!failed) return null; // 没有失败步（ok / 候选冲突 / lock_timeout）→ 无「同因」可比
  const sig = buildSignature({
    command: failed.command ?? null,
    exit_code: failed.exit_code ?? null,
    timed_out: Boolean(failed.timed_out),
    stdout_tail: failed.tail ?? '',
    stderr_tail: '',
  });
  return `precommit|${failed.step}|${hash16([failed.step, failed.command ?? null, sig.hash])}`;
}

function reviewerSignature(rec) {
  if (rec.outcome === 'ok') return null; // 全 pass 无 fail 行，签名无内容
  const fails = reviewerFailLines(rec.summary);
  return `reviewer|${rec.tier ?? '-'}|${hash16([rec.tier ?? null, fails])}`;
}

function makerSignature(rec) {
  const pkg = rec.package ?? null;
  return `maker|${pkg ?? '-'}|${rec.outcome ?? '-'}|${hash16([pkg, rec.outcome ?? null, firstLine(rec.summary)])}`;
}

/**
 * 一条记录 → 签名字符串；不参与保险丝或不构成「失败」的记录返回 null。
 * 返回值前缀带角色与可读锚点（步名 / tier / 包），便于 `fuse_tripped{signature}` 事件被人一眼看懂。
 */
export function signatureOf(record) {
  if (record == null || typeof record !== 'object') return null;
  switch (record.role) {
    case 'precommit': return precommitSignature(record);
    case 'reviewer': return reviewerSignature(record);
    case 'maker': return makerSignature(record);
    default: return null;
  }
}

function groupKey(rec) {
  return `${rec.role} ${rec.package ?? ''}`;
}

/**
 * 同一 `(role, package)` 上尾部连续 fuseStreak 条签名相同 → { role, package, signature }，否则 null。
 *
 * - `fuseStreak: 0`（或非正数）永不触发，spec 的关闭开关。
 * - 只看**尾部**连击：中间断过的旧连击不再算数；无签名的记录（ok / 冲突 / lock_timeout）
 *   出现即打断本组连击，绝不「跳过它继续数」。
 * - `sinceRound`：人 `retry` 后连击计数从零开始（Edge Case「保险丝触发后人 retry」），
 *   内核把复位轮次传进来即可，本函数不读任何状态。
 * - 多组同时触发时取尾部记录最靠后的那一组（最新发生的那次打转）。
 */
export function checkFuse(records, fuseStreak, { sinceRound = 0 } = {}) {
  const streak = Number(fuseStreak);
  if (!Number.isFinite(streak) || streak < 1) return null;

  const groups = new Map();
  (records ?? []).forEach((rec, index) => {
    if (rec == null || !FUSE_ROLES.includes(rec.role)) return;
    if (Number.isFinite(rec.round) && rec.round < sinceRound) return;
    const key = groupKey(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ index, rec, signature: signatureOf(rec) });
  });

  let best = null;
  for (const entries of groups.values()) {
    if (entries.length < streak) continue;
    const tail = entries.slice(-streak);
    const signature = tail[0].signature;
    if (signature == null) continue;
    if (!tail.every((e) => e.signature === signature)) continue;
    const lastIndex = tail[tail.length - 1].index;
    if (best == null || lastIndex > best.lastIndex) {
      best = { lastIndex, role: tail[0].rec.role, package: tail[0].rec.package ?? null, signature };
    }
  }
  if (best == null) return null;
  return { role: best.role, package: best.package, signature: best.signature };
}
