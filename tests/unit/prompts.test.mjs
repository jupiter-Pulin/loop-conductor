// 单元：prompt 拼装（AC-026 的纯函数面）。
// 四条硬约束：①拼装后不残留 `{{`（漏填占位 = agent 看到花括号乱码）；②每份 prompt 含自己
// log 的绝对路径与「用 Write 工具」一句（防 Read-before-Write 撞墙），且那条路径必须是 prompt 里
// **最后一个** `*.log.json`——fake-claude 与真实 agent 都按「最后一条」取交付路径；③条件段按情形
// 出现/不出现——没有工作包的任务绝不能看到工作包段，无 spec 的任务必须看到「先写复现测试」段，
// 有 spec 的任务绝不能看到 reviewer 的分诊段；④router 逐字写下的授权（委派的五个文字字段、
// 负责人指导）必须一个字不改地到达执行上下文，改写等于悄悄换了一份授权。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRouterPrompt, buildSpecPrompt, buildMakerPrompt, buildReviewerPrompt,
  buildDigestPrompt, buildWorkerPrompt,
  splitSections, fill, readRolePrompt, readFewShot, AGENTS_SUBDIR,
} from '../../conductor/lib/prompts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = { root: REPO_ROOT };
const ID = 'task-20260830-001';
const LOG = `/abs/dossier/${ID}/router-r1.log.json`;

function assertNoResidual(prompt, label) {
  assert.equal(prompt.includes('{{'), false, `${label}：占位未填完 → ${prompt.match(/\{\{[^}]*\}\}/)?.[0]}`);
}

function assertDelivery(prompt, logPath, label) {
  assert.ok(prompt.includes(logPath), `${label}：prompt 必须含 log 绝对路径`);
  assert.match(prompt, /用 Write 工具/, `${label}：prompt 必须写明用 Write 工具`);
}

// 取法与 tests/fixtures/fake-claude.mjs::logPathFromPrompt 逐字一致：正则一样、取最后一个一样。
// 这里复制而不是 import，是因为被复制的那一份才是「替身 agent 眼中的契约」——两边任何一处漂移
// 都应该在这里当场红。
function allLogPaths(prompt) {
  return String(prompt).match(/\/[^\s"'`]*\.log\.json/g) ?? [];
}

function lastLogPath(prompt) {
  const m = allLogPaths(prompt);
  return m.length > 0 ? m[m.length - 1] : null;
}

test('splitSections / fill：段切分丢掉 marker 行；未提供的键原样保留以便被测试抓住', () => {
  const sections = splitSections('preamble\n<!-- section: a -->\nAAA\n<!-- section: b -->\nBBB\n');
  assert.deepEqual([...sections.keys()], ['a', 'b']);
  assert.equal(sections.get('a'), 'AAA');
  assert.equal(fill('x {{k}} y', { k: 'V' }), 'x V y');
  assert.equal(fill('x {{k}} y', {}), 'x {{k}} y');
  assert.equal(fill('x {{spec 或 brief}}', { 'spec 或 brief': 'spec' }), 'x spec');
});

test('AC-026: agents/ 恰好只含六份角色 prompt + fewshot/ 里的四份 few-shot，一个遗留文件都不剩', () => {
  assert.equal(AGENTS_SUBDIR, 'agents');
  const dir = path.join(REPO_ROOT, 'agents');
  // 角色从四个涨到六个：digest（只有 Write 的 spec 摘要）与 worker（受委派的执行者）是新角色，
  // 它们的固定 prompt 也是产品资产，漏文件 = 对应角色整段固定上下文静默消失。
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'digest-agent.md', 'fewshot', 'maker-agent.md', 'reviewer-agent.md',
    'router-agent.md', 'spec-agent.md', 'worker-agent.md',
  ]);
  // few-shot 仍是四份：digest 与 worker 的行为由固定 prompt + 逐字注入的委派决定，不靠样例传判断力。
  assert.deepEqual(fs.readdirSync(path.join(dir, 'fewshot')).sort(), [
    'maker.md', 'reviewer.md', 'router.md', 'spec.md',
  ]);
  for (const role of ['router', 'spec', 'maker', 'reviewer', 'digest', 'worker']) {
    assert.ok(readRolePrompt(cfg, role).get('base')?.length > 50, `${role} 缺 base 段`);
  }
  for (const role of ['router', 'spec', 'maker', 'reviewer']) {
    assert.ok(readFewShot(cfg, role).length > 200, `${role} few-shot 太短或缺失`);
  }
  for (const role of ['digest', 'worker']) {
    assert.equal(readFewShot(cfg, role), '', `${role} 不该有 few-shot（多出来的文件不会被任何 builder 读到）`);
  }
});

test('AC-026: prompt 资产的位置由 cfg.root 决定；缺失的角色 / few-shot 退化为空段而不是崩', (t) => {
  // builder 读盘的根只能来自 cfg.root——写死仓库路径会让 worktree / 测试环境读到别人的 prompt。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-root-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, AGENTS_SUBDIR), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, AGENTS_SUBDIR, 'router-agent.md'),
    '# 标题\n<!-- section: base -->\n任务 {{id}} 的假 base，log 在 {{log_path}}，记忆在 {{notes_path}}。\n',
  );
  const fake = { root: tmp };

  assert.match(readRolePrompt(fake, 'router').get('base'), /假 base/);
  assert.equal(readFewShot(fake, 'router'), '', 'few-shot 文件不存在时读成空串，不抛');
  assert.deepEqual([...readRolePrompt(fake, 'worker').keys()], [], '角色文件不存在 → 空段表');

  const p = buildRouterPrompt(fake, { id: ID, logPath: LOG, notesPath: '/tmp/n.json', brief: 'b' });
  assertNoResidual(p, 'router-fake-root');
  assert.match(p, /假 base/, '固定上下文来自 cfg.root 下的文件');
  assert.equal(/# 决策样例/.test(p), false, 'few-shot 缺失 → 整段不出现，而不是留一个空标题');
  assertDelivery(p, LOG, 'router-fake-root');
});

