// 集成测试助手：新状态机（router conductor）的剧本片段与环境搭建。
// 每个 step 就是 fake-claude 的一次调用：router 只写一份 log，maker 顺带改 target 仓的文件。
// log 的绝对路径由内核注入 prompt，fake-claude 的 writeLog 从 prompt 里取——路径漏注入时当场红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv } from './env.mjs';
import { FIXED_STATS } from './target-fixture.mjs';
import { sha256Of, splitLines } from '../../conductor/lib/spec-version.mjs';
import { enumerateAcceptanceCriteria } from '../../conductor/lib/state.mjs';

const FIX = { type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS };

export function routerStep(action, over = {}) {
  const { tier, summary, guidance, cost = 0.01, ...rest } = over;
  return {
    cost,
    actions: [{
      type: 'writeLog',
      content: {
        role: 'router',
        outcome: 'ok',
        action,
        ...(tier ? { tier } : {}),
        ...(guidance ? { guidance } : {}),
        summary: summary ?? `router 选择 ${action}`,
      },
    }],
    result: 'ok',
    ...rest,
  };
}

export function makerStep(over = {}) {
  const { actions = [FIX], outcome = 'ok', summary = 'AC-001 done；node --test 全绿', cost = 0.1, ...rest } = over;
  return {
    cost,
    actions: [...actions, { type: 'writeLog', content: { role: 'maker', outcome, summary } }],
    result: 'ok',
    ...rest,
  };
}

export function reviewerStep(over = {}) {
  const { outcome = 'ok', tier = 'unit', summary = 'B-001 pass', cost = 0.05, ...rest } = over;
  return {
    cost,
    actions: [{ type: 'writeLog', content: { role: 'reviewer', outcome, tier, summary } }],
    result: 'ok',
    ...rest,
  };
}

export function specStep(specBody, over = {}) {
  const { outcome = 'ok', summary = 'AC×2；触及 lib/stats.mjs；工作包 0；待决 0', cost = 0.05, specPath, ...rest } = over;
  return {
    cost,
    actions: [
      { type: 'writeFile', path: specPath, content: specBody },
      { type: 'writeLog', content: { role: 'spec', outcome, summary } },
    ],
    result: 'ok',
    ...rest,
  };
}

/** 建一个「目标仓已配好 precommit 段」的环境，并用新 CLI 建一个任务，返回 { env, id }。 */
export function newRouterEnv(t, { config = {}, precommit = { unit: 'node --test' }, brief, seedModels } = {}) {
  // spawnBackoffMs 压到毫秒级：剧本步数写错时，代价是测试立刻红，而不是五分钟退避阶梯。
  const env = makeEnv(t, {
    config: { eventsLogEnabled: true, spawnBackoffMs: [5, 5, 5], ...config },
    ...(seedModels ? { seedModels } : {}),
  });
  env.writePrecommitProfile(precommit);
  const briefPath = env.writeBrief(brief ?? 'median 的偶数分支应取中间两数平均；补一条在旧代码上会失败的测试。\n');
  const created = env.run('new', '--title', 'median 偶数分支返回错误', '--brief', briefPath);
  assert.equal(created.status, 0, created.stderr);
  const id = /id: (task-\d{8}-\d{3})/.exec(created.stdout)?.[1];
  assert.ok(id, `new 应打印 id，实际 stdout=${created.stdout}`);
  return { env, id };
}

/** 只建环境（不建任务），给「直接落盘 router 任务」的用例用。 */
export function routerEnv(t, { config = {}, precommit = { unit: 'node --test' }, seedModels } = {}) {
  const env = makeEnv(t, {
    config: { eventsLogEnabled: true, spawnBackoffMs: [5, 5, 5], ...config },
    ...(seedModels ? { seedModels } : {}),
  });
  env.writePrecommitProfile(precommit);
  return env;
}

/**
 * 最短的「有产出且停得住」剧本：r1 派 maker 干活，r2 开 help 闸让 drain 停在人闸上。
 * 需要一个确定终点又不关心 review / precommit 的用例（锁、并发、worktree、护栏…）用它。
 */
