# 实现契约：Loop Conductor 状态契约强化

> 本文件是 conductor（主会话）为 maker 冻结的实现蓝图。它把 `2-tech-spec.md`
> 留下的集成歧义点逐一定死，所有 maker pass 必须严格遵守这里的**精确签名、字段名、
> schema、轮次编号与路由表**。tech-spec 是「要什么」，本文件是「按什么接口做」。
> 与 tech-spec 冲突时以 tech-spec 的 AC 为准、以本文件的接口形态为准。

## 0. 全局约定

- Node ≥ 20，ESM，零 npm 依赖。保持现有风格（中文注释、纯函数与副作用分层）。
- **先产物后状态**：先把 spec / cost / green-gate / verdict / repair-context 落盘，
  最后才写 `runtime.json` 的 `stage`（runtime 写入是「提交点」）。
- **确定性、可重入、幂等** 不能退化：crash 双标记、预算闸、锁、green gate 权威性、
  fake-claude 可测试性全部保留。
- `miss_count` 全局重命名为 **`maker_miss_count`**（已决策问题）。代码、runtime、
  status、测试一律用新名。它只统计 maker 可行动失败（green gate 失败 或 AC 验收失败），
  不因 invalid verifier、瞬态重试、解析错误而增加。

## 1. 磁盘布局

旧单文件 `state/<box>/task-*.md` → **任务目录**：

```
state/queue/<id>/
  task.json        # 不可变（创建后 byte-for-byte 不变）
  runtime.json     # 可变状态机记录
  spec.md          # 仅 bugfix：人类可编辑的初始验收标准草稿（READY 时冻结进 dossier）
  reject_notes.md  # 仅 feature 且被 reject 过：累加的打回意见（喂给 plan-agent）
dossier/<id>/
  spec.md                       # 冻结后的唯一契约
  timeline.md                   # append-only，人读；状态决策绝不解析它
  plan-r<n>.json / maker-r<n>.json / verifier-r<n>.json   # spawn 双标记 + 原始 CLI JSON
  green-gate-r<n>.json
  verify-r<n>.md                # verifier 叙事（人读，绝不进 maker repair）
  verify-r<n>.verdict.json      # per-AC 机器裁决
  verify-r<n>.invalid-a<m>.json # 第 m 次 verifier 协议/schema 失败留档
  repair-context-r<n>.json      # conductor 为 maker 生成的最小修复输入
```

- feature 的 spec **草稿**仍在仓库级 `specs/<id>.md`（approve→冻结进 dossier、reject→归档
  `specs/archive/`），与现状一致，最小改动。
- bugfix 的 spec **草稿**在 `state/queue/<id>/spec.md`，READY 冻结进 `dossier/<id>/spec.md`。

### task.json（不可变）

```json
{
  "schema_version": 1,
  "id": "task-20260620-001",
  "kind": "feature",
  "title": "median 偶数分支返回错误",
  "repo": "example-service",
  "targetRepo": "/abs/path/to/target",
  "baseBranch": "main",
  "testCommand": "node --test",
  "created_at": "2026-06-20T00:00:00.000Z"
}
```

- `new` 时从 config 快照：`targetRepo`=resolve(config.targetRepo)，`testCommand`=config.testCommand，
  `repo`=basename(targetRepo)，`baseBranch`=`config.baseBranch ?? currentBranch(targetRepo) ?? 'main'`
  （读 currentBranch 失败兜底 'main'）。`title` 来自 `--title`。
- 创建后**只读**；只有显式 migration 工具可改（本期不实现 migration）。

### runtime.json（可变）

```json
{
  "schema_version": 1,
  "stage": "NEEDS_SPEC",
  "maker_miss_count": 0,
  "verifier_invalid_count": 0,
  "spent_usd": 0,
  "approval": null,
  "maker_session_id": null,
  "current_round": 0,
  "last_failure_type": null,
  "updated_at": "2026-06-20T00:00:00.000Z"
}
```

- bugfix 初始 `stage="READY"`；feature 初始 `stage="NEEDS_SPEC"`。
- 每次写 runtime 都刷新 `updated_at`。

## 2. 轮次编号（关键，必须全handler一致）

