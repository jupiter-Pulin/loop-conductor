// stages/decisions.mjs — 状态机的全部转移分支，纯函数化（契约 §3 §5），单测直击。
// 不做任何 IO；handler 只是「读盘 → 调这里 → 落盘」。

export const STAGES = [
  'NEEDS_TARGET_SETUP',
  'AWAIT_SETUP_APPROVAL',
  'NEEDS_FEASIBILITY',
  'AWAIT_FEASIBILITY_APPROVAL',
  'NEEDS_SPEC',
  'SPEC_VERIFY',
  'SPEC_FIXING',
  'AWAIT_SPEC_APPROVAL',
  'READY',
  'VERIFY',
  'FIXING',
  'AWAIT_HUMAN_MERGE',
  'AWAIT_PROBE_CLOSE',
  'FAILED_BOX',
];

export const MAX_MISS = 3;

/**
 * 绿门失败签名的尾部连续相等 run 长度（本攻坚周期的 green-gate-r1..rN 签名 hash 数组）。
 * `[A,A]→2`、`[A,A,B]→1`、`[A,B,A]→1`、`[]→0`；undefined（旧记录/无签名）不与任何值相等，
 * 打断连续——conductor 无状态哲学：不新增计数器，每次从 dossier 现读派生。
 */
export function sameSignatureStreak(signatures) {
  const arr = signatures ?? [];
  if (arr.length === 0) return 0;
  let streak = 1;
  for (let i = arr.length - 1; i > 0; i--) {
    const cur = arr[i];
    const prev = arr[i - 1];
    if (cur === undefined || prev === undefined || cur !== prev) break;
    streak++;
  }
  return streak;
}

/** verifier verdict 的程序级契约：prompt/agent 只引用它，真正裁判仍是 validateVerifierVerdict。 */
export const VERIFIER_VERDICT_CONTRACT = Object.freeze({
  id: 'verifier-verdict/v1',
  schemaVersion: 1,
  overallValues: Object.freeze(['pass', 'fail']),
  criterionStatuses: Object.freeze(['pass', 'fail', 'unknown']),
});

/**
 * verdict 字段骨架（喂 verifier prompt 用）：字段名与 validateVerifierVerdict 逐字一致。
 * verifier 的 cwd 是 target worktree，读不到本文件，prompt 必须自带字段形态；
 * 从契约常量生成而非手写复制，保证 prompt 与裁判不漂移。`a|b` 表示枚举取值。
 */
export function verifierVerdictSkeleton(round = 1) {
  const { schemaVersion, overallValues, criterionStatuses } = VERIFIER_VERDICT_CONTRACT;
  return {
    schema_version: schemaVersion,
    round,
    overall: overallValues.join('|'),
    criteria_results: [
      {
        ac_id: 'AC-###（与枚举清单逐字一致，无缺无多）',
        status: criterionStatuses.join('|'),
        reason: '非空字符串',
        evidence: [
          { type: 'code', file: '相对路径', summary: '非空字符串', start_line: 1, end_line: 1 },
        ],
      },
    ],
    non_ac_findings: [],
  };
}

/** spec-verifier 的程序级契约：包含机器路由字段 + 人类/spec-agent 可读报告字段。 */
export const SPEC_VERIFIER_CONTRACT = Object.freeze({
  id: 'spec-verifier-verdict/v1',
  schemaVersion: 1,
  overallValues: Object.freeze(['pass', 'fail']),
  severities: Object.freeze(['blocker', 'major', 'minor', 'advisory']),
  audiences: Object.freeze(['human', 'spec-agent', 'both']),
});

/**
 * merge commit 文案的程序级契约（committer 提案 → conductor 裁决）。
 * type 白名单即 .claude/skills/git-conventions/SKILL.md 决策表的机器形态。
 */
export const COMMIT_MESSAGE_CONTRACT = Object.freeze({
  id: 'commit-message/v1',
  types: Object.freeze(['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore']),
  subjectMaxLen: 72, // `type(scope): ` 之后的描述长度上限
  bodyLineMaxLen: 100,
});

/** 非 ASCII 字符探测（CJK 等）：commit 语言门用，不识别具体语言，只认字节范围。 */
const NON_ASCII_RE = /[^\x00-\x7F]/;

