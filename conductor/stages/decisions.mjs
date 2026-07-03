// stages/decisions.mjs — 状态机的全部转移分支，纯函数化（契约 §3 §5），单测直击。
// 不做任何 IO；handler 只是「读盘 → 调这里 → 落盘」。

export const STAGES = [
  'NEEDS_TARGET_SETUP',
  'AWAIT_SETUP_APPROVAL',
  'NEEDS_SPEC',
  'SPEC_VERIFY',
  'SPEC_FIXING',
  'AWAIT_SPEC_APPROVAL',
  'READY',
  'VERIFY',
  'FIXING',
  'AWAIT_HUMAN_MERGE',
  'FAILED_BOX',
];

export const MAX_MISS = 3;

/** verifier verdict 的程序级契约：prompt/agent 只引用它，真正裁判仍是 validateVerifierVerdict。 */
export const VERIFIER_VERDICT_CONTRACT = Object.freeze({
  id: 'verifier-verdict/v1',
  schemaVersion: 1,
  overallValues: Object.freeze(['pass', 'fail']),
  criterionStatuses: Object.freeze(['pass', 'fail', 'unknown']),
});

/** spec-verifier 的程序级契约：包含机器路由字段 + 人类/spec-agent 可读报告字段。 */
export const SPEC_VERIFIER_CONTRACT = Object.freeze({
  id: 'spec-verifier-verdict/v1',
  schemaVersion: 1,
  overallValues: Object.freeze(['pass', 'fail']),
  severities: Object.freeze(['blocker', 'major', 'minor']),
  audiences: Object.freeze(['human', 'spec-agent', 'both']),
});

/**
 * spawn 双标记判定：none | in-progress（上次崩溃）| done。
 * 崩溃收箱语义只对 maker 生效：maker 是唯一改 worktree 的角色，孤儿标记（有 started 无 done）
 * 意味着 worktree 可能停在半改状态，必须 FAILED_BOX(crashed) 等人工 retry（见 ready/fixing）。
 * 只读角色（setup/spec/spec-verifier/verifier）的崩溃残留有两种自然结局：同轮重 spawn 被覆盖
 * （经 startSpawnRecord 的 superseded 数组留档）、或跳号留下孤儿记录（spec-agent 走 nextRoleRound）；
 * 它们不改 worktree，重跑无害，所以不收箱。
 */
export function markerStatus(marker) {
  if (!marker || typeof marker !== 'object') return 'none';
  if (marker.abandoned) return 'none'; // 人工 retry 清理后的标记
  if (marker.done) return 'done';
  if (marker.started) return 'in-progress';
  return 'none';
}

/** 预算闸：达到上限即拒绝 spawn。 */
export function overBudget(spentUsd, budgetUsd) {
  return (spentUsd ?? 0) >= budgetUsd;
}

/** green gate 只认 exit code，不信 agent 口供。 */
export function greenGatePassed(exitCode) {
  return exitCode === 0;
}

/**
 * maker 轮次的唯一推导点。不变量：maker 轮次恒等于 miss+1（READY 时 miss=0 → r1，
 * FIXING 时 miss==1 → r2、miss==2 → r3）。`runtime.current_round` 仅为记录性字段，
 * 供人排查 timeline 时对照，绝不作路由依据。
 */
export function makerRound(missCount) {
  return (missCount ?? 0) + 1;
}

/**
 * maker 可行动失败后：miss++，按阶梯决定去向。
 * m >= maxMisses → FAILED_BOX，否则 FIXING。
 */
export function makerMissNext(missCount, maxMisses = MAX_MISS) {
  const m = (missCount ?? 0) + 1;
  return { stage: m >= maxMisses ? 'FAILED_BOX' : 'FIXING', missCount: m };
}

/**
 * 消费「有效」verifier 总裁决：pass 终点，fail 与 green gate 失败走同一 miss 阶梯。
 */
export function verdictNext(overall, missCount, maxMisses = MAX_MISS) {
  if (overall === 'pass') return { stage: 'AWAIT_HUMAN_MERGE', missCount: missCount ?? 0 };
  return makerMissNext(missCount, maxMisses); // fail 走同一阶梯
}

/**
 * verifier 协议/schema 失败：留在 VERIFY 重试，超额则收箱。
 * maxInvalid=2 时：0→1 留、1→2 留、2→3 收箱（c>maxInvalid）。共容忍初始+2 重试=3 次尝试。
 */
export function verifierInvalidNext(invalidCount, maxInvalid) {
  const c = (invalidCount ?? 0) + 1;
  if (c > maxInvalid) {
    return { stage: 'FAILED_BOX', invalidCount: c, failureType: 'verifier_protocol_exhausted' };
  }
  return { stage: 'VERIFY', invalidCount: c, failureType: null };
}