**`round = runtime.maker_miss_count + 1`**，在 spawn maker（READY/FIXING）与 VERIFY 时都成立
（green gate pass 不增 miss，所以 VERIFY 的 round 与刚产出 diff 的 maker round 对齐）。

一次「round N」的产物全部用 `-r<N>` 命名：`maker-r<N>.json`、`green-gate-r<N>.json`、
`verify-r<N>.verdict.json`、`repair-context-r<N>.json`、`verify-r<N>.md`、`verify-r<N>.invalid-a<m>.json`。

下一次 maker 修复（FIXING）是 round N+1，读「最新」= 编号最大的 `repair-context-r<N>.json`。

`current_round` 在每次 spawn maker 时设为该 round，仅供 status/可观测，不参与决策。

典型时序（maxMakerMisses=3）：

```
READY      miss=0 round=1  maker-r1 → green-gate-r1
  gate fail → repair-context-r1(green_gate), miss→1, FIXING
FIXING     miss=1 round=2  maker-r2(resume) → green-gate-r2
  gate pass → VERIFY
VERIFY     miss=1 round=2  verifier-r2
  invalid  → verify-r2.invalid-a1, verifier_invalid_count→1, 留在 VERIFY 重试
  valid&fail → verify-r2.verdict + repair-context-r2(verifier), miss→2, FIXING
FIXING     miss=2 round=3  maker-r3(cold+全案卷) → green-gate-r3
  ...
  miss→3 ≥ maxMakerMisses → FAILED_BOX
```

## 3. decisions.mjs（纯函数，不做 IO，单测直击）

保留：`markerStatus`、`overBudget`、`approvalNext`、`needsSpecAction`、`fixingMode`、`MAX_MISS=3`。
`fixingMode(missCount, sessionId)` 不变：`missCount===1 && sessionId ? 'resume' : 'cold'`。

新增/改写：

```js
// green gate 只认 exit code
export function greenGatePassed(exitCode) { return exitCode === 0; }

// maker 可行动失败后：miss++，按阶梯决定去向
export function makerMissNext(missCount, maxMisses = MAX_MISS) {
  const m = (missCount ?? 0) + 1;
  return { stage: m >= maxMisses ? 'FAILED_BOX' : 'FIXING', missCount: m };
}

// 消费「有效」verifier 总裁决
export function verdictNext(overall, missCount, maxMisses = MAX_MISS) {
  if (overall === 'pass') return { stage: 'AWAIT_HUMAN_MERGE', missCount: missCount ?? 0 };
  return makerMissNext(missCount, maxMisses); // fail 走同一阶梯
}

// verifier 协议/schema 失败：留在 VERIFY 重试，超额则收箱
export function verifierInvalidNext(invalidCount, maxInvalid) {
  const c = (invalidCount ?? 0) + 1;
  if (c > maxInvalid) return { stage: 'FAILED_BOX', invalidCount: c, failureType: 'verifier_protocol_exhausted' };
  return { stage: 'VERIFY', invalidCount: c, failureType: null };
}

// 整段必须是严格 JSON（容忍 ```json 围栏），绝不在叙事里打捞；失败返回 null
export function parseStrictJson(text) { /* trim → 去 ```json 围栏 → JSON.parse → 失败 null */ }

// 校验 per-AC verdict。expectedAcIds 来自 conductor 对 spec 的 AC 枚举。
// 返回 { ok:true, verdict } | { ok:false, errors:[...] }
export function validateVerifierVerdict(parsed, expectedAcIds) { /* 见 §5 规则 */ }
```

`verdictNext('fail', 2, 3)` → `{stage:'FAILED_BOX', missCount:3}`；
`verifierInvalidNext(2, 2)` → 留 VERIFY（c=3>2? 否，c=3>2 为真）→ 注意：c=invalidCount+1。
maxInvalid=2 时：invalidCount 0→1 留、1→2 留、2→3 收箱（`c>maxInvalid`）。共容忍初始+2 重试=3 次尝试。

## 4. AC 枚举（conductor owns，喂给 verifier 也用于校验）

`state.extractAcceptanceCriteria(specMarkdown) → [{ ac_id, text }]`：

1. 取 `## 验收标准` 段（`extractSection`）。
2. 逐条列表项（行匹配 `^\s*-\s+`，去掉 `[ ]`/`[x]` 复选框前缀）。
3. 每条：若含 `AC-(\d+)` 则归一为 `AC-###`（3 位补零）作 ac_id；否则按位置赋 `AC-00N`（1 基）。
4. `text` = 清洗后的条目正文。
5. 若取不到任何条目 → 兜底返回 `[{ ac_id:'AC-001', text:'满足 spec.md 全部要求且 testCommand 全绿' }]`。

