// lib/profile.mjs — target repo 级 profile：路径派生 + `precommit` 段的读取与校验。
// 文件本身是人手写的（`new` 只校验、不生成），所以这里没有任何写盘函数。
import path from 'node:path';
import crypto from 'node:crypto';

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

// ---- precommit 段（spec §precommit / AC-018 / AC-019）----
// `target-profiles/<repo>/setup-profile.json` 的 `precommit` 段是人手写的：precommit 三步
// （构建 / 启动服务 / 分层测试）的命令由人在 profile 里给定，内核不猜、不生成、不改写。
// 这里只做「读」与「校验」两件纯函数的事；`new` 用校验结果决定拒不拒绝建任务，
// `lib/precommit.mjs` 用读取结果决定跑哪几步。

/** 层级测试命令的键序（tier 累加的唯一顺序来源）。 */
export const PRECOMMIT_TIERS = Object.freeze(['unit', 'integration', 'e2e']);

/** `new` 拒绝时打印的样例：全部键都在，可删的逐条注明（AC-019）。 */
export const PRECOMMIT_PROFILE_SAMPLE = `{
  "precommit": {
    "build": "npm run build",
    "service": {
      "start": "npm run start",
      "ready": { "url": "http://127.0.0.1:3000/health" },
      "ready_timeout_ms": 60000,
      "env": { "PORT": "3000", "NODE_ENV": "test" },
      "stop_grace_ms": 10000
    },
    "unit": "npm test",
    "integration": "npm run test:integration",
    "e2e": "npm run test:e2e"
  }
}

可删的键：
- build —— 无构建步的解释型仓库删掉，该步记 skipped。
- service —— 库 / CLI / 纯合约仓库删掉，该步记 skipped；保留时 start 与 ready 必填，
  ready 为 { "url": … }（2xx 即就绪）或 { "command": … }（exit 0 即就绪）二选一，
  ready_timeout_ms 默认 60000、stop_grace_ms 默认 10000、env 可省。
- integration / e2e —— 没有这两层的仓库删掉，reviewer 声明更高层级时记 skipped_tiers。
必填的键：
- unit —— 缺省时回落任务的 testCommand；两者皆无则本仓库无法建任务。`;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * 读 precommit 段（含 unit 的 testCommand 回落）。零 IO：入参是已解析的 setup-profile.json
 * 与任务快照。缺段、缺键一律回落 null——「没配」是合法状态（该步 skipped），不是错误。
 * 返回 { build, service, unit, integration, e2e, unit_source }。
 */
export function readPrecommitProfile(setupProfileJson, task = null) {
  const sec = isPlainObject(setupProfileJson?.precommit) ? setupProfileJson.precommit : null;
  const unitConfigured = nonEmptyString(sec?.unit);
  const unitFallback = nonEmptyString(task?.testCommand);
  return {
    build: nonEmptyString(sec?.build),
    service: isPlainObject(sec?.service) ? sec.service : null,
    unit: unitConfigured ?? unitFallback,
    integration: nonEmptyString(sec?.integration),
    e2e: nonEmptyString(sec?.e2e),
    unit_source: unitConfigured ? 'precommit.unit' : (unitFallback ? 'task.testCommand' : null),
  };
}

function validateService(service, errors) {
  if (!isPlainObject(service)) {
    errors.push('precommit.service 必须是对象（不需要服务就整段删掉）');
    return;
  }
  if (!nonEmptyString(service.start)) errors.push('precommit.service.start 必填且为非空字符串');
  const ready = service.ready;
  if (!isPlainObject(ready)) {
    errors.push('precommit.service.ready 必填，形如 { "url": … } 或 { "command": … }');
  } else {
    const hasUrl = nonEmptyString(ready.url) != null;
    const hasCommand = nonEmptyString(ready.command) != null;
    if (hasUrl === hasCommand) {
      errors.push('precommit.service.ready 必须且只能给 url 与 command 之一');
    }
    if (hasUrl) {
      try { new URL(ready.url); } catch { errors.push(`precommit.service.ready.url 不是合法 URL：${ready.url}`); }
    }
  }
  for (const key of ['ready_timeout_ms', 'stop_grace_ms']) {
    if (service[key] === undefined) continue;
    if (!Number.isFinite(service[key]) || service[key] <= 0) {
      errors.push(`precommit.service.${key} 必须是正数毫秒`);
    }
  }
  if (service.env !== undefined) {
    if (!isPlainObject(service.env)) errors.push('precommit.service.env 必须是对象');
    else {
      for (const [k, v] of Object.entries(service.env)) {
        if (typeof v !== 'string') errors.push(`precommit.service.env.${k} 必须是字符串（环境变量值）`);
      }
    }
  }
}

/**
 * 校验 precommit 段（AC-019 的裁判）。返回 { ok, errors, sample }：
 * profile 缺失、无 precommit 段、unit 与 task.testCommand 皆缺，或各键形状不对 → errors 非空。
 * sample 恒为 PRECOMMIT_PROFILE_SAMPLE，调用方（`new`）原样打到 stderr 让人照着手写。
 */
export function validatePrecommitProfile(setupProfileJson, task = null) {
  const errors = [];
  if (!isPlainObject(setupProfileJson)) {
    errors.push('setup-profile.json 缺失或不是 JSON 对象：目标仓库尚未配置 precommit');
  } else if (!isPlainObject(setupProfileJson.precommit)) {
    errors.push('setup-profile.json 缺 precommit 段');
  } else {
    const sec = setupProfileJson.precommit;
    if (sec.build !== undefined && !nonEmptyString(sec.build)) {
      errors.push('precommit.build 必须是非空字符串（无构建步就删掉该键）');
    }
    if (sec.service !== undefined) validateService(sec.service, errors);
    for (const tier of PRECOMMIT_TIERS) {
      if (sec[tier] !== undefined && !nonEmptyString(sec[tier])) {
        errors.push(`precommit.${tier} 必须是非空字符串（没有这一层就删掉该键）`);
      }
    }
    if (!nonEmptyString(sec.unit) && !nonEmptyString(task?.testCommand)) {
      errors.push('precommit.unit 与任务的 testCommand 皆缺：至少要有一条单元测试命令');
    }
  }
  return { ok: errors.length === 0, errors, sample: PRECOMMIT_PROFILE_SAMPLE };
}