/** setup profile 人类闸门。null = 闸门未动，停住。 */
export function setupApprovalNext(approval) {
  if (approval === 'approved') return 'approved';
  return null;
}

/** AWAIT_SPEC_APPROVAL：纯读字段。null = 闸门未动，停住。 */
export function approvalNext(approval) {
  if (approval === 'approved') return 'READY';
  if (approval === 'rejected') return 'NEEDS_SPEC';
  return null;
}

/** NEEDS_SPEC 幂等保证：spec 草稿已存在且未被打回 → 跳过 spawn。 */
export function needsSpecAction(specExists, approval) {
  return specExists && approval === null ? 'skip-spawn' : 'spawn';
}

/** FIXING 阶梯：miss==1 续原 maker（有 session 才行），其余冷启动。 */
export function fixingMode(missCount, sessionId) {
  return missCount === 1 && sessionId ? 'resume' : 'cold';
}

/**
 * spec-verifier 有效 fail 后：前两次回 SPEC_FIXING；第三次 fail 触发新 spec-agent 冷启动。
 * maxMisses=3 时：0→1 修、1→2 修、2→3 冷启动重写。
 */
export function specMissNext(missCount, maxMisses = 3) {
  const m = (missCount ?? 0) + 1;
  if (m >= maxMisses) return { stage: 'NEEDS_SPEC', missCount: m, coldRestart: true };
  return { stage: 'SPEC_FIXING', missCount: m, coldRestart: false };
}

/**
 * spec-agent 交付产物契约门失败（spec-doc/v1：文件缺失 / 缺 AC 段 / 编号冲突）：
 * 留在原 stage（NEEDS_SPEC / SPEC_FIXING）重试 spec-agent，超额收箱。
 * 与 verifier 协议失败同构：这是交付协议失败，不是 spec 质量 miss（后者归 specMissNext）。
 */
export function specContractInvalidNext(invalidCount, maxInvalid) {
  const c = (invalidCount ?? 0) + 1;
  if (c > maxInvalid) {
    return { exhausted: true, invalidCount: c, failureType: 'spec_contract_exhausted' };
  }
  return { exhausted: false, invalidCount: c, failureType: null };
}

/** spec-verifier 协议/schema 失败：留在 SPEC_VERIFY 重试，超额收箱。 */
export function specVerifierInvalidNext(invalidCount, maxInvalid) {
  const c = (invalidCount ?? 0) + 1;
  if (c > maxInvalid) {
    return { stage: 'FAILED_BOX', invalidCount: c, failureType: 'spec_verifier_protocol_exhausted' };
  }
  return { stage: 'SPEC_VERIFY', invalidCount: c, failureType: null };
}

/**
 * 整段必须是严格 JSON（容忍 ```json 围栏），绝不在叙事里打捞；失败返回 null。
 * trim → 去 ```json 围栏 → JSON.parse → 失败 null。
 */
export function parseStrictJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 校验 per-AC verdict（契约 §5）。expectedAcIds = conductor 对 spec 的 AC 枚举集合
 * （数组或 Set 均可）。返回 { ok:true, verdict } | { ok:false, errors:[...] }。
 */
