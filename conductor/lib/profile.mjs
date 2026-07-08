// lib/profile.mjs — target repo 级 setup profile 路径与审批状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic, writeJsonAtomic } from './state.mjs';

function safeName(name) {
  return String(name ?? 'repo').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

export function setupProfileKey(cfg) {
  const repo = path.resolve(cfg.targetRepo);
  const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 12);
  return `${safeName(path.basename(repo))}-${hash}`;
}

export function setupProfilePaths(cfg) {
  const key = setupProfileKey(cfg);
  const dir = path.join(cfg.targetProfilesDir, key);
  return {
    key,
    dir,
    draft: path.join(dir, 'setup-profile.draft.md'),
    approved: path.join(dir, 'setup-profile.md'),
    meta: path.join(dir, 'setup-profile.json'),
  };
}

export function readApprovedSetupProfile(cfg) {
  const paths = setupProfilePaths(cfg);
  try {
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
    if (meta?.approved !== true) return null;
    if (!fs.existsSync(paths.approved)) return null;
    return { paths, meta, markdown: fs.readFileSync(paths.approved, 'utf8') };
  } catch {
    return null;
  }
}

export function hasApprovedSetupProfile(cfg) {
  return readApprovedSetupProfile(cfg) !== null;
}

/**
 * gateCommands：可选，repo 级 green-gate 附加命令默认值（task.json 未提供该字段时的兜底，
 * 见 stages/decisions.mjs::resolveGateCommands）。缺省不写该字段，保持旧 meta 形态不变。
 */
export function writeApprovedSetupProfile(cfg, { markdown, sourceTaskId = null, gateCommands } = {}) {
  const paths = setupProfilePaths(cfg);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeFileAtomic(paths.approved, markdown);
  const meta = {
    schema_version: 1,
    profile_key: paths.key,
    targetRepo: cfg.targetRepo,
    approved: true,
    approved_at: new Date().toISOString(),
    source_task_id: sourceTaskId,
    ...(gateCommands !== undefined ? { gateCommands } : {}),
  };
  writeJsonAtomic(paths.meta, meta);
  return { paths, meta };
}
