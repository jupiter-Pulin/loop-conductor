// lib/digest-contract.mjs — spec 摘要（spec-digest/v1）的程序级契约：**只做机械校验**。
//
// 摘要由专门的快速模型按固定 prompt（agents/digest-agent.md）生成，给 router 当「回到原文的入口」。
// 内核在这里只校三件事，全部不需要理解自然语言：
//   1. 格式：字段、类型、枚举、长度上限；
//   2. 来源版本：`source_sha256` 必须等于内核给出的那一版 spec 的 sha256；
//   3. 引用有效性：每个关键条目至少一条引用，行号在文档范围内，`quote` 必须逐字出现在所引行里；
//      AC 索引必须与内核枚举（state.enumerateAcceptanceCriteria）逐条相等——不多不少不重复，且每条 AC 的
//      引用必须覆盖内核算出的该 AC 定义行（所以 AC 引用的 quote 可省：真实 44 条 AC 的 spec 上，快速模型
//      行号全对、却爱把长句「概括」进 quote，白白作废整份摘要；定义行这个锚点比 quote 更硬）。
// 校验通过**不代表语义正确**：摘要有没有曲解原文，机械校验看不出来。所以 router 的 prompt 明说
// 「摘要与原文冲突以原文为准」，reviewer 与人审也永远读原文，不读摘要。
//
// 内核绝不改写、补全或替模型生成摘要：不合格就把错误清单原样喂回摘要 agent 让它自己改
// （Stop hook 会话内快反馈 + 内核有界重派），改不好就走显式降级（router 直接读原文）。
//
// 零 IO 纯函数，绝不抛错。

import { splitLines } from './spec-version.mjs';

export const DIGEST_SCHEMA = 'spec-digest/v1';
export const DIGEST_MAX_BYTES = 120_000;
export const ITEM_TEXT_MAX = 400;
export const QUOTE_MIN = 6;
export const QUOTE_MAX = 300;
export const REF_SPAN_MAX = 80;
export const REFS_PER_ITEM_MAX = 6;

export const CONSTRAINT_KINDS = Object.freeze(['must', 'should', 'must_not', 'invariant', 'non_goal']);
export const QUESTION_STATUS = Object.freeze(['unresolved', 'resolved_in_spec']);
export const PACKAGE_STATUS = 'proposal';

const TOP_FIELDS = Object.freeze([
  'schema', 'source_sha256', 'goal', 'constraints', 'acs', 'modules', 'open_questions', 'proposed_packages',
]);

const SECTION_FIELDS = Object.freeze({
  goal: ['text', 'refs'],
  constraints: ['text', 'kind', 'refs'],
  acs: ['id', 'gist', 'group', 'refs'],
  modules: ['name', 'text', 'refs'],
  open_questions: ['text', 'safe_default', 'status', 'refs'],
  proposed_packages: ['id', 'title', 'acs', 'depends_on', 'status', 'refs'],
});

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

/** quote 在全文里实际出现的行号（给模型自纠的提示；内核不据此改写任何东西）。 */
function findQuoteLines(lines, quote, limit = 3) {
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (lines[i].includes(quote)) hits.push(i + 1);
  }
  return hits;
}

