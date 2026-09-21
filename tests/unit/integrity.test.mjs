// 单元：越权写入的事后核对与还原（lib/integrity.mjs）。maker / worker 手里有 Bash，
// 没有 OS 沙盒时 write-guard 那类 hook 管不到 `echo … > 文件`——所以内核在派出前给「必须不变的东西」
// 拍快照，跑完逐字节核对。这一层一旦松掉，后果不是风格问题：
//   - 改掉过去轮次的 log / 判决台账 → 历史被回写，router 与人复盘时看到的是伪造的过去；
//   - 删掉冻结 spec、改掉人闸裁决 → 验收基准被执行者自己挪动（Invariant 8）；
//   - 改掉 conductor.config.json / agents/ / conductor/*.mjs → 被审的人改了裁判的规则；
//   - 凭空多出一份别的角色的案卷（伪造 reviewer 判决）→ 内核据此推进状态机。
// 反面同样是硬约束：本轮自己的产物、内核自己随时会写的文件绝不能被判成违规，
// 否则每一轮 maker 都会撞上 help 闸，整个流水线停摆。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotProtected, verifyProtected } from '../../conductor/lib/integrity.mjs';
import { setupProfilePaths } from '../../conductor/lib/profile.mjs';

const ID = 'task-20260917-001';
const ROUND = 2; // 本次派出的轮次：轮次 < 2 的案卷是不可变历史
const KEEP_CONTENT_MAX = 512 * 1024; // 与 lib/integrity.mjs 内部常量同值（该常量未导出）

// spec 正文故意带 CRLF 与非 UTF-8 字节：还原必须是字节级的，
// 「读成字符串再写回去」会把 0xff 变成 U+FFFD，spec 的 sha256 随之改变、冻结版本对不上。
const SPEC_BYTES = Buffer.concat([
  Buffer.from('# 冻结 spec\r\nAC-001 偶数分支取中间两数平均\r\n', 'utf8'),
  Buffer.from([0x00, 0xff, 0xfe]),
  Buffer.from('\n', 'utf8'),
]);

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  const targetRepo = path.join(root, 'target'); // 任务级目标仓
  const cfg = {
    root,
    dossierDir: path.join(root, 'dossier'),
    targetProfilesDir: path.join(root, 'target-profiles'),
    targetRepo: path.join(root, 'other-repo'), // cfg 级默认；任务级快照必须压过它
  };
  const ts = { id: ID, dir: path.join(root, 'state', 'queue', ID), task: { targetRepo } };
  const dossier = path.join(cfg.dossierDir, ID);
  const d = (name) => path.join(dossier, name);

  const files = {
    spec: write(`dossier/${ID}/spec.md`, SPEC_BYTES),
    human: write(`dossier/${ID}/human-r2.json`, `${JSON.stringify({ verdict: 'approve', by: 'human' })}\n`),
    makerLogR1: write(`dossier/${ID}/maker-r1.log.json`, `${JSON.stringify({ role: 'maker', outcome: 'ok', summary: 'r1 done' })}\n`),
    makerRecR1: write(`dossier/${ID}/maker-r1.json`, `${JSON.stringify({ role: 'maker', round: 1, cost_usd: 0.3 })}\n`),
    reviewerLogR1: write(`dossier/${ID}/reviewer-r1.log.json`, `${JSON.stringify({ role: 'reviewer', outcome: 'fail' })}\n`),
    streamR1: write(`dossier/${ID}/maker-r1.stream.jsonl`, '{"type":"system"}\n'),
    timeline: write(`dossier/${ID}/timeline.md`, '- r1 maker 产出已提交\n'),
    events: write(`dossier/${ID}/events.jsonl`, '{"event":"spawned"}\n'),
    digest: write(`dossier/${ID}/digest/r1.json`, `${JSON.stringify({ round: 1, text: '摘要' })}\n`),
    taskJson: write(`state/queue/${ID}/task.json`, `${JSON.stringify({ id: ID, targetRepo })}\n`),
    brief: write(`state/queue/${ID}/brief.md`, '把 median 的偶数分支改掉。\n'),
    config: write('conductor.config.json', `${JSON.stringify({ budgetUsd: 5, baseBranch: 'main' }, null, 2)}\n`),
    agent: write('agents/maker-agent.md', '# maker\n只做 spec 点名的事。\n'),
    fewshot: write('agents/fewshot/router.md', '# few-shot\n'),
    kernel: write('conductor/lib/fake-kernel.mjs', 'export const x = 1;\n'),
    kernelNote: write('conductor/lib/notes.md', '不是 .mjs，不进快照\n'),
  };
  // 任务级 targetRepo 的 profile 与 cfg 级的各写一份：快照只能拍前者。
  const profileMeta = setupProfilePaths({ ...cfg, targetRepo }).meta;
  const otherProfileMeta = setupProfilePaths(cfg).meta;
  fs.mkdirSync(path.dirname(profileMeta), { recursive: true });
  fs.writeFileSync(profileMeta, `${JSON.stringify({ approved: true, precommit: { unit: 'node --test' } }, null, 2)}\n`);
  fs.mkdirSync(path.dirname(otherProfileMeta), { recursive: true });
  fs.writeFileSync(otherProfileMeta, `${JSON.stringify({ approved: true, note: '别的仓库' }, null, 2)}\n`);

  return {
    root, cfg, ts, dossier, d, write, files, profileMeta, otherProfileMeta,
    snap: () => snapshotProtected(cfg, ts, { round: ROUND }),
  };
}

