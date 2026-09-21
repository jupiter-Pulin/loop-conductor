#!/usr/bin/env node
// hooks/check-digest.mjs — 摘要 agent 的 Stop hook：摘要文件的会话内机械校验。
// 与内核终审共用同一份裁判代码（lib/digest-contract.mjs::validateDigestText），两侧永远一个口径。
// 语义：快反馈层，不是终审——不合格 exit 2 阻断结束，stderr 把错误清单喂回模型当场自修。
// 引用行号抄错是最常见的毛病，值得在会话里多给几次机会：最多阻断 --max-blocks 次（默认 3），
// 次数记在 --report 里；用完即放行，剩余问题由内核记成一次失败尝试（有界重派 / 显式降级）。
// stdin：{ session_id, stop_hook_active, ... }；
// 参数：--digest <path> --source <spec 快照路径> --sha <spec sha256> --report <path> [--max-blocks N]。
import fs from 'node:fs';
import path from 'node:path';
import { validateDigestText } from '../lib/digest-contract.mjs';
import { enumerateAcceptanceCriteria } from '../lib/state.mjs';
import { sha256Of } from '../lib/spec-version.mjs';

function parseArgs(argv) {
  const out = { maxBlocks: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--digest' && argv[i + 1]) out.digest = argv[++i];
    else if (argv[i] === '--source' && argv[i + 1]) out.source = argv[++i];
    else if (argv[i] === '--sha' && argv[i + 1]) out.sha = argv[++i];
    else if (argv[i] === '--report' && argv[i + 1]) out.report = argv[++i];
    else if (argv[i] === '--max-blocks' && argv[i + 1]) out.maxBlocks = Number(argv[++i]) || 0;
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

const args = parseArgs(process.argv.slice(2));
if (!args.digest || !args.source || !args.sha) {
  console.error('check-digest: 缺 --digest / --source / --sha 参数（hook 配置错误，放行，交给内核终审）');
  process.exit(0);
}

const input = readStdinJson();
let specText = null;
try { specText = fs.readFileSync(args.source, 'utf8'); } catch { /* 快照读不到：放行给内核判 */ }
if (specText == null || sha256Of(specText) !== args.sha) {
  console.error('check-digest: spec 快照缺失或与 --sha 不符（放行，交给内核终审）');
  process.exit(0);
}

let raw = null;
try { raw = fs.readFileSync(args.digest, 'utf8'); } catch { /* 没写也是一种不合格 */ }
const acIds = enumerateAcceptanceCriteria(specText).map((a) => a.ac_id);
const check = validateDigestText(raw, { specText, specSha: args.sha, acIds });

let prevBlocks = 0;
try { prevBlocks = Number(JSON.parse(fs.readFileSync(args.report, 'utf8')).blocks) || 0; } catch { /* 首次 */ }
const blocked = !check.ok && prevBlocks < args.maxBlocks;

if (args.report) {
  try {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify({
      schema_version: 1,
      source: 'stop-hook',
      digest_path: args.digest,
      spec_sha256: args.sha,
      session_id: input.session_id ?? null,
      stop_hook_active: input.stop_hook_active === true,
      ok: check.ok,
      errors: check.errors,
      blocks: prevBlocks + (blocked ? 1 : 0),
      blocked,
      checked_at: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch { /* 留档失败不影响裁决 */ }
}

if (!blocked) process.exit(0);

console.error(
  `摘要机械校验未通过（${args.digest}）：\n- ${check.errors.join('\n- ')}\n`
  + '请逐条修正后用 Write 重写整份 JSON 再结束。quote 必须逐字复制原文、行号用原文每行开头的编号。',
);
process.exit(2);