function checkRef(ref, where, lines, errors, { quoteOptional = false } = {}) {
  if (!isPlainObject(ref)) { errors.push(`${where} 必须是对象 {lines:[起,止], quote}`); return null; }
  for (const k of Object.keys(ref)) {
    if (k !== 'lines' && k !== 'quote') errors.push(`${where} 未知字段：${k}`);
  }
  const range = ref.lines;
  if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
    errors.push(`${where}.lines 必须是两个整数 [起, 止]`);
    return null;
  }
  const [start, end] = range;
  if (start < 1 || end < start || end > lines.length) {
    errors.push(`${where}.lines=[${start},${end}] 越界：原文共 ${lines.length} 行，须满足 1 ≤ 起 ≤ 止 ≤ ${lines.length}`);
    return null;
  }
  if (end - start + 1 > REF_SPAN_MAX) {
    errors.push(`${where}.lines 跨度 ${end - start + 1} 行超过上限 ${REF_SPAN_MAX}（引用要能定位，不是整章）`);
    return null;
  }
  // AC 的引用另有更强的机械锚点（必须覆盖内核算出的那条 AC 的定义行），quote 可省；给了照样逐字核对。
  if (quoteOptional && !Object.hasOwn(ref, 'quote')) return { start, end };
  const quote = typeof ref.quote === 'string' ? ref.quote.trim() : '';
  if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX || quote.includes('\n')) {
    errors.push(`${where}.quote 必须是 ${QUOTE_MIN}–${QUOTE_MAX} 字符的单行原文片段`);
    return null;
  }
  const hit = lines.slice(start - 1, end).some((l) => l.includes(quote));
  if (!hit) {
    const actual = findQuoteLines(lines, quote);
    errors.push(
      `${where}.quote 没有逐字出现在 L${start}-${end}：${JSON.stringify(quote.slice(0, 60))}`
      + (actual.length > 0
        ? `（该片段实际在 L${actual.join(' / L')}）`
        // 给出所引行的原文开头只是帮模型对照着重抄（机械提示）：内核不替它选 quote，也不改摘要。
        : `（全文都找不到这个片段：quote 必须逐字复制、不得改写。L${start} 的原文开头是 ${JSON.stringify(lines[start - 1].trim().slice(0, 48))}，取其中连续的一小段即可）`),
    );
    return null;
  }
  return { start, end };
}

function checkRefs(item, where, lines, errors, opts = {}) {
  if (!Array.isArray(item.refs) || item.refs.length === 0) {
    errors.push(`${where}.refs 必填且至少一条（每个关键条目都要能回到原文）`);
    return [];
  }
  if (item.refs.length > REFS_PER_ITEM_MAX) errors.push(`${where}.refs 超过 ${REFS_PER_ITEM_MAX} 条`);
  const ok = [];
  item.refs.forEach((ref, i) => {
    const r = checkRef(ref, `${where}.refs[${i}]`, lines, errors, opts);
    if (r) ok.push(r);
  });
  return ok;
}

function checkUnknown(item, allowed, where, errors) {
  for (const k of Object.keys(item)) {
    if (!allowed.includes(k)) errors.push(`${where} 未知字段：${k}（只接受 ${allowed.join(' / ')}）`);
  }
}

/**
 * 每条 AC 的定义行（1 基行号）。口径与 state.mjs::enumerateAcceptanceCriteria 一致：
 * 「## 验收标准」段内的列表项，带 AC-### 标签的按标签归一，否则按位置编号。
 */
export function acDefinitionLines(lines) {
  const map = new Map();
  const start = lines.findIndex((l) => l.trim().startsWith('## 验收标准'));
  if (start === -1) return map;
  let index = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = lines[i].match(/^\s*-\s+(.*)$/);
    if (!m) continue;
    const text = m[1].replace(/^\[[ xX]\]\s*/, '').trim();
    if (text === '') continue;
    index += 1;
    const tagged = text.match(/AC-(\d+)/);
    const id = tagged ? `AC-${String(Number(tagged[1])).padStart(3, '0')}` : `AC-${String(index).padStart(3, '0')}`;
    if (!map.has(id)) map.set(id, i + 1);
  }
  return map;
}

/**
 * 校验一份摘要。
 *   obj      —— 已 JSON.parse 的对象
 *   specText —— 内核交给摘要 agent 的那一版 spec 原文
 *   specSha  —— 该原文的 sha256
 *   acIds    —— 内核枚举出的 AC 编号（顺序无关）
 * 返回 { ok, errors, stats }。
 */
