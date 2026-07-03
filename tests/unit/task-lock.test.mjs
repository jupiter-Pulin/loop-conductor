import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTaskLock, TaskLockBusyError, taskLockDir } from '../../conductor/lib/task-lock.mjs';

function tmpCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dossierDir: path.join(root, 'dossier') };
}

test('withTaskLock：持锁期间第二个调用失败，释放后可重入', async (t) => {
  const cfg = tmpCfg(t);
  const id = 'task-20260611-701';
  let release;
  const first = withTaskLock(cfg, id, async () => {
    await new Promise((resolve) => { release = resolve; });
    return 'done';
  });
  while (!fs.existsSync(taskLockDir(cfg, id))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await assert.rejects(
    () => withTaskLock(cfg, id, async () => 'second', { retries: 1, retryDelayMs: 5 }),
    TaskLockBusyError,
  );
  release();
  assert.equal(await first, 'done');
  assert.equal(await withTaskLock(cfg, id, async () => 'again'), 'again');
});
