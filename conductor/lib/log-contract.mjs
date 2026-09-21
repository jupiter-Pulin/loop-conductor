// lib/log-contract.mjs — 执行 log（`dossier/<id>/<role>[-P-xxx]-r<n>.log.json`）的程序级契约。
// log 文件是 agent → 内核的唯一通道；这里是唯一裁判代码，Stop hook（hooks/check-log.mjs，
// 会话内快反馈）与记录合成（lib/records.mjs，权威读取）都只调它，两侧永远一个口径。
// 零 IO 纯函数：不读文件、不写文件、绝不抛错——「文件不是合法 log」本身就是一种校验结果。
//
// 语义边界（spec §执行 log 契约 第二条 / AC-007 / AC-011）：
//   - 四个通用字段由 agent 写（role / outcome / summary，加角色专属的 tier / action / packages）；
//     cost_usd、truncated、head_sha 等由内核在读取时盖章，**不在 agent log 里**，出现即非法。
//   - precommit 没有 agent：内核跑完三步自己合成一条同构记录，用 role="precommit" 走同一入口。
//   - 短 log 只是「交付信号 + 一段摘要」：summary 上限 2000 字符不放宽。长诊断、逐条 AC 判决、
//     调查结论走各自的完整产物（worker 的 `.report.md`、reviewer 的 `.verdicts.json`），
//     log 里只留结论与指路——证据不因长度限制而丢，也不必每轮整份重放。

import { validateAssignments } from './assignment-contract.mjs';

export const LOG_ROLES = Object.freeze(['router', 'spec', 'maker', 'reviewer', 'digest', 'worker']);
export const ACTIONS = Object.freeze(['spec', 'plan', 'maker', 'dispatch', 'review', 'precommit', 'human', 'merge', 'abandon']);
export const TIERS = Object.freeze(['unit', 'integration', 'e2e']);
export const PACKAGE_ID_RE = /^P-\d{3}$/;
export const SUMMARY_MAX = 2000;

/** 每个角色允许的 outcome 取值（spec §执行 log 契约 第二条的注释逐字）。 */
export const OUTCOMES_BY_ROLE = Object.freeze({
  router: Object.freeze(['ok']),
  spec: Object.freeze(['ok', 'needs_human']),
  // partial = 有进展但没做完（撞上限前增量写下的那一版）；内核不把它当完成，也不把它当失败。
  maker: Object.freeze(['ok', 'partial', 'fail', 'needs_human']),
  // reviewer 的 partial = 还有 AC 没判完；能不能放行由内核按判决台账重算，不看这个自述。
  reviewer: Object.freeze(['ok', 'partial', 'fail']),
  digest: Object.freeze(['ok', 'fail']),
  // blocked = 依赖失效 / 约束冲突，需要 router 调整计划；needs_human = 需要产品裁决。
  worker: Object.freeze(['ok', 'partial', 'blocked', 'fail', 'needs_human']),
  precommit: Object.freeze(['ok', 'fail']),
});

/** agent 写的 log 允许出现的字段（未知字段一律非法：防内核字段被 agent 自己盖章）。 */
const AGENT_FIELDS = Object.freeze([
  'role', 'outcome', 'tier', 'action', 'packages', 'summary',
  'assignments', 'guidance', // router：dispatch 的委派清单 / maker 动作的具体指导
  'done', 'remaining', // maker / worker：已完成项与未完成项（撞上限后下一轮据此续做）
]);

export const GUIDANCE_MAX = 4000;
export const PROGRESS_ITEMS_MAX = 60;
export const PROGRESS_ITEM_MAX = 300;

/** precommit 记录（内核合成）允许出现的字段。 */
const PRECOMMIT_FIELDS = Object.freeze([
  'role', 'outcome', 'tier', 'summary', 'cost_usd',
  'base_sha', 'head_sha', 'candidate_sha', 'steps', 'skipped_tiers', 'conflict_files',
]);

const PRECOMMIT_STEPS = Object.freeze(['build', 'service', 'unit', 'integration', 'e2e']);
const PRECOMMIT_STEP_STATUS = Object.freeze(['ok', 'fail', 'skipped', 'not_run']);
const PRECOMMIT_STEP_FIELDS = Object.freeze(['step', 'command', 'status', 'exit_code', 'timed_out', 'duration_ms', 'tail']);
const PRECOMMIT_SERVICE_FIELDS = Object.freeze(['ready_ms', 'pid', 'stopped']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkSummary(obj, errors) {
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    errors.push('summary 必填且非空字符串');
  } else if (obj.summary.length > SUMMARY_MAX) {
    errors.push(`summary 超长：${obj.summary.length} > ${SUMMARY_MAX} 字符`);
  }
}

