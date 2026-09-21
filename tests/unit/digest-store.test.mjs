// 单元：摘要的落盘布局与「这一版 spec 的摘要能不能用」的判定。
// 这个模块的全部价值在于「现算」：每次要用摘要，都拿盘上的文件对**此刻**的原文重跑一遍机械校验，
// 而不是信 meta 里留档的 valid。松掉这一点，人在闸上改过的 spec、被动过的摘要、上一版的旧摘要
// 都会被当成有效索引交给 router——router 以为自己核对过原文，其实读的是另一个版本。
// 另外两条同样是安全性质：尝试次数必须真的用完并落到 exhausted（否则摘要失败会把任务卡死），
// resetDigest 必须归档而不是删除（人要重做摘要时，旧摘要是复盘「模型当时看错了什么」的唯一证据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256Of, shortSha, splitLines } from '../../conductor/lib/spec-version.mjs';
import {
  digestDir, digestPath, digestMetaPath, digestSourcePath, digestStateFor,
  readDigestMeta, writeDigestMeta, writeDigestSource, readDigestSource,
  digestMaxAttempts, digestPromptSha, resetDigest, DEFAULT_DIGEST_MAX_ATTEMPTS,
} from '../../conductor/lib/digest-store.mjs';

const ID = 'task-20260918-007';

const SPEC_TEXT = `# task-20260918-007：摘要的落盘与现算判定

## 目标

- router 能按行回到原文，不必整份重读 spec。

## 验收标准

- AC-001: 摘要的来源哈希与当前 spec 不一致时，内核判定摘要不可用。
`;

/** currentSpec 的返回形态；digestStateFor 只用 sha256 与 text。 */
function specOf(text) {
  return { status: 'draft', path: `specs/${ID}.md`, text, sha256: sha256Of(text), lines: splitLines(text).length };
}

const SPEC_A = specOf(SPEC_TEXT);
// 人在闸上改了一句：内容变了 → 哈希变了 → 这就是另一个版本（A 的摘要对它一律无效）。
const SPEC_B = specOf(SPEC_TEXT.replace('不必整份重读 spec', '不必整份重读 spec（新增：也不必读摘要以外的东西）'));

/** 夹具里某段文字所在的 1 基行号。 */
function lineIn(text, needle) {
  const i = splitLines(text).findIndex((l) => l.includes(needle));
  assert.notEqual(i, -1, `夹具里找不到包含 ${JSON.stringify(needle)} 的行`);
  return i + 1;
}

/** 为某一版 spec 造一份**合格**摘要（行号按该版正文现算）。 */
function digestFor(spec) {
  const goalLine = lineIn(spec.text, '不必整份重读 spec');
  const acLine = lineIn(spec.text, 'AC-001');
  return {
    schema: 'spec-digest/v1',
    source_sha256: spec.sha256,
    goal: [{ text: 'router 能按行回到原文。', refs: [{ lines: [goalLine, goalLine], quote: '不必整份重读 spec' }] }],
    constraints: [],
    acs: [{ id: 'AC-001', gist: '来源哈希不一致的摘要判不可用。', refs: [{ lines: [acLine, acLine], quote: '来源哈希与当前 spec 不一致' }] }],
    modules: [],
    open_questions: [],
    proposed_packages: [],
  };
}

function makeCfg(t, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dossierDir: path.join(root, 'dossier'), ...over };
}

function writeDigestFile(cfg, spec, content) {
  const p = digestPath(cfg, ID, spec.sha256);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const raw = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(p, raw);
  return { p, raw };
}

/** 造 n 次失败尝试的 meta（内核真实写入的形状，见 stages/actions/digest.mjs）。 */
function metaWithAttempts(n, over = {}) {
  return {
    schema_version: 1,
    spec_sha256: SPEC_A.sha256,
    valid: false,
    attempts: Array.from({ length: n }, (_, i) => ({
      round: i + 1, ok: false, errors: ['摘要文件缺失'], cost_usd: 0.01, session_ok: true,
      at: '2026-09-18T00:00:00.000Z',
    })),
    ...over,
  };
}