export function makerThenHelp(makerOver = {}) {
  return [
    routerStep('maker'),
    makerStep(makerOver),
    routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' }),
  ];
}

/** fake-claude 调用日志里属于 maker 的那些（cwd 在 worktrees/ 下、带 --permission-mode）。 */
export function makerCalls(env) {
  return env.calls().filter((c) => c.cwd.includes('/worktrees/') && c.argv.includes('--permission-mode'));
}

// ---- 造「人在 worktree 里动过手」与「base 往前走了一步」的场景 ----

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** 在任务 worktree 里落一次提交（模拟人在 help 闸期间自己动手），返回新的 H。 */
export function commitInTaskWorktree(env, id, files, message = 'human fix during help gate') {
  const wt = env.worktree(id);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(wt, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', message);
  return git(wt, 'rev-parse', 'HEAD').trim();
}

/** base 分支自己往前走一步（precommit 基线过期的场景），返回新的 B。 */
export function commitOnBase(env, files, message = 'base moved') {
  const repo = env.targetDir;
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/** 目标仓的 rev-parse（断言 H / B 用）。 */
export function sha(env, ref) {
  return git(env.targetDir, 'rev-parse', ref).trim();
}

// ---- 升级后的新角色与新动作：dispatch / worker / digest / 判决台账 / 工作记忆 ----


/** 一个最小但合格的委派。over 覆盖任意字段。 */
export function assignment(key, profile = 'write', over = {}) {
  return {
    key,
    profile,
    intent: profile === 'write' ? 'implement' : (profile === 'sandbox' ? 'experiment' : 'investigate'),
    title: `委派 ${key}`,
    purpose: `${key} 的本轮目的`,
    inputs: ['spec:L1-3'],
    scope: `${key} 的授权范围`,
    deliverables: `${key} 的预期产物`,
    done_when: `${key} 的完成条件`,
    ...over,
  };
}

/** router 选 dispatch。notes 给了就顺带重写工作记忆。 */
export function dispatchStep(assignments, over = {}) {
  const { summary, cost = 0.01, notes = null, ...rest } = over;
  return {
    cost,
    actions: [
      ...(notes ? [{ type: 'writeNotes', content: notes }] : []),
      { type: 'writeLog', content: { role: 'router', outcome: 'ok', action: 'dispatch', summary: summary ?? `委派 ${assignments.map((a) => a.key).join(', ')}`, assignments } },
    ],
    result: 'ok',
    ...rest,
  };
}

/**
 * 一次 worker 会话。files = { 相对路径: 内容 } 落在 cwd（它自己的 worktree / 实验目录）；
 * report 给了就写报告；log=false 模拟「来不及写 log」。
 */
export function workerStep(over = {}) {
  const {
    outcome = 'ok', summary = '完成条件已满足', done = null, remaining = null, files = {}, report = null,
    log = true, cost = 0.1, actions = [], ...rest
  } = over;
  return {
    cost,
    actions: [
      ...Object.entries(files).map(([p, content]) => ({ type: 'writeFile', path: p, content })),
      ...(report != null ? [{ type: 'writeReport', content: report }] : []),
      ...(log ? [{
        type: 'writeLog',
        content: { role: 'worker', outcome, summary, ...(done ? { done } : {}), ...(remaining ? { remaining } : {}) },
      }] : []),
      ...actions,
    ],
    result: 'ok',
    ...rest,
  };
}

/** reviewer：除 log 外把逐条判决写进台账。verdicts = { 'AC-001': 'pass' | 'fail' | {verdict,evidence,note} }。 */
export function ledgerReviewerStep(verdicts, over = {}) {
  const { outcome = 'ok', tier = 'unit', summary = null, cost = 0.05, truncate = false, ...rest } = over;
  const list = Object.entries(verdicts).map(([ac, v]) => (typeof v === 'string'
    ? { ac, verdict: v, evidence: v === 'pass' ? `test/${ac}.test.mjs:1 钉住` : `lib/stats.mjs:1 ${ac} 不满足` }
    : { ac, ...v }));
  return {
    cost,
    actions: [
      { type: 'writeVerdicts', content: { verdicts: list } },
      { type: 'writeLog', content: { role: 'reviewer', outcome, tier, summary: summary ?? `已判 ${list.length} 条` } },
      ...(truncate ? [{ type: 'truncateAfterWrite' }] : []),
    ],
    result: 'ok',
    ...rest,
  };
}

/** 一份多 AC 的 spec 正文（带 Summary / 约束 / 待决问题 / 工作包提议，供摘要用例引用）。 */
export function bigSpec(n = 6) {
  return [
    '# stats 能力扩展',
    '',
    '## Summary',
    '',
    '给 stats 模块补齐 median 与 percentile，并保持零依赖。',
    '',
    '## 契约',
    '',
    '1. 不得引入任何第三方依赖。',
    '',
    '## 验收标准',
    '',
    ...Array.from({ length: n }, (_, i) => `- AC-${String(i + 1).padStart(3, '0')}: 第 ${i + 1} 条可观察行为成立`),
    '',
    '## 工作包',
    '',
    '| id | 标题 | 主责 AC | 依赖 |',
    '| --- | --- | --- | --- |',
    '| P-001 | 核心实现 | AC-001 | — |',
    '',
    '## 待决问题',
    '',
    '| 问题 | safe default | 影响 |',
    '| --- | --- | --- |',
    '| 空数组返回什么 | 返回 null | 改成抛错会影响 AC-001 |',
    '',
  ].join('\n');
}

/** 从 spec 正文机械地造一份**合格**摘要（行号 / quote 都是真的）。mutate 可以在返回前把它改坏。 */
export function makeDigest(specText, mutate = null) {
  const lines = splitLines(specText);
  const find = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    if (i === -1) throw new Error(`makeDigest: 原文里找不到 ${needle}`);
    return { lines: [i + 1, i + 1], quote: lines[i].trim().slice(0, 120) };
  };
  const acs = enumerateAcceptanceCriteria(specText);
  const digest = {
    schema: 'spec-digest/v1',
    source_sha256: sha256Of(specText),
    goal: [{ text: '补齐 median 与 percentile', refs: [find('median 与 percentile')] }],
    constraints: [{ kind: 'must_not', text: '不引入第三方依赖', refs: [find('不得引入任何第三方依赖')] }],
    acs: acs.map((a) => ({ id: a.ac_id, gist: `${a.ac_id} 的要点`, refs: [find(`${a.ac_id}:`)] })),
    modules: [],
    open_questions: [{ status: 'unresolved', text: '空数组返回什么', safe_default: '返回 null', refs: [find('空数组返回什么')] }],
    proposed_packages: [{ id: 'P-001', title: '核心实现', acs: ['AC-001'], depends_on: [], status: 'proposal', refs: [find('| P-001 |')] }],
  };
  if (mutate) mutate(digest);
  return digest;
}

/** 摘要 agent 的一次会话：写摘要 + log。 */
export function digestStep(digest, over = {}) {
  const { outcome = 'ok', cost = 0.02, writeLogToo = true, ...rest } = over;
  return {
    cost,
    actions: [
      ...(digest != null ? [{ type: 'writeDigest', content: digest }] : []),
      ...(writeLogToo ? [{ type: 'writeLog', content: { role: 'digest', outcome, summary: 'AC 索引完成；引用逐字核对过' } }] : []),
    ],
    result: 'ok',
    ...rest,
  };
}

/** 走完「spec 动作 → spec 闸 → approve」并停在 ROUTING 的环境（摘要是否开启由 config 决定）。 */
export function approvedSpecEnv(t, { config = {}, specBody = bigSpec(), extraSteps = [], notes = null } = {}) {
  const { env, id } = newRouterEnv(t, { config, brief: '扩展 stats：median 与 percentile，零依赖。\n' });
  env.setScenario([
    routerStep('spec', { summary: '新能力，先出 spec' }),
    specStep(specBody, { specPath: path.join(env.root, 'specs', `${id}.md`) }),
    ...extraSteps,
  ]);
  const first = env.run('run');
  assert.equal(first.status, 0, first.stderr);
  const approve = env.run('approve', id, ...(notes ? ['--notes', notes] : []));
  assert.equal(approve.status, 0, approve.stderr);
  return { env, id, specBody };
}
