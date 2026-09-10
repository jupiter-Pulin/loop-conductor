#!/usr/bin/env node
// hooks/check-log.mjs — 每个 agent 的 Stop hook：执行 log 的会话内契约预检。
// 与内核记录合成共用同一份裁判代码（lib/log-contract.mjs::validateLog）。
// 语义：快反馈层，不是终审——文件缺失或不合 schema 时 exit 2 阻断结束（stderr 喂回模型当场自修）；
// stop_hook_active=true 说明本次 stop 已是上一次阻断后的续跑，只拦一次即放行（避免 Stop hook
// 死循环，--max-turns 是最后兜底），剩余问题由内核以 product: missing|invalid 原样交给 router。
// 会话内多一轮近乎免费，冷重派是完整一轮的钱——这就是这个 hook 存在的全部理由。
// stdin：{ session_id, stop_hook_active, ... }；
// 参数：--log <path> --role <role> [--has-plan] --report <path>。
import fs from 'node:fs';
import path from 'node:path';
import { validateLog } from '../lib/log-contract.mjs';

function parseArgs(argv) {
  const out = { hasPlan: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log' && argv[i + 1]) out.log = argv[++i];
    else if (argv[i] === '--role' && argv[i + 1]) out.role = argv[++i];
    else if (argv[i] === '--report' && argv[i + 1]) out.report = argv[++i];
    else if (argv[i] === '--has-plan') out.hasPlan = true;
  }
  return out;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const { log: logPath, role, report, hasPlan } = parseArgs(process.argv.slice(2));
if (!logPath || !role) {
  console.error('check-log: 缺 --log 或 --role 参数（hook 配置错误，放行，交给内核读取时判定）');
  process.exit(0);
}

const input = readStdinJson();
let check;
let raw = null;
try {
  raw = fs.readFileSync(logPath, 'utf8');
} catch {
  check = { ok: false, errors: [`log 文件不存在：${logPath}`] };
}
if (!check) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    check = { ok: false, errors: [`log 不是合法 JSON：${e.message}`] };
  }
  if (!check) check = validateLog(parsed, role, { planActive: hasPlan });
}

const stopHookActive = input.stop_hook_active === true;
const blocked = !check.ok && !stopHookActive;

if (report) {
  try {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${JSON.stringify({
      schema_version: 1,
      source: 'stop-hook',
      log_path: logPath,
      role,
      has_plan: hasPlan,
      session_id: input.session_id ?? null,
      stop_hook_active: stopHookActive,
      ok: check.ok,
      errors: check.errors,
      blocked,
      checked_at: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch { /* 留档失败不影响裁决 */ }
}

if (!blocked) process.exit(0);

console.error(
  `执行 log 契约检查未通过（${logPath}）：\n- ${check.errors.join('\n- ')}\n`
  + '请用 Write 工具把完整合法的 JSON 重写进该文件后再结束回复。',
);
process.exit(2);