test('落盘布局：三个文件同目录、按 spec 内容哈希前 12 位命名（换了路径不换名字）', (t) => {
  const cfg = makeCfg(t);
  const dir = digestDir(cfg, ID);
  assert.equal(dir, path.join(cfg.dossierDir, ID, 'digest'));
  const sha12 = shortSha(SPEC_A.sha256);
  assert.equal(digestPath(cfg, ID, SPEC_A.sha256), path.join(dir, `${sha12}.json`));
  assert.equal(digestMetaPath(cfg, ID, SPEC_A.sha256), path.join(dir, `${sha12}.meta.json`));
  assert.equal(digestSourcePath(cfg, ID, SPEC_A.sha256), path.join(dir, `${sha12}.source.md`));
  // 两个版本必须落到两个文件：同名会让新版覆盖旧版，「旧摘要过期」就退化成「旧摘要被顶替」。
  assert.notEqual(digestPath(cfg, ID, SPEC_B.sha256), digestPath(cfg, ID, SPEC_A.sha256));
});

test('digestStateFor：没有 spec（brief 即契约）→ none，且不碰盘', (t) => {
  const cfg = makeCfg(t);
  assert.deepEqual(digestStateFor(cfg, ID, null), {
    state: 'none', path: null, digest: null, errors: [], meta: null, attempts: 0,
  });
  assert.equal(fs.existsSync(cfg.dossierDir), false, 'none 分支不该建出任何目录');
});

test('digestStateFor：这一版还没有摘要 → missing（不是 invalid，也不是 exhausted）', (t) => {
  const cfg = makeCfg(t);
  const r = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(r.state, 'missing');
  assert.equal(r.path, digestPath(cfg, ID, SPEC_A.sha256));
  assert.equal(r.digest, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.attempts, 0);
  assert.deepEqual(r.meta.attempts, [], '没有 meta 时给出默认形状，而不是 null');
});

test('digestStateFor：合格摘要 → valid，带回 parse 好的摘要与 stats', (t) => {
  const cfg = makeCfg(t);
  writeDigestFile(cfg, SPEC_A, digestFor(SPEC_A));
  const r = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(r.state, 'valid', r.errors.join(' | '));
  assert.deepEqual(r.digest, digestFor(SPEC_A));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats, { goal: 1, constraints: 0, acs: 1, modules: 0, open_questions: 0, proposed_packages: 0 });
});

test('digestStateFor：文件在但不合格 → invalid + 错误清单，digest 恒为 null（半成品绝不外流）', (t) => {
  const cfg = makeCfg(t);
  const bad = digestFor(SPEC_A);
  bad.acs = []; // 少一条 AC：范围被悄悄裁掉
  writeDigestFile(cfg, SPEC_A, bad);
  const r = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(r.state, 'invalid');
  assert.equal(r.digest, null, 'invalid 时绝不能把半成品摘要交给 router');
  assert.match(r.errors.join(' | '), /acs 缺 1 条：AC-001/);
  assert.equal(r.attempts, 0, '还没写过 meta，重试额度还在');

  // 坏 JSON / 空文件同样是 invalid，而不是被当成「没有摘要」而反复重生成。
  writeDigestFile(cfg, SPEC_A, '{ 这不是 JSON');
  assert.match(digestStateFor(cfg, ID, SPEC_A).errors.join(), /摘要不是合法 JSON/);
  writeDigestFile(cfg, SPEC_A, '');
  const empty = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(empty.state, 'invalid');
  assert.deepEqual(empty.errors, ['摘要文件缺失或为空']);
});