verifier prompt 内嵌枚举清单（`AC-001: <text>` 每行一条），校验时 `expectedAcIds` = 这些 ac_id 的集合。

## 5. Verifier verdict schema 与校验

`verify-r<n>.verdict.json`：

```json
{
  "schema_version": 1,
  "round": 1,
  "overall": "pass",
  "criteria_results": [
    { "ac_id": "AC-001", "status": "pass", "reason": "...",
      "evidence": [ { "type": "source", "file": "lib/stats.mjs", "start_line": 8, "end_line": 8, "summary": "..." } ] }
  ],
  "non_ac_findings": []
}
```

`validateVerifierVerdict(parsed, expectedAcIds)` 失败（任一不满足即 `ok:false`，记 errors）：

- `parsed` 是对象；`schema_version===1`；`overall ∈ {pass,fail}`；`criteria_results` 是数组；
  `non_ac_findings` 缺省可补 `[]`。
- 每个 criterion：`ac_id` 字符串、`status ∈ {pass,fail,unknown}`、`reason` 非空字符串、`evidence` 数组。
- **AC 覆盖**：`criteria_results` 的 ac_id 集合 == `expectedAcIds`（无缺、无重、无多余）。
- **证据规则**：`status==='pass'|'fail'` ⇒ `evidence.length>=1`；`status==='unknown'` 允许空 evidence
  但 `reason` 必须非空。每个 evidence 项需含 `type,file,summary`（字符串）、`start_line,end_line`
  （整数 ≥1 且 `end_line>=start_line`）。**不校验行号是否真实存在**（已决策：那是 verifier hook 的职责）。
- **一致性**：`overall==='pass'` ⇔ 每条 criterion 都是 `pass`。`overall==='pass'` 但有非 pass ⇒ 非法。

校验通过返回 `{ok:true, verdict: 规范化对象}`；失败 `{ok:false, errors}`，handler 据此走 invalid 分支。

## 6. Green gate 结构化记录

`shared.runGreenGate(testCommand, cwd) → { exitCode, stdout, stderr }`（shell 跑命令，只认 exit code）。
`shared.writeGreenGateResult(cfg, id, round, fields, tailBytes) → record`，写 `green-gate-r<n>.json`：

```json
{ "schema_version":1, "round":1, "command":"node --test", "cwd":"worktrees/<id>",
  "exit_code":1, "stdout_tail":"...", "stderr_tail":"...",
  "started_at":"...", "finished_at":"..." }
```

- `stdout_tail`/`stderr_tail` 取末尾 `tailBytes`（=`cfg.greenGateOutputTailBytes`，默认 12000）字节。
- **pass 与 fail 都写**（AC-004 要求 pass 也写）。
- `cwd` 写成相对仓库根的 `worktrees/<id>` 即可（可读性）。

## 7. Repair context（conductor 生成，绝不照抄 verifier 叙事）

`shared.buildRepairContext({ source, round, verdict, greenGate, tailBytes }) → object`，
`shared.writeRepairContext(cfg, id, round, ctx)` 写 `repair-context-r<n>.json`：

```json
{ "schema_version":1, "round":1, "source":"verifier", "overall":"fail",
  "failed_criteria":[ { "ac_id":"AC-002","status":"fail","reason":"...","evidence":[...] } ],
  "green_gate": null,
  "instruction":"Repair only the failed or unknown acceptance criteria. Keep passing criteria intact." }
```

