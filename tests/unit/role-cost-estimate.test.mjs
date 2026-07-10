// 单元：estimateRoleCost（H20）——killed spawn 成本估计的样本口径。
// 只取该角色 <role>-r<n>.json 中 cost_unknown!==true 且 cost_usd>0 的样本；
// 其他角色 / unknown 样本 / 零成本 / 损坏 JSON / 缺目录一律不入样。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateRoleCost } from '../../conductor/stages/shared.mjs';

function makeDossier(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRec(dossierDir, taskId, name, rec) {
  const d = path.join(dossierDir, taskId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), typeof rec === 'string' ? rec : JSON.stringify(rec));
}

test('estimateRoleCost：跨任务聚合同角色已知成本，排除 unknown/零成本/他角色/损坏样本', (t) => {
  const dossierDir = makeDossier(t);
  writeRec(dossierDir, 'task-20260701-001', 'verifier-r1.json', { cost_usd: 2.0 });
  writeRec(dossierDir, 'task-20260701-002', 'verifier-r1.json', { cost_usd: 1.0 });
  writeRec(dossierDir, 'task-20260701-002', 'verifier-r2.json', { cost_usd: 3.0, cost_unknown: true }); // killed 样本不入样
  writeRec(dossierDir, 'task-20260701-002', 'verifier-r3.json', { cost_usd: 0 });                        // 零成本不入样
  writeRec(dossierDir, 'task-20260701-002', 'maker-r1.json', { cost_usd: 99 });                          // 他角色不入样
  writeRec(dossierDir, 'task-20260701-003', 'verifier-r1.json', '{broken json');                         // 损坏容错
  const { avg, samples } = estimateRoleCost({ dossierDir }, 'verifier');
  assert.equal(samples, 2);
  assert.equal(avg, 1.5);
});

test('estimateRoleCost：无样本 / 目录缺失 → { avg: 0, samples: 0 }', (t) => {
  const dossierDir = makeDossier(t);
  assert.deepEqual(estimateRoleCost({ dossierDir }, 'verifier'), { avg: 0, samples: 0 });
  assert.deepEqual(estimateRoleCost({ dossierDir: path.join(dossierDir, 'nope') }, 'verifier'), { avg: 0, samples: 0 });
  // 角色名作正则字面量：spec-agent 的 `-` 无特殊义，常规命名全兼容
  writeRec(dossierDir, 'task-20260701-004', 'spec-agent-r1.json', { cost_usd: 0.5 });
  assert.deepEqual(estimateRoleCost({ dossierDir }, 'spec-agent'), { avg: 0.5, samples: 1 });
});
