// 单元：accountSpawnCost 对确定性 spawn 失败（ENOENT/EACCES/ENOTDIR 类）的成本入账（H20）。
// dossier 证据：task-20260718-001 spec-agent r1 `spawn claude ENOENT`（进程根本没起来，
// 零 API 消费）仍被按历史均价 $1.913436 估计入账，虚增 runtime.estimated_cost_usd 与
// dossier-stats 成本统计。估价本意只覆盖「跑了但拿不到 result 的 spawn」（killed/超时），
// 不该覆盖确定性起跑失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountSpawnCost } from '../../conductor/stages/shared.mjs';

function makeDossier(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'det-spawn-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRec(dossierDir, taskId, name, rec) {
  const d = path.join(dossierDir, taskId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), JSON.stringify(rec));
}

test('accountSpawnCost：确定性 spawn 失败（ENOENT）不按历史均价估计入账', (t) => {
  const dossierDir = makeDossier(t);
  writeRec(dossierDir, 'task-20260701-history', 'maker-r1.json', { cost_usd: 2 }); // 有历史样本可估，验证仍不估
  const cfg = { dossierDir, unknownSpawnCostEstimateEnabled: true };
  const ts = { id: 'task-under-test', runtime: { spent_usd: 0 } };
  const res = {
    ok: false,
    costUsd: 0,
    costUnknown: true,
    spawnError: true,
    error: 'Error: spawn claude ENOENT',
  };

  accountSpawnCost(ts, cfg, 'maker', 1, res);

  assert.equal(ts.runtime.estimated_cost_usd, undefined, 'ENOENT 确定性失败不得虚增 estimated_cost_usd');
  assert.equal(ts.runtime.spent_usd, 0, '确定性失败 spent_usd 保持 0（无估计入账）');
  const timeline = fs.readFileSync(path.join(dossierDir, 'task-under-test', 'timeline.md'), 'utf8');
  assert.ok(!timeline.includes('按历史均价'), 'timeline 不出现估计入账行');
  assert.ok(timeline.includes('spawn 确定性失败'), 'timeline 仍保留确定性失败归因');
  assert.ok(timeline.includes('ENOENT'), 'timeline 带 errno 供人工排查');
});