- `source:'verifier'`：`failed_criteria` = criteria_results 里 `status∈{fail,unknown}` 的项（含其 reason+结构化 evidence）；`green_gate:null`；`overall:'fail'`。
- `source:'green_gate'`：`failed_criteria:[]`；`green_gate` = 来自 green-gate-r<n>.json 的紧凑摘要
  `{command, exit_code, stdout_tail, stderr_tail}`（tail 仍受 tailBytes 约束）；`instruction` 改为
  "Fix the failing tests so the test command exits 0. Keep unrelated code intact."。

**maker repair prompt（FIXING）只能含**：`agents/maker-agent.md` + 冻结 `dossier/<id>/spec.md`
+ 最新 `repair-context-r<n>.json`（直接内嵌该 JSON）+ 可选「完整日志/verdict 文件路径」（仅路径，
不嵌全文）。**绝不含 `verify-r<n>.md` 叙事**。

## 8. Worktree harness 排除

`shared.HARNESS_ARTIFACTS`：
- exclude patterns：`['/.claude_review_state.json', '/.will-workflow/', '/.agent/']`
- tracked 检测名：`['.claude_review_state.json', '.will-workflow', '.agent']`

`git.installWorktreeExcludes(wtPath, patterns)`：
- 解析真实 exclude 路径：`git -C wtPath rev-parse --git-path info/exclude`（相对 cwd→resolve 绝对）。
- 读现有内容，**逐行幂等**追加缺失 pattern（已存在则不重复），保留既有内容与尾换行。

`git.ensureWorktree(repo, wtPath, branch)`：创建/复用 worktree 后调用 `installWorktreeExcludes`，再返回 wtPath。

`git.checkTrackedHarness(wtPath, names) → string[]`：对每个 name 跑 `git -C wtPath ls-files -- <name>`
（目录名直接传，git 会列其下文件），输出非空即「已被目标仓库追踪」，收集冲突名返回。

**handler 用法**（READY/FIXING，spawn maker 前）：`ensureWorktree` →（excludes 已装）→
`checkTrackedHarness`：非空则 `failToBox(..., 'tracked_harness_artifact_conflict')`，**绝不静默删除**；
否则继续 spawn。因 exclude 在 maker 跑之前已装，`commitAll` 的 `git add -A` 不会 stage 这些 artifact，
diff（`git diff <baseBranch>...HEAD`）里也不会出现。`commitAll` 保留 `git add -A`。

## 9. state.mjs 任务目录 helper（精确签名）

TaskState 形态：`{ box, dir, id, task /*task.json*/, runtime /*runtime.json*/ }`。

```js
export function taskDir(boxDir, id);                 // path.join
export function readTaskState(dir, box);             // 读 task.json+runtime.json → TaskState；任一缺失/坏 JSON 抛错
export function saveRuntime(ts);                      // 刷新 updated_at，写 ts.dir/runtime.json
export function writeNewTask(boxDir, task, runtime, { specDraft } = {}); // mkdir <boxDir>/<id>，写两 JSON + 可选 spec.md
export function listTaskStates(boxDir, box);          // 子目录名匹配 /^task-\d{8}-\d{3}$/，排序，map→readTaskState（坏的跳过并可被 status 标注）
export function listTaskDirNames(boxDir);             // 仅返回合法任务目录名（排序），供 nextId / 遍历
export function findLegacyTaskFiles(boxDir);          // 返回旧布局 *.md 路径数组（用于告警跳过）
export function transitionState(ts, cfg, nextStage, note, extra = {}); // Object.assign(ts.runtime, extra, {stage}); saveRuntime; FAILED_BOX 则把目录 rename 到 failedDir 并更新 ts.dir/ts.box; appendTimeline
export function extractAcceptanceCriteria(specMd);   // §4
```

保留并继续导出：`extractSection`、`appendToSection`、`dossierPath`、`readJsonIf`、`writeJson`、
`writeFileEnsured`、`appendTimeline`。**移除**任务 `.md` 专用：`parseTaskText`/`serializeTask`/
`readTask`/`saveTask`/`listTaskFiles`（其单测一并改写）。`parseValue`/`serializeValue` 可删（仅旧
frontmatter 用）。

`transitionState` 是「先产物后状态」的最后一步。`failToBox` 经它设置 `last_failure_type`。

## 10. shared.mjs（副作用 helper）签名增量