export function validateVerifierVerdict(parsed, expectedAcIds) {
  const errors = [];
  const expected = new Set(expectedAcIds ?? []);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['verdict 不是对象'] };
  }
  if (parsed.schema_version !== VERIFIER_VERDICT_CONTRACT.schemaVersion) {
    errors.push(`schema_version 必须为 ${VERIFIER_VERDICT_CONTRACT.schemaVersion}`);
  }
  if (!VERIFIER_VERDICT_CONTRACT.overallValues.includes(parsed.overall)) {
    errors.push('overall 必须 ∈ {pass,fail}');
  }
  if (!Array.isArray(parsed.criteria_results)) {
    errors.push('criteria_results 必须是数组');
    return { ok: false, errors };
  }
  // non_ac_findings 缺省可补 []。
  const nonAcFindings = Array.isArray(parsed.non_ac_findings) ? parsed.non_ac_findings : [];

  const seen = new Set();
  let allPass = true;
  for (const c of parsed.criteria_results) {
    if (!c || typeof c !== 'object') { errors.push('criterion 不是对象'); allPass = false; continue; }
    if (typeof c.ac_id !== 'string' || c.ac_id === '') {
      errors.push('criterion.ac_id 必须是非空字符串');
    } else {
      if (seen.has(c.ac_id)) errors.push(`criterion.ac_id 重复：${c.ac_id}`);
      seen.add(c.ac_id);
    }
    if (!VERIFIER_VERDICT_CONTRACT.criterionStatuses.includes(c.status)) {
      errors.push(`criterion.status 非法：${c.ac_id ?? '?'}`);
      allPass = false;
    } else if (c.status !== 'pass') {
      allPass = false;
    }
    if (typeof c.reason !== 'string' || c.reason.trim() === '') {
      errors.push(`criterion.reason 必须非空字符串：${c.ac_id ?? '?'}`);
    }
    if (!Array.isArray(c.evidence)) {
      errors.push(`criterion.evidence 必须是数组：${c.ac_id ?? '?'}`);
    } else {
      // pass/fail ⇒ evidence 至少 1 条；unknown 允许空。
      if ((c.status === 'pass' || c.status === 'fail') && c.evidence.length < 1) {
        errors.push(`criterion ${c.ac_id ?? '?'} 为 ${c.status} 但缺 evidence`);
      }
      for (const ev of c.evidence) {
        if (!ev || typeof ev !== 'object') { errors.push(`evidence 项不是对象：${c.ac_id ?? '?'}`); continue; }
        if (typeof ev.type !== 'string' || typeof ev.file !== 'string' || typeof ev.summary !== 'string') {
          errors.push(`evidence 缺 type/file/summary 字符串：${c.ac_id ?? '?'}`);
        }
        if (!Number.isInteger(ev.start_line) || !Number.isInteger(ev.end_line)
          || ev.start_line < 1 || ev.end_line < 1 || ev.end_line < ev.start_line) {
          errors.push(`evidence 行号非法：${c.ac_id ?? '?'}`);
        }
      }
    }
  }

  // AC 覆盖：criteria_results 的 ac_id 集合 == expectedAcIds（无缺、无重、无多余）。
  for (const id of expected) {
    if (!seen.has(id)) errors.push(`缺 AC：${id}`);
  }
  for (const id of seen) {
    if (!expected.has(id)) errors.push(`多余 AC：${id}`);
  }

  // 一致性：overall==='pass' ⇔ 每条 criterion 都是 pass。
  if (parsed.overall === 'pass' && !allPass) {
    errors.push('overall=pass 但存在非 pass criterion');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    verdict: {
      schema_version: VERIFIER_VERDICT_CONTRACT.schemaVersion,
      round: parsed.round,
      overall: parsed.overall,
      criteria_results: parsed.criteria_results,
      non_ac_findings: nonAcFindings,
    },
  };
}

export function validateSpecVerifierVerdict(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['spec verdict 不是对象'] };
  }
  if (parsed.schema_version !== SPEC_VERIFIER_CONTRACT.schemaVersion) {
    errors.push(`schema_version 必须为 ${SPEC_VERIFIER_CONTRACT.schemaVersion}`);
  }
  if (!Number.isInteger(parsed.round) || parsed.round < 1) {
    errors.push('round 必须为正整数');
  }
  if (!SPEC_VERIFIER_CONTRACT.overallValues.includes(parsed.overall)) {
    errors.push('overall 必须 ∈ {pass,fail}');
  }
  for (const key of ['summary', 'human_report', 'spec_agent_feedback']) {
    if (typeof parsed[key] !== 'string' || parsed[key].trim() === '') {
      errors.push(`${key} 必须是非空字符串`);
    }
  }
  if (!Array.isArray(parsed.findings)) {
    errors.push('findings 必须是数组');
  } else {
    if (parsed.overall === 'fail' && parsed.findings.length < 1) {
      errors.push('overall=fail 时 findings 至少 1 条');
    }
    for (const f of parsed.findings) {
      if (!f || typeof f !== 'object') { errors.push('finding 不是对象'); continue; }
      if (!SPEC_VERIFIER_CONTRACT.severities.includes(f.severity)) {
        errors.push(`finding.severity 非法：${f.severity ?? '?'}`);
      }
      if (!SPEC_VERIFIER_CONTRACT.audiences.includes(f.audience)) {
        errors.push(`finding.audience 非法：${f.audience ?? '?'}`);
      }
      for (const key of ['issue', 'recommendation']) {
        if (typeof f[key] !== 'string' || f[key].trim() === '') {
          errors.push(`finding.${key} 必须是非空字符串`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    verdict: {
      schema_version: SPEC_VERIFIER_CONTRACT.schemaVersion,
      round: parsed.round,
      overall: parsed.overall,
      summary: parsed.summary,
      human_report: parsed.human_report,
      spec_agent_feedback: parsed.spec_agent_feedback,
      findings: parsed.findings,
    },
  };
}
