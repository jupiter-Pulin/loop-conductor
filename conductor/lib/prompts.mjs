// lib/prompts.mjs — 各角色的 prompt 拼装（router / spec / maker / reviewer / digest / worker）。
// 固定上下文与 few-shot 逐字来自 spec 的「Agent 提示词与 few-shot」一节，落在磁盘上
// （agents/<role>-agent.md、agents/fewshot/<role>.md）；本模块只负责选段、填占位、
// 拼注入内容。判断力靠 few-shot 传，固定上下文越短越好。
//
// 硬约束（AC-026）：`agents/` 下只有这十个文件（6 份 prompt + fewshot/ 下 4 份；digest 与 worker
// 的行为由固定 prompt 与逐字注入的委派决定，不配 few-shot）；
// 任何 builder 的产物都不得残留 `{{`；
// 每份 prompt 都含自己 log 的绝对路径与「用 Write 工具」一句（防 Read-before-Write 撞墙）。

import fs from 'node:fs';
import path from 'node:path';

/** prompt 资产的根目录（相对 cfg.root）。 */
export const AGENTS_SUBDIR = 'agents';

const SECTION_RE = /^<!--\s*section:\s*([a-z0-9-]+)\s*-->\s*$/;
const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

function agentsDir(cfg) {
  return path.join(cfg.root, AGENTS_SUBDIR);
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** prompt 文件正文 → { 段名: 段文本 }；`<!-- section: x -->` 行本身不进 prompt。 */
export function splitSections(text) {
  const sections = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current != null) sections.set(current, buf.join('\n').trim());
    buf = [];
  };
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(SECTION_RE);
    if (m) { flush(); current = m[1]; continue; }
    if (current != null) buf.push(line);
  }
  flush();
  return sections;
}

export function readRolePrompt(cfg, role) {
  return splitSections(readFile(path.join(agentsDir(cfg), `${role}-agent.md`)));
}

export function readFewShot(cfg, role) {
  return readFile(path.join(agentsDir(cfg), 'fewshot', `${role}.md`)).trim();
}

/** 占位填充。未提供的键原样保留 —— 让「残留 {{」的测试当场抓住漏填，而不是静默出空洞。 */
export function fill(text, values = {}) {
  return String(text ?? '').replace(PLACEHOLDER_RE, (whole, key) => {
    const k = key.trim();
    return Object.hasOwn(values, k) ? String(values[k] ?? '') : whole;
  });
}

/** 交付口径：所有角色共用的一句「用 Write 工具写 log」+ 绝对路径（契约第五条）。 */
function logDelivery(logPath) {
  return [
    '# 交付：执行 log',
    `用 Write 工具把 log 写到这个绝对路径（不要先 Read，文件不存在时 Write 会直接创建）：\n${logPath}`,
    'Stop hook 会用与内核同一份脚本校验它；不合格会当场要求你改好再结束。内核只读这个文件，不读你的最终回复。',
  ].join('\n');
}

function section(title, body) {
  return body != null && String(body).trim() !== '' ? `# ${title}\n\n${String(body).trim()}` : '';
}

function assemble(parts) {
  return parts.filter((p) => p != null && String(p).trim() !== '').join('\n\n');
}

// ---- router ----

/**
 * router：brief + 当前适用 spec 的位置与摘要 + 工作记忆 + 记录 + 内核事实（含已裁决事项、委派台账、
 * review 覆盖率）+ log 路径。
 * 默认上下文是摘要与事实，不是全文：spec 原文、代码、diff、完整产物都以**路径**给出，router 需要
 * 确认时按引用自己 Read（读范围由 read-guard 收口）。摘要不可用时明说降级，绝不给空摘要或过期摘要。
 */