- `worktreePath(cfg,id)`、`READONLY_TOOLS=['Read','Grep','Glob']`、
  `VERIFIER_TOOLS=['Read','Grep','Glob','Bash(git diff:*)','Bash(git log:*)']`（保留原集合不变，
  happy-path 测试断言此串）。
- `startSpawnRecord/finishSpawnRecord/nextRoleRound`：不变。
- `addCost(ts,costUsd)`、`budgetExceeded(ts,cfg)`：改用 `ts.runtime.spent_usd`。
- `failToBox(ts,cfg,reason,failureType=null)`：`transitionState(ts,cfg,'FAILED_BOX',reason,{last_failure_type:failureType})`，console.error，返回 `{changed:true}`。
- `ensureDossierSpec(ts,cfg)`：bugfix 从 `ts.dir/spec.md` 取（无则回退正文/兜底），feature 从已冻结
  dossier 或 `specs/<id>.md`；落盘 `dossier/<id>/spec.md`，幂等。
- prompt builders：`buildMakerColdPrompt(ts,cfg,round,{fullDossier})`、
  `buildMakerRepairPrompt(ts,cfg,round)`（读最新 repair-context，**不含叙事**）、
  `buildVerifierPrompt(ts,cfg,round,acList)`（嵌 spec + diff + AC 枚举 + 严格 schema 指令）。
- `runMakerRound(ts,cfg,round,{mode,prompt,coldPrompt,wt})`：写 started、spawn（`runClaudeWithRetry`）、
  resume 失败降级冷启动、写 done+raw、`addCost`+`saveRuntime`、`commitAll`。**不**在此跑 green gate / 不在此 ensureWorktree（handler 负责）。
- verifier 工具集硬限制 `--tools` 与 `--allowedTools` 同集合（不放行测试/写）。

## 11. handler 路由表（state/stage）

- **NEEDS_SPEC**：feature 专用。spec 草稿不存在或被 reject → spawn plan-agent（只读、cwd=targetRepo、
  读 `reject_notes.md`）写 `specs/<id>.md`，清 `approval=null` → `AWAIT_SPEC_APPROVAL`；草稿已存在且未打回 → 跳过 spawn 直接转。预算超 → FAILED_BOX。
- **AWAIT_SPEC_APPROVAL**：纯读 `runtime.approval`。approved → 冻结 `specs/<id>.md`→`dossier/<id>/spec.md` → READY；rejected → 归档旧草稿到 `specs/archive/` → NEEDS_SPEC；null → `{changed:false}`。
- **READY**：round=1。crash 检（maker-r1 started 无 done）→ FAILED_BOX(crashed)。预算闸。
  `ensureDossierSpec`。`ensureWorktree`→`checkTrackedHarness`（冲突→FAILED_BOX tracked_harness_artifact_conflict）。
  `runtime.verifier_invalid_count=0`（新 maker 轮）。spawn maker（cold）。`runGreenGate`→`writeGreenGateResult`。
  pass→`transitionState(VERIFY, {current_round:1})`；fail→`writeRepairContext(green_gate)` + `makerMissNext`：
  FIXING(`{maker_miss_count:m, current_round:?}`) 或 FAILED_BOX。
- **VERIFY**：round=miss+1。若 `verify-r<round>.verdict.json` 已存在 → 直接消费（幂等）。
  否则预算闸 → 枚举 AC → `buildVerifierPrompt` → spawn verifier（只读）→ `parseStrictJson`+`validateVerifierVerdict`：
  - **invalid** → 写 `verify-r<round>.invalid-a<m>.json`（m=新 verifier_invalid_count），
    `verifierInvalidNext`：留 VERIFY（`{verifier_invalid_count:c}`，返回 `{changed:true}` 让 drain 再次进 VERIFY 重 spawn）
    或 FAILED_BOX(`verifier_protocol_exhausted`)。**不**写 verdict、**不**写 repair-context、**不**增 maker_miss_count。
  - **valid** → 写 `verify-r<round>.verdict.json`、`verify-r<round>.md`（叙事，res.result）、
    `verifier_invalid_count=0`；`verdictNext(overall,miss)`：pass→AWAIT_HUMAN_MERGE；
    fail→`writeRepairContext(verifier)` + `makerMissNext`→FIXING/FAILED_BOX。
  - 消费已存在 verdict 的幂等分支同样按 `verdictNext` 路由。
  - green gate 失败的轮次不会进 VERIFY（READY/FIXING 直接 FIXING），天然满足 AC-006。