export function validateDigest(obj, { specText, specSha, acIds = [] } = {}) {
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ['摘要不是 JSON 对象'], stats: null };
  const lines = splitLines(specText);

  checkUnknown(obj, TOP_FIELDS, '摘要', errors);
  if (obj.schema !== DIGEST_SCHEMA) errors.push(`schema 必须为 ${JSON.stringify(DIGEST_SCHEMA)}`);
  if (obj.source_sha256 !== specSha) {
    errors.push(`source_sha256 不匹配：摘要写 ${JSON.stringify(obj.source_sha256)}，当前 spec 版本是 ${specSha}（过期或抄错）`);
  }

  for (const section of Object.keys(SECTION_FIELDS)) {
    if (!Array.isArray(obj[section])) errors.push(`${section} 必填且为数组（没有内容就给空数组）`);
  }
  if (Array.isArray(obj.goal) && obj.goal.length === 0) errors.push('goal 至少一条');

  const each = (section, fn) => {
    if (!Array.isArray(obj[section])) return;
    obj[section].forEach((item, i) => {
      const where = `${section}[${i}]`;
      if (!isPlainObject(item)) { errors.push(`${where} 必须是对象`); return; }
      checkUnknown(item, SECTION_FIELDS[section], where, errors);
      fn(item, where);
    });
  };

  each('goal', (item, where) => {
    if (!isNonEmptyString(item.text, ITEM_TEXT_MAX)) errors.push(`${where}.text 必填，≤ ${ITEM_TEXT_MAX} 字符`);
    checkRefs(item, where, lines, errors);
  });

  each('constraints', (item, where) => {
    if (!isNonEmptyString(item.text, ITEM_TEXT_MAX)) errors.push(`${where}.text 必填，≤ ${ITEM_TEXT_MAX} 字符`);
    if (!CONSTRAINT_KINDS.includes(item.kind)) errors.push(`${where}.kind 取值非法（${CONSTRAINT_KINDS.join(' | ')}）`);
    checkRefs(item, where, lines, errors);
  });

  // ---- AC 索引：必须与内核枚举逐条相等 ----
  const acDefLines = acDefinitionLines(lines);
  const expected = new Set(acIds);
  const seen = new Set();
  each('acs', (item, where) => {
    if (typeof item.id !== 'string' || !expected.has(item.id)) {
      errors.push(`${where}.id=${JSON.stringify(item.id)} 不在原文的 AC 编号里（内核枚举：${acIds.length} 条）`);
    } else if (seen.has(item.id)) {
      errors.push(`${where}.id 重复：${item.id}`);
    }
    if (typeof item.id === 'string') seen.add(item.id);
    if (!isNonEmptyString(item.gist, ITEM_TEXT_MAX)) errors.push(`${where}.gist 必填，≤ ${ITEM_TEXT_MAX} 字符`);
    if (item.group != null && !isNonEmptyString(item.group, 80)) errors.push(`${where}.group 须为 ≤ 80 字符的字符串`);
    const refs = checkRefs(item, where, lines, errors, { quoteOptional: true });
    // 引用必须覆盖这条 AC 的**定义行**（「验收标准」段里那条列表项），而不是任何一处顺带提到它编号的地方
    // ——否则把 AC-001 的引用指到「工作包 P-001 主责 AC-001」那一行也能过。
    const defLine = acDefLines.get(item.id);
    if (typeof item.id === 'string' && expected.has(item.id) && refs.length > 0 && defLine != null
      && !refs.some((r) => r.start <= defLine && defLine <= r.end)) {
      errors.push(`${where}（${item.id}）的引用没有覆盖它在「验收标准」段里的定义行 L${defLine}：引用必须指向这条 AC 自己`);
    }
  });
  const missing = acIds.filter((a) => !seen.has(a));
  if (missing.length > 0) {
    errors.push(`acs 缺 ${missing.length} 条：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}（索引必须覆盖全部 AC，不得裁剪）`);
  }

  each('modules', (item, where) => {
    if (!isNonEmptyString(item.name, 160)) errors.push(`${where}.name 必填，≤ 160 字符`);
    if (!isNonEmptyString(item.text, ITEM_TEXT_MAX)) errors.push(`${where}.text 必填，≤ ${ITEM_TEXT_MAX} 字符`);
    checkRefs(item, where, lines, errors);
  });

  each('open_questions', (item, where) => {
    if (!isNonEmptyString(item.text, ITEM_TEXT_MAX)) errors.push(`${where}.text 必填，≤ ${ITEM_TEXT_MAX} 字符`);
    if (item.safe_default != null && !isNonEmptyString(item.safe_default, ITEM_TEXT_MAX)) {
      errors.push(`${where}.safe_default 须为 ≤ ${ITEM_TEXT_MAX} 字符的字符串`);
    }
    if (!QUESTION_STATUS.includes(item.status)) {
      errors.push(`${where}.status 取值非法（${QUESTION_STATUS.join(' | ')}）：待决问题与它的 safe default 不是已批准事实`);
    }
    checkRefs(item, where, lines, errors);
  });

  const pkgIds = new Set((Array.isArray(obj.proposed_packages) ? obj.proposed_packages : [])
    .map((p) => p?.id).filter((v) => typeof v === 'string'));
  each('proposed_packages', (item, where) => {
    if (!isNonEmptyString(item.id, 40)) errors.push(`${where}.id 必填`);
    if (!isNonEmptyString(item.title, 200)) errors.push(`${where}.title 必填，≤ 200 字符`);
    if (item.status !== PACKAGE_STATUS) {
      errors.push(`${where}.status 必须是 ${JSON.stringify(PACKAGE_STATUS)}：原 spec 的工作包只是提议，不是已批准的执行计划`);
    }
    if (!Array.isArray(item.acs) || item.acs.some((a) => !expected.has(a))) {
      errors.push(`${where}.acs 必须是原文 AC 编号的数组`);
    }
    if (!Array.isArray(item.depends_on) || item.depends_on.some((d) => !pkgIds.has(d))) {
      errors.push(`${where}.depends_on 必须是本摘要里出现过的工作包 id 数组`);
    }
    checkRefs(item, where, lines, errors);
  });

  const stats = {
    goal: obj.goal?.length ?? 0,
    constraints: obj.constraints?.length ?? 0,
    acs: obj.acs?.length ?? 0,
    modules: obj.modules?.length ?? 0,
    open_questions: obj.open_questions?.length ?? 0,
    proposed_packages: obj.proposed_packages?.length ?? 0,
  };
  // 错误清单封顶：喂回模型的反馈太长反而修不动。
  const capped = errors.length > 40 ? [...errors.slice(0, 40), `… 另有 ${errors.length - 40} 条同类错误`] : errors;
  return errors.length === 0 ? { ok: true, errors: [], stats } : { ok: false, errors: capped, stats };
}

