// 单元：prompt 拼装（AC-026 的纯函数面）。
// 三条硬约束：①拼装后不残留 `{{`（漏填占位 = agent 看到花括号乱码）；②每份 prompt 含自己
// log 的绝对路径与「用 Write 工具」一句（防 Read-before-Write 撞墙）；③条件段按情形出现/不出现
// ——没有工作包的任务绝不能看到工作包段，无 spec 的任务必须看到「先写复现测试」段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRouterPrompt, buildSpecPrompt, buildMakerPrompt, buildReviewerPrompt,
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

test('splitSections / fill：段切分丢掉 marker 行；未提供的键原样保留以便被测试抓住', () => {
  const sections = splitSections('preamble\n<!-- section: a -->\nAAA\n<!-- section: b -->\nBBB\n');
  assert.deepEqual([...sections.keys()], ['a', 'b']);
  assert.equal(sections.get('a'), 'AAA');
  assert.equal(fill('x {{k}} y', { k: 'V' }), 'x V y');
  assert.equal(fill('x {{k}} y', {}), 'x {{k}} y');
  assert.equal(fill('x {{spec 或 brief}}', { 'spec 或 brief': 'spec' }), 'x spec');
});

test('AC-026: agents/ 恰好只含四份 prompt + fewshot/ 里的四份 few-shot，一个遗留文件都不剩', () => {
  assert.equal(AGENTS_SUBDIR, 'agents');
  const dir = path.join(REPO_ROOT, 'agents');
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'fewshot', 'maker-agent.md', 'reviewer-agent.md', 'router-agent.md', 'spec-agent.md',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'fewshot')).sort(), [
    'maker.md', 'reviewer.md', 'router.md', 'spec.md',
  ]);
  for (const role of ['router', 'spec', 'maker', 'reviewer']) {
    const sections = readRolePrompt(cfg, role);
    assert.ok(sections.get('base')?.length > 50, `${role} 缺 base 段`);
    assert.ok(readFewShot(cfg, role).length > 200, `${role} few-shot 太短或缺失`);
  }
});

// ---- router ----

test('AC-026: router prompt —— 动作闭集 + 记录 + 事实，且不含 spec 正文/diff（Invariant 2）', () => {
  const p = buildRouterPrompt(cfg, {
    id: ID,
    logPath: LOG,
    brief: 'STATUS.md 里出现 /Users/<name>/…',
    records: 'r1 maker  outcome=ok  cost=$8.10',
    facts: 'need_review=true  need_precommit=true',
  });
  assertNoResidual(p, 'router');
  assertDelivery(p, LOG, 'router');
  assert.match(p, new RegExp(`你是任务 ${ID} 的管理员`));
  assert.match(p, /动作闭集：spec \| plan \| maker \| review \| precommit \| human \| merge \| abandon/);
  assert.match(p, /r1 maker {2}outcome=ok/);
  assert.match(p, /need_review=true/);
  assert.match(p, /你不能 push、不能批 spec、不能执行 git、不能改任何文件/);
});

test('AC-026: router prompt 记录为空时给出明示占位，不留空段', () => {
  const p = buildRouterPrompt(cfg, { id: ID, logPath: LOG, brief: 'b' });
  assertNoResidual(p, 'router-empty');
  assert.match(p, /\(还没有任何记录\)/);
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

test('AC-026/039: reviewer prompt —— 全部 AC + diff；无方案时不含接口约定段', () => {
  const p = buildReviewerPrompt(cfg, {
    id: ID, logPath: REVIEW_LOG,
    acList: '- AC-001: …\n- AC-002: …',
    diff: 'diff --git a/src/x.mjs b/src/x.mjs',
  });
  assertNoResidual(p, 'reviewer');
  assertDelivery(p, REVIEW_LOG, 'reviewer');
  assert.match(p, /冷读下面的 spec 与 diff（整份任务分支相对 base）/);
  assert.match(p, /声明本次 diff 触及的最高测试层级 tier/);
  assert.match(p, /- AC-001: …/);
  assert.match(p, /diff --git/);
  assert.equal(/\[工作包接口约定\]/.test(p), false);
  assert.equal(/\[人审补充约束\]/.test(p), false);
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

test('AC-026: reviewer 无 spec 时按 brief 判，编号 B-001…', () => {
  const p = buildReviewerPrompt(cfg, { id: ID, logPath: REVIEW_LOG, hasSpec: false, acList: '- B-001: …', diff: 'd' });
  assertNoResidual(p, 'reviewer-nospec');
  assert.match(p, /冷读下面的 brief 与 diff/);
  assert.match(p, /无 spec 时按 brief 的目标与验收线索逐条判，编号 B-001…。/);
});
