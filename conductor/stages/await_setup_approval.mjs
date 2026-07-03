// AWAIT_SETUP_APPROVAL：repo 级 setup profile 人类闸门。
// approved → 冻结 setup-profile.md + setup-profile.json → 回到原任务入口。
import fs from 'node:fs';
import path from 'node:path';
import { setupProfilePaths, writeApprovedSetupProfile } from '../lib/profile.mjs';
import * as state from '../lib/state.mjs';
import { entryStageAfterSetup } from './shared.mjs';
import { setupApprovalNext } from './decisions.mjs';

export default function awaitSetupApprovalHandler(ts, cfg) {
  const id = ts.id;
  const next = setupApprovalNext(ts.runtime.setup_approval ?? null);
  if (next === null) return { changed: false };

  const paths = setupProfilePaths(cfg);
  if (!fs.existsSync(paths.draft)) {
    console.error(`[${id}] setup profile 草稿缺失：${path.relative(cfg.root, paths.draft)}`);
    return { changed: false };
  }
  const markdown = fs.readFileSync(paths.draft, 'utf8');
  writeApprovedSetupProfile(cfg, { markdown, sourceTaskId: id });
  state.appendTimeline(cfg, id, `setup profile approved → ${path.relative(cfg.root, paths.approved)}`);
  state.transitionState(ts, cfg, entryStageAfterSetup(ts), 'setup approved');
  return { changed: true };
}