export function buildRouterPrompt(cfg, {
  id, logPath, notesPath = '', brief = '', records = '', facts = '',
  specInfo = '', digest = '', notes = '',
} = {}) {
  const s = readRolePrompt(cfg, 'router');
  return assemble([
    fill(s.get('base') ?? '', { id, log_path: logPath, notes_path: notesPath || '(本轮未提供工作记忆路径)' }),
    section('决策样例', readFewShot(cfg, 'router')),
    section('任务 brief', brief),
    section('当前适用的 spec（只读）', specInfo),
    section('spec 摘要（索引；与原文冲突以原文为准）', digest),
    section('你的工作记忆（上一轮你自己写的；其中的内容未经内核验证）', notes),
    section('记录', records || '(还没有任何记录)'),
    section('内核事实', facts),
    logDelivery(logPath),
  ]);
}

// ---- digest ----

/**
 * digest：固定 prompt + 带行号的 spec 原文（内联：摘要 agent 只有 Write，没有任何读盘能力）。
 * errors 非空 = 修复轮：把上一次机械校验的错误清单原样喂回去。
 */
export function buildDigestPrompt(cfg, {
  id, logPath, digestPath, specSha, acIds = [], numberedSpec = '', errors = [],
} = {}) {
  const s = readRolePrompt(cfg, 'digest');
  const values = {
    id, log_path: logPath, digest_path: digestPath, spec_sha256: specSha,
    ac_ids: acIds.join(', ') || '(内核没有枚举到带编号的 AC)',
  };
  return assemble([
    fill(s.get('base') ?? '', values),
    errors.length > 0 ? fill(s.get('repair') ?? '', { errors: errors.map((e) => `- ${e}`).join('\n') }) : '',
    fill(s.get('log') ?? '', values),
    section(`spec 原文（版本 ${specSha}；每行开头是行号，\`|\` 之后才是原文）`, numberedSpec),
    logDelivery(logPath),
  ]);
}

// ---- worker ----

/**
 * worker：router 的委派逐字注入 + 契约位置 + 权限档说明 + 并行 / 续做上下文 + 交付协议。
 * assignment 的五个文字字段一个字不改地进 prompt——router 的指导必须真的到达执行上下文。
 */
export function buildWorkerPrompt(cfg, {
  id, assignment, logPath, reportPath, testCommand = '', hasSpec = true,
  specPath = '', specSha = '', digestPath = '', briefText = '', humanNotes = '',
  siblings = [], continuation = null,
} = {}) {
  const s = readRolePrompt(cfg, 'worker');
  const a = assignment ?? {};
  const parts = [
    fill(s.get('base') ?? '', {
      id,
      key: a.key ?? '',
      title: a.title ?? '',
      intent: a.intent ?? '',
      purpose: a.purpose ?? '',
      inputs: (a.inputs ?? []).join('；'),
      scope: a.scope ?? '',
      deliverables: a.deliverables ?? '',
      done_when: a.done_when ?? '',
    }),
    hasSpec
      ? fill(s.get('contract-spec') ?? '', {
        spec_sha: String(specSha).slice(0, 12),
        spec_path: specPath,
        digest_hint: digestPath ? `带行号引用的摘要索引在 ${digestPath}（只是目录，以原文为准）。` : '',
      })
      : fill(s.get('contract-brief') ?? '', {}),
  ];
  if (String(humanNotes ?? '').trim()) parts.push(fill(s.get('human-notes') ?? '', { notes: humanNotes.trim() }));
  parts.push(fill(s.get(`profile-${a.profile}`) ?? '', { testCommand }));
  if (Array.isArray(a.paths) && a.paths.length > 0) parts.push(`[声明的写入范围] ${a.paths.join('，')}`);
  if (Array.isArray(a.acs) && a.acs.length > 0) parts.push(`[相关 AC（仅供定位原文，不代表由你验收）] ${a.acs.join(', ')}`);
  if (siblings.length > 0) {
    parts.push(fill(s.get('parallel') ?? '', {
      siblings: siblings.map((x) => `${x.key}「${x.title}」(${x.profile}${x.paths?.length ? `：${x.paths.join(',')}` : ''})`).join('；'),
    }));
  }
  if (continuation) {
    parts.push(fill(s.get('continue') ?? '', {
      prev_round: continuation.round,
      progress: String(continuation.progress ?? '').trim() || '(上一次没有留下进度 log；先用 git status / git log 与报告核对现状)',
    }));
  }
  parts.push(fill(s.get('delivery') ?? '', { report_path: reportPath, log_path: logPath }));
  if (!hasSpec) parts.push(section('任务 brief（即契约）', briefText));
  parts.push(logDelivery(logPath));
  return assemble(parts);
}

