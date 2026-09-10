// 单元：模型可用性探测的缓存键与错误分类（AC-052）。
// 探测存在的理由是「配置里的模型 id 打错时，代价是 run 启动即停」，
// 所以两件事必须钉死：缓存键含 claude 版本（换 CLI 要重探），限额与不可用绝不混为一谈。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  probeModels, classifyProbeResult, collectModelIds, cacheKeyOf, modelProbeCacheFile,
  detectClaudeVersion, PROBE_PROMPT,
} from '../../conductor/lib/model-probe.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const okRes = () => ({ ok: true, exitCode: 0, raw: { result: 'ok' }, rate_limit: null });
const failRes = (result) => ({
  ok: false, exitCode: 1, rate_limit: null,
  raw: { is_error: true, result, api_error_status: 404 },
  error: 'claude exited 1',
});
const rateLimitedRes = (resetsAt) => ({
  ok: false, exitCode: null, rate_limited: true,
  rate_limit: { type: 'five_hour', resets_at: resetsAt, status: 'rejected' },
});

test('collectModelIds：对象与数组都吃，去重，null / 空串不探（= 用 CLI 默认模型）', () => {
  assert.deepEqual(
    collectModelIds({ router: 'claude-opus-5', spec: 'claude-opus-5', maker: 'claude-sonnet-9', reviewer: null }),
    ['claude-opus-5', 'claude-sonnet-9'],
  );
  assert.deepEqual(collectModelIds(['a', '  ', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(collectModelIds(null), []);
});

test('classifyProbeResult：ok / 限额 / 不可用三分，绝不混淆', () => {
  assert.equal(classifyProbeResult(okRes()).kind, 'ok');

  const rl = classifyProbeResult(rateLimitedRes(1757500000));
  assert.equal(rl.kind, 'rate_limited');
  assert.equal(rl.rate_limit.resets_at, 1757500000);
  // 裸 runClaudeStream 的形态（没盖 rate_limited 标记）同样认得
  assert.equal(
    classifyProbeResult({ ok: false, rate_limit: { type: 'weekly', resets_at: 1, status: 'rejected' } }).kind,
    'rate_limited',
  );

  const bad = classifyProbeResult(failRes('model "claude-opus-9" not found'));
  assert.equal(bad.kind, 'unavailable');
  assert.match(bad.error, /not found/);
  // 瞬态耗尽 / spawn 失败也归不可用：探测已替我们退避过了
  assert.equal(classifyProbeResult({ ok: false, spawnError: true, error: 'ENOENT claude' }).kind, 'unavailable');
  assert.match(classifyProbeResult({ ok: false, exitCode: 7 }).error, /claude exited 7/);
});

test('全部可用 → ok，缓存按「模型 id + claude 版本」落盘', async (t) => {
  const dir = tmpDir(t);
  const cacheFile = path.join(dir, '.model-probe.json');
  const calls = [];
  const res = await probeModels({
    models: { router: 'm-a', maker: 'm-b' },
    cacheFile,
    claudeVersion: '2.1.3',
    runner: async (args) => { calls.push(args); return okRes(); },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.unavailable, []);
  assert.equal(res.rateLimited, null);
  assert.deepEqual(res.probed, ['m-a', 'm-b']);
  assert.deepEqual(calls.map((c) => c.model), ['m-a', 'm-b']);
  assert.equal(calls[0].prompt, PROBE_PROMPT);
  assert.equal(calls[0].maxTurns, 1);

  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(cache.entries).sort(), [cacheKeyOf('m-a', '2.1.3'), cacheKeyOf('m-b', '2.1.3')].sort());
  assert.equal(cache.entries['m-a@2.1.3'].ok, true);
  assert.equal(cache.entries['m-a@2.1.3'].claude_version, '2.1.3');
});

test('缓存命中不再探测；换了 claude 版本必须重探', async (t) => {
  const dir = tmpDir(t);
  const cacheFile = path.join(dir, '.model-probe.json');
  let probes = 0;
  const runner = async () => { probes += 1; return okRes(); };

  const first = await probeModels({ models: ['m-a'], cacheFile, claudeVersion: '2.1.3', runner });
  assert.deepEqual(first.probed, ['m-a']);
  assert.equal(probes, 1);

  const second = await probeModels({ models: ['m-a'], cacheFile, claudeVersion: '2.1.3', runner });
  assert.deepEqual(second.probed, []);
  assert.deepEqual(second.cached, ['m-a']);
  assert.equal(probes, 1, '同版本缓存命中，一次都不该再探');

  const upgraded = await probeModels({ models: ['m-a'], cacheFile, claudeVersion: '2.2.0', runner });
  assert.deepEqual(upgraded.probed, ['m-a'], '换了 CLI 版本，可用模型集合可能变，必须重探');
  assert.equal(probes, 2);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 2, '两个版本各留一条，不互相覆盖');
});

test('模型不可用：逐个列出，不写缓存，ok=false', async (t) => {
  const dir = tmpDir(t);
  const cacheFile = path.join(dir, '.model-probe.json');
  const res = await probeModels({
    models: ['good', 'typo-1', 'typo-2'],
    cacheFile,
    claudeVersion: 'v1',
    runner: async ({ model }) => (model === 'good' ? okRes() : failRes(`model "${model}" not found`)),
  });

  assert.equal(res.ok, false);
  assert.deepEqual(res.unavailable.map((u) => u.model), ['typo-1', 'typo-2'], '不在第一个失败处停手：人要一次看全');
  assert.match(res.unavailable[0].error, /typo-1/);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(cache.entries), [cacheKeyOf('good', 'v1')], '失败不进缓存，否则模型恢复后也永远起不来');
});

test('撞限额：立即停止后续探测，带出重置时刻，不写缓存', async (t) => {
  const dir = tmpDir(t);
  const cacheFile = path.join(dir, '.model-probe.json');
  const probed = [];
  const res = await probeModels({
    models: ['m-a', 'm-b', 'm-c'],
    cacheFile,
    claudeVersion: 'v1',
    runner: async ({ model }) => {
      probed.push(model);
      return model === 'm-a' ? rateLimitedRes(1757500000) : okRes();
    },
  });

  assert.equal(res.ok, false);
  assert.deepEqual(res.unavailable, [], '限额不是「模型不可用」，绝不混报');
  assert.deepEqual(res.rateLimited, { type: 'five_hour', resets_at: 1757500000 });
  assert.deepEqual(probed, ['m-a'], '撞墙后不再探后面的模型');
  assert.equal(fs.existsSync(cacheFile), false, '零成功即不落盘');
});

test('缓存文件损坏当空缓存处理，不抛错', async (t) => {
  const dir = tmpDir(t);
  const cacheFile = path.join(dir, '.model-probe.json');
  fs.writeFileSync(cacheFile, '{ 这不是 JSON');
  const res = await probeModels({ models: ['m-a'], cacheFile, claudeVersion: 'v1', runner: async () => okRes() });
  assert.equal(res.ok, true);
  assert.deepEqual(res.probed, ['m-a']);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries['m-a@v1'].ok, true);
});

test('没有配置任何模型 id → 零探测，直接 ok', async (t) => {
  const dir = tmpDir(t);
  const res = await probeModels({
    models: { router: null, spec: null },
    cacheFile: path.join(dir, '.model-probe.json'),
    claudeVersion: 'v1',
    runner: async () => { throw new Error('不该被调用'); },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.probed, []);
});

test('缓存文件默认落 state/.model-probe.json', () => {
  assert.equal(modelProbeCacheFile({ stateDir: '/x/state' }), path.join('/x/state', '.model-probe.json'));
});

test('detectClaudeVersion：取首行；探不到回落 unknown', () => {
  assert.equal(detectClaudeVersion({ bin: 'claude', run: () => ({ stdout: '2.1.3 (Claude Code)\n' }) }), '2.1.3 (Claude Code)');
  assert.equal(detectClaudeVersion({ bin: 'claude', run: () => ({ stdout: '' }) }), 'unknown');
  assert.equal(detectClaudeVersion({ bin: 'claude', run: () => { throw new Error('ENOENT'); } }), 'unknown');
});