/** 原始文件内容 → { ok, errors, stats, digest }：把「读不出来 / 不是 JSON / 超长」也归成校验结果。 */
export function validateDigestText(raw, ctx) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, errors: ['摘要文件缺失或为空'], stats: null, digest: null };
  }
  if (Buffer.byteLength(raw, 'utf8') > DIGEST_MAX_BYTES) {
    return { ok: false, errors: [`摘要超过 ${DIGEST_MAX_BYTES} 字节上限：摘要是索引，不是第二份 spec`], stats: null, digest: null };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: [`摘要不是合法 JSON：${e.message}`], stats: null, digest: null };
  }
  return { ...validateDigest(parsed, ctx), digest: parsed };
}

// ---- 渲染（router prompt 用）：紧凑文本，每条带 Lx-y 引用 ----

function refsText(refs) {
  return (refs ?? []).map((r) => `L${r.lines[0]}${r.lines[1] !== r.lines[0] ? `-${r.lines[1]}` : ''}`).join(',');
}

export function renderDigestForRouter(digest) {
  if (!isPlainObject(digest)) return '';
  const out = [];
  const push = (title, rows) => { if (rows.length > 0) out.push(`${title}：`, ...rows, ''); };
  push('目标', (digest.goal ?? []).map((g) => `- ${g.text} [${refsText(g.refs)}]`));
  push('硬约束', (digest.constraints ?? []).map((c) => `- (${c.kind}) ${c.text} [${refsText(c.refs)}]`));
  push('AC 索引（验收依据永远是原文，这里只是目录）', (digest.acs ?? []).map(
    (a) => `- ${a.id}${a.group ? `〔${a.group}〕` : ''} ${a.gist} [${refsText(a.refs)}]`,
  ));
  push('涉及模块', (digest.modules ?? []).map((m) => `- ${m.name}：${m.text} [${refsText(m.refs)}]`));
  push('未决问题（safe default 只是原文的提议，不是已批准事实）', (digest.open_questions ?? []).map(
    (q) => `- (${q.status}) ${q.text}${q.safe_default ? `｜safe default：${q.safe_default}` : ''} [${refsText(q.refs)}]`,
  ));
  push('原 spec 提议的工作包（提议，不是强制计划；怎么拆、什么顺序由你定）', (digest.proposed_packages ?? []).map(
    (p) => `- ${p.id} ${p.title}｜AC：${(p.acs ?? []).join(',') || '-'}｜依赖：${(p.depends_on ?? []).join(',') || '-'} [${refsText(p.refs)}]`,
  ));
  return out.join('\n').trim();
}
