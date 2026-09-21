// 集成：spec 摘要（digest）——专门的快速摘要 agent、固定 prompt、内核只做机械校验。
//
// 覆盖的验收场景：
//   · 大 spec 正常生成摘要：当前版本、可引用、router 可回原文；批准冻结（文件搬家）不重做
//   · 摘要错引用 / 生成中断：不使用无效摘要，有界修复；用尽后显式降级，任务不卡死
//   · 人在闸上改了 spec：router 最终用的是与**获批内容**一致的摘要
//   · 摘要角色的权限：只有 Write，写白名单只有这一版摘要与自己的 log（源 spec 不在其内）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { promptOf } from '../helpers/env.mjs';
import {
  approvedSpecEnv, bigSpec, digestStep, makeDigest, newRouterEnv, routerStep, specStep,
} from '../helpers/router-env.mjs';
import { sha256Of } from '../../conductor/lib/spec-version.mjs';

const ON = { digestEnabled: true };
const stop = () => routerStep('human', { summary: '本用例到此为止：开一道 help 闸让 drain 停下' });
const digestCalls = (env) => env.calls().filter((c) => /digest-r\d+\.log\.json/.test(promptOf(c)));
const routerCalls = (env) => env.calls().filter((c) => /router-r\d+\.log\.json/.test(promptOf(c)));

