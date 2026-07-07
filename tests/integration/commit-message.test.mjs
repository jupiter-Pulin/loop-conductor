// 集成：merge commit 文案提案制（agent 提案，conductor 裁决——与 verifier verdict 同模式）。
// cmdMerge 时 spawn committer（可配 models.committer），prompt = git-conventions skill 全文 +
// 冻结 spec AC + git diff --stat；输出严格 JSON {subject, body}，validateCommitMessage 终审；
// 两次不过 fail-open 降级机器文案。铁律：merge 保持 --no-ff，任务分支的轮次 commit
// （task <id>: maker r<n>）颗粒度原样保留，绝不丢。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, promptOf, verifierStep } from '../helpers/env.mjs';
import { FIXED_STATS } from '../helpers/target-fixture.mjs';

const PROPOSAL = {
  subject: 'fix(stats): median 偶数长度取中间两数平均',
  body: '预埋 bug：偶数长度错取上中位。\n\n验证：node --test 全绿。\n索引：README case 表 bugfix happy path。',
};

/** target 主分支（merge 后）的最近 commit subject / 全文 / 全部 subject 列表。 */
function mainLog(env, format) {
  return execFileSync('git', ['-C', env.targetDir, 'log', `--format=${format}`], { encoding: 'utf8' });
}