// ---- spec ----

/**
 * spec：起草模式写 spec（+ 可选工作包方案）；方案模式（plan）整段替换固定上下文，
 * 只为已冻结的 spec 补方案，绝不碰 spec 正文（Invariant 8）。
 */
export function buildSpecPrompt(cfg, {
  id,
  mode = 'draft',
  specPath,
  packagesPath,
  logPath,
  brief = '',
  rejectNotes = '',
  humanNotes = '',
  packagesEnabled = false,
  frozenSpec = '',
  makerSummaries = '',
  diffStat = '',
} = {}) {
  const s = readRolePrompt(cfg, 'spec');
  const values = { id, spec_path: specPath, packages_path: packagesPath, log_path: logPath };

  if (mode === 'plan') {
    return assemble([
      fill(s.get('plan-mode') ?? '', values),
      fill(s.get('packages-format') ?? '', values),
      section('写作样例', readFewShot(cfg, 'spec')),
      section('人审补充约束（逐字，优先于你的判断）', humanNotes),
      section('已冻结的 spec 全文（不可修改）', frozenSpec),
      section('任务分支上已有的 maker 记录', makerSummaries),
      section('任务分支相对 base 的 git diff --stat', diffStat),
      logDelivery(logPath),
    ]);
  }

  return assemble([
    fill(s.get('base') ?? '', values),
    packagesEnabled ? fill(s.get('packages') ?? '', values) : '',
    fill(s.get('log') ?? '', values),
    fill(s.get('template') ?? '', values),
    packagesEnabled ? fill(s.get('packages-format') ?? '', values) : '',
    section('写作样例', readFewShot(cfg, 'spec')),
    section('任务 brief', brief),
    section('人审打回意见（必须逐条处理）', rejectNotes),
    logDelivery(logPath),
  ]);
}

// ---- maker ----

/**
 * maker：spec（或 brief）+ 人审补充约束 + 修复记录 + 工作包段 + testCommand + log 路径。
 * pkg 形如 { id, title, goal, acs, files, interfaces, parallelFiles, reviewFindings, conflictFiles }。
 */
export function buildMakerPrompt(cfg, {
  id,
  logPath,
  testCommand,
  specText = '',
  briefText = '',
  hasSpec = true,
  humanNotes = '',
  repairContext = '',
  guidance = '',
  pkg = null,
} = {}) {
  const s = readRolePrompt(cfg, 'maker');
  const parts = [
    fill(s.get('base') ?? '', {
      'spec 或 brief': hasSpec ? 'spec' : 'brief',
      testCommand,
      log_path: logPath,
    }),
  ];
  if (String(humanNotes ?? '').trim()) {
    parts.push(fill(s.get('human-notes') ?? '', { 'spec 闸 human notes 原文': humanNotes.trim() }));
  }
  // router 的具体指导逐字进 prompt：以前它只活在一行路由理由里，maker 根本收不到。
  if (String(guidance ?? '').trim()) parts.push(fill(s.get('guidance') ?? '', { guidance: guidance.trim() }));
  if (pkg) {
    const pkgParts = [fill(s.get('package') ?? '', {
      'P-xxx': pkg.id,
      title: pkg.title ?? '',
      goal: pkg.goal ?? '',
      acs: (pkg.acs ?? []).join(', ') || '(无：纯脚手架包)',
      files: (pkg.files ?? []).join(', '),
      interfaces: pkg.interfaces ?? '(无)',
      '并行包 files': (pkg.parallelFiles ?? []).join(', ') || '(本轮只有你一个包)',
    })];
    if (String(pkg.reviewFindings ?? '').trim()) {
      pkgParts.push(fill(s.get('package-redo') ?? '', { 'fail 行与 note 行': pkg.reviewFindings.trim() }));
    }
    if ((pkg.conflictFiles ?? []).length > 0) {
      pkgParts.push(fill(s.get('package-conflict') ?? '', {
        conflict_files: pkg.conflictFiles.join(', '),
        id,
        'P-xxx': pkg.id,
      }));
    }
    parts.push(pkgParts.join('\n'));
  }
  if (String(repairContext ?? '').trim()) {
    parts.push(fill(s.get('repair') ?? '', {
      '最近一条 reviewer 记录的 summary，或 precommit 记录的失败步骤 tail': repairContext.trim(),
    }));
  }
  if (!hasSpec) parts.push(fill(s.get('no-spec') ?? '', {}));

  parts.push(section('实现样例', readFewShot(cfg, 'maker')));
  parts.push(section(hasSpec ? '已批准的 spec（契约）' : '任务 brief（即契约）', hasSpec ? specText : briefText));
  parts.push(logDelivery(logPath));
  return assemble(parts);
}

