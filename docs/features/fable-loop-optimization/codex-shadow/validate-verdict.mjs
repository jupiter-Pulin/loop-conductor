#!/usr/bin/env node
// codex-shadow：用 conductor 同一份校验代码机械验收 codex 输出，并与 opus 基准 verdict 对照。
// 用法：node validate-verdict.mjs <taskId> <round> <codexOutputFile>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, validateVerifierVerdict } from '../../../../conductor/stages/decisions.mjs';
import { extractAcceptanceCriteria } from '../../../../conductor/lib/state.mjs';

const [taskId, roundStr, outFile] = process.argv.slice(2);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const spec = fs.readFileSync(path.join(repoRoot, 'dossier', taskId, 'spec.md'), 'utf8');
const expectedAcIds = extractAcceptanceCriteria(spec).map((a) => a.ac_id);

const text = fs.readFileSync(outFile, 'utf8');
const parsed = parseStrictJson(text);
const validation = parsed == null
  ? { ok: false, errors: ['parseStrictJson 返回 null（非严格 JSON）'] }
  : validateVerifierVerdict(parsed, expectedAcIds);

// 与 opus 基准 verdict 对照（同任务同轮）
const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dossier', taskId, `verify-r${roundStr}.verdict.json`), 'utf8'));
const baseMap = new Map((baseline.criteria_results ?? []).map((c) => [c.ac_id, c.status]));
const comparison = [];
let agree = 0;
let missedFail = 0; // 危险失败：opus 判非 pass，codex 放行 pass
let falseAlarm = 0; // 误杀：opus pass，codex 判非 pass
for (const acId of expectedAcIds) {
  const opus = baseMap.get(acId) ?? null;
  const codex = parsed?.criteria_results?.find((c) => c.ac_id === acId)?.status ?? null;
  const same = opus === codex;
  if (same) agree++;
  else if (opus !== 'pass' && codex === 'pass') missedFail++;
  else if (opus === 'pass' && codex !== 'pass') falseAlarm++;
  comparison.push({ ac_id: acId, opus, codex, same });
}

process.stdout.write(`${JSON.stringify({
  task: taskId,
  round: Number(roundStr),
  protocol_valid: validation.ok === true || validation === true,
  validation_errors: validation.ok === true ? [] : (validation.errors ?? []),
  overall: { opus: baseline.overall, codex: parsed?.overall ?? null },
  ac_total: expectedAcIds.length,
  agree,
  missed_fail: missedFail,
  false_alarm: falseAlarm,
  disagreements: comparison.filter((c) => !c.same),
}, null, 2)}\n`);