test('digestStateFor：尝试次数用尽 → exhausted（缺文件与不合格文件两条路径都要降级，不能卡死）', (t) => {
  const cfg = makeCfg(t);
  const max = DEFAULT_DIGEST_MAX_ATTEMPTS;

  // 边界：差一次仍然可重试，到点就降级。
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(max - 1));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'missing');
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(max));
  const gone = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(gone.state, 'exhausted');
  assert.equal(gone.attempts, max);

  // 盘上有不合格文件时同理：invalid → exhausted，errors 仍要带出来给人看。
  const bad = digestFor(SPEC_A);
  bad.schema = 'spec-digest/v0';
  writeDigestFile(cfg, SPEC_A, bad);
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(max - 1));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'invalid');
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(max));
  const dead = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(dead.state, 'exhausted');
  assert.match(dead.errors.join(), /schema 必须为/);

  // 已经合格的摘要不受尝试计数影响：用尽额度不等于作废成果。
  writeDigestFile(cfg, SPEC_A, digestFor(SPEC_A));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'valid');
});

test('digestMaxAttempts：默认 3；正整数可覆盖；0 / 负数 / 小数 / 垃圾值一律回落默认', (t) => {
  const cfg = makeCfg(t);
  assert.equal(DEFAULT_DIGEST_MAX_ATTEMPTS, 3);
  assert.equal(digestMaxAttempts(cfg), 3);
  assert.equal(digestMaxAttempts({ digestMaxAttempts: 1 }), 1);
  assert.equal(digestMaxAttempts({ digestMaxAttempts: 5 }), 5);
  for (const bad of [0, -1, 2.5, 'three', null, undefined, {}, NaN, Infinity]) {
    assert.equal(digestMaxAttempts({ digestMaxAttempts: bad }), 3, `${String(bad)} 应回落默认`);
  }
  assert.equal(digestMaxAttempts(null), 3, 'cfg 本身为 null 也不抛错');

  // 配置真的生效：max=1 时第一次失败即降级。
  const one = makeCfg(t, { digestMaxAttempts: 1 });
  writeDigestMeta(one, ID, SPEC_A.sha256, metaWithAttempts(1));
  assert.equal(digestStateFor(one, ID, SPEC_A).state, 'exhausted');
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'missing', '同样一份 meta，默认额度下仍可重试');
});

test('过期（核心）：A 版的合格摘要，对正文改过的 B 版报 missing；A 版自己仍然 valid', (t) => {
  const cfg = makeCfg(t);
  writeDigestFile(cfg, SPEC_A, digestFor(SPEC_A));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'valid');

  // 人在闸上改了一个字：这就是另一个版本，旧摘要既不会被复用，也不会被覆盖。
  assert.notEqual(SPEC_B.sha256, SPEC_A.sha256);
  const b = digestStateFor(cfg, ID, SPEC_B);
  assert.equal(b.state, 'missing', '哈希即版本：改过的 spec 没有摘要，必须重新生成');
  assert.equal(b.digest, null);
  assert.equal(fs.existsSync(digestPath(cfg, ID, SPEC_A.sha256)), true, '旧版摘要留在盘上，供旧版引用继续解析');
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'valid');
});

test('过期：把旧摘要复制到新版路径也没用——判定是现算的，来源哈希与引用都会当场被戳穿', (t) => {
  const cfg = makeCfg(t);
  // 在正文开头插一行：内容变了，而且原来的行号全部下移一行。
  const shifted = specOf(`> 评审备注：本段由人在闸上追加。\n${SPEC_TEXT}`);
  const stale = digestFor(SPEC_A); // 为 A 版生成，行号是 A 版的
  writeDigestFile(cfg, shifted, stale);

  const r = digestStateFor(cfg, ID, shifted);
  assert.equal(r.state, 'invalid');
  assert.equal(r.digest, null);
  const joined = r.errors.join(' | ');
  assert.match(joined, /source_sha256 不匹配/, '来源版本对不上是第一道拦截');
  assert.match(joined, /没有逐字出现在 L\d+/, '行号整体下移后，旧引用不再指向原来的句子');
});