/**
 * committer 提案的唯一裁判（绝不抛错）：subject 匹配
 * ^(type)(\(scope\))?: 描述{1,72}$，单行、无首尾空白、不含 WIP；
 * body 非空字符串且每行 ≤bodyLineMaxLen。合格返回 { ok:true, subject, body }。
 * 不合格由调用方重试一次，再不过降级机器文案（fail-open，格式问题绝不 block merge）。
 *
 * commitLanguage 语言门（缺省 "en"，团队政策：commit 一律英文）：subject/body 命中非 ASCII
 * 字符即拒收。显式传非 "en"（如 "zh"）关闭此门，逐字节回退旧行为——既有 shape/行长校验不受影响。
 */
export function validateCommitMessage(parsed, commitLanguage = 'en') {
  const { types, subjectMaxLen, bodyLineMaxLen } = COMMIT_MESSAGE_CONTRACT;
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['提案不是对象'] };
  }
  const { subject, body } = parsed;
  if (typeof subject !== 'string' || subject.trim() === '') {
    errors.push('subject 必须是非空字符串');
  } else {
    if (subject !== subject.trim() || subject.includes('\n')) {
      errors.push('subject 必须单行且无首尾空白');
    }
    const re = new RegExp(`^(${types.join('|')})(\\(.+\\))?: .{1,${subjectMaxLen}}$`);
    if (!re.test(subject)) {
      errors.push(`subject 必须匹配 \`type(scope)?: 描述\`（type ∈ {${types.join('|')}}，描述 ≤${subjectMaxLen} 字符）`);
    }
    if (/\bwip\b/i.test(subject)) errors.push('subject 不得含 WIP');
    if (commitLanguage === 'en' && NON_ASCII_RE.test(subject)) {
      errors.push('commit 必须为英文（subject 检出非 ASCII 字符）');
    }
  }
  if (typeof body !== 'string' || body.trim() === '') {
    errors.push('body 必须是非空字符串（为什么 / 契约边界 / 验证 / 索引指针）');
  } else {
    body.split('\n').forEach((line, i) => {
      if (line.length > bodyLineMaxLen) errors.push(`body 第 ${i + 1} 行超 ${bodyLineMaxLen} 字符`);
    });
    if (commitLanguage === 'en' && NON_ASCII_RE.test(body)) {
      errors.push('commit 必须为英文（body 检出非 ASCII 字符）');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], subject, body };
}

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

/** gateCommands 规范化：非数组或含非字符串元素 → []（保守处理，不得抛错中断状态机）。 */
export function normalizeGateCommands(value) {
  if (!Array.isArray(value)) return [];
  return value.every((c) => typeof c === 'string') ? value : [];
}

/**
 * gateCommands 来源优先级（AC-1）：task.json 显式提供该字段（即使值非法）即完全覆盖
 * target-profile 默认，不做合并；task.json 未提供该字段时才退回 profile 默认。
 * 两侧值均经 normalizeGateCommands 保守处理。
 */
export function resolveGateCommands(task, profileDefault) {
  if (task && Object.hasOwn(task, 'gateCommands')) return normalizeGateCommands(task.gateCommands);
  return normalizeGateCommands(profileDefault);
}

/**
 * test gate（基线空转测试探针）单侧判定：只有「当前测试叠加到基线后 testCommand 仍
 * exit 0」才是 vacuous（测试没钉住 spec 要求的新行为）；红/超时（exit_code=null）/
 * 跑不起来一律 falsifies——绝不因基线本身烂或基建抖动误伤 maker。
 */
export function testGateVerdict(exitCode) {
  return exitCode === 0 ? 'vacuous' : 'falsifies';
}

/**
 * per-AC 方向裁决（test gate 探针 per-ac 模式，方向表见任务 spec「约定 2」）：
 *   fail_on_baseline：基线 exit 0 → vacuous（唯一 block 项）；非 0 → falsifies。
 *   pass_on_baseline：基线 exit 0 → guard_holds；非 0 → guard_broken（放行留痕）。
 *   超时（exit_code=null）/ spawn error（exit_code<0）→ error，两方向一致（fail-open）。
 */
