// lib/feasibility-contract.mjs — feasibility 交付文档（<taskdir>/feasibility-study.md）的
// 程序级契约（feasibility-doc/v1）。唯一裁判代码：Stop hook（conductor/hooks/check-feasibility.mjs，
// 会话内快反馈）与 conductor 契约门（stages/shared.mjs::runFeasibilityContractGate，权威终审）
// 都只调这里，两侧永远一个口径。内容质量（证据是否扎实、取舍是否成立）归人审闸门裁决，
// 不在此契约内；本契约只钉死机器必需的锚点：
//   1. 「## 选项对比」段存在且可枚举 ≥minOptions 个稳定 option ID（O-X），无重复——
//      approve-feasibility --option 要能机械校验所选 option 存在；
//   2. 「## 推荐」段存在且引用的 option ID 全部真实存在、至少引用一个；
//   3. 「## 开放问题」段存在（每条须带 safe default，质量归人审）。
import { extractSection } from './state.mjs';

export const OPTION_SECTION_TITLE = '选项对比';
export const RECOMMENDATION_SECTION_TITLE = '推荐';
export const OPEN_QUESTIONS_SECTION_TITLE = '开放问题';

export const FEASIBILITY_DOC_CONTRACT = Object.freeze({
  id: 'feasibility-doc/v1',
  schemaVersion: 1,
  optionSectionTitle: OPTION_SECTION_TITLE,
  recommendationSectionTitle: RECOMMENDATION_SECTION_TITLE,
  openQuestionsSectionTitle: OPEN_QUESTIONS_SECTION_TITLE,
  minOptions: 2,
});

// option ID：O- 后跟大写字母/数字（O-A、O-B、O-1…）。全词匹配，防 O-Auth 之类误吞。
const OPTION_ID_RE = /O-[A-Z0-9]+(?![A-Za-z0-9-])/g;

/**
 * 枚举「## 选项对比」段里的 option。两种承载形态都认（表格行首格 / 列表项开头），
 * 其余行忽略；返回 [{ option_id, text }]（text 为该行去掉表格线/列表符后的原文，供人排查）。
 */
export function enumerateOptions(md) {
  const section = extractSection(md, OPTION_SECTION_TITLE);
  if (section == null) return [];
  const options = [];
  for (const raw of section.split('\n')) {
    // 表格数据行：首格以 O-X 开头（跳过表头与 |---| 分隔行）。
    const tableCell = raw.match(/^\s*\|\s*(?:\*\*)?(O-[A-Z0-9]+)(?![A-Za-z0-9-])/);
    // 列表项：`- O-X: …` 形态。
    const listItem = raw.match(/^\s*-\s+(?:\*\*)?(O-[A-Z0-9]+)(?![A-Za-z0-9-])/);
    const m = tableCell ?? listItem;
    if (!m) continue;
    options.push({
      option_id: m[1],
      text: raw.replace(/^\s*\|\s*/, '').replace(/^\s*-\s+/, '').trim(),
    });
  }
  return options;
}

/**
 * 校验 feasibility 文档全文。返回 { ok, errors, options }；options 为枚举结果
 * （ok=false 时可能不完整）。绝不抛错——文档缺失/为空也是一种校验失败。
 */
export function validateFeasibilityDoc(md) {
  if (typeof md !== 'string' || md.trim() === '') {
    return {
      ok: false,
      errors: [`feasibility 文档缺失或为空（应为完整 Markdown，含「## ${OPTION_SECTION_TITLE}」等段）`],
      options: [],
    };
  }
  const errors = [];

  const optionSection = extractSection(md, OPTION_SECTION_TITLE);
  if (optionSection == null) {
    errors.push(
      `缺少「## ${OPTION_SECTION_TITLE}」段：标题必须逐字为「## ${OPTION_SECTION_TITLE}」，` +
      '不接受同义标题（如 Option Comparison / 方案对比）',
    );
  }
  const options = enumerateOptions(md);
  if (optionSection != null && options.length < FEASIBILITY_DOC_CONTRACT.minOptions) {
    errors.push(
      `「## ${OPTION_SECTION_TITLE}」段可枚举 option 不足 ${FEASIBILITY_DOC_CONTRACT.minOptions} 个：` +
      '每个 option 必须以稳定 ID 开头（表格行首格或列表项，形如 `O-A`、`O-B`）',
    );
  }
  const seen = new Set();
  for (const o of options) {
    if (seen.has(o.option_id)) errors.push(`option ID 重复：${o.option_id}`);
    seen.add(o.option_id);
  }

  const recommendation = extractSection(md, RECOMMENDATION_SECTION_TITLE);
  if (recommendation == null) {
    errors.push(`缺少「## ${RECOMMENDATION_SECTION_TITLE}」段：必须明确推荐某个 option（人审可推翻，但你必须表态）`);
  } else {
    const mentioned = [...new Set(recommendation.match(OPTION_ID_RE) ?? [])];
    if (mentioned.length === 0) {
      errors.push(`「## ${RECOMMENDATION_SECTION_TITLE}」段未引用任何 option ID（须点名如 O-A）`);
    }
    for (const id of mentioned) {
      if (!seen.has(id)) errors.push(`「## ${RECOMMENDATION_SECTION_TITLE}」引用了不存在的 option：${id}`);
    }
  }

  if (extractSection(md, OPEN_QUESTIONS_SECTION_TITLE) == null) {
    errors.push(
      `缺少「## ${OPEN_QUESTIONS_SECTION_TITLE}」段：未知项必须显式列出且每条带 safe default（确实没有时写「（无）」）`,
    );
  }

  if (errors.length > 0) return { ok: false, errors, options };
  return { ok: true, errors: [], options };
}