- **FIXING**：round=miss+1。crash 检（maker-r<round>）。预算闸。`fixingMode`。
  `buildMakerRepairPrompt`（resume）/`buildMakerColdPrompt(fullDossier)`（cold）。
  `ensureWorktree`→`checkTrackedHarness`。`verifier_invalid_count=0`。spawn maker。green gate→同 READY 的 pass/fail 路由。
- **AWAIT_HUMAN_MERGE / FAILED_BOX**：`{changed:false}`。

## 12. conductor.mjs CLI

- `loadCfg` 默认值新增：`maxMakerMisses:3, maxVerifierInvalidRetries:2, greenGateOutputTailBytes:12000, baseBranch:null`；
  保留 `budgetUsd/maxTurns/testCommand/targetRepo/models/spawnRetries/spawnBackoffMs/maxDrainSteps`。
- drain：`listTaskStates(queueDir,'queue')`，按 `ts.runtime.stage` 分发 handler。锁、maxDrainSteps、
  pending 日志逻辑不变。每轮开始检 `findLegacyTaskFiles(queueDir)`，非空则 `console.error` 清晰告警并跳过（不当新任务）。
- `nextId`：扫三箱的 `listTaskDirNames`。
- `cmdNew`：建 `state/queue/<id>/`，写 task.json（§1，读 currentBranch 快照 baseBranch）+ runtime.json；
  bugfix 额外写 `spec.md` 草稿（`# <title>` + `## 验收标准` 模板 TODO）。打印 id 与提示。
- `cmdStatus`：列 queue/failed/done 的 `listTaskStates`，列 `id/kind/stage/maker_miss/inval/spent/box`
  （新增 INVAL 列 = verifier_invalid_count）。坏任务目录标注。空表 `(no tasks)`。
- `cmdApprove/cmdReject`：改 `runtime.approval`；reject 的 notes 追加到 `state/<box>/<id>/reject_notes.md`，
  **不**入 runtime。stage 非 AWAIT_SPEC_APPROVAL 时仍写并告警（同旧）。
- `cmdMerge`：要求 queue 且 `runtime.stage==='AWAIT_HUMAN_MERGE'`；`mergeBranch`→ 归档：`runtime.stage='DONE'`、
  saveRuntime、`fs.renameSync` 任务目录到 `doneDir/<id>`、清 worktree+删分支、timeline。
- `cmdRetry`：failed→queue：`archiveRoundArtifacts`（移 dossier 轮次产物入 `attempts/<ts>/`，保留），
  reset runtime：`stage='READY', maker_miss_count:0, verifier_invalid_count:0, maker_session_id:null, last_failure_type:null`，
  renameSync 目录回 queue。预算仍超时给告警。queue 中崩溃残留清理路径保留。
- 旧 `.md` 任务（`new`/`run`/`status`）：检测到给清晰提示，不静默当新任务。

## 13. agents/*.md

- `verifier-agent.md`：改写为「输出必须且仅为匹配 per-AC schema 的严格 JSON（§5），按 prompt 内的 AC 枚举逐条给 status+reason+结构化 evidence；overall 仅当每条 pass 才 pass；不跑测试不改文件」。
- `maker-agent.md`：补「FIXING 轮只依据 repair-context 的 failed_criteria/green_gate 做最小修复，保持已通过项不动；不依赖任何人读叙事」。
- `plan-agent.md`：基本不变（仍输出含「## 验收标准」清单的 spec 草稿）。

## 14. 测试（tests/）改写与新增

helper `tests/helpers/env.mjs`：
- `writeTask(id, {kind,stage,miss,invalid,spent,sessionId,approval,baseBranch,testCommand,bodyAc})` →
  建任务目录（task.json+runtime.json，字段用 `maker_miss_count`/`verifier_invalid_count`），
  bugfix 写 `spec.md` 草稿（默认含 median 两条验收标准 → AC-001/AC-002）。
