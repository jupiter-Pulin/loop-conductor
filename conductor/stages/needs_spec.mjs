// NEEDS_SPEC（契约 §11，feature 专用）：spawn plan-agent（只读、cwd=targetRepo、读 reject_notes.md）
// → 落盘 specs/<id>.md → 清 approval=null → AWAIT_SPEC_APPROVAL。
// 幂等：specs/<id>.md 已存在且 approval==null → 跳过 spawn，仅推进状态。预算超 → FAILED_BOX。
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../lib/claude.mjs';
import * as state from '../lib/state.mjs';
import { needsSpecAction } from './decisions.mjs';
import {
  readAgentPrompt, addCost, budgetExceeded, failToBox,
  READONLY_TOOLS, nextRoleRound, startSpawnRecord, finishSpawnRecord,
} from './shared.mjs';

export default function needsSpecHandler(ts, cfg) {
  const id = ts.id;
  const specPath = path.join(cfg.specsDir, `${id}.md`);
  const action = needsSpecAction(fs.existsSync(specPath), ts.runtime.approval ?? null);

  if (action === 'spawn') {
    if (budgetExceeded(ts, cfg)) {
      return failToBox(ts, cfg, `budget exceeded: $${ts.runtime.spent_usd} >= $${cfg.budgetUsd}`, 'budget_exceeded');
    }
    // reject_notes 来自任务目录的 reject_notes.md（cmdReject 累加写入，不入 runtime）。
    let rejectNotes = '';
    try { rejectNotes = fs.readFileSync(path.join(ts.dir, 'reject_notes.md'), 'utf8'); } catch { /* 首稿无 */ }

    const prompt = [
      readAgentPrompt(cfg, 'plan-agent.md'),
      `# 任务 ${id}\n\n标题：${ts.task.title ?? '(untitled)'}\nkind：${ts.task.kind}`,
      rejectNotes.trim() ? `# 上一稿被打回，必须回应以下 reject_notes\n\n${rejectNotes}` : '',
      '# 指令\n在当前目录（target 仓库）只读调研后，直接以最终回复输出 spec 草稿的 Markdown 全文，' +
      '必须包含「## 验收标准」清单。不要输出 JSON 或其他包装。',
    ].filter(Boolean).join('\n\n');

    // plan-r<n>.json 案卷：spawn 记录统一留档（reject 回炉再 spawn 即 r2）。
    const round = nextRoleRound(cfg, id, 'plan');
    const rec = startSpawnRecord(cfg, id, 'plan', round);
    const res = runClaude({
      cwd: cfg.targetRepo,
      prompt,
      maxTurns: cfg.maxTurns,
      model: cfg.models?.plan ?? null,
      tools: READONLY_TOOLS,        // 工具集硬限制：只读
      allowedTools: READONLY_TOOLS, // 免审批放行同一集合
    });
    finishSpawnRecord(rec, res);
    addCost(ts, res.costUsd);
    if (!res.ok || !res.result?.trim()) {
      state.saveRuntime(ts);
      state.appendTimeline(cfg, id, `plan spawn failed: ${res.error ?? 'empty result'}`);
      console.error(`[${id}] plan-agent 失败（${res.error ?? 'empty result'}），任务停留在 NEEDS_SPEC，下次 run 重试`);
      return { changed: false };
    }
    // 先产物后状态：spec 落盘，再清 approval，最后才转移。
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, res.result);
    ts.runtime.approval = null;
    state.saveRuntime(ts);
    state.appendTimeline(cfg, id, `plan-agent 产出 spec 草稿 (cost=$${res.costUsd}) → specs/${id}.md`);
  }

  state.transitionState(ts, cfg, 'AWAIT_SPEC_APPROVAL', action === 'skip-spawn' ? 'spec 草稿已存在' : 'spec 草稿就绪');
  console.log(`[${id}] spec 草稿待审批：specs/${id}.md → conductor approve|reject ${id}`);
  return { changed: true };
}
