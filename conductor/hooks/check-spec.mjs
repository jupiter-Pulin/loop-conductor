#!/usr/bin/env node
// hooks/check-spec.mjs — spec-agent 的 Stop hook：spec 交付文件的会话内契约预检。
// 与 conductor 契约门共用同一份裁判代码（lib/spec-contract.mjs::validateSpecDoc）。
// 语义：快反馈层，不是终审——不合格 exit 2 阻断结束（stderr 喂回模型当场自修）；
// stop_hook_active=true 说明本次 stop 已是上一次阻断后的续跑，只拦一次即放行，
// 剩余问题交给 conductor 契约门（避免 Stop hook 死循环，--max-turns 是最后兜底）。
// 检查结果写入 --report 指定路径（dossier 内），沙箱内质检也留案卷证据。
// stdin：{ session_id, stop_hook_active, ... }；参数：--spec <path> --report <path>。
import fs from 'node:fs';
import path from 'node:path';
import { validateSpecDoc } from '../lib/spec-contract.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec' && argv[i + 1]) out.spec = argv[++i];
    else if (argv[i] === '--report' && argv[i + 1]) out.report = argv[++i];
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

const { spec, report } = parseArgs(process.argv.slice(2));
if (!spec) {
  console.error('check-spec: 缺 --spec 参数（hook 配置错误，放行，交给 conductor 终审）');
  process.exit(0);
}

const input = readStdinJson();
let md = null;
try { md = fs.readFileSync(spec, 'utf8'); } catch { /* 文件未写入也是契约失败 */ }
const check = validateSpecDoc(md);
const stopHookActive = input.stop_hook_active === true;
const blocked = !check.ok && !stopHookActive;

if (report) {
  try {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${JSON.stringify({
      schema_version: 1,
      source: 'stop-hook',
      spec_path: spec,
      session_id: input.session_id ?? null,
      stop_hook_active: stopHookActive,
      ok: check.ok,
      errors: check.errors,
      ac_count: check.acs.length,
      blocked,
      checked_at: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch { /* 留档失败不影响裁决 */ }
}

if (!blocked) process.exit(0);

console.error(
  `spec 契约检查未通过（${spec}）：\n- ${check.errors.join('\n- ')}\n` +
  '请用 Write/Edit 修复该文件后再结束回复。',
);
process.exit(2);
