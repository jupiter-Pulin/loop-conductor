import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScheduler } from '../../conductor/lib/scheduler.mjs';
import { writeNewTask, saveRuntime } from '../../conductor/lib/state.mjs';

function cfgWithTask(t, stage = 'READY') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = {
    root,
    queueDir: path.join(root, 'state', 'queue'),
    dossierDir: path.join(root, 'dossier'),
    maxConcurrentTasks: 3,
    maxStepsPerTask: 3,
  };
  fs.mkdirSync(cfg.queueDir, { recursive: true });
  const id = 'task-20260611-801';
  writeNewTask(
    cfg.queueDir,
    { schema_version: 1, id, kind: 'bugfix', title: 'x', baseBranch: 'main', testCommand: 'node --test' },
    { schema_version: 1, stage, spent_usd: 0, updated_at: '2026-06-11T00:00:00.000Z' },
  );
  return { cfg, id };
}

test('runScheduler：同一任务相邻 step 严格串行，不重叠', async (t) => {
  const { cfg, id } = cfgWithTask(t);
  let active = 0;
  let calls = 0;
  const handlers = {
    READY: async (ts) => {
      active += 1;
      assert.equal(active, 1, '同一任务 handler 不应重叠执行');
      await new Promise((resolve) => setTimeout(resolve, 25));
      calls += 1;
      ts.runtime.stage = calls === 1 ? 'VERIFY' : 'AWAIT_HUMAN_MERGE';
      saveRuntime(ts);
      active -= 1;
      return { changed: true };
    },
    VERIFY: async (ts) => {
      active += 1;
      assert.equal(active, 1, '同一任务第二个 step 不应与前一个重叠');
      await new Promise((resolve) => setTimeout(resolve, 25));
      calls += 1;
      ts.runtime.stage = 'AWAIT_HUMAN_MERGE';
      saveRuntime(ts);
      active -= 1;
      return { changed: true };
    },
    AWAIT_HUMAN_MERGE: async () => ({ changed: false }),
  };

  const result = await runScheduler(cfg, handlers);
  assert.equal(result.capped.length, 0);
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(path.join(cfg.dossierDir, id, '.lock')), false, 'step 后释放 task lock');
});
