// lib/prompts.mjs — 四个角色的 prompt 拼装（router / spec / maker / reviewer）。
// 固定上下文与 few-shot 逐字来自 spec 的「Agent 提示词与 few-shot」一节，落在磁盘上
// （agents/<role>-agent.md、agents/fewshot/<role>.md）；本模块只负责选段、填占位、
// 拼注入内容。判断力靠 few-shot 传，固定上下文越短越好。
//
// 硬约束（AC-026）：`agents/` 下只有这八个文件（4 份 prompt + fewshot/ 下 4 份）；
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
 * router：brief + 记录列表 + 内核事实（含已裁决事项、工作包状态表与 AC 主责包）+ log 路径。
 * 输入闭合（Invariant 2）：spec 正文、diff、代码永不进这里。
 */
export function buildRouterPrompt(cfg, { id, logPath, brief = '', records = '', facts = '' } = {}) {
  const s = readRolePrompt(cfg, 'router');
  return assemble([
    fill(s.get('base') ?? '', { id, log_path: logPath }),
    section('决策样例', readFewShot(cfg, 'router')),
    section('任务 brief', brief),
    section('记录', records || '(还没有任何记录)'),
    section('内核事实', facts),
    logDelivery(logPath),
  ]);
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
 * reviewer：全部 AC + 人审补充约束 + 各包接口约定（有方案时）+ diff + log 路径。
 * 永远是整体复审：AC 清单恒为 spec 全部 AC，不带包段、不接受 packages。
 */
export function buildReviewerPrompt(cfg, {
  id,
  logPath,
  acList = '',
  hasSpec = true,
  humanNotes = '',
  packageInterfaces = '',
  diff = '',
} = {}) {
  const s = readRolePrompt(cfg, 'reviewer');
  const parts = [
    fill(s.get('base') ?? '', { 'spec 或 brief': hasSpec ? 'spec' : 'brief', log_path: logPath }),
  ];
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
  parts.push(section('diff（任务分支相对 base）', diff));
  parts.push(logDelivery(logPath));
  return assemble(parts);
}