// ---- router ----

test('AC-026: router prompt —— 动作闭集 + 记录 + 事实，且不含 spec 正文/diff（Invariant 2）', () => {
  const p = buildRouterPrompt(cfg, {
    id: ID,
    logPath: LOG,
    brief: 'STATUS.md 里出现 /Users/<name>/…',
    records: 'r1 maker  outcome=ok  cost=$8.10',
    facts: 'need_review=true  need_precommit=true',
    // 下面两个键不在 buildRouterPrompt 的参数面上：router 的默认上下文是摘要与路径，
    // 正文与 diff 只能由它自己 Read。参数面一旦被悄悄放开，这两条哨兵会出现在 prompt 里。
    specText: '## 验收标准\n- AC-001: SPEC-BODY-SENTINEL',
    diff: 'diff --git a/tools/status.mjs b/tools/status.mjs DIFF-SENTINEL',
  });
  assertNoResidual(p, 'router');
  assertDelivery(p, LOG, 'router');
  assert.match(p, new RegExp(`你是任务 ${ID} 的负责人`));
  // 动作闭集换代：plan 退场（阶段闸恒关），dispatch 入场（1–8 个有边界的委派）。
  assert.match(p, /动作闭集：spec \| maker \| dispatch \| review \| precommit \| human \| merge \| abandon/);
  assert.equal(/动作闭集：spec \| plan \|/.test(p), false, 'plan 已不在 router 能选的动作里');
  assert.match(p, /r1 maker {2}outcome=ok/);
  assert.match(p, /need_review=true/);
  // 边界的「写下来那一半」：强制的那一半是工具集，两半都在才算钉死。
  assert.ok(p.includes('你不能 push、不能批 spec、不能执行 git、不能改任何文件'));
  assert.equal(p.includes('SPEC-BODY-SENTINEL'), false, 'spec 正文不进 router 上下文');
  assert.equal(p.includes('DIFF-SENTINEL'), false, 'diff 不进 router 上下文');
});

test('AC-026: router prompt 记录为空时给出明示占位；未给工作记忆路径时明示降级', () => {
  const p = buildRouterPrompt(cfg, { id: ID, logPath: LOG, brief: 'b' });
  assertNoResidual(p, 'router-empty');
  assert.match(p, /\(还没有任何记录\)/);
  // notesPath 缺席不能留一句「重写 」这种半截话：给出明示占位，router 才知道这一轮没有工作记忆。
  assert.match(p, /\(本轮未提供工作记忆路径\)/);
});