export function perAcProbeVerdict(expect, exitCode, timedOut) {
  if (timedOut || typeof exitCode !== 'number' || exitCode < 0) return 'error';
  if (expect === 'fail_on_baseline') return exitCode === 0 ? 'vacuous' : 'falsifies';
  return exitCode === 0 ? 'guard_holds' : 'guard_broken';
}

/**
 * per-AC 顶层聚合：任一条 vacuous → 'vacuous'（复用 ready/fixing 现有
 * probe?.verdict === 'vacuous' 分支，stage 路由零改动），否则 'falsifies'。
 * guard_broken / unmapped / error 均不 block（单侧闸门不变）。
 */
export function perAcGateVerdict(perAc) {
  return (perAc ?? []).some((e) => e.verdict === 'vacuous') ? 'vacuous' : 'falsifies';
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

/** NEEDS_FEASIBILITY 幂等保证（与 needsSpecAction 同构，独立命名以便两路各自演化）。 */
export function needsFeasibilityAction(draftExists, approval) {
  return draftExists && approval === null ? 'skip-spawn' : 'spawn';
}

/**
 * AWAIT_FEASIBILITY_APPROVAL：纯读字段。null = 闸门未动，停住。
 * approved（人已 --option 点名选项）→ NEEDS_SPEC；rejected → NEEDS_FEASIBILITY 重产。
 */
export function feasibilityApprovalNext(approval) {
  if (approval === 'approved') return 'NEEDS_SPEC';
  if (approval === 'rejected') return 'NEEDS_FEASIBILITY';
  return null;
}

/**
 * feasibility-agent 交付产物契约门失败（feasibility-doc/v1：缺选项对比/推荐/开放问题段、
 * option 不足或重复）：留在 NEEDS_FEASIBILITY 重试，超额收箱。与 specContractInvalidNext
 * 同构：这是交付协议失败，不是内容质量问题（后者归人审闸门）。
 */
export function feasibilityContractInvalidNext(invalidCount, maxInvalid) {
  const c = (invalidCount ?? 0) + 1;
  if (c > maxInvalid) {
    return { exhausted: true, invalidCount: c, failureType: 'feasibility_contract_exhausted' };
  }
  return { exhausted: false, invalidCount: c, failureType: null };
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

/**
 * H15：verifier evidence 机械锚定核验（纯函数）。fileIndex 由调用方按 worktree/base 构建：
 * `{ [file]: { lines: number|null, in_diff: boolean, missing_reason?: string } }`，
 * lines=null 表示文件在 worktree 与 base blob 都解析不到。
 * hard = 客观幻觉（文件不存在 / 行号越界）；soft = 引用 diff 外文件——verifier 有全树只读权，
 * 属合法行为，只观测不拒收。行号区间形状（整数、≥1、end≥start）已由 validateVerifierVerdict
 * 把关，此处只裁与真实文件的锚定关系。
 */
export function checkEvidenceAnchors(verdict, fileIndex) {
  const hard = [];
  const soft = [];
  for (const c of verdict?.criteria_results ?? []) {
    for (const ev of c.evidence ?? []) {
      const info = fileIndex?.[ev.file];
      if (!info || info.lines === null || info.lines === undefined) {
        hard.push({
          ac_id: c.ac_id, file: ev.file, reason: info?.missing_reason ?? 'file_missing',
          start_line: ev.start_line, end_line: ev.end_line,
        });
        continue;
      }
      if (ev.end_line > info.lines) {
        hard.push({
          ac_id: c.ac_id, file: ev.file, reason: 'line_out_of_range',
          start_line: ev.start_line, end_line: ev.end_line, file_lines: info.lines,
        });
        continue;
      }
      if (!info.in_diff) {
        soft.push({
          ac_id: c.ac_id, file: ev.file, reason: 'outside_diff',
          start_line: ev.start_line, end_line: ev.end_line,
        });
      }
    }
  }
  return { hard, soft };
}

/**
 * H21：独立 Reviewer 报告的程序级契约。字段名与取值逐字移植自 review-diff skill
 * （references/review-diff-template.json + scripts/check-review-diff.mjs），零外部依赖。
 * gate 由 findings/acCoverage/tests/residualRisk 机械推导，agent 声明的 gate 必须与推导一致。
 */
export const REVIEW_REPORT_CONTRACT = Object.freeze({
  id: 'review-diff/v1',
  schemaVersion: 1,
  stage: 'review-diff',
  gates: Object.freeze(['ready', 'ready_with_concerns', 'blocked']),
  severities: Object.freeze(['P0', 'P1', 'P2']),
  acStatuses: Object.freeze(['pass', 'fail', 'unknown', 'not-applicable']),
  commandStatuses: Object.freeze(['passed', 'failed', 'not-run']),
});

/** review 报告骨架（喂 reviewer prompt 用），从契约常量生成防漂移；`a|b` 表示枚举取值。 */
export function reviewReportSkeleton() {
  const { schemaVersion, stage, gates, severities, acStatuses } = REVIEW_REPORT_CONTRACT;
  return {
    schemaVersion,
    stage,
    gate: gates.join('|'),
    findings: [
      {
        severity: severities.join('|'),
        file: '相对路径',
        line: 1,
        title: '非空字符串',
        impact: '出错时用户/系统承受什么',
        trigger: '什么输入/状态触发',
        evidence: '锚定 diff 的证据描述',
        fix: '最小修复方向',
      },
    ],
    acCoverage: [
      { acId: 'AC-###（与枚举清单逐字一致，无缺无多）', status: acStatuses.join('|'), evidence: '非空字符串' },
    ],
    tests: { run: [], suggested: [] },
    residualRisk: false,
  };
}

/**
 * review 报告的唯一裁判（绝不抛错）。expectedAcIds = conductor 对冻结 spec 的 AC 枚举。
 * 校验 = check-review-diff.mjs 全量移植 + verifier 级 AC 覆盖纪律（无缺、无重、无多）。
 * 合格返回 { ok:true, report }，report 附机械推导的 metrics 与 blockers（不采信 agent 自报）。
 */
export function validateReviewReport(parsed, expectedAcIds) {
  const C = REVIEW_REPORT_CONTRACT;
  const errors = [];
  const expected = new Set(expectedAcIds ?? []);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['report 不是对象'] };
  }
  if (parsed.schemaVersion !== C.schemaVersion) errors.push(`schemaVersion 必须为 ${C.schemaVersion}`);
  if (parsed.stage !== C.stage) errors.push(`stage 必须为 '${C.stage}'`);
  if (!C.gates.includes(parsed.gate)) errors.push(`gate 必须 ∈ {${C.gates.join(',')}}`);

  const findings = Array.isArray(parsed.findings) ? parsed.findings : (errors.push('findings 必须是数组'), []);
  findings.forEach((f, i) => {
    if (!f || typeof f !== 'object') { errors.push(`findings[${i + 1}] 不是对象`); return; }
    if (!C.severities.includes(f.severity)) errors.push(`findings[${i + 1}].severity 非法`);
    if (!Number.isInteger(f.line) || f.line < 1) errors.push(`findings[${i + 1}].line 必须是正整数`);
    for (const field of ['file', 'title', 'impact', 'trigger', 'evidence', 'fix']) {
      if (typeof f[field] !== 'string' || f[field].trim() === '') errors.push(`findings[${i + 1}].${field} 必须非空`);
    }
  });

  const acCoverage = Array.isArray(parsed.acCoverage) ? parsed.acCoverage : (errors.push('acCoverage 必须是数组'), []);
  const seen = new Set();
  acCoverage.forEach((a, i) => {
    if (!a || typeof a !== 'object') { errors.push(`acCoverage[${i + 1}] 不是对象`); return; }
    const acId = String(a.acId ?? '');
    if (!/^AC-\d{3,}$/i.test(acId)) errors.push(`acCoverage[${i + 1}].acId 必须是 AC-001 形态`);
    else {
      if (seen.has(acId)) errors.push(`acCoverage acId 重复：${acId}`);
      seen.add(acId);
    }
    if (!C.acStatuses.includes(a.status)) errors.push(`acCoverage[${i + 1}].status 非法`);
    if (typeof a.evidence !== 'string' || a.evidence.trim() === '') errors.push(`acCoverage[${i + 1}].evidence 必须非空`);
  });
  for (const id of expected) if (!seen.has(id)) errors.push(`acCoverage 缺 AC：${id}`);
  for (const id of seen) if (!expected.has(id)) errors.push(`acCoverage 多余 AC：${id}`);

  const testsRun = Array.isArray(parsed.tests?.run) ? parsed.tests.run : [];
  if (!parsed.tests || typeof parsed.tests !== 'object' || !Array.isArray(parsed.tests.run) || !Array.isArray(parsed.tests.suggested)) {
    errors.push('tests 必须是 { run: [], suggested: [] } 形态');
  }
  testsRun.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.command !== 'string' || c.command.trim() === '') errors.push(`tests.run[${i + 1}].command 必须非空`);
    if (!C.commandStatuses.includes(c?.status)) errors.push(`tests.run[${i + 1}].status 非法`);
  });

  // gate 机械推导（不采信 agent 自报 blockers）：与 check-review-diff.mjs 同口径。
  const metrics = {
    p0: findings.filter((f) => f?.severity === 'P0').length,
    p1: findings.filter((f) => f?.severity === 'P1').length,
    p2: findings.filter((f) => f?.severity === 'P2').length,
    acFailed: acCoverage.filter((a) => a?.status === 'fail').length,
    acUnknown: acCoverage.filter((a) => a?.status === 'unknown').length,
    testsFailed: testsRun.filter((c) => c?.status === 'failed').length,
    testsNotRun: testsRun.filter((c) => c?.status === 'not-run').length,
    residualRisk: Boolean(parsed.residualRisk),
  };
  const blockers = [];
  if (metrics.p0 > 0) blockers.push({ code: 'P0_FINDINGS', count: metrics.p0 });
  if (metrics.p1 > 0) blockers.push({ code: 'P1_FINDINGS', count: metrics.p1 });
  if (metrics.acFailed > 0) blockers.push({ code: 'AC_FAILED', count: metrics.acFailed });
  if (metrics.testsFailed > 0) blockers.push({ code: 'REVIEW_VALIDATION_FAILED', count: metrics.testsFailed });
  let derivedGate = 'ready';
  if (blockers.length > 0) derivedGate = 'blocked';
  else if (metrics.p2 > 0 || metrics.acUnknown > 0 || metrics.testsNotRun > 0 || metrics.residualRisk) derivedGate = 'ready_with_concerns';
  if (C.gates.includes(parsed.gate) && parsed.gate !== derivedGate) {
    errors.push(`gate 必须为机械推导值 '${derivedGate}'（声明为 '${parsed.gate}'）`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    report: {
      schemaVersion: C.schemaVersion,
      stage: C.stage,
      gate: parsed.gate,
      findings,
      acCoverage,
      tests: { run: testsRun, suggested: parsed.tests.suggested },
      residualRisk: metrics.residualRisk,
      metrics,
      blockers,
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

/**
 * H18 规模闸 ⇔ advisory 的机械双向核验（纯函数）。协议要求「规模闸触发 ⇔ verdict 携
 * severity=advisory 拆分建议」只是 prompt 文字，verifier 不守约时必须机械执法：
 * - 闸已触发但零 advisory：拆分建议缺失，人审拿不到该拿的信息；
 * - 闸未触发却带 advisory：advisory 只许在 conductor 明文要求时出现（防洗白通道）。
 * 违约返回错误文本（走 spec-verifier invalid 阶梯），守约返回 null。
 */
export function specScaleGateViolation(scaleGate, verdict) {
  const advisories = (verdict?.findings ?? []).filter((f) => f?.severity === 'advisory');
  if (scaleGate && advisories.length === 0) {
    return `规模闸已触发（AC×${scaleGate.acCount} > ${scaleGate.max}）但 verdict 缺 severity=advisory 拆分建议`;
  }
  if (!scaleGate && advisories.length > 0) {
    return `规模闸未触发但 verdict 携 ${advisories.length} 条 severity=advisory finding（advisory 仅限 conductor 明文要求时使用）`;
  }
  return null;
}

/** 解析 git diff --numstat 输出（H33）：{ total_lines, files, binary }。二进制行（-\t-）计入 binary。 */
export function parseNumstat(text) {
  let totalLines = 0;
  const files = [];
  let binary = 0;
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const [added, deleted, ...rest] = line.split('\t');
    const p = rest.join('\t').trim();
    if (p === '') continue;
    files.push(p);
    if (added === '-' || deleted === '-') {
      binary++;
      continue;
    }
    totalLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { total_lines: totalLines, files, binary };
}

/**
 * H33 自动本地合并放行谓词（纯函数唯一裁判；输入全部是机械产物，禁止任何 AI 自评）。
 * 放行 = 全部机械门的合取；任何一门数据缺失即 fail-closed（观测开关没开 = 无证据 = 不放行）。
 * 注意：shadow 的 high_risk 字段衡量的是「shadow=pass 而 main=fail」（换用 shadow 的放水风险），
 * 与自动合并的风险方向（main 假绿）相反——所以这里要求分歧数为 0（任何方向），不看 high_risk_count。
 * 边界：本谓词只决定「本地合并」；push 永远人工（git-safety hook 不变）。
 */
/**
 * spec 审批门机器放行谓词（纯函数唯一裁判；输入全部机械产物，禁止任何 AI 自评）。
 * 放行 = 全部机械门的合取；任何一门数据缺失即 fail-closed（无证据 = 不放行）。
 * 护栏方向：spec-verifier pass 是必要非充分——pass 但带 blocker/major/advisory finding
 * （advisory 典型：规模拆分建议，不翻转 overall 但拆分与否必须人裁）意味着 verdict 里有值得人裁决的信息，一律留人审。
 * 边界：本谓词只免「人在 AWAIT_SPEC_APPROVAL 点章」这一步；merge 闸门与 reject 通道不动。
 */
export function evaluateAutoApproveSpec({ kind, draftCheck, maxAcs, specVerdict }) {
  const reasons = [];
  if (kind !== 'feature') reasons.push(`kind=${kind ?? '?'} ≠ feature`);

  // spec 草稿契约（与 cmdApprove 人审落章处同一终审：validateSpecDoc）。
  if (!draftCheck) reasons.push('spec 草稿缺失（无契约校验结果）');
  else {
    if (draftCheck.ok !== true) {
      reasons.push(`spec-doc/v1 不合格：${(draftCheck.errors ?? []).join('；') || '未知原因'}`);
    }
    const acCount = Array.isArray(draftCheck.acs) ? draftCheck.acs.length : 0;
    if (acCount <= 0) reasons.push('AC 数为 0');
    else if (Number.isFinite(maxAcs) && acCount > maxAcs) reasons.push(`AC 数 ${acCount} > 上限 ${maxAcs}`);
  }

  // spec-verifier verdict：当轮产物必须存在、pass、且无需人裁决的重 finding。
  if (!specVerdict) reasons.push('spec-verify verdict 缺失');
  else {
    if (specVerdict.overall !== 'pass') reasons.push(`spec-verifier overall=${specVerdict.overall ?? '?'} ≠ pass`);
    const findings = Array.isArray(specVerdict.findings) ? specVerdict.findings : [];
    const heavy = findings.filter((f) => f?.severity === 'blocker' || f?.severity === 'major' || f?.severity === 'advisory');
    if (heavy.length > 0) {
      reasons.push(`verdict 带需人裁决的 finding：${heavy.map((f) => `${f.severity}（${String(f.issue ?? '').slice(0, 60)}）`).join('、')}`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function evaluateAutoMerge({
  kind, allowedKinds,
  verdictOverall, acCount, maxAcs,
  testGate,
  guardEnabled, guardChanges,
  anchorsMode, anchors,
  shadowEnabled, shadowCompare,
  reviewCompare,
  diff, maxDiffLines, deniedPaths,
}) {
  const reasons = [];

  if (!Array.isArray(allowedKinds) || !allowedKinds.includes(kind)) {
    reasons.push(`kind=${kind ?? '?'} 不在 autoMergeKinds`);
  }
  if (verdictOverall !== 'pass') reasons.push(`verifier overall=${verdictOverall ?? '缺失'} ≠ pass`);
  if (!Number.isFinite(acCount) || acCount <= 0) reasons.push('AC 数缺失');
  else if (Number.isFinite(maxAcs) && acCount > maxAcs) reasons.push(`AC 数 ${acCount} > 上限 ${maxAcs}`);

  // 机械测试证明：per-AC 模式 + 映射 valid + 每条 AC 都有定向探针裁决（unmapped/error/vacuous 都不算证明）。
  if (!testGate) reasons.push('test-gate 产物缺失');
  else {
    if (testGate.mode !== 'per-ac') reasons.push(`test-gate mode=${testGate.mode ?? '?'} ≠ per-ac（无逐 AC 机械证明）`);
    if (testGate.verdict !== 'falsifies') reasons.push(`test-gate verdict=${testGate.verdict ?? '?'} ≠ falsifies`);
    if (testGate.mapping_status !== 'valid') reasons.push(`mapping_status=${testGate.mapping_status ?? '?'} ≠ valid`);
    const perAc = Array.isArray(testGate.per_ac) ? testGate.per_ac : [];
    const unproven = perAc.filter((p) => p.verdict !== 'falsifies' && p.verdict !== 'guard_holds');
    if (unproven.length > 0) {
      reasons.push(`存在无机械证明的 AC：${unproven.map((p) => `${p.ac_id}=${p.verdict}`).join('、')}`);
    }
  }

  // 既有测试改动守卫：开关必须开（否则无证据），且清单必须为空（零弱化嫌疑）。
  if (guardEnabled !== true) reasons.push('testChangeGuardEnabled 未开（无守卫证据，fail-closed）');
  else if (guardChanges !== null && guardChanges !== undefined) {
    reasons.push(`既有测试被改动（modified ${guardChanges.modified?.length ?? 0} / deleted ${guardChanges.deleted?.length ?? 0} / renamed ${guardChanges.renamed?.length ?? 0}）`);
  }

  // evidence 锚定：observe/enforce 之一且当轮产物 hard=0。
  if (anchorsMode !== 'observe' && anchorsMode !== 'enforce') reasons.push('verifierEvidenceAnchorsMode=off（无锚定证据，fail-closed）');
  else if (!anchors) reasons.push('evidence-anchors 产物缺失');
  else {
    const hard = anchors.hard_count ?? (Array.isArray(anchors.hard) ? anchors.hard.length : null);
    if (hard !== 0) reasons.push(`evidence anchors hard=${hard ?? '?'} ≠ 0`);
  }

  // codex shadow：必须开、当轮 shadow verdict 有效、分歧数为 0（任何方向）。
  if (shadowEnabled !== true) reasons.push('verifierShadowEnabled 未开（无第二意见，fail-closed）');
  else if (!shadowCompare?.agreement || shadowCompare?.shadow?.valid !== true) {
    reasons.push('shadow 对照缺失或 shadow verdict 无效');
  } else if ((shadowCompare.agreement.disagreements?.length ?? 0) > 0) {
    const d = shadowCompare.agreement.disagreements.map((x) => `${x.ac_id} ${x.main}→${x.shadow}`).join('、');
    reasons.push(`shadow 分歧：${d}`);
  }

  // reviewer shadow（可选面）：产物存在时必须无分歧；不存在不阻塞（reviewStage 默认 off，是否强制由开启提案裁）。
  if (reviewCompare) {
    if (reviewCompare.review?.valid !== true) reasons.push('reviewer 对照存在但 review 无效');
    else if (reviewCompare.disagreement === true) reasons.push(`reviewer 分歧（gate=${reviewCompare.review?.gate ?? '?'}）`);
  }

  // 变更规模与危险路径（机械「低风险」判定）。
  if (!diff) reasons.push('diff 统计缺失');
  else {
    if (diff.binary > 0) reasons.push(`含 ${diff.binary} 个二进制/不可计行文件`);
    if (Number.isFinite(maxDiffLines) && diff.total_lines > maxDiffLines) {
      reasons.push(`diff ${diff.total_lines} 行 > 上限 ${maxDiffLines}`);
    }
    for (const p of Array.isArray(deniedPaths) ? deniedPaths : []) {
      const hit = diff.files.filter((f) => (p.endsWith('/') ? f.startsWith(p) : f.includes(p)));
      if (hit.length > 0) reasons.push(`命中危险路径 ${p}：${hit.join('、')}`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}