const byPath = (violations) => new Map(violations.map((v) => [v.path, v]));
const bytes = (p) => fs.readFileSync(p);

test('快照面：不可变历史 + 内核策略面进快照；本轮产物、只增的原始流、内核自写文件不进', (t) => {
  const fx = makeFixture(t);
  const snap = fx.snap();

  assert.equal(snap.id, ID);
  assert.equal(snap.round, ROUND);
  assert.equal(snap.dossier, fx.dossier);

  for (const [name, p] of Object.entries({
    // 冻结 spec 与人闸裁决：无条件拍（human-r2 与本轮同号也要拍——裁决任何时候都不可变）
    spec: fx.files.spec,
    human: fx.files.human,
    // 轮次 < 本轮的案卷都是历史
    makerLogR1: fx.files.makerLogR1,
    makerRecR1: fx.files.makerRecR1,
    reviewerLogR1: fx.files.reviewerLogR1,
    digest: fx.files.digest, // digest/ 递归全拍
    taskJson: fx.files.taskJson,
    brief: fx.files.brief,
    // 内核策略面：被审的人不能改裁判的规则
    config: fx.files.config,
    agent: fx.files.agent,
    fewshot: fx.files.fewshot, // agents/ 递归
    kernel: fx.files.kernel,
  })) {
    assert.equal(snap.files.has(p), true, `${name} 必须进快照`);
  }

  // 原始流由内核逐行落盘、只增不改：拍进去等于每轮都判自己违规。
  assert.equal(snap.files.has(fx.files.streamR1), false, '*.stream.jsonl 不进快照');
  // timeline / events 是内核自己随时追加的。
  assert.equal(snap.files.has(fx.files.timeline), false);
  assert.equal(snap.files.has(fx.files.events), false);
  assert.equal(snap.files.has(fx.files.kernelNote), false, 'conductor/ 下只拍 .mjs');

  // existing 记的是派出前案卷里已有的文件名：它决定了「哪些文件不算凭空出现」。
  assert.equal(snap.existing.has('maker-r1.stream.jsonl'), true);
  assert.equal(snap.existing.has('timeline.md'), true);
  assert.equal(snap.existing.has('spec.md'), true);
  assert.equal(snap.existing.has('digest'), false, 'existing 只收文件，不收目录');

  // 每条快照都留了 sha；≤512KB 的还留了内容（留内容才还原得了）。
  const spec = snap.files.get(fx.files.spec);
  assert.equal(typeof spec.sha, 'string');
  assert.equal(spec.sha.length, 64);
  assert.deepEqual(spec.content, SPEC_BYTES);
});

test('快照拍的是任务级 targetRepo 的 profile，不是 cfg 级的（每个任务锁自己的目标仓）', (t) => {
  const fx = makeFixture(t);
  const snap = fx.snap();
  assert.notEqual(fx.profileMeta, fx.otherProfileMeta);
  assert.equal(snap.files.has(fx.profileMeta), true, 'ts.task.targetRepo 对应的 setup-profile.json 必须进快照');
  assert.equal(snap.files.has(fx.otherProfileMeta), false, 'cfg.targetRepo 的 profile 与本任务无关，不该被锁');
});