// ---- reviewer ----

/**
 * reviewer：全部 AC + 人审补充约束 + 各包接口约定（有方案时）+ diff --stat + diff + log 路径。
 * 永远是整体复审：AC 清单恒为 spec 全部 AC，不带包段、不接受 packages。
 * 无 spec 的任务另注入 [分诊] 段（含 base 分支名，供 git show <base>:<path> 看旧实现）：brief 即契约，
 * 改动小时只审测试是否钉住目标；有 spec 的任务连这段都看不到，永远全审。
 */
export function buildReviewerPrompt(cfg, {
  id,
  logPath,
  acList = '',
  hasSpec = true,
  humanNotes = '',
  packageInterfaces = '',
  base = null,
  diffStat = '',
  diff = '',
  ledger = null,
} = {}) {
  const s = readRolePrompt(cfg, 'reviewer');
  const baseRef = String(base ?? '').trim() || '<base 分支>';
  const parts = [
    fill(s.get('base') ?? '', { 'spec 或 brief': hasSpec ? 'spec' : 'brief', log_path: logPath }),
  ];
  if (!hasSpec) parts.push(fill(s.get('triage') ?? '', { base: baseRef }));
  // 有 spec 的任务：逐条判决走台账（可分轮续审）。ledger = { verdictsPath, todo, carried, specPath, patchPath }
  if (hasSpec && ledger?.verdictsPath) {
    parts.push(fill(s.get('ledger') ?? '', {
      verdicts_path: ledger.verdictsPath,
      todo: (ledger.todo ?? []).join(', ') || '(全部 AC)',
      carried: String(ledger.carried ?? '').trim(),
      spec_path: ledger.specPath ?? '(见下方 AC 清单)',
      patch_hint: ledger.patchPath ? `diff 超过内嵌上限时，完整 patch 在 ${ledger.patchPath}（用 Read 分段读、Grep 定位），代码现状直接读 cwd。` : '',
    }));
  }
  if (String(humanNotes ?? '').trim()) {
    parts.push(fill(s.get('human-notes') ?? '', { 'spec 闸 human notes 原文': humanNotes.trim() }));
  }
  if (String(packageInterfaces ?? '').trim()) {
    parts.push(fill(s.get('package-interfaces') ?? '', {
      '每包一行：P-xxx title — interfaces': packageInterfaces.trim(),
    }));
  }
  parts.push(section('裁决样例', readFewShot(cfg, 'reviewer')));
  parts.push(section(`任务 ${id} 的全部 AC`, acList));
  // stat 段恒在（分诊段说的「下面的 diff --stat」就是它）；空 diff 也给明示占位，不留空洞。
  parts.push(section(`diff --stat（任务分支相对 base ${baseRef}）`, String(diffStat ?? '').trim() || '(空)'));
  parts.push(section('diff（任务分支相对 base）', diff));
  parts.push(logDelivery(logPath));
  return assemble(parts);
}
