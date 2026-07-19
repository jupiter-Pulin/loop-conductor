// 回归守卫：--task 的新增分支不得影响全量模式输出（spec AC-006/AC-007）。
// 只导入改动前已存在的 collectStats/renderMarkdown，并直接子进程跑 CLI 脚本本身——
// 这样本文件在改动前基线上也能正常加载并通过，符合「回归守卫」的 pass_on_baseline 语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectStats, renderMarkdown } from '../../tools/dossier-stats.mjs';

const CLI = fileURLToPath(new URL('../../tools/dossier-stats.mjs', import.meta.url));

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-stats-full-'));
  for (const d of ['state/queue', 'state/done', 'state/failed', 'dossier']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTaskFixture(root, box, id, { kind = 'bugfix', runtime = {} } = {}) {
  const stateDir = path.join(root, 'state', box, id);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task.json'), JSON.stringify({ id, kind }));
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ stage: 'DONE', maker_miss_count: 0, spent_usd: 0, ...runtime }));
  fs.mkdirSync(path.join(root, 'dossier', id), { recursive: true });
}

test('AC-006：全量 markdown 模式 CLI 实际输出与 renderMarkdown(collectStats(root)) 逐字节等价', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260703-001', { runtime: { spent_usd: 1.5 } });
  writeTaskFixture(root, 'failed', 'task-20260703-002', { runtime: { last_failure_type: 'spawn_failed' } });

  const stdout = execFileSync(process.execPath, [CLI, root], { encoding: 'utf8' });
  const expected = `${renderMarkdown(collectStats(root))}\n`;
  assert.equal(stdout, expected);
});

test('AC-007：全量 --json 模式 CLI 实际输出与 JSON.stringify(collectStats(root), null, 2) 逐字节等价', (t) => {
  const root = makeRoot(t);
  writeTaskFixture(root, 'done', 'task-20260703-001', { runtime: { spent_usd: 1.5 } });

  const stdout = execFileSync(process.execPath, [CLI, '--json', root], { encoding: 'utf8' });
  const expected = `${JSON.stringify(collectStats(root), null, 2)}\n`;
  assert.equal(stdout, expected);
});