test('摘要正常生成：快速模型 + 固定 prompt + 只有 Write；人审看得到；批准冻结后按内容哈希沿用，不重做', (t) => {
  const spec = bigSpec();
  const { env, id } = approvedSpecEnv(t, { config: ON, specBody: spec, extraSteps: [digestStep(makeDigest(spec))] });
  const sha = sha256Of(spec);
  const short = sha.slice(0, 12);

  // ---- 派出参数：专门角色、快速模型、零读盘能力 ----
  const [call] = digestCalls(env);
  assert.ok(call, 'spec 写完即自动触发摘要');
  const arg = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(arg('--model'), 'claude-haiku-4-5-20251001', '摘要用快速模型（models.digest 可配）');
  assert.equal(arg('--tools'), 'Write', '摘要 agent 只有 Write：原文由内核带行号内联，它没有任何读盘 / 执行能力');
  const prompt = promptOf(call);
  assert.match(prompt, /你的唯一职责：把下面这一版 spec 压缩成一份\*\*带原文引用的索引\*\*/, '固定 prompt');
  assert.ok(prompt.includes(sha), 'prompt 写明来源版本');
  assert.match(prompt, /^ *13\| - AC-001:/m, '原文带行号内联');
  assert.match(prompt, /本版 spec 的 AC 编号：AC-001, AC-002/);

  // ---- 写白名单：只有这一版摘要与自己的 log；源 spec、案卷其余文件都不在其内 ----
  const settings = env.readJson(env.dossier(id, 'digest-r2.settings.json'));
  const guard = settings.hooks.PreToolUse[0].hooks[0].command;
  const allows = [...guard.matchAll(/--allow "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(allows, [env.dossier(id, 'digest', `${short}.json`), env.dossier(id, 'digest-r2.log.json')]);
  assert.ok(settings.hooks.Stop[0].hooks.some((h) => /check-digest\.mjs/.test(h.command)), '会话内挂同一份机械校验');

  // ---- 产物：摘要本体（agent 写）+ meta（内核写）+ 原文快照；成本与模型进案卷 ----
  const meta = env.readJson(env.dossier(id, 'digest', `${short}.meta.json`));
  assert.equal(meta.valid, true);
  assert.equal(meta.spec_sha256, sha);
  assert.equal(meta.model, 'claude-haiku-4-5-20251001');
  assert.match(meta.prompt_sha256, /^[0-9a-f]{64}$/, '固定 prompt 的指纹可追溯');
  assert.equal(meta.attempts.length, 1);
  assert.equal(env.readFile(env.dossier(id, 'digest', `${short}.source.md`)), spec, '按版本留原文快照');
  assert.ok(env.events(id).some((e) => e.type === 'digest_ready' && e.spec_sha === sha));
  const gate = env.readJson(env.dossier(id, 'human-r1.json'));
  assert.ok(gate.refs.includes(path.join('dossier', id, 'digest', `${short}.json`)), '人审的 refs 里有摘要');
  assert.ok(env.readRuntime(id).spent_usd >= 0.02, '摘要的花费计入同一任务成本');

  // ---- 批准 = 草稿移走 + 冻结稿落盘（路径全变），内容没变 → 摘要沿用，不再起摘要会话 ----
  assert.equal(env.readRuntime(id).spec_sha256, sha, '批准时记下获批版本的内容哈希');
  env.appendScenario([stop()]);
  assert.equal(env.run('run').status, 0);
  assert.equal(digestCalls(env).length, 1, '文件搬家不触发重做');

  // ---- router 读到：摘要（带 Lx 引用）+ 原文位置与版本 + 「以原文为准」；读范围含冻结稿 ----
  const router = promptOf(routerCalls(env).at(-1));
  assert.match(router, /AC-003 AC-003 的要点 \[L15\]/, '摘要条目带行号引用');
  assert.match(router, /\(unresolved\) 空数组返回什么｜safe default：返回 null/, '待决问题仍标为未决');
  assert.match(router, /原 spec 提议的工作包（提议，不是强制计划/);
  assert.ok(router.includes(env.dossier(id, 'spec.md')), '给出当前适用原文的路径');
  assert.ok(router.includes(short), '给出版本');
  assert.match(router, /有歧义或与原文冲突时，以当前适用版本的原文为准/);
  const routerSettings = env.readJson(env.dossier(id, `router-r${env.readRuntime(id).current_round}.settings.json`));
  const readGuard = routerSettings.hooks.PreToolUse.find((h) => h.matcher === 'Read|Grep|Glob').hooks[0].command;
  assert.ok(readGuard.includes(`--root "${env.dossier(id)}"`), 'router 可按引用回到案卷里的原文');
});

test('摘要引用无效：不被采用；错误清单喂回下一次尝试；修好后才交给 router', (t) => {
  const spec = bigSpec();
  const bad = makeDigest(spec, (d) => { d.acs[2].refs[0].quote = '这句话原文里根本没有'; });
  const { env, id } = approvedSpecEnv(t, { config: ON, specBody: spec, extraSteps: [digestStep(bad)] });
  const short = sha256Of(spec).slice(0, 12);

  // 闸前那一次失败不拦人审，但也绝不留下「有效摘要」。
  assert.equal(env.readJson(env.dossier(id, 'digest', `${short}.meta.json`)).valid, false);
  const invalid = env.events(id).find((e) => e.type === 'digest_invalid');
  assert.match(invalid.errors.join('\n'), /quote 没有逐字出现在 L15/);

  env.appendScenario([digestStep(makeDigest(spec)), stop()]);
  assert.equal(env.run('run').status, 0);
  const calls = digestCalls(env);
  assert.equal(calls.length, 2, '回到 ROUTING 先补摘要，再问 router');
  assert.match(promptOf(calls[1]), /\[修复轮\] 上一次写出的摘要没有通过机械校验/);
  assert.match(promptOf(calls[1]), /acs\[2\]\.refs\[0\]\.quote 没有逐字出现在 L15/, '错误清单原样喂回');
  assert.ok(calls[1].started_at_ms <= routerCalls(env).at(-1).started_at_ms, '摘要在 router 之前');
  assert.match(promptOf(routerCalls(env).at(-1)), /AC-003 AC-003 的要点 \[L15\]/);
  assert.equal(env.readJson(env.dossier(id, 'digest', `${short}.meta.json`)).attempts.length, 2);
});

test('摘要生成中断 / 反复不合格：有界尝试，用尽后显式降级——router 直接读原文，任务不卡死；--force 可重做', (t) => {
  const spec = bigSpec();
  const stale = makeDigest(spec, (d) => { d.source_sha256 = 'f'.repeat(64); });
  const { env, id } = approvedSpecEnv(t, {
    // spawnRetries=0：会话崩溃不走瞬态重试（否则重试会把后面的剧本步骤提前吃掉）。
    config: { ...ON, digestMaxAttempts: 3, spawnRetries: 0 }, specBody: spec,
    extraSteps: [{ exitCode: 1, stderr: 'boom' }], // 第 1 次：会话直接崩了，什么都没写
  });
  const short = sha256Of(spec).slice(0, 12);

  env.appendScenario([
    digestStep(stale), // 第 2 次：抄错来源版本（过期摘要）
    digestStep(null), // 第 3 次：只写了 log、没写摘要
    stop(),
  ]);
  const run = env.run('run');
  assert.equal(run.status, 0, run.stderr);

  const meta = env.readJson(env.dossier(id, 'digest', `${short}.meta.json`));
  assert.equal(meta.attempts.length, 3);
  assert.equal(meta.valid, false);
  assert.match(meta.attempts[1].errors.join('\n'), /source_sha256 不匹配/);
  assert.ok(env.events(id).some((e) => e.type === 'digest_failed'), '降级是显式事件');
  assert.equal(digestCalls(env).length, 3, '不超过 digestMaxAttempts');

  // 降级后 router 照常被问到，prompt 里明说摘要不可用、给原文路径；绝不出现摘要条目。
  const router = promptOf(routerCalls(env).at(-1));
  assert.match(router, /【摘要不可用：exhausted】/);
  assert.match(router, /请直接 Read 上面的 spec 原文再做决定/);
  assert.ok(router.includes(env.dossier(id, 'spec.md')));
  assert.equal(/的要点 \[L/.test(router), false, '不合格的摘要一个字都不进 router 的上下文');
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help', '任务继续推进到了 router 的决策，没有卡在摘要上');

  const show = env.run('show', id);
  assert.match(show.stdout, /摘要：exhausted/);
  assert.match(show.stdout, /已降级：router 直接读原文/);

  // 人显式重做：旧文件归档、计数清零、成功后可用。
  env.run('resume', id);
  env.appendScenario([digestStep(makeDigest(spec))]);
  const forced = env.run('digest', id, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /摘要状态：valid/);
  assert.ok(fs.readdirSync(env.dossier(id, 'digest')).some((n) => n.includes('.replaced-')), '旧摘要 / meta 归档而不是删除');
});

test('人在 spec 闸上改了草稿：旧摘要自动过期，router 用的是与最终获批内容一致的摘要', (t) => {
  const spec = bigSpec(4);
  const { env, id } = newRouterEnv(t, { config: ON, brief: '扩展 stats。\n' });
  const draft = path.join(env.root, 'specs', `${id}.md`);
  env.setScenario([routerStep('spec'), specStep(spec, { specPath: draft }), digestStep(makeDigest(spec))]);
  assert.equal(env.run('run').status, 0);

  // 人审期间直接改草稿：多一条 AC。
  const revised = spec.replace('- AC-004: 第 4 条可观察行为成立', '- AC-004: 第 4 条可观察行为成立\n- AC-005: 人在闸上补的一条');
  fs.writeFileSync(draft, revised);
  assert.equal(env.run('approve', id).status, 0);
  assert.equal(env.readRuntime(id).spec_sha256, sha256Of(revised), '批准的是改过之后的内容');

  env.appendScenario([digestStep(makeDigest(revised)), stop()]);
  assert.equal(env.run('run').status, 0);
  assert.equal(digestCalls(env).length, 2, '获批内容变了 → 按新版本重做摘要');
  assert.ok(promptOf(digestCalls(env)[1]).includes(sha256Of(revised)));
  const router = promptOf(routerCalls(env).at(-1));
  assert.match(router, /AC-005 AC-005 的要点/, 'router 看到的是获批版本的摘要');
  assert.ok(router.includes(sha256Of(revised).slice(0, 12)));
  assert.ok(env.exists(env.dossier(id, 'digest', `${sha256Of(spec).slice(0, 12)}.json`)), '旧版本的摘要留在案卷里（不删），只是不再适用');
});

test('人审 notes 是独立原始依据：摘要生成得再早，notes 也逐字进 router 与执行者，不被摘要覆盖', (t) => {
  const spec = bigSpec(3);
  const { env, id } = approvedSpecEnv(t, {
    config: ON, specBody: spec, extraSteps: [digestStep(makeDigest(spec))], notes: '待决 1 取「抛错」，不要返回 null',
  });
  env.appendScenario([stop()]);
  assert.equal(env.run('run').status, 0);
  const router = promptOf(routerCalls(env).at(-1));
  assert.match(router, /已裁决事项（同一事项不得再次 human）/);
  assert.match(router, /notes="待决 1 取「抛错」，不要返回 null"/);
  assert.match(router, /safe default：返回 null/, '摘要照录原文的提议；裁决在另一段，两者都在，互不覆盖');
  assert.equal(env.exists(env.dossier(id, 'spec.md')), true);
});