test('改历史 log / 删 spec / 篡改人闸裁决 / 篡改 conductor.config.json → 逐条 violation 并按字节还原', (t) => {
  const fx = makeFixture(t);
  const before = {
    makerLogR1: bytes(fx.files.makerLogR1),
    spec: bytes(fx.files.spec),
    human: bytes(fx.files.human),
    config: bytes(fx.files.config),
  };
  const snap = fx.snap();

  fs.appendFileSync(fx.files.makerLogR1, '{"role":"maker","outcome":"ok","summary":"其实 r1 也过了"}\n');
  fs.rmSync(fx.files.spec);
  fs.writeFileSync(fx.files.human, `${JSON.stringify({ verdict: 'approve', by: 'maker 自己' })}\n`);
  fs.writeFileSync(fx.files.config, `${JSON.stringify({ budgetUsd: 9999 }, null, 2)}\n`);

  const violations = verifyProtected(snap, { expectedBases: ['maker'] });
  assert.equal(violations.length, 4, `应恰好 4 条：${JSON.stringify(violations)}`);
  const m = byPath(violations);

  // kind 必须分得清「改了」和「删了」：删掉 spec 与改掉 spec 对人的含义完全不同。
  assert.deepEqual(m.get(fx.files.makerLogR1), { path: fx.files.makerLogR1, kind: 'modified', restored: true });
  assert.deepEqual(m.get(fx.files.spec), { path: fx.files.spec, kind: 'deleted', restored: true });
  assert.deepEqual(m.get(fx.files.human), { path: fx.files.human, kind: 'modified', restored: true });
  assert.deepEqual(m.get(fx.files.config), { path: fx.files.config, kind: 'modified', restored: true });
  assert.equal(violations.some((v) => v.kind === 'forged'), false, '这一组都是既有文件，不该被判成伪造');

  // 还原必须逐字节相同：spec 的 sha256 是冻结版本的身份，差一个字节就是另一份 spec。
  for (const k of Object.keys(before)) {
    assert.deepEqual(bytes(fx.files[k]), before[k], `${k} 必须被按字节还原`);
  }

  // 还原之后再核对一次必须干净：否则内核会对同一次越权反复开闸。
  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker'] }), []);
});

test('凭空出现的案卷文件 → forged，移进 quarantine/ 而不是删除（证据要留着）', (t) => {
  const fx = makeFixture(t);
  const snap = fx.snap();

  // 伪造一份别的角色的判决：内核读到它就会据此推进状态机。
  const forgedReviewer = fx.write(`dossier/${ID}/reviewer-r9.json`, `${JSON.stringify({ role: 'reviewer', outcome: 'ok', summary: '我自己审过了' })}\n`);
  // 回写历史：base 在本轮白名单里，但轮次早于快照轮次 —— 过去不可写。
  const backdated = fx.write(`dossier/${ID}/worker-a-r1.json`, `${JSON.stringify({ role: 'worker', round: 1 })}\n`);
  // 形状根本不像案卷文件的，也不属于内核 → 同样隔离。
  const stray = fx.write(`dossier/${ID}/notes.txt`, '顺手写点东西\n');

  const violations = verifyProtected(snap, { expectedBases: ['maker', 'worker-a'] });
  assert.equal(violations.length, 3, `应恰好 3 条：${JSON.stringify(violations)}`);
  for (const p of [forgedReviewer, backdated, stray]) {
    assert.deepEqual(byPath(violations).get(p), { path: p, kind: 'forged', restored: true });
    assert.equal(fs.existsSync(p), false, '伪造文件必须离开案卷目录，否则后续读取仍会读到它');
  }

  const quarantined = fs.readdirSync(path.join(fx.dossier, 'quarantine'));
  assert.equal(quarantined.length, 3);
  for (const name of ['reviewer-r9.json', 'worker-a-r1.json', 'notes.txt']) {
    const hit = quarantined.find((q) => q.endsWith(`-${name}`));
    assert.ok(hit, `quarantine/ 里应有 ${name}`);
    assert.match(hit, /^\d+-/, '隔离文件名带时间戳前缀，避免同名覆盖');
  }
  // 隔离 = 移走，不是删掉：人要能看见执行者到底写了什么。
  assert.match(
    fs.readFileSync(path.join(fx.dossier, 'quarantine', quarantined.find((q) => q.endsWith('-reviewer-r9.json'))), 'utf8'),
    /我自己审过了/,
  );
  // quarantine/ 是目录，下一次核对不会把隔离物再当成伪造件循环上报。
  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker', 'worker-a'] }), []);
});