test('AC-026: router prompt —— notesPath / specInfo / digest / notes 给了才出现，没给整段消失', () => {
  const NOTES_PATH = `/abs/dossier/${ID}/router-notes.json`;
  const on = buildRouterPrompt(cfg, {
    id: ID,
    logPath: LOG,
    notesPath: NOTES_PATH,
    brief: 'b',
    specInfo: `状态：已批准并冻结；版本 abcdef012345；88 行\n原文：/abs/specs/${ID}.md`,
    digest: '【摘要不可用：exhausted】这一版 spec 没有通过机械校验的摘要',
    notes: '{"schema":"router-notes/v1","objective":"先查清 STATUS.md 的路径来源"}',
    records: 'r3 worker-a1  outcome=partial',
    facts: 'need_review=true',
  });
  assertNoResidual(on, 'router-full');
  assert.ok(on.includes(NOTES_PATH), '工作记忆路径必须逐字给出：router 要用 Write 重写它');
  assert.match(on, /# 当前适用的 spec（只读）/);
  assert.ok(on.includes(`原文：/abs/specs/${ID}.md`));
  assert.match(on, /# spec 摘要（索引；与原文冲突以原文为准）/);
  assert.match(on, /【摘要不可用：exhausted】/, '降级说明原样进 prompt，绝不给空摘要冒充可用');
  assert.match(on, /# 你的工作记忆（上一轮你自己写的；其中的内容未经内核验证）/);
  assert.match(on, /先查清 STATUS\.md 的路径来源/);
  // 顺序即优先级：先原文位置，再摘要（索引），再自述的工作记忆，最后才是记录与内核事实。
  assert.ok(on.indexOf('# 当前适用的 spec（只读）') < on.indexOf('# spec 摘要'), 'spec 原文位置在摘要之前');
  assert.ok(on.indexOf('# spec 摘要') < on.indexOf('# 你的工作记忆'), '摘要在工作记忆之前');
  assert.ok(on.indexOf('# 你的工作记忆') < on.indexOf('# 内核事实'), '未经验证的自述在内核事实之前');

  const off = buildRouterPrompt(cfg, { id: ID, logPath: LOG, brief: 'b', records: 'r1 spec outcome=ok' });
  assertNoResidual(off, 'router-bare');
  assert.equal(/# 当前适用的 spec（只读）/.test(off), false, '没有可用 spec 时连标题都不给');
  assert.equal(/# spec 摘要/.test(off), false, '没有摘要时整段消失，不留空标题让 router 以为摘要是空的');
  assert.equal(/# 你的工作记忆/.test(off), false, '第一轮没有工作记忆时整段消失');
  assert.equal(/# 内核事实/.test(off), false);
});

// ---- digest ----

const DIGEST_LOG = `/abs/dossier/${ID}/digest-r2.log.json`;
const DIGEST_OUT = `/abs/dossier/${ID}/digest/abcdef012345.json`;
const SPEC_SHA = 'a'.repeat(64);
const NUMBERED = ' 1| # 把 STATUS.md 的绝对路径换成相对路径\n 2| ## 验收标准\n 3| - AC-001: 给定…，当…，则…';

test('AC-026: digest prompt —— 摘要路径 / spec 版本 / AC 清单 / 带行号原文都到位，首轮不带修复段', () => {
  const p = buildDigestPrompt(cfg, {
    id: ID, logPath: DIGEST_LOG, digestPath: DIGEST_OUT, specSha: SPEC_SHA,
    acIds: ['AC-001', 'AC-002'], numberedSpec: NUMBERED,
  });
  assertNoResidual(p, 'digest');
  assertDelivery(p, DIGEST_LOG, 'digest');
  assert.ok(p.includes(DIGEST_OUT), '摘要写到哪里必须是绝对路径：摘要 agent 只有 Write');
  // sha 在两处逐字出现：规则句与 JSON 骨架。少一处，摘要就可能落在「没说清是哪一版」的状态。
  assert.ok(p.includes(`\`source_sha256\` 逐字填 ${SPEC_SHA}`));
  assert.ok(p.includes(`"source_sha256": "${SPEC_SHA}"`));
  assert.ok(p.includes('本版 spec 的 AC 编号：AC-001, AC-002'), '内核枚举到的 AC 编号必须给全');
  // 原文内联（摘要 agent 没有任何读盘能力），且每行行号还在——refs.lines 全靠它。
  assert.ok(p.includes(`# spec 原文（版本 ${SPEC_SHA}`));
  assert.ok(p.includes(' 2| ## 验收标准'));
  assert.ok(p.includes(' 3| - AC-001: 给定…，当…，则…'));
  // section() 会 trim 正文，首行的对齐空格被吃掉；行号本身还在，引用行号的能力不受影响。
  assert.ok(p.includes('1| # 把 STATUS.md 的绝对路径换成相对路径'));
  assert.equal(/\[修复轮\]/.test(p), false, '首轮没有校验错误，不该出现修复段');
  assert.equal(/# 决策样例|# 写作样例|# 实现样例|# 裁决样例/.test(p), false, 'digest 不配 few-shot');
});

test('AC-026: digest prompt —— 修复轮把机械校验错误逐条喂回；AC 枚举为空时给明示占位', () => {
  const p = buildDigestPrompt(cfg, {
    id: ID, logPath: DIGEST_LOG, digestPath: DIGEST_OUT, specSha: SPEC_SHA,
    acIds: [], numberedSpec: NUMBERED,
    errors: ['acs 少了 AC-002', 'acs[0].refs[0].quote 不是原文逐字片段'],
  });
  assertNoResidual(p, 'digest-repair');
  assert.match(p, /\[修复轮\] 上一次写出的摘要没有通过机械校验/);
  // 错误清单原样喂回（逐条一行），模型才知道要改哪一条；内核自己不改摘要。
  assert.ok(p.includes('- acs 少了 AC-002'));
  assert.ok(p.includes('- acs[0].refs[0].quote 不是原文逐字片段'));
  assert.match(p, /\(内核没有枚举到带编号的 AC\)/, 'AC 枚举为空时明示，不留「AC 编号：」这种半截话');
  assert.ok(
    p.indexOf('[修复轮]') < p.indexOf('# spec 原文'),
    '修复段属于固定上下文，必须在原文之前——它决定这一轮怎么读原文',
  );
});

// ---- worker ----

const WORKER_LOG = `/abs/dossier/${ID}/worker-a1-r5.log.json`;
const WORKER_REPORT = `/abs/dossier/${ID}/worker-a1-r5.report.md`;
const ASSIGNMENT = {
  key: 'a1',
  profile: 'write',
  intent: 'implement',
  title: '把 STATUS.md 的绝对路径换成相对路径',
  purpose: '让 STATUS.md 不再泄漏 /Users/<name>/ 开头的本机路径',
  inputs: ['spec:L65-68', `dossier/${ID}/worker-a1-r3.report.md`],
  scope: '只改 tools/status.mjs 与它的测试，不动 conductor/',
  deliverables: '改好的 tools/status.mjs + 一个在旧代码上会失败的单测',
  done_when: '新单测在旧代码上红、在新代码上绿，且 npm test 全绿',
  paths: ['tools/status.mjs', 'tests/unit/status.test.mjs'],
  acs: ['AC-013', 'AC-014'],
};

function worker(over = {}) {
  return buildWorkerPrompt(cfg, {
    id: ID, assignment: ASSIGNMENT, logPath: WORKER_LOG, reportPath: WORKER_REPORT,
    testCommand: 'npm test', hasSpec: true, specPath: `/abs/specs/${ID}.md`, specSha: 'f'.repeat(64),
    ...over,
  });
}

test('AC-026: worker prompt —— 委派的五个文字字段逐字进 prompt（router 的授权不许被改写）', () => {
  const p = worker();
  assertNoResidual(p, 'worker');
  assertDelivery(p, WORKER_LOG, 'worker');
  assert.ok(p.includes(`你是任务 ${ID} 的执行者`));
  assert.ok(p.includes(`[委派 a1]「${ASSIGNMENT.title}」（implement）`));
  // 五个文字字段是 router 写下的授权本身：改写一个字就等于换了一份授权，只能逐字注入。
  assert.ok(p.includes(`本轮目的：${ASSIGNMENT.purpose}`));
  assert.ok(p.includes(`输入依据：${ASSIGNMENT.inputs.join('；')}`));
  assert.ok(p.includes(`授权范围：${ASSIGNMENT.scope}`));
  assert.ok(p.includes(`预期产物：${ASSIGNMENT.deliverables}`));
  assert.ok(p.includes(`完成条件：${ASSIGNMENT.done_when}`));
  // 声明范围与相关 AC 只是定位用，不是验收授权——这两句的措辞本身就是边界。
  assert.ok(p.includes('[声明的写入范围] tools/status.mjs，tests/unit/status.test.mjs'));
  assert.ok(p.includes('[相关 AC（仅供定位原文，不代表由你验收）] AC-013, AC-014'));
  assert.match(p, /不要自称某条 AC「已通过」/);
  // 报告与 log 是两个不同的产物，两条绝对路径都要在。
  assert.ok(p.includes(`1. 报告 ${WORKER_REPORT}`));
  assert.ok(p.includes(`2. log ${WORKER_LOG}`));

  // paths / acs 没给时不造空段：router 没声明范围就不该凭空出现一句「声明的写入范围」。
  const bare = worker({ assignment: { ...ASSIGNMENT, paths: undefined, acs: [] } });
  assertNoResidual(bare, 'worker-no-paths');
  assert.equal(/\[声明的写入范围\]/.test(bare), false);
  assert.equal(/\[相关 AC/.test(bare), false);
});

test('AC-026: worker prompt —— 三个权限档各渲染自己的段，互不串台', () => {
  const MARKERS = {
    read: '[权限：静态只读]',
    sandbox: '[权限：临时实验]',
    write: '[权限：产品代码修改]',
  };
  for (const profile of ['read', 'sandbox', 'write']) {
    const p = worker({ assignment: { ...ASSIGNMENT, profile, paths: profile === 'write' ? ASSIGNMENT.paths : undefined } });
    assertNoResidual(p, `worker-${profile}`);
    assert.ok(p.includes(MARKERS[profile]), `${profile} 必须渲染自己的权限段`);
    for (const other of Object.keys(MARKERS).filter((k) => k !== profile)) {
      assert.equal(p.includes(MARKERS[other]), false, `${profile} 不该看到 ${other} 档的权限描述`);
    }
  }
  // 三档的差别不是措辞而是能力：写进 prompt 的那句话必须和内核真给的工具集一致。
  const read = worker({ assignment: { ...ASSIGNMENT, profile: 'read', paths: undefined } });
  assert.match(read, /你没有命令执行能力/);
  assert.equal(/测试命令：/.test(read), false, '只读档没有命令执行能力，给测试命令只会诱导它去跑');
  const sandbox = worker({ assignment: { ...ASSIGNMENT, profile: 'sandbox', paths: undefined } });
  assert.match(sandbox, /这里的一切改动在你结束后丢弃，不会进入产品/);
  assert.equal(/测试命令：/.test(sandbox), false);
  const write = worker();
  assert.match(write, /内核会在你结束后提交并集成到任务分支/);
  assert.ok(write.includes('测试命令：`npm test`'), 'write 档必须拿到 testCommand');
});

test('AC-026: worker prompt —— 续做段 / 并行段 / 人审补充约束给了才出现，没给整段消失', () => {
  const SIBLINGS = [
    { key: 'a2', title: '调查旧实现', profile: 'read', paths: [] },
    { key: 'a3', title: '改 dashboard', profile: 'write', paths: ['tools/dashboard.mjs'] },
  ];
  const on = worker({
    humanNotes: '  别动 conductor/  ',
    siblings: SIBLINGS,
    continuation: { round: 3, progress: 'summary: 改了一半\ndone: 加了失败测试' },
  });
  assertNoResidual(on, 'worker-on');
  assert.ok(on.includes('[人审补充约束（逐字，优先于你的判断）] 别动 conductor/'), '人审约束逐字注入（两端空白裁掉）');
  assert.ok(on.includes('[并行] 同一轮还有这些委派在同时进行：a2「调查旧实现」(read)；a3「改 dashboard」(write：tools/dashboard.mjs)'));
  assert.match(on, /它们的结果你这一轮看不到/);
  assert.match(on, /\[续做\] 这是对 r3 的续接/);
  assert.ok(on.includes('summary: 改了一半'));

  const off = worker();
  assertNoResidual(off, 'worker-off');
  assert.equal(/\[人审补充约束/.test(off), false);
  assert.equal(/\[并行\]/.test(off), false, '本轮只有它一个委派时不能暗示还有并行同伴');
  assert.equal(/\[续做\]/.test(off), false, '首轮不能说「接着上一次做」——它没有上一次');

  // 续做但上一轮没留下 log：给明示占位，让它先核对现状，而不是看到一个空的「上一次留下的进度：」。
  const blank = worker({ continuation: { round: 4, progress: '   ' } });
  assertNoResidual(blank, 'worker-continue-blank');
  assert.match(blank, /\(上一次没有留下进度 log；先用 git status \/ git log 与报告核对现状\)/);

  // 并行段的空数组同样是「整段消失」，不是渲染成一个空清单。
  const noSiblings = worker({ siblings: [] });
  assert.equal(/\[并行\]/.test(noSiblings), false);
});

test('AC-026: worker prompt —— 有 spec 走只读契约段，无 spec 走 brief 契约段并附 brief 全文', () => {
  const SPEC_PATH_W = `/abs/specs/${ID}.md`;
  const DIGEST_PATH_W = `/abs/dossier/${ID}/digest/ffffffffffff.json`;
  const withSpec = worker({ digestPath: DIGEST_PATH_W, briefText: 'BRIEF-SENTINEL' });
  assertNoResidual(withSpec, 'worker-spec');
  // 版本号截到 12 位：prompt 里给的是人能核对的短号，不是 64 位全量。
  assert.ok(withSpec.includes(`[契约] 获批 spec（版本 ${'f'.repeat(12)}）在 ${SPEC_PATH_W}，对你只读`));
  assert.equal(withSpec.includes('f'.repeat(13)), false, 'spec 版本号只给前 12 位');
  assert.ok(withSpec.includes(`带行号引用的摘要索引在 ${DIGEST_PATH_W}（只是目录，以原文为准）。`));
  assert.match(withSpec, /「待决问题 \/ safe default \/ 工作包」是提议，不是已批准的范围变更/);
  assert.equal(withSpec.includes('BRIEF-SENTINEL'), false, '有 spec 时 brief 不是契约，不进 prompt');
  assert.equal(/# 任务 brief（即契约）/.test(withSpec), false);

  // 没有摘要时 digest_hint 填空：既不残留占位，也不能编一个不存在的摘要路径。
  const noDigest = worker({ digestPath: '' });
  assertNoResidual(noDigest, 'worker-no-digest');
  assert.equal(/摘要索引在/.test(noDigest), false);

  const noSpec = worker({ hasSpec: false, briefText: 'STATUS.md 泄漏绝对路径 BRIEF-SENTINEL' });
  assertNoResidual(noSpec, 'worker-nospec');
  assert.match(noSpec, /\[契约\] 本任务没有 spec，brief 即契约（全文在本提示末尾）。/);
  assert.match(noSpec, /# 任务 brief（即契约）/);
  assert.ok(noSpec.includes('BRIEF-SENTINEL'), 'brief 即契约时必须给全文');
  assert.equal(noSpec.includes(SPEC_PATH_W), false, '无 spec 的任务不能拿到一个不存在的 spec 路径');
  assert.ok(
    noSpec.indexOf('# 任务 brief（即契约）') < noSpec.indexOf('# 交付：执行 log'),
    'brief 正文在交付段之前，交付段（含 log 路径）永远收尾',
  );
});

test('AC-026: worker prompt —— 报告路径取最后一个 *.report.md，续做段里的旧报告不得夺走它', () => {
  // fake-claude 的 writeReport 与 agent 的读法一样取最后一个 *.report.md；续做段会带上一轮的
  // 报告路径，所以交付段必须排在续做段之后。顺序一反，报告就会盖回上一轮的文件。
  const OLD_REPORT = `/abs/dossier/${ID}/worker-a1-r3.report.md`;
  const p = worker({
    continuation: { round: 3, progress: `summary: 改了一半\n上一次的报告：${OLD_REPORT}` },
  });
  const reports = p.match(/\/[^\s"'`]*\.report\.md/g) ?? [];
  assert.ok(reports.length >= 2, '这一轮 prompt 里确实同时出现了旧报告与本轮报告');
  assert.equal(reports[reports.length - 1], WORKER_REPORT, '最后一个 *.report.md 必须是本轮的报告路径');
  assert.ok(reports.includes(OLD_REPORT));
});

test('AC-026: 六个 builder 的交付 log 恒为 prompt 里最后一个 *.log.json（fake-claude 与 agent 都按最后一条取）', () => {
  // 每个用例都故意先埋一个更早的 *.log.json（记录 / 原文 / 进度 / 修复上下文 / diff / brief），
  // 所以「最后一条」这个约定真的被考到：谁在交付段之后再追加一条 log 路径，这里当场红。
  const cases = [
    ['router', LOG, buildRouterPrompt(cfg, {
      id: ID, logPath: LOG, brief: 'b',
      records: `r3 worker-a1  outcome=partial  log=/abs/dossier/${ID}/worker-a1-r3.log.json`,
    })],
    ['digest', DIGEST_LOG, buildDigestPrompt(cfg, {
      id: ID, logPath: DIGEST_LOG, digestPath: DIGEST_OUT, specSha: SPEC_SHA, acIds: ['AC-001'],
      numberedSpec: ` 1| 见 /abs/dossier/${ID}/maker-r1.log.json 的失败记录`,
    })],
    ['worker', WORKER_LOG, worker({
      continuation: { round: 3, progress: `上一版 log：/abs/dossier/${ID}/worker-a1-r3.log.json` },
    })],
    ['spec', `/abs/dossier/${ID}/spec-r1.log.json`, buildSpecPrompt(cfg, {
      id: ID, specPath: `/abs/specs/${ID}.md`, packagesPath: `/abs/specs/${ID}.packages.json`,
      logPath: `/abs/dossier/${ID}/spec-r1.log.json`,
      brief: `修 /abs/dossier/${ID}/router-r1.log.json 的写入`,
    })],
    ['maker', `/abs/dossier/${ID}/maker-r2.log.json`, buildMakerPrompt(cfg, {
      id: ID, logPath: `/abs/dossier/${ID}/maker-r2.log.json`, testCommand: 'npm test', specText: '# spec',
      repairContext: `AC-013 fail，详见 /abs/dossier/${ID}/reviewer-r1.log.json`,
    })],
    ['reviewer', `/abs/dossier/${ID}/reviewer-r3.log.json`, buildReviewerPrompt(cfg, {
      id: ID, logPath: `/abs/dossier/${ID}/reviewer-r3.log.json`, acList: '- AC-001: …',
      diff: `+ const p = '/abs/dossier/${ID}/maker-r2.log.json';`,
    })],
  ];
  for (const [label, expected, prompt] of cases) {
    assertNoResidual(prompt, `${label}-lastlog`);
    const all = allLogPaths(prompt);
    assert.ok(all.length >= 2, `${label}：用例里应当同时存在更早的 log 路径，否则这条断言没被真正考到`);
    assert.equal(lastLogPath(prompt), expected, `${label}：最后一个 *.log.json 必须是本轮交付的 log`);
  }
});

// ---- spec ----

const SPEC_PATH = `/abs/specs/${ID}.md`;
const PKG_PATH = `/abs/specs/${ID}.packages.json`;
const SPEC_LOG = `/abs/dossier/${ID}/spec-r1.log.json`;

test('AC-026/044: spec 起草 prompt —— packagesEnabled=false 时不含工作包段与 packages 路径', () => {
  const off = buildSpecPrompt(cfg, {
    id: ID, specPath: SPEC_PATH, packagesPath: PKG_PATH, logPath: SPEC_LOG, brief: '实现 X', packagesEnabled: false,
  });
  assertNoResidual(off, 'spec-draft-off');
  assertDelivery(off, SPEC_LOG, 'spec-draft-off');
  assert.ok(off.includes(SPEC_PATH));
  assert.equal(off.includes(PKG_PATH), false, '阶段闸关时 packages 路径都不该出现');
  assert.equal(/改动大到一个 maker 一轮做不完时/.test(off), false);
  assert.match(off, /## 验收标准/, '模板必须在');

  const on = buildSpecPrompt(cfg, {
    id: ID, specPath: SPEC_PATH, packagesPath: PKG_PATH, logPath: SPEC_LOG, brief: '实现 X', packagesEnabled: true,
  });
  assertNoResidual(on, 'spec-draft-on');
  assert.match(on, /改动大到一个 maker 一轮做不完时/);
  assert.ok(on.includes(PKG_PATH));
  assert.match(on, /"schema_version":1,"packages"/);
});

test('AC-026/046: spec 方案模式 —— 整段替换固定上下文，注入冻结 spec / maker 记录 / --stat', () => {
  const p = buildSpecPrompt(cfg, {
    id: ID, mode: 'plan', packagesPath: PKG_PATH, logPath: `/abs/dossier/${ID}/spec-plan-r1.log.json`,
    humanNotes: '按 4 包做，不再拆细',
    frozenSpec: '# 冻结 spec\n\n## 验收标准\n\n- AC-001: x\n',
    makerSummaries: 'r1 maker：AC-001..006 done，AC-007..019 未动',
    diffStat: ' 3 files changed, 120 insertions(+)',
    packagesEnabled: true,
  });
  assertNoResidual(p, 'spec-plan');
  assertDelivery(p, `/abs/dossier/${ID}/spec-plan-r1.log.json`, 'spec-plan');
  assert.match(p, /spec 已批准冻结（全文在下），不要改它/);
  assert.match(p, /一条不多一条不少——你的工作是拆分，不是裁剪/);
  assert.match(p, /人审补充约束/);
  assert.match(p, /按 4 包做，不再拆细/);
  assert.match(p, /3 files changed/);
  assert.equal(p.includes(SPEC_PATH), false, '方案模式绝不给 spec 草稿路径（Invariant 8）');
  assert.equal(/把 brief 写成 spec/.test(p), false, '固定上下文被整段替换');
});

test('AC-026: spec 打回轮注入 reject notes；无 notes 时该段不出现', () => {
  const withNotes = buildSpecPrompt(cfg, {
    id: ID, specPath: SPEC_PATH, packagesPath: PKG_PATH, logPath: SPEC_LOG, brief: 'b',
    rejectNotes: 'AC-007 与现有 Non-goal 冲突，删掉',
  });
  assert.match(withNotes, /人审打回意见/);
  assert.match(withNotes, /AC-007 与现有 Non-goal 冲突/);
  const without = buildSpecPrompt(cfg, {
    id: ID, specPath: SPEC_PATH, packagesPath: PKG_PATH, logPath: SPEC_LOG, brief: 'b',
  });
  assert.equal(/人审打回意见/.test(without), false);
});

// ---- maker ----

const MAKER_LOG = `/abs/dossier/${ID}/maker-r1.log.json`;

test('AC-026: maker 无 spec 轮 —— 含「先写一个在当前代码上失败的复现测试」，且以 brief 为契约', () => {
  const p = buildMakerPrompt(cfg, {
    id: ID, logPath: MAKER_LOG, testCommand: 'npm test', hasSpec: false, briefText: 'STATUS.md 泄漏绝对路径',
  });
  assertNoResidual(p, 'maker-nospec');
  assertDelivery(p, MAKER_LOG, 'maker-nospec');
  assert.match(p, /实现下面 brief 中你负责的全部 AC/);
  assert.match(p, /让 `npm test` 全绿/);
  assert.match(p, /先写一个在当前代码上失败的复现测试，再修到绿/);
  assert.match(p, /任务 brief（即契约）/);
  assert.equal(/\[工作包\]/.test(p), false);
  assert.equal(/\[修复轮\]/.test(p), false);
  assert.equal(/\[负责人指导/.test(p), false);
});

test('AC-026: maker 修复轮 —— 注入最近一条 reviewer / precommit 的失败内容', () => {
  const p = buildMakerPrompt(cfg, {
    id: ID, logPath: MAKER_LOG, testCommand: 'npm test', specText: '# spec',
    repairContext: 'AC-013 fail src/run.mjs:88 真实 RSS 路径无任何产物证明跑通',
  });
  assertNoResidual(p, 'maker-repair');
  assert.match(p, /\[修复轮\] 只修下面记录指出的问题，已通过的 AC 不动/);
  assert.match(p, /AC-013 fail src\/run\.mjs:88/);
  assert.equal(/先写一个在当前代码上失败的复现测试/.test(p), false, '有 spec 时不出现无 spec 段');
});

test('AC-026: maker prompt —— router 的 guidance 逐字进 prompt，没给时整段消失', () => {
  // guidance 以前只活在一行路由理由里，maker 根本收不到；现在它是 router 唯一能把具体指导
  // 送进单执行者上下文的通道，必须逐字、且排在样例与契约正文之前。
  const GUIDANCE = '先把 tools/status.mjs 的路径拼装抽成函数，再改调用点；不要顺手重排 dashboard 的输出';
  const on = buildMakerPrompt(cfg, {
    id: ID, logPath: MAKER_LOG, testCommand: 'npm test', specText: '# spec', guidance: `  ${GUIDANCE}  `,
  });
  assertNoResidual(on, 'maker-guidance');
  assert.ok(on.includes(`[负责人指导（逐字）] ${GUIDANCE}`), 'guidance 逐字注入（两端空白裁掉）');
  assert.ok(on.indexOf('[负责人指导（逐字）]') < on.indexOf('# 实现样例'), '指导属于固定上下文，在 few-shot 之前');

  const off = buildMakerPrompt(cfg, { id: ID, logPath: MAKER_LOG, testCommand: 'npm test', specText: '# spec' });
  assertNoResidual(off, 'maker-no-guidance');
  assert.equal(/\[负责人指导/.test(off), false, 'router 没给指导时不能凭空出现一句「负责人指导」');
  // 只有空白也算没给：否则会渲染出一句空指导，读起来像 router 什么都没说却特意说了一次。
  const blank = buildMakerPrompt(cfg, {
    id: ID, logPath: MAKER_LOG, testCommand: 'npm test', specText: '# spec', guidance: '   \n  ',
  });
  assert.equal(/\[负责人指导/.test(blank), false);
});

test('AC-026: maker 工作包轮 —— 工作包段含 id/title/goal/acs/files/interfaces/并行包声明', () => {
  const p = buildMakerPrompt(cfg, {
    id: ID, logPath: `/abs/dossier/${ID}/maker-P-002-r1.log.json`, testCommand: 'forge test', specText: '# spec',
    humanNotes: '按 4 包做；待决 1 取 A',
    pkg: {
      id: 'P-002', title: 'Curve', goal: '实现联合曲线',
      acs: ['AC-005', 'AC-006'], files: ['src/launch/Curve.sol'],
      interfaces: 'P-001 暴露 ILaunchFactory.createToken(LaunchParams)',
      parallelFiles: ['src/launch/Fees.sol'],
    },
  });
  assertNoResidual(p, 'maker-package');
  assert.match(p, /\[人审补充约束\] 按 4 包做；待决 1 取 A/);
  assert.match(p, /\[工作包\] 本轮只做 P-002「Curve」：实现联合曲线/);
  assert.match(p, /主责 AC：AC-005, AC-006/);
  assert.match(p, /预期修改：src\/launch\/Curve\.sol/);
  assert.match(p, /接口约定：P-001 暴露 ILaunchFactory/);
  assert.match(p, /同时进行中的其他包及其声明文件：src\/launch\/Fees\.sol/);
  assert.equal(/整体 review 对本包 AC 的判决/.test(p), false, '首轮不带重做段');
  assert.equal(/上一轮集成冲突/.test(p), false);
});

test('AC-026/037: maker 重做轮 —— 附整体 review 的 fail/note 行与 conflict_files + 旧分支参考', () => {
  const p = buildMakerPrompt(cfg, {
    id: ID, logPath: `/abs/dossier/${ID}/maker-P-002-r2.log.json`, testCommand: 'forge test', specText: '# spec',
    pkg: {
      id: 'P-002', title: 'Curve', goal: 'g', acs: ['AC-007'], files: ['src/launch/Curve.sol'],
      interfaces: 'x', parallelFiles: [],
      reviewFindings: 'AC-007 fail src/launch/Curve.sol:210 …\nnote: P-002 调 P-001.createToken 少传 quoteToken',
      conflictFiles: ['src/launch/Types.sol'],
    },
  });
  assertNoResidual(p, 'maker-redo');
  assert.match(p, /整体 review 对本包 AC 的判决：AC-007 fail/);
  assert.match(p, /note: P-002 调 P-001\.createToken 少传 quoteToken/);
  assert.match(p, /上一轮集成冲突：src\/launch\/Types\.sol/);
  assert.match(p, new RegExp(`task/${ID}--P-002 保留`));
  assert.match(p, /\(本轮只有你一个包\)/, '并行包为空时给明示占位，不留空洞');
});

// ---- reviewer ----

const REVIEW_LOG = `/abs/dossier/${ID}/reviewer-r1.log.json`;

test('AC-026/039: reviewer prompt —— 全部 AC + diff --stat + diff；无方案时不含接口约定段，有 spec 时不含分诊段', () => {
  const p = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG,
    acList: '- AC-001: …\n- AC-002: …',
    base: 'main',
    diffStat: ' src/x.mjs | 10 +++++\n 1 file changed, 10 insertions(+)',
    diff: 'diff --git a/src/x.mjs b/src/x.mjs',
  });
  assertNoResidual(p, 'reviewer');
  assertDelivery(p, REVIEW_LOG, 'reviewer');
  assert.match(p, /冷读下面的 spec 与 diff（整份任务分支相对 base）/);
  assert.match(p, /声明本次 diff 触及的最高测试层级 tier/);
  assert.match(p, /总长 ≤ 2000 字符，超长整份作废/, 'summary 纪律对两种任务都说');
  assert.match(p, /- AC-001: …/);
  assert.match(p, /# diff --stat（任务分支相对 base main）\n\nsrc\/x\.mjs \| 10/);
  assert.ok(p.indexOf('# diff --stat') < p.indexOf('# diff（任务分支相对 base）'), 'stat 段在 diff 段之前');
  assert.match(p, /diff --git/);
  assert.equal(/\[分诊\]/.test(p), false, '有 spec 的任务永远全审，连分诊段都不给它看（few-shot H 仍共用，那是样例不是指令）');
  assert.equal(/\[工作包接口约定\]/.test(p), false);
  assert.equal(/\[人审补充约束\]/.test(p), false);
  assert.equal(/\[判决台账\]/.test(p), false, '内核没开台账（ledger=null）时不该出现台账段');
});

test('AC-026: reviewer prompt —— plan_active 时附 [工作包接口约定] 段与人审补充约束', () => {
  const p = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG, acList: '- AC-001: …',
    humanNotes: '按 4 包做',
    packageInterfaces: 'P-001 Factory — 暴露 createToken(LaunchParams)',
    diff: 'diff --git a/x b/x',
  });
  assertNoResidual(p, 'reviewer-plan');
  assert.match(p, /\[人审补充约束\] 按 4 包做/);
  assert.match(p, /\[工作包接口约定\] P-001 Factory — 暴露 createToken\(LaunchParams\)/);
});

test('AC-026: reviewer 判决台账段 —— 只有 hasSpec ∧ ledger.verdictsPath 齐备时才注入', () => {
  const VERDICTS = `/abs/dossier/${ID}/reviewer-r9.verdicts.json`;
  const PATCH = `/abs/dossier/${ID}/diff-r9.patch`;
  const ledger = {
    verdictsPath: VERDICTS, todo: ['AC-003', 'AC-004'],
    carried: '上一轮已判：AC-001 pass；AC-002 fail src/x.mjs:40',
    specPath: SPEC_PATH, patchPath: PATCH,
  };
  const on = buildReviewerPrompt(cfg, { id: ID, logPath: REVIEW_LOG, acList: '- AC-001: …', diff: 'd', ledger });
  assertNoResidual(on, 'reviewer-ledger');
  assert.match(on, /\[判决台账\]/);
  assert.ok(on.includes(VERDICTS), '逐条判决写到哪里必须是绝对路径');
  assert.ok(on.includes('本轮要判：AC-003, AC-004'), '续审只判剩余的那几条');
  assert.ok(on.includes(ledger.carried), '上一轮的判决原样带回，避免重判');
  // 覆盖率由内核按台账算：这句写死了「没写进台账 = 没判」，是 ok 也不放行的依据。
  assert.match(on, /没写进台账的 AC 就是没判，outcome 写 ok 也不会放行/);
  assert.ok(on.includes(`验收依据永远是 spec 原文（${SPEC_PATH}）`), '验收依据是原文路径，不是摘要');
  assert.ok(on.includes(`完整 patch 在 ${PATCH}`), 'diff 超限时给出可分段 Read 的 patch 路径');

  // todo 为空 = 整份重判：给明示占位，不能渲染成「本轮要判：」这种空指令。
  const all = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG, acList: '- AC-001: …', diff: 'd',
    ledger: { verdictsPath: VERDICTS, todo: [], carried: '', specPath: SPEC_PATH },
  });
  assertNoResidual(all, 'reviewer-ledger-all');
  assert.ok(all.includes('本轮要判：(全部 AC)'));
  assert.equal(/完整 patch 在/.test(all), false, '没有落盘 patch 时不能给一个不存在的路径');

  // 台账没开齐就整段不给：半个台账（有段落、没路径）会让 reviewer 写到不存在的地方。
  for (const bad of [null, {}, { todo: ['AC-001'] }, { verdictsPath: '' }]) {
    const p = buildReviewerPrompt(cfg, { id: ID, logPath: REVIEW_LOG, acList: '- AC-001: …', diff: 'd', ledger: bad });
    assertNoResidual(p, 'reviewer-ledger-incomplete');
    assert.equal(/\[判决台账\]/.test(p), false, `ledger=${JSON.stringify(bad)} 时不该注入台账段`);
  }

  // 无 spec 的任务不走台账（它按 brief 判、编号 B-001…，覆盖率也不对照 spec 的 AC 全集）。
  const noSpec = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG, hasSpec: false, acList: '- B-001: …', diff: 'd', ledger,
  });
  assertNoResidual(noSpec, 'reviewer-ledger-nospec');
  assert.equal(/\[判决台账\]/.test(noSpec), false, '无 spec 的任务即便内核传了 ledger 也不注入');
  assert.equal(noSpec.includes(VERDICTS), false);
  assert.match(noSpec, /\[分诊\]/, '无 spec 的任务拿到的是分诊段');
});

test('AC-026: reviewer 无 spec 时按 brief 判，编号 B-001…，并带 [分诊] 段（base 分支名已填）', () => {
  const p = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG, hasSpec: false, acList: '- B-001: …', base: 'dev',
    diffStat: ' 3 files changed, 120 insertions(+)', diff: 'd',
  });
  assertNoResidual(p, 'reviewer-nospec');
  assert.match(p, /冷读下面的 brief 与 diff/);
  assert.match(p, /无 spec 时对照 brief 的目标判，编号 B-001…。/);
  assert.match(p, /\[分诊\] 先看下面的 diff --stat。文件 ≤ 6 ∧ 行数 ≤ 300 ∧ 有测试文件改动 → 测试审；否则全审/);
  assert.match(p, /升为全审，不可反向/);
  assert.match(p, /summary 首行写 mode=tests\|full 与依据/);
  assert.match(p, /它在 base（dev）上会不会失败/);
  assert.match(p, /用 git show dev:<path> 看旧实现/, 'base 分支名填进 git show 指令');
  assert.match(p, /两种模式都必须声明 tier/);
  assert.match(p, /# diff --stat（任务分支相对 base dev）\n\n3 files changed/);
  assert.ok(p.indexOf('[分诊]') < p.indexOf('# 裁决样例'), '分诊段属于固定上下文，在 few-shot 之前');

  // base 未知时占位不残留，stat 为空时给明示占位
  const bare = buildReviewerPrompt(cfg, { id: ID, logPath: REVIEW_LOG, hasSpec: false, acList: '- B-001: …', diff: 'd' });
  assertNoResidual(bare, 'reviewer-nospec-nobase');
  assert.match(bare, /git show <base 分支>:<path>/);
  assert.match(bare, /# diff --stat（任务分支相对 base <base 分支>）\n\n\(空\)/);
});