function checkUnknownFields(obj, allowed, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`未知字段：${k}（本契约只接受 ${allowed.join(' / ')}）`);
  }
}

function validatePrecommitSteps(steps, errors) {
  if (!Array.isArray(steps)) {
    errors.push('steps 必填且为数组');
    return;
  }
  steps.forEach((s, i) => {
    if (!isPlainObject(s)) {
      errors.push(`steps[${i}] 必须是对象`);
      return;
    }
    if (!PRECOMMIT_STEPS.includes(s.step)) {
      errors.push(`steps[${i}].step 取值非法：${JSON.stringify(s.step)}（应为 ${PRECOMMIT_STEPS.join(' | ')}）`);
    }
    if (!PRECOMMIT_STEP_STATUS.includes(s.status)) {
      errors.push(`steps[${i}].status 取值非法：${JSON.stringify(s.status)}（应为 ${PRECOMMIT_STEP_STATUS.join(' | ')}）`);
    }
    for (const f of PRECOMMIT_STEP_FIELDS) {
      if (!Object.hasOwn(s, f)) errors.push(`steps[${i}] 缺字段 ${f}`);
    }
    if (s.step === 'service') {
      for (const f of PRECOMMIT_SERVICE_FIELDS) {
        if (!Object.hasOwn(s, f)) errors.push(`steps[${i}]（service）缺字段 ${f}`);
      }
    }
    const extra = Object.keys(s).filter(
      (k) => !PRECOMMIT_STEP_FIELDS.includes(k) && !(s.step === 'service' && PRECOMMIT_SERVICE_FIELDS.includes(k)),
    );
    for (const k of extra) errors.push(`steps[${i}] 未知字段：${k}`);
  });
}

/**
 * precommit 记录的同构校验（AC-011）：与 agent log 共用 role/outcome/tier/summary 的语义，
 * 另加内核事实（base_sha/head_sha/candidate_sha/steps/skipped_tiers/conflict_files）与 cost_usd: 0。
 */