test('提案有效：merge commit 用 committer 文案，轮次 commit 颗粒度不丢', (t) => {
  const env = makeEnv(t, { config: { models: { committer: 'haiku-test' } } });
  const id = 'task-20260704-901';
  env.writeTask(id);
  // 仓库根的 git-conventions skill 是 committer prompt 的规范源
  const skillPath = path.join(env.root, '.claude', 'skills', 'git-conventions', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '# Git 提交规范 stub\n\ntype 决策表……\n');
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
    { cost: 0.01, result: JSON.stringify(PROPOSAL) }, // committer 提案（cmdMerge 时消费）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(env.findTask(id).runtime.stage, 'AWAIT_HUMAN_MERGE');

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(env.findTask(id).box, 'done');

  // merge commit 用提案文案（subject + body）
  const head = execFileSync('git', ['-C', env.targetDir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.ok(head.startsWith(`${PROPOSAL.subject}\n`), `merge commit subject 应为提案：${head.split('\n')[0]}`);
  assert.ok(head.includes('验证：node --test 全绿。'), 'merge commit body 应含提案正文');

  // 铁律：--no-ff 保留任务分支轮次 commit，颗粒度不丢
  const subjects = mainLog(env, '%s');
  assert.ok(subjects.includes(`task ${id}: maker r1 (cold)`), '轮次 commit 必须保留在 main 历史中');

  // committer spawn：第 3 次调用，模型可配，prompt 含规范全文 + AC 枚举 + diff --stat
  const calls = env.calls();
  assert.equal(calls.length, 3, 'maker + verifier + committer');
  const committerCall = calls[2];
  const mi = committerCall.argv.indexOf('--model');
  assert.equal(committerCall.argv[mi + 1], 'haiku-test', 'models.committer 可配');
  const prompt = promptOf(committerCall);
  assert.ok(prompt.includes('# Git 提交规范 stub'), 'prompt 嵌 git-conventions skill 全文');
  assert.ok(prompt.includes('AC-001'), 'prompt 含冻结 spec 的 AC 枚举');
  assert.ok(prompt.includes('lib/stats.mjs'), 'prompt 含 diff --stat 变更规模');
  assert.ok(prompt.includes('validateCommitMessage'), 'prompt 指明唯一裁判');

  // 提案 spawn 留档 + 成本入账
  const rec = env.readJson(env.dossier(id, 'committer-r1.json'));
  assert.equal(rec.role, 'committer');
  assert.ok(rec.done, '双标记收尾');
  const rt = env.findTask(id).runtime;
  assert.ok(rt.spent_usd >= 0.13 - 1e-9, 'committer 成本计入 spent_usd');
});

test('提案两次 invalid → fail-open 降级机器文案，merge 不被 block', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-902';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
    { cost: 0.01, result: '这不是 JSON' }, // committer a1：解析失败
    { cost: 0.01, result: JSON.stringify({ subject: 'optimize: 提升性能', body: 'x' }) }, // a2：type 非白名单
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);

  // 降级为原机器文案，交付不受格式问题影响
  const subject = execFileSync('git', ['-C', env.targetDir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  assert.equal(subject, `merge task/${id} (conductor)`);
  assert.equal(env.findTask(id).box, 'done');

  // 重试恰一次：committer 两次 spawn 留档；第二次 prompt 附上一轮校验错误
  const calls = env.calls();
  assert.equal(calls.length, 4, 'maker + verifier + committer×2');
  assert.ok(promptOf(calls[3]).includes('上一轮提案校验失败'), '重试 prompt 附错误反馈');
  assert.ok(env.exists(env.dossier(id, 'committer-r1.json')));
  assert.ok(env.exists(env.dossier(id, 'committer-r2.json')));
  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(timeline.includes('降级机器文案'), 'timeline 留降级痕迹');
});

test('提案 a1 轮次耗尽未输出：重试反馈禁工具指令而非「提案不是对象」，a2 提案生效', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-904';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
    // committer a1：模型把轮次花在工具上，输出提案前被 max-turns 截断（真实事故形态：
    // dossier/task-20260707-001/committer-r1.stream.jsonl，result 缺失 + subtype=error_max_turns）
    { cost: 0.01, result: '', extra: { subtype: 'error_max_turns', is_error: true, num_turns: 5 } },
    { cost: 0.01, result: JSON.stringify(PROPOSAL) }, // a2：收到轮次纪律反馈后直接输出
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);
  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(env.findTask(id).box, 'done');

  // a2 提案生效，不降级机器文案
  const head = execFileSync('git', ['-C', env.targetDir, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
  assert.ok(head.startsWith(`${PROPOSAL.subject}\n`), `merge commit subject 应为 a2 提案：${head.split('\n')[0]}`);

  // a2 prompt 收到的是轮次纪律反馈（禁工具直出），不是失真的「提案不是对象」
  const calls = env.calls();
  assert.equal(calls.length, 4, 'maker + verifier + committer×2');
  const retryPrompt = promptOf(calls[3]);
  assert.ok(retryPrompt.includes('耗尽了轮次'), '重试 prompt 指明真实失败原因');
  assert.ok(retryPrompt.includes('禁止调用任何工具'), '重试 prompt 附禁工具直出指令');
  assert.ok(!retryPrompt.includes('提案不是对象'), '不得回喂失真的校验错误');

  const timeline = env.readFile(env.dossier(id, 'timeline.md'));
  assert.ok(timeline.includes('轮次耗尽未输出提案'), 'timeline 记录真实归因');
});

test('budget 已超：跳过 committer spawn，直接机器文案', (t) => {
  const env = makeEnv(t);
  const id = 'task-20260704-903';
  env.writeTask(id);
  env.setScenario([
    { actions: [{ type: 'writeFile', path: 'lib/stats.mjs', content: FIXED_STATS }], session_id: 'sess-m1', cost: 0.1, result: 'r1 修好' },
    verifierStep(1),
    // 无 committer 步骤：预算超限时绝不 spawn（多 spawn 会让 fake-claude 报 no step 而失败）
  ]);

  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  // 人为把已花费抬过预算（模拟长任务耗尽预算后仍需人工 merge）
  const ts = env.findTask(id);
  const rt = { ...ts.runtime, spent_usd: 99 };
  fs.writeFileSync(path.join(ts.dir, 'runtime.json'), `${JSON.stringify(rt, null, 2)}\n`);

  const merge = env.run('merge', id);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(env.calls().length, 2, 'budget 超限不得 spawn committer');
  const subject = execFileSync('git', ['-C', env.targetDir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  assert.equal(subject, `merge task/${id} (conductor)`);
  assert.equal(env.findTask(id).box, 'done');
});