test('本轮自己的产物不算违规：expectedBases × 轮次 ≥ 快照轮次才放行，白名单是唯一放行口', (t) => {
  const fx = makeFixture(t);
  const snap = fx.snap();

  const own = [
    // 本轮 maker 自己的四件套
    fx.write(`dossier/${ID}/maker-r2.json`, '{"role":"maker"}\n'),
    fx.write(`dossier/${ID}/maker-r2.log.json`, '{"role":"maker","outcome":"ok","summary":"done"}\n'),
    fx.write(`dossier/${ID}/maker-r2.stream.jsonl`, '{"type":"system"}\n'),
    fx.write(`dossier/${ID}/maker-r2.salvage.json`, '{"schema_version":1}\n'),
    fx.write(`dossier/${ID}/maker-r2.settings.json`, '{"hooks":{}}\n'),
    // 自动续接轮：轮次比快照轮次更大也必须放行
    fx.write(`dossier/${ID}/maker-r3.json`, '{"role":"maker"}\n'),
    // 委派出去的 worker
    fx.write(`dossier/${ID}/worker-a-r2.json`, '{"role":"worker"}\n'),
  ];
  // 内核自己在本轮写的几种基名：写死放行，不依赖调用方传
  const kernelBases = [
    fx.write(`dossier/${ID}/dispatch-r2.json`, '{}\n'),
    fx.write(`dossier/${ID}/digest-r2.json`, '{}\n'),
    fx.write(`dossier/${ID}/digest-check-r2.json`, '{}\n'),
    fx.write(`dossier/${ID}/router-r2.json`, '{}\n'),
  ];

  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker', 'worker-a'] }), [], '本轮合法派出的产物一个都不能被判违规');

  // 对照：白名单为空（缺省参数）时，同一批 maker / worker 产物立刻变成伪造件 ——
  // 证明放行靠的是调用方给的 expectedBases，而不是文件名长得像就放过。
  const strict = verifyProtected(snap);
  assert.deepEqual(strict.map((v) => v.path).sort(), [...own].sort());
  assert.equal(strict.every((v) => v.kind === 'forged' && v.restored === true), true);
  for (const p of kernelBases) assert.equal(fs.existsSync(p), true, 'dispatch / digest / digest-check / router 四个基名恒被放行');
});

test('内核自己的文件永不算违规：timeline / events / router-state / router-notes / merge-intent', (t) => {
  const fx = makeFixture(t);
  const snap = fx.snap();

  // 快照之后内核继续追加的（这两份在派出前就存在）
  fs.appendFileSync(fx.files.timeline, '- r2 maker 已派出\n');
  fs.appendFileSync(fx.files.events, '{"event":"spawn_done"}\n');
  // 派出期间才第一次出现的内核文件
  const fresh = ['router-state.json', 'router-notes.json', 'merge-intent.json']
    .map((n) => fx.write(`dossier/${ID}/${n}`, '{}\n'));

  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker'] }), []);
  for (const p of fresh) assert.equal(fs.existsSync(p), true, '内核自己的文件不该被隔离');
  // 内核写的内容也不该被「还原」回快照时的样子。
  assert.match(fs.readFileSync(fx.files.timeline, 'utf8'), /r2 maker 已派出/);
  assert.match(fs.readFileSync(fx.files.events, 'utf8'), /spawn_done/);
});

test('> 512KB 的文件只留哈希：能发现、不能还原，且必须如实上报 restored:false', (t) => {
  const fx = makeFixture(t);
  const big = fx.write(`dossier/${ID}/maker-r1.big.json`, 'b'.repeat(KEEP_CONTENT_MAX + 1));
  const edge = fx.write(`dossier/${ID}/maker-r1.edge.json`, 'e'.repeat(KEEP_CONTENT_MAX));
  const snap = fx.snap();
  assert.equal(snap.files.get(big).content, null, '超阈值只留 sha');
  assert.equal(snap.files.get(edge).content.length, KEEP_CONTENT_MAX, '恰好等于阈值仍留内容');

  fs.writeFileSync(big, 'tampered\n');
  fs.writeFileSync(edge, 'tampered\n');
  const m = byPath(verifyProtected(snap, { expectedBases: ['maker'] }));

  // 还原不了也必须报出来：内核靠 restored 字段告诉人「这份要你自己救」。
  assert.deepEqual(m.get(big), { path: big, kind: 'modified', restored: false });
  assert.equal(fs.readFileSync(big, 'utf8'), 'tampered\n', '大文件保持被改后的样子（只发现，不还原）');
  assert.deepEqual(m.get(edge), { path: edge, kind: 'modified', restored: true });
  assert.equal(fs.readFileSync(edge, 'utf8').length, KEEP_CONTENT_MAX);
});

test('首轮还没有案卷目录时也能拍快照（不抛错），此时只锁策略面与任务文件', (t) => {
  const fx = makeFixture(t);
  fs.rmSync(fx.dossier, { recursive: true, force: true });
  const snap = fx.snap();

  assert.equal(snap.files.has(fx.files.config), true);
  assert.equal(snap.files.has(fx.files.taskJson), true);
  assert.equal(snap.existing.size, 0);
  // 案卷目录读不到时，核对也不能抛：本轮的产物还没落盘就先崩了的话，违规根本无从上报。
  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker'] }), []);

  // 派出期间才被建出来的案卷目录里，本轮产物照样放行、伪造件照样隔离。
  fx.write(`dossier/${ID}/maker-r2.json`, '{}\n');
  const forged = fx.write(`dossier/${ID}/reviewer-r2.json`, '{}\n');
  assert.deepEqual(verifyProtected(snap, { expectedBases: ['maker'] }), [{ path: forged, kind: 'forged', restored: true }]);
});