test('过期：meta 里留档的 valid:true 不是依据，现算说了算（反之亦然）', (t) => {
  const cfg = makeCfg(t);
  const bad = digestFor(SPEC_A);
  bad.source_sha256 = sha256Of('别的版本');
  writeDigestFile(cfg, SPEC_A, bad);
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(0, { valid: true, validated_at: '2026-09-18T00:00:00.000Z' }));
  const r = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(r.state, 'invalid', 'meta 盖章 valid 也救不了一份现在不合格的摘要');
  assert.equal(r.meta.valid, true, 'meta 原样带出（留档），但不参与判定');

  // 反向：meta 记着 valid:false，盘上的文件其实合格 → 仍判 valid。
  writeDigestFile(cfg, SPEC_A, digestFor(SPEC_A));
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(0, { valid: false }));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'valid');
});

test('readDigestMeta / writeDigestMeta：缺失与损坏都回默认形状，attempts 恒为数组', (t) => {
  const cfg = makeCfg(t);
  assert.deepEqual(readDigestMeta(cfg, ID, SPEC_A.sha256), {
    schema_version: 1, spec_sha256: SPEC_A.sha256, attempts: [], valid: false,
  });

  const meta = metaWithAttempts(2, { model: 'claude-haiku-4-5', prompt_sha256: 'a'.repeat(64) });
  writeDigestMeta(cfg, ID, SPEC_A.sha256, meta);
  assert.deepEqual(readDigestMeta(cfg, ID, SPEC_A.sha256), meta);
  assert.ok(fs.readFileSync(digestMetaPath(cfg, ID, SPEC_A.sha256), 'utf8').endsWith('}\n'), '按内核的原子 JSON 写法落盘');

  // 坏 meta 不能让整条判定链抛错：摘要只是锦上添花，绝不能因为元数据损坏卡住任务。
  fs.writeFileSync(digestMetaPath(cfg, ID, SPEC_A.sha256), '{ 坏掉了');
  assert.deepEqual(readDigestMeta(cfg, ID, SPEC_A.sha256).attempts, []);
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'missing');

  // attempts 被写成非数组时强制归位，否则 .length 会算出垃圾额度。
  writeDigestMeta(cfg, ID, SPEC_A.sha256, { schema_version: 1, attempts: 'lots', valid: true });
  assert.deepEqual(readDigestMeta(cfg, ID, SPEC_A.sha256).attempts, []);
  assert.equal(digestStateFor(cfg, ID, SPEC_A).attempts, 0);
});

test('writeDigestSource / readDigestSource：快照按哈希命名，读取方必须用 sha 复核', (t) => {
  const cfg = makeCfg(t);
  assert.equal(readDigestSource(cfg, ID, SPEC_A.sha256), null, '还没拍快照');

  const p = writeDigestSource(cfg, ID, SPEC_A);
  assert.equal(p, digestSourcePath(cfg, ID, SPEC_A.sha256));
  assert.equal(fs.readFileSync(p, 'utf8'), SPEC_TEXT, '逐字落盘，不加不减');
  assert.equal(readDigestSource(cfg, ID, SPEC_A.sha256), SPEC_TEXT);

  // 快照被动过 → null。摘要的行号引用只对这一版成立，读到一份被改过的「原文」比读不到更危险。
  fs.writeFileSync(p, `${SPEC_TEXT}被悄悄加的一行\n`);
  assert.equal(readDigestSource(cfg, ID, SPEC_A.sha256), null);
  assert.equal(readDigestSource(cfg, ID, SPEC_B.sha256), null, '没有这一版的快照');
  assert.equal(readDigestSource(cfg, ID, 'deadbeef'), null, '乱给哈希也只返回 null，不抛错');
});

test('writeDigestSource：内容一致就不重写，被改过则用正本覆盖回去（自愈）', (t) => {
  const cfg = makeCfg(t);
  const p = writeDigestSource(cfg, ID, SPEC_A);
  const before = fs.statSync(p).mtimeMs;
  assert.equal(writeDigestSource(cfg, ID, SPEC_A), p);
  assert.equal(fs.statSync(p).mtimeMs, before, '内容没变就不该动文件');

  fs.writeFileSync(p, '被别人覆盖成了别的东西\n');
  writeDigestSource(cfg, ID, SPEC_A);
  assert.equal(fs.readFileSync(p, 'utf8'), SPEC_TEXT);
  assert.equal(readDigestSource(cfg, ID, SPEC_A.sha256), SPEC_TEXT);

  // 名字取自调用方给的 sha256：如果 sha 与正文不是一对，快照就永远复核不过（读侧只会拿到 null）。
  writeDigestSource(cfg, ID, { text: '和哈希对不上的正文\n', sha256: SPEC_B.sha256 });
  assert.equal(readDigestSource(cfg, ID, SPEC_B.sha256), null);
});