function validatePrecommitRecord(obj) {
  const errors = [];
  if (obj.role !== 'precommit') errors.push(`role 必须为 "precommit"，实际 ${JSON.stringify(obj.role)}`);
  if (!OUTCOMES_BY_ROLE.precommit.includes(obj.outcome)) {
    errors.push(`outcome 取值非法：${JSON.stringify(obj.outcome)}（precommit 允许 ok | fail）`);
  }
  if (!TIERS.includes(obj.tier)) {
    errors.push(`tier 必填且取值为 ${TIERS.join(' | ')}，实际 ${JSON.stringify(obj.tier)}`);
  }
  checkSummary(obj, errors);
  if (obj.cost_usd !== 0) errors.push(`cost_usd 必须为 0（precommit 没有 agent），实际 ${JSON.stringify(obj.cost_usd)}`);
  for (const f of ['base_sha', 'head_sha', 'candidate_sha']) {
    if (!Object.hasOwn(obj, f)) errors.push(`缺字段 ${f}`);
  }
  validatePrecommitSteps(obj.steps, errors);
  if (!Array.isArray(obj.skipped_tiers)) errors.push('skipped_tiers 必填且为数组');
  if (!Array.isArray(obj.conflict_files)) errors.push('conflict_files 必填且为数组');
  checkUnknownFields(obj, PRECOMMIT_FIELDS, errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * 校验一份执行 log。
 *   obj  —— 已 JSON.parse 的对象（非对象即非法，不抛错）
 *   role —— 内核派出的角色：router | spec | maker | reviewer，或内核自合成的 precommit
 *           （方案模式的 spec-agent 仍是 "spec"）
 *   ctx  —— { planActive?: boolean }，只影响 router 的 packages 规则
 * 返回 { ok, errors }。
 */
export function validateLog(obj, role, ctx = {}) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['log 不是 JSON 对象'] };
  }
  if (role === 'precommit') return validatePrecommitRecord(obj);
  if (!LOG_ROLES.includes(role)) {
    return { ok: false, errors: [`期望角色非法：${JSON.stringify(role)}（应为 ${LOG_ROLES.join(' | ')} 或 precommit）`] };
  }

  const errors = [];
  if (obj.role !== role) {
    errors.push(`role 不匹配：log 写 ${JSON.stringify(obj.role)}，内核派出的是 ${JSON.stringify(role)}`);
  }
  const allowedOutcomes = OUTCOMES_BY_ROLE[role];
  if (!allowedOutcomes.includes(obj.outcome)) {
    errors.push(`outcome 取值非法：${JSON.stringify(obj.outcome)}（${role} 允许 ${allowedOutcomes.join(' | ')}）`);
  }
  checkSummary(obj, errors);

  // ---- action：router 必填且在闭集内；其余角色出现即非法 ----
  const hasAction = Object.hasOwn(obj, 'action');
  if (role === 'router') {
    if (!hasAction) errors.push('router 的 action 必填');
    else if (!ACTIONS.includes(obj.action)) {
      errors.push(`action 不在闭集内：${JSON.stringify(obj.action)}（${ACTIONS.join(' | ')}）`);
    }
  } else if (hasAction) {
    errors.push(`action 是 router 专属字段，${role} 不得出现`);
  }

  // ---- tier：reviewer 必填；router 选 precommit 时必填；其余角色出现即非法 ----
  const hasTier = Object.hasOwn(obj, 'tier');
  if (role === 'reviewer') {
    if (!hasTier) errors.push('reviewer 的 tier 必填（只有它冷读过 diff）');
    else if (!TIERS.includes(obj.tier)) errors.push(`tier 取值非法：${JSON.stringify(obj.tier)}（${TIERS.join(' | ')}）`);
  } else if (role === 'router') {
    if (obj.action === 'precommit') {
      if (!hasTier) errors.push('router 选 precommit 时 tier 必填');
      else if (!TIERS.includes(obj.tier)) errors.push(`tier 取值非法：${JSON.stringify(obj.tier)}（${TIERS.join(' | ')}）`);
    } else if (hasTier) {
      errors.push('tier 只在 action=precommit 时允许出现');
    }
  } else if (hasTier) {
    errors.push(`tier 是 reviewer / router(precommit) 专属字段，${role} 不得出现`);
  }

  // ---- packages：router 专属；仅 planActive 且 action=maker 时合法且必填 ----
  const hasPackages = Object.hasOwn(obj, 'packages');
  const packagesLegal = role === 'router' && ctx.planActive === true && obj.action === 'maker';
  if (packagesLegal) {
    if (!hasPackages) errors.push('有生效方案时 router 的 maker 动作必须点名 packages');
    else if (!Array.isArray(obj.packages) || obj.packages.length === 0) {
      errors.push('packages 必须是非空数组');
    } else {
      for (const p of obj.packages) {
        if (typeof p !== 'string' || !PACKAGE_ID_RE.test(p)) {
          errors.push(`packages 元素非法：${JSON.stringify(p)}（应匹配 ^P-\\d{3}$）`);
        }
      }
    }
  } else if (hasPackages) {
    if (role !== 'router') errors.push(`packages 是 router 专属字段，${role} 不得出现`);
    else if (ctx.planActive !== true) errors.push('无生效方案的任务不得出现 packages');
    else errors.push(`packages 只在 action=maker 时合法，action=${JSON.stringify(obj.action)} 不得出现`);
  }

  // ---- assignments：router 专属，dispatch 必填，其余动作不得出现 ----
  const hasAssignments = Object.hasOwn(obj, 'assignments');
  if (role === 'router' && obj.action === 'dispatch') {
    errors.push(...validateAssignments(obj.assignments));
  } else if (hasAssignments) {
    errors.push(role === 'router'
      ? `assignments 只在 action=dispatch 时合法，action=${JSON.stringify(obj.action)} 不得出现`
      : `assignments 是 router 专属字段，${role} 不得出现`);
  }

  // ---- guidance：router 选 maker 时可选的具体指导（逐字进 maker 的 prompt） ----
  if (Object.hasOwn(obj, 'guidance')) {
    if (role !== 'router' || obj.action !== 'maker') {
      errors.push('guidance 只在 router 的 action=maker 时合法（多任务委派用 dispatch 的 assignments）');
    } else if (typeof obj.guidance !== 'string' || obj.guidance.trim() === '' || obj.guidance.length > GUIDANCE_MAX) {
      errors.push(`guidance 须为非空字符串，≤ ${GUIDANCE_MAX} 字符`);
    }
  }

  // ---- done / remaining：maker / worker 的进度清单 ----
  for (const f of ['done', 'remaining']) {
    if (!Object.hasOwn(obj, f)) continue;
    if (role !== 'maker' && role !== 'worker') {
      errors.push(`${f} 是 maker / worker 专属字段，${role} 不得出现`);
    } else if (!Array.isArray(obj[f]) || obj[f].length > PROGRESS_ITEMS_MAX
      || obj[f].some((x) => typeof x !== 'string' || x.trim() === '' || x.length > PROGRESS_ITEM_MAX)) {
      errors.push(`${f} 须为字符串数组（≤ ${PROGRESS_ITEMS_MAX} 项，每项 ≤ ${PROGRESS_ITEM_MAX} 字符）`);
    }
  }

  checkUnknownFields(obj, AGENT_FIELDS, errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