- `findTask(id)` → 读任务目录 → `{box, dir, task, runtime}`。
- 新增 `readRuntime(id)`/`readTaskJson(id)`。`makeEnv` 的 config 可加 `baseBranch` 缺省。
- `target-fixture.mjs`：新增可选 `initTargetRepoWithTrackedHarness(dir)`（在 fixture 里预先 `git add` 一个
  `.claude_review_state.json` 并 commit）供 tracked-conflict 测试。

单测：
- `state.test.mjs`：task.json/runtime.json round-trip、`listTaskStates` 排序、坏/缺 JSON、
  `findLegacyTaskFiles`、`extractAcceptanceCriteria`（AC-### 与位置赋号、复选框、兜底）、保留 extract/appendToSection。
- `decisions.test.mjs`：`greenGatePassed/makerMissNext/verdictNext(overall)/verifierInvalidNext(边界)/fixingMode/parseStrictJson/validateVerifierVerdict`（接受合法、拒绝 prose-wrapped/缺AC/多AC/非法status/pass无evidence/overall不一致/非法overall）。
- `claude.test.mjs`/`lock.test.mjs`：基本不变。

集成（fake-claude，零 token；verifier 步骤一律返回新 schema）：
- happy-path：bugfix new→run→AWAIT_HUMAN_MERGE→merge 归档；断言 task.json 不变、runtime 字段、
  green-gate-r1.json 写入、verify-r1.verdict.json(overall pass, 含 AC-001/AC-002)、spawn 形态
  （maker acceptEdits 无 --tools；verifier --tools/--allowedTools=READONLY 串）。
- feature-flow：plan→闸门→approve→冻结→…→AWAIT_HUMAN_MERGE；reject+notes 回炉（notes 进 reject_notes.md，旧草稿归档）。
- retry-ladder：valid fail×3 走 1/2/3 → FAILED_BOX(last_failure_type 由 verdict fail 链)；resume/cold 阶梯；retry 复活。
- **green-gate-fail**（新）：maker 首轮写坏代码→green gate 非0→写 green-gate-r1+repair-context-r1(green_gate)，
  maker_miss_count→1，FIXING；二轮修好→VERIFY→pass。断言不进 FAILED_BOX、未 spawn verifier 于失败轮、
  repair-context 含 bounded tail。
- **verifier-invalid**（新）：verifier 返回「叙事+JSON」→写 invalid-a1、verifier_invalid_count→1、
  留 VERIFY、不 spawn maker、maker_miss_count 不变；下一次返回合法→pass。
- **verifier-invalid-exhausted**（新）：连续 invalid 超 maxVerifierInvalidRetries → FAILED_BOX
  (last_failure_type='verifier_protocol_exhausted')。
- **verifier-fail-minimal-repair**（新）：valid fail（AC-002 fail）→ repair-context 仅含失败 AC；
  下一 maker repair prompt 含该 JSON 且**不含** verify-r<n>.md 叙事文本。
- **worktree-artifact**（新）：maker 额外 writeFile `.claude_review_state.json` → commit/diff 不含它
  （`git -C worktrees/<id> diff <base>...HEAD --name-only` 无该文件）。
- **tracked-harness-conflict**（新）：用 `initTargetRepoWithTrackedHarness` → run → FAILED_BOX
  (last_failure_type='tracked_harness_artifact_conflict')，未删除该文件。
- budget / crash-reentry / drain-cap / lock / transient-retry：迁到新布局与字段名，行为断言不变。

`npm test` == `node --test tests/`，必须全绿且零真 claude。

## 15. 边界（照 tech-spec §边界情况）

旧 `.md` 任务→清晰失败不静默；task.json 被改坏/缺不可变字段→FAILED_BOX 或可见错误跳过；runtime 缺→
视目录损坏并记路径；verifier 漏 AC / pass 无 evidence→当 invalid（非 maker 失败）；worktree 已存在→复用但仍
确保 exclude；已知 harness 已被 target 追踪→不自动删，以 tracked_harness_artifact_conflict 失败；
Claude 瞬态→沿用 `runClaudeWithRetry`，瞬态不算 maker miss。