test('resetDigest：归档而不是删除——旧摘要与 meta 原样留在盘上，尝试计数清零', (t) => {
  const cfg = makeCfg(t);
  const { raw } = writeDigestFile(cfg, SPEC_A, digestFor(SPEC_A));
  const metaRaw = `${JSON.stringify(metaWithAttempts(3), null, 2)}\n`;
  fs.writeFileSync(digestMetaPath(cfg, ID, SPEC_A.sha256), metaRaw);
  writeDigestSource(cfg, ID, SPEC_A);
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'valid');

  resetDigest(cfg, ID, SPEC_A.sha256);

  assert.equal(fs.existsSync(digestPath(cfg, ID, SPEC_A.sha256)), false);
  assert.equal(fs.existsSync(digestMetaPath(cfg, ID, SPEC_A.sha256)), false);
  const names = fs.readdirSync(digestDir(cfg, ID));
  const archived = names.filter((n) => /\.json\.replaced-\d+$/.test(n));
  assert.equal(archived.length, 2, '摘要与 meta 各归档一份');
  // 旧摘要是复盘「模型当时看错了什么」的唯一证据：字节必须一个不差地留着。
  const archivedDigest = archived.find((n) => !n.includes('.meta.'));
  assert.equal(fs.readFileSync(path.join(digestDir(cfg, ID), archivedDigest), 'utf8'), raw);
  const archivedMeta = archived.find((n) => n.includes('.meta.'));
  assert.equal(fs.readFileSync(path.join(digestDir(cfg, ID), archivedMeta), 'utf8'), metaRaw);
  // 原文快照不归档：它是这一版引用的坐标系，重做摘要还要接着用。
  assert.equal(readDigestSource(cfg, ID, SPEC_A.sha256), SPEC_TEXT);

  // 计数随 meta 一起清零：--force 之后必须真的还能再生成，否则「重做」等于不做。
  const after = digestStateFor(cfg, ID, SPEC_A);
  assert.equal(after.state, 'missing');
  assert.equal(after.attempts, 0);
});

test('resetDigest：盘上什么都没有时静默返回，不抛错也不凭空建目录', (t) => {
  const cfg = makeCfg(t);
  assert.doesNotThrow(() => resetDigest(cfg, ID, SPEC_A.sha256));
  assert.equal(fs.existsSync(digestDir(cfg, ID)), false);

  // 只有 meta 没有摘要（生成失败过 N 次）时，也要能清零重来。
  writeDigestMeta(cfg, ID, SPEC_A.sha256, metaWithAttempts(3));
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'exhausted');
  resetDigest(cfg, ID, SPEC_A.sha256);
  assert.equal(digestStateFor(cfg, ID, SPEC_A).state, 'missing');
});

test('digestPromptSha：跟着 agents/digest-agent.md 的内容走（摘要按哪一版 prompt 生成要能追溯）', (t) => {
  const cfg = makeCfg(t);
  const empty = crypto.createHash('sha256').update('', 'utf8').digest('hex');
  assert.equal(digestPromptSha(cfg), empty, 'prompt 文件缺失时退化成空串的哈希，而不是抛错');

  const promptPath = path.join(cfg.root, 'agents', 'digest-agent.md');
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, '# Digest Agent\n第一版\n');
  const v1 = digestPromptSha(cfg);
  assert.equal(v1, crypto.createHash('sha256').update('# Digest Agent\n第一版\n', 'utf8').digest('hex'));

  fs.writeFileSync(promptPath, '# Digest Agent\n第二版\n');
  assert.notEqual(digestPromptSha(cfg), v1, '改了 prompt 就是另一个指纹');
});
