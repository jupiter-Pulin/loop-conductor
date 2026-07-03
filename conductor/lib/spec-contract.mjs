// lib/spec-contract.mjs — spec 交付文档（specs/<id>.md）的程序级契约（spec-doc/v1）。
// 唯一裁判代码：Stop hook（conductor/hooks/check-spec.mjs，会话内快反馈）与
// conductor 契约门（stages/shared.mjs::runSpecContractGate，权威终审）都只调这里，
// 两侧永远一个口径。内容质量（背景/现状是否充分）归 spec-verifier 裁决，不在此契约内；
// 本契约只钉死机器必需的锚点：AC 段标题逐字一致 + 至少一条可枚举 AC + 编号无重复。
import { AC_SECTION_TITLE, extractSection, enumerateAcceptanceCriteria } from './state.mjs';

export const SPEC_DOC_CONTRACT = Object.freeze({
  id: 'spec-doc/v1',
  schemaVersion: 1,
  acSectionTitle: AC_SECTION_TITLE,
  minAcItems: 1,
});

/**
 * 校验 spec 文档全文。返回 { ok, errors, acs }；acs = [{ ac_id, text }]（枚举结果，
 * ok=false 时可能不完整）。绝不抛错——文档缺失/为空也是一种校验失败。
 */
export function validateSpecDoc(specMd) {
  if (typeof specMd !== 'string' || specMd.trim() === '') {
    return {
      ok: false,
      errors: [`spec 文档缺失或为空（应为完整 Markdown，含「## ${AC_SECTION_TITLE}」段）`],
      acs: [],
    };
  }
  const errors = [];
  const section = extractSection(specMd, AC_SECTION_TITLE);
  if (section == null) {
    errors.push(
      `缺少「## ${AC_SECTION_TITLE}」段：标题必须逐字为「## ${AC_SECTION_TITLE}」，` +
      '不接受同义标题（如 Acceptance Criteria / AC / 可验证标准）',
    );
    return { ok: false, errors, acs: [] };
  }
  const acs = enumerateAcceptanceCriteria(specMd);
  if (acs.length < SPEC_DOC_CONTRACT.minAcItems) {
    errors.push(
      `「## ${AC_SECTION_TITLE}」段没有可枚举的条目：每条验收标准必须是 \`- AC-xxx: 可验证描述\` 形式的列表项`,
    );
  }
  const seen = new Set();
  for (const a of acs) {
    if (seen.has(a.ac_id)) {
      errors.push(`AC 编号重复：${a.ac_id}（带 AC-### 标签的条目按标签归一，未标号条目按位置编号，两者不得冲突）`);
    }
    seen.add(a.ac_id);
  }
  if (errors.length > 0) return { ok: false, errors, acs };
  return { ok: true, errors: [], acs };
}
