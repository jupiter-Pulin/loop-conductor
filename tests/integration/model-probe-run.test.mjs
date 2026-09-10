// 集成：run 启动时的模型可用性探测（AC-052 的终止路径）。
// 探测失败必须在**处理任何任务之前**终止本次 run：任务状态零变化，代价是一次启动，
// 而不是四个角色各 spawn 失败、各烧一遍退避阶梯、把任务推进错误的分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makerStep, newRouterEnv, routerStep } from '../helpers/router-env.mjs';

function probeCache(env) {
  const p = path.join(env.root, 'state', '.model-probe.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('AC-052：配置了不可用的模型 id → run 终止并列出 id，任务状态零变化', (t) => {
  const { env, id } = newRouterEnv(t, { config: { models: { router: 'no-such-model-x' } } });
  const before = env.findTask(id);
  // 探测那一次调用就是剧本的第 0 步：让它以非零退出（模型不存在类错误）。
  env.setScenario([
    { exitCode: 1, stderr: 'API Error: model not found: no-such-model-x' },
    routerStep('maker'),
    makerStep(),
  ]);

  const run = env.run('run');
  assert.notEqual(run.status, 0, 'run 应以非零退出');
  assert.match(run.stderr, /模型不可用：no-such-model-x/);
  assert.match(run.stderr, /本次 run 终止/);

  const after = env.findTask(id);
  assert.equal(after.runtime.stage, before.runtime.stage);
  assert.equal(after.runtime.current_round, 0, '任务一轮都没跑');
  assert.ok(env.calls().every((c) => c.prompt === 'reply ok'), '只有探测调用，没有任何任务侧 spawn');
  assert.ok(!env.exists(env.dossier(id, 'router-r1.json')));

  // 失败的探测不进缓存：模型恢复后不该被一份「说它不可用」的缓存卡死。
  const cache = probeCache(env);
  assert.ok(!Object.keys(cache?.entries ?? {}).some((k) => k.startsWith('no-such-model-x@')));
});

test('AC-052：探测通过后写入缓存，下次 run 不再探测', (t) => {
  const { env, id } = newRouterEnv(t, { config: { models: { router: 'probe-me-once' } } });
  env.setScenario([
    { cost: 0, result: 'ok' },  // 探测：一次成功的最小会话
    routerStep('human', { summary: '探测通过后照常跑一轮' }),
  ]);
  assert.equal(env.run('run').status, 0);
  assert.equal(env.calls().filter((c) => c.prompt === 'reply ok').length, 1, '探测恰好 1 次');
  assert.equal(env.calls().length, 2, '探测 1 次 + router 1 次');
  assert.ok(Object.keys(probeCache(env).entries).some((k) => k.startsWith('probe-me-once@')));

  // 第二次 run：缓存命中，只剩任务自己的 spawn（这里任务停在 help 闸，一次都不 spawn）。
  assert.equal(env.findTask(id).runtime.awaiting.kind, 'help');
  assert.equal(env.run('run').status, 0);
  assert.equal(env.calls().filter((c) => c.prompt === 'reply ok').length, 1, '缓存命中不再探测');
});
