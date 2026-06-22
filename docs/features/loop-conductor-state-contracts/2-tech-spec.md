# 技术规格：Loop Conductor 状态契约强化

## 概要

本次变更要强化 loop conductor，让 agent 工作流由持久、可审计的状态契约驱动，而不是依赖混杂叙事内容的文件。它会把不可变任务元数据与可变运行时状态拆开；把 verifier 输出从粗粒度的 `verdict/reasons` 升级为按验收标准逐条记录证据；把面向人类的审查叙事与面向 maker 的修复上下文分离；在 verifier 输出格式无效时重试 verifier，而不是错误地责怪 maker；并防止 agent harness 临时文件污染目标 worktree 的 diff。

## 背景

当前实现是一个围绕 headless Claude agent 的确定性 Node conductor。`conductor/conductor.mjs` 会 drain `state/queue/*.md`，按 stage 分发到 `conductor/stages/` 里的 handler，把 agent spawn 记录存到 `dossier/<id>/`，并用 `worktrees/<id>/` 隔离目标仓库改动。

当前行为已经具备一些很好的 loop 边界：

- `READY` 先运行 maker，然后 conductor 在进入 `VERIFY` 前运行配置好的 green gate。
- `VERIFY` 使用只读 verifier，对照 `dossier/<id>/spec.md` 和 worktree diff 做验收。
- `FIXING` 会把 verifier 失败结果通过重试阶梯路由回 maker。
- `dossier/<id>/timeline.md` 记录 conductor 事件。

当前薄弱点：

- 任务身份、任务配置和运行时字段都混在一个 Markdown frontmatter 文件里。
- Verifier 协议失败会被转换为 `{"verdict":"fail"}`，即使代码可能正确，也会消耗 maker 修复次数。
- Verifier 输出只有 `verdict` 和 `reasons`，无法按验收标准逐条审计。
- Maker 修复 prompt 可能包含面向人类的 verifier 叙事，污染实现上下文。
- `git add -A` 可能提交本地 agent harness 文件，例如 `.claude_review_state.json`。

相关文件：

| 区域 | 当前文件 |
| --- | --- |
| CLI 与状态 drain | `conductor/conductor.mjs` |
| 任务解析与 dossier 工具 | `conductor/lib/state.mjs` |
| Worktree 与 commit 工具 | `conductor/lib/git.mjs` |
| Stage handler | `conductor/stages/{needs_spec,await_spec_approval,ready,verify,fixing}.mjs` |
| Prompt 构造与 green gate | `conductor/stages/shared.mjs` |
| 状态转移逻辑 | `conductor/stages/decisions.mjs` |
| Agent 角色说明 | `agents/{plan-agent,maker-agent,verifier-agent}.md` |
| 现有测试 | `tests/unit/*.test.mjs`, `tests/integration/*.test.mjs` |

## 目标

- MUST 将任务身份/配置与可变运行时状态拆成独立 JSON 文件。
- MUST 保持已批准的 `spec.md` 作为“要构建什么”的唯一契约。
- MUST 保持 `timeline.md` 作为 append-only 的“发生过什么”的历史记录。
- MUST 让 verifier 输出可以按每条验收标准审计，并为 pass/fail 判断提供文件与行号证据。
- MUST 在 verifier 协议/schema 失败时重试 verifier，且不增加 maker 的 `maker_miss_count`。
- MUST 在修复失败 AC 或 green gate 失败时，只给 maker 最小修复 JSON 加已批准 spec。
- MUST 防止 conductor 或 agent harness 产物出现在目标 worktree diff 中。
- SHOULD 保留当前 conductor 的性质：确定性状态机、可幂等重入、预算闸、green gate 权威性、fake-claude 可测试性。

## 非目标

- 不把 conductor 重设计成 agent。
- 不新增 dashboard、GitHub 集成、webhook 系统或 PR 自动化。
- 不要求目标仓库提交新的 `.gitignore` 规则。
- 默认不让 verifier 跑测试；行为验证仍由 conductor green gate 负责。
- 不让 request/progress log 成为需求来源；只有已批准的 `spec.md` 定义任务契约。

## 契约

### 状态布局

把 `state/<box>/task-*.md` 这种单文件任务，替换为任务目录：

```text
state/
  queue/
    task-20260620-001/
      task.json
      runtime.json
  failed/
    task-20260620-002/
      task.json
      runtime.json
  done/
    task-20260620-003/
      task.json
      runtime.json
dossier/
  task-20260620-001/
    spec.md
    timeline.md
    maker-r1.json
    green-gate-r1.json
    verify-r1.md
    verify-r1.verdict.json
    repair-context-r1.json
```

`task.json` 创建后不可变，除非通过显式 migration 工具修改。它回答“这个任务在哪里做、怎么运行？”

```json
{
  "schema_version": 1,
  "id": "task-20260620-001",
  "kind": "feature",
  "repo": "example-service",
  "targetRepo": "/Users/jupiter/code/example-org/example-service",
  "baseBranch": "main",
  "testCommand": "yarn test",
  "created_at": "2026-06-20T00:00:00.000Z"
}
```

`runtime.json` 是可变的状态机记录。它回答“这个 loop 现在做到哪一步？”

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

`spec.md` 仍然是冻结后的、已批准的“要做什么”说明。对于 bugfix 任务，初始验收标准仍可来自人类创建的任务正文，但必须在 maker 运行前冻结到 `dossier/<id>/spec.md`。

`timeline.md` 仍然是 append-only 且面向人类阅读的事件记录。状态决策不得解析 `timeline.md`。

### Stage 语义

| Stage | 含义 | 允许的下一状态 |
| --- | --- | --- |
| `NEEDS_SPEC` | Feature 任务需要生成 spec 草稿。 | `AWAIT_SPEC_APPROVAL`, `FAILED_BOX` |
| `AWAIT_SPEC_APPROVAL` | Spec 草稿的人类审批闸门。 | `READY`, `NEEDS_SPEC` |
| `READY` | Maker 可以基于已批准 spec 开始工作。 | `VERIFY`, `FIXING`, `FAILED_BOX` |
| `VERIFY` | Verifier 对照 spec 检查 diff。 | `AWAIT_HUMAN_MERGE`, `FIXING`, `VERIFY`, `FAILED_BOX` |
| `FIXING` | Maker 基于最小 repair context 修复。 | `VERIFY`, `FIXING`, `FAILED_BOX` |
| `AWAIT_HUMAN_MERGE` | 最终人类 merge 闸门。 | `DONE` |
| `FAILED_BOX` | 需要人类介入。 | 通过显式 retry 回到 `READY` |

`maker_miss_count` 只统计 maker 可行动的失败：green gate 失败，或 AC 验收失败。它不得因为 invalid verifier JSON、已由内部重试处理的 Claude 瞬态失败、或 conductor 解析错误而增加。

`verifier_invalid_count` 统计当前轮次 verifier 协议/schema 失败次数。当消费到有效 verifier verdict，或开始新的 maker 轮次时，它重置为 `0`。

### Green Gate

Green gate 在 maker 之后、verifier 之前运行。

```text
maker 修改代码
-> conductor 提交 maker 产出
-> conductor 在 worktree 中运行 task.testCommand
-> pass: stage VERIFY
-> fail: 写入 green-gate-r<n>.json 和 repair-context-r<n>.json，然后 stage FIXING
```

Green gate 失败不得直接进入 `FAILED_BOX`，除非 maker 可行动的重试预算已经耗尽。

`green-gate-r<n>.json`：

```json
{
  "schema_version": 1,
  "round": 1,
  "command": "yarn test",
  "cwd": "worktrees/task-20260620-001",
  "exit_code": 1,
  "stdout_tail": "...",
  "stderr_tail": "...",
  "started_at": "2026-06-20T00:00:00.000Z",
  "finished_at": "2026-06-20T00:00:05.000Z"
}
```

为了避免污染 maker 上下文，repair context 里只应保存有边界的 stdout/stderr 尾部内容。

### Verifier Verdict Schema

Verifier 必须只返回严格 JSON。Conductor 解析和校验完整输出，不得从带叙事的文本里打捞 JSON。

`verify-r<n>.verdict.json`：

```json
{
  "schema_version": 1,
  "round": 1,
  "overall": "pass",
  "criteria_results": [
    {
      "ac_id": "AC-001",
      "status": "pass",
      "reason": "The implementation averages the two middle values for even-length inputs.",
      "evidence": [
        {
          "type": "source",
          "file": "lib/stats.mjs",
          "start_line": 8,
          "end_line": 8,
          "summary": "Even branch returns (s[mid - 1] + s[mid]) / 2."
        },
        {
          "type": "test",
          "file": "test/stats.test.mjs",
          "start_line": 12,
          "end_line": 14,
          "summary": "Test asserts median([1,2,3,4]) is 2.5."
        }
      ]
    }
  ],
  "non_ac_findings": []
}
```

允许的 `overall`：`pass`, `fail`。

允许的 `status`：`pass`, `fail`, `unknown`。

规则：

- 只有当每条验收标准都是 `pass` 时，`overall` 才能是 `pass`。
- `spec.md` 中的每一条 AC 必须在 `criteria_results` 中有且只有一个条目。
- `pass` 和 `fail` 条目必须至少包含一个 evidence，除非失败原因是“缺少实现/缺少证据”；这种情况应使用 `status: "unknown"` 并给出清晰 reason。
- Evidence 文件路径相对于目标 worktree 或 `dossier/<id>/spec.md`。
- Evidence 行号从 1 开始，并且必须指向 verification 当时存在的行。
- `reason` 是 verifier 的自由判断，但 `evidence` 必须结构化。

面向人类的 verifier 叙事仍然允许存在，但只能写入 `verify-r<n>.md`。它不得作为 maker repair 输入。

### Invalid Verifier Output

Verifier 协议/schema 失败不是 maker 失败。

当 verifier 输出不是严格有效 JSON，或 schema 校验失败时：

1. 写入 `verify-r<n>.invalid-a<m>.json`，记录解析/校验错误以及原始输出引用。
2. 增加 `runtime.verifier_invalid_count`。
3. 保持在 `VERIFY`，对相同轮次、相同 diff 重试 verifier。
4. 不增加 `runtime.maker_miss_count`。
5. 不写入 `repair-context-r<n>.json`。
6. 如果 `verifier_invalid_count` 达到配置上限，则进入 `FAILED_BOX`，并设置 `last_failure_type: "verifier_protocol_exhausted"`。

建议默认值：`maxVerifierInvalidRetries = 2`。

### Repair Context Schema

Maker repair 输入必须由 conductor 基于结构化证据生成，而不是复制 verifier 叙事。

`repair-context-r<n>.json`：

```json
{
  "schema_version": 1,
  "round": 1,
  "source": "verifier",
  "overall": "fail",
  "failed_criteria": [
    {
      "ac_id": "AC-002",
      "status": "fail",
      "reason": "Reset-window behavior is not implemented.",
      "evidence": [
        {
          "type": "source",
          "file": "lib/rateLimit.ts",
          "start_line": 42,
          "end_line": 58,
          "summary": "Counter increments but no reset window is checked."
        }
      ]
    }
  ],
  "green_gate": null,
  "instruction": "Repair only the failed or unknown acceptance criteria. Keep passing criteria intact."
}
```

对于 green gate 失败，`source` 为 `green_gate`，`failed_criteria` 可以为空，`green_gate` 包含来自 `green-gate-r<n>.json` 的紧凑摘要。

Maker repair prompt 只能包含：

- `agents/maker-agent.md`
- 冻结后的 `dossier/<id>/spec.md`
- 最新的 `repair-context-r<n>.json`
- 可选的完整 green gate log 或 verdict 文件路径，供人类检查；不能包含它们的完整叙事内容

Maker repair prompt 不得包含 `verify-r<n>.md` 叙事文本。

### Worktree Harness 排除

`ensureWorktree` 必须更新任务 worktree 的本地 `.git/info/exclude`，不得修改目标仓库 `.gitignore`。

必须加入的 ignore pattern：

```gitignore
/.claude_review_state.json
/.will-workflow/
/.agent/
```

在提交 maker 产出前，conductor 必须确保已知 harness artifact 既不会被 staged，也不会出现在 `git diff <baseBranch>...HEAD` 中。

只有在本地 exclude 规则安装后，`commitAll` 才可以继续使用 `git add -A`。如果某个已知 harness artifact 已经被目标仓库追踪，conductor 不得静默删除它；应以 `last_failure_type: "tracked_harness_artifact_conflict"` 使该轮失败，并将任务送入 `FAILED_BOX`。

### CLI / 入口

| 入口 | 变更 | 说明 |
| --- | --- | --- |
| `conductor new` | 创建 `state/queue/<id>/task.json` 和 `runtime.json` | 现有 flag 应继续可用。 |
| `conductor run` | Drain 任务目录，而不是任务 Markdown 文件 | 必须保留锁机制和确定性排序。 |
| `conductor approve/reject` | 更新 `runtime.json.approval` | Reject notes 可留在 spec 草稿流程或小型 notes 文件中，但不放入 runtime。 |
| `conductor status` | 读取 `task.json` 和 `runtime.json` | 展示 box、stage、miss count、invalid verifier count、spent。 |
| `conductor merge` | 要求 `runtime.stage === "AWAIT_HUMAN_MERGE"` | 将任务目录移动到 `state/done/<id>/`。 |
| `conductor retry` | 将 failed 任务目录移回 queue 并重置 runtime 字段 | 保留 dossier attempts。 |

### 配置

在 `conductor.config.json` 加载逻辑中增加默认值：

```json
{
  "maxMakerMisses": 3,
  "maxVerifierInvalidRetries": 2,
  "greenGateOutputTailBytes": 12000
}
```

现有 `budgetUsd`、`maxTurns`、`testCommand`、`targetRepo`、`models`、`spawnRetries` 和 `spawnBackoffMs` 行为必须保持兼容。

## 验收标准

- [ ] AC-001：当运行 `conductor new --kind feature --title "x"` 时，任务被创建为 `state/queue/<id>/task.json` 加 `runtime.json`；`id`、`kind`、`targetRepo`、`baseBranch`、`testCommand` 等不可变字段位于 `task.json`，而 `stage`、`approval`、`maker_miss_count`、`spent_usd`、`maker_session_id` 位于 `runtime.json`。
- [ ] AC-002：当任务推进 stage 时，只有 `runtime.json` 中的运行时字段变化；`task.json` 在创建后保持 byte-for-byte 不变。
- [ ] AC-003：当 feature spec 被批准后，批准稿被冻结到 `dossier/<id>/spec.md`，并且所有 maker/verifier prompt 都使用这个冻结文件作为任务契约。
- [ ] AC-004：当 maker 完成且 green gate 退出码为 `0` 时，conductor 写入 `green-gate-r<n>.json`，在 `timeline.md` 记录 pass，并推进到 `VERIFY`。
- [ ] AC-005：当 maker 完成且 green gate 退出码非 0 时，conductor 写入 `green-gate-r<n>.json` 和 `repair-context-r<n>.json`，增加 maker 可行动的 `maker_miss_count`，并路由到 `FIXING`，除非 `maxMakerMisses` 已耗尽。
- [ ] AC-006：Green gate 失败的轮次不得 spawn verifier。
- [ ] AC-007：Verifier prompt 要求返回匹配 per-AC verdict schema 的严格 JSON，并包含已批准 spec 和 worktree diff，但不包含 maker self-report 或上一轮 verifier 叙事。
- [ ] AC-008：当 verifier 返回有效 schema，且每条 AC 都是 `pass` 时，conductor 写入 `verify-r<n>.verdict.json`，重置 `verifier_invalid_count`，并推进到 `AWAIT_HUMAN_MERGE`。
- [ ] AC-009：当 verifier 返回有效 schema，且任意 AC 是 `fail` 或 `unknown` 时，conductor 写入 `verify-r<n>.verdict.json` 和 `repair-context-r<n>.json`，增加 `maker_miss_count`，并路由到 `FIXING`，除非 `maxMakerMisses` 已耗尽。
- [ ] AC-010：当 verifier 输出不是严格 JSON 或 schema 校验失败时，conductor 写入 `verify-r<n>.invalid-a<m>.json`，增加 `verifier_invalid_count`，保持在 `VERIFY`，且不 spawn maker、不增加 `maker_miss_count`。
- [ ] AC-011：当 verifier invalid output 超过 `maxVerifierInvalidRetries` 时，conductor 将任务移入 `FAILED_BOX`，并设置 `last_failure_type: "verifier_protocol_exhausted"`。
- [ ] AC-012：`FIXING` 阶段的 maker repair prompt 包含 `spec.md` 和最新 `repair-context-r<n>.json`，且不包含 `verify-r<n>.md` 叙事内容。
- [ ] AC-013：Verifier 失败产生的 `repair-context-r<n>.json` 只包含失败或 unknown 的 AC，以及对应 `reason` 和结构化 `evidence`。
- [ ] AC-014：Green gate 失败产生的 `repair-context-r<n>.json` 包含有边界的 stdout/stderr tail，且不超过配置的 tail 字节上限。
- [ ] AC-015：`ensureWorktree` 为已知 harness artifact 写入本地 `.git/info/exclude` 条目，并且 maker 创建的 `.claude_review_state.json` 不会出现在 `git diff <baseBranch>...HEAD` 中。
- [ ] AC-016：如果某个已知 harness artifact 已经被目标仓库追踪，conductor 不会静默删除它；该轮会以 `last_failure_type: "tracked_harness_artifact_conflict"` 失败。
- [ ] AC-017：`timeline.md` 记录每一次状态转移、green gate 结果、invalid verifier retry、maker repair 路由、failed-box 原因以及最终 human merge 事件。
- [ ] AC-018：保留现有预算闸行为：当任务花费达到 `budgetUsd` 后，不再发生新的 maker 或 verifier spawn。
- [ ] AC-019：现有 fake-claude 测试保持确定性，且不调用真实 Claude binary。
- [ ] AC-020：`npm test` 通过，并包含针对 JSON 状态布局、verifier schema、invalid verifier retry 路径、green gate repair 路径、repair-context prompt 最小化和 worktree exclude 行为的新单测/集成测试。

## 实现说明

| 区域 | 文件 | 说明 |
| --- | --- | --- |
| 状态模型 | `conductor/lib/state.mjs` | 增加任务目录读写 helper，用于 `task.json` 和 `runtime.json`。JSON 写入保持 pretty；在当前 demo 约束下做到足够原子。 |
| CLI | `conductor/conductor.mjs` | 更新 `new`、`status`、`approve`、`reject`、`merge`、`retry` 和 drain iteration，让它们使用任务目录。 |
| 决策逻辑 | `conductor/stages/decisions.mjs` | 增加 green gate 失败路由、verifier schema invalid 路由、maker miss 耗尽等纯函数决策。 |
| 共享 helper | `conductor/stages/shared.mjs` | 增加 `writeGreenGateResult`、`buildRepairContext`、`validateVerifierVerdict`，以及使用 repair context 而不是 verifier 叙事的 prompt builder。 |
| Ready/Fixing | `conductor/stages/ready.mjs`, `conductor/stages/fixing.mjs` | 将 failed green gate 路由到 repair context 和 `FIXING`；不要直接跳到 `FAILED_BOX`，除非修复预算耗尽。 |
| Verify | `conductor/stages/verify.mjs` | 解析/校验结构化 verdict；invalid verifier output 不消耗 maker miss；只在有效 fail/unknown AC 时生成 repair context。 |
| Git/worktree | `conductor/lib/git.mjs` | 在每个任务 worktree 安装 `.git/info/exclude` pattern，并在 commit/diff 前防御 tracked harness artifact 冲突。 |
| Agent prompt | `agents/maker-agent.md`, `agents/verifier-agent.md` | 更新角色契约，使其匹配严格 schema 和最小 repair context。 |
| 测试 | `tests/unit/*.test.mjs`, `tests/integration/*.test.mjs` | 更新旧 frontmatter 测试，并新增 state、verifier、green gate、prompt 和 exclude 测试。 |

沿用现有测试风格：纯状态转移逻辑放在 unit tests 中，完整 conductor 行为通过 `tests/fixtures/fake-claude.mjs` 做端到端集成测试。

## 边界情况

| 情况 | 期望行为 |
| --- | --- |
| 旧布局中已有 `state/queue/*.md` 任务 | 要么提供 migration helper，要么显式失败并给出清晰提示。不得静默忽略旧任务。 |
| `task.json` 创建后被编辑 | Conductor 应检测 malformed/missing immutable fields，并将任务移入 `FAILED_BOX` 或以可见错误跳过；不得猜测。 |
| `runtime.json` 缺失 | Conductor 应将任务目录视为损坏并记录路径。 |
| Verifier 漏掉某条 AC | 视为 invalid schema，而不是 maker 失败。 |
| Verifier 将某条 AC 标为 `pass` 但没有 evidence | 默认视为 invalid schema，除非 schema 明确允许无证据 pass。 |
| Evidence 行号不存在 | 如果 conductor 实现行号校验，则视为 invalid schema；否则 verifier 应标记为 `unknown`。 |
| Green gate 输出巨大 | 只有在已有 spawn/test artifact 时才保存完整日志；repair context 只保存有边界的 tail。 |
| Maker 修复 green gate 失败后 verifier 又发现 AC 失败 | 使用同一套 `maker_miss_count` 阶梯；失败来源必须在 timeline 和 repair context 中可见。 |
| Claude 瞬态失败 | 保留现有 `runClaudeWithRetry` 行为；瞬态 retry attempt 不算 maker miss。 |
| Worktree 已存在 | 复用它，但仍需确保 `.git/info/exclude` 包含必需 pattern。 |
| 已知 harness 文件已经被目标仓库追踪 | 不自动移除；以 `tracked_harness_artifact_conflict` 失败。 |

## 验证计划

单元测试：

- `state.mjs`：`task.json` 与 `runtime.json` round-trip、任务目录确定性排序、损坏/缺失 JSON 行为。
- `decisions.mjs`：green gate pass/fail 路由、maker miss 耗尽、invalid verifier retry 路由、预算行为保持。
- `verify` schema parser：接受有效 per-AC verdict JSON；拒绝 prose-wrapped JSON、缺失 AC、非法 status、pass/fail 缺 evidence、非法 `overall`。
- `git.mjs`：本地 exclude 安装是幂等的，并保留既有 exclude 内容。

Fake Claude 集成测试：

- Feature happy path：使用 task/runtime JSON 跑通 `NEEDS_SPEC -> AWAIT_SPEC_APPROVAL -> READY -> VERIFY -> AWAIT_HUMAN_MERGE`。
- Green gate fail path：maker 写入错误代码；conductor 写入 green gate result 和 repair context，路由到 `FIXING`；随后 maker 修复并 verifier pass。
- Verifier invalid path：verifier 返回“叙事 + JSON”；conductor 重试 verifier，不 spawn maker，且不增加 `maker_miss_count`。
- Verifier fail path：有效 per-AC fail 创建最小 repair context；maker prompt 包含 failed AC JSON，且不包含 `verify-r1.md` 叙事。
- Worktree artifact path：maker 创建 `.claude_review_state.json`；conductor commit/diff 排除它。
- Retry path：`FAILED_BOX -> READY` 保留 dossier attempts，并按当前 retry 语义重置 runtime counters。

人工检查：

```bash
npm test
node conductor/conductor.mjs status
```

真实目标仓库试跑时，检查：

```bash
git -C worktrees/<id> diff <baseBranch>...HEAD --name-status
cat dossier/<id>/repair-context-r1.json
cat dossier/<id>/verify-r1.verdict.json
cat dossier/<id>/timeline.md
```

## 已决策问题

| 问题 | 决策 | 实现影响 |
| --- | --- | --- |
| 是否自动迁移旧的 `state/queue/*.md` 任务？ | 不迁移。旧任务文件属于 demo/test 数据，可以删除或忽略；新实现只支持任务目录布局。 | 实现无需 migration helper；如果 conductor 发现旧布局文件，应给出清晰提示并跳过，不要静默当作新任务处理。 |
| 是否把旧字段 `miss_count` 重命名为 `maker_miss_count`？ | 重命名为 `maker_miss_count`。 | `runtime.json`、状态转移逻辑、status 输出和测试都使用新字段；它只统计 maker 可行动失败，不统计 verifier 协议失败。 |
| Evidence 行号是否由总 conductor 程序校验？ | 不放到总 conductor 程序里校验。Verifier agent 必须通过自身 hook 校验 evidence 的 `file/start_line/end_line/summary`，确认引用文件存在、行号范围存在且 excerpt/summary 与实际内容一致后，才能输出 verdict JSON。 | 如果 verifier hook 发现 evidence 行号错误或引用内容不匹配，本轮 verifier 输出应直接失败并重新生成；不要把这种错误交给 maker 修复。总 conductor 只消费 verifier 最终产出的 schema，不承担逐行证据校验职责。 |
| Green gate 是否保存测试记录？ | 保存测试命令的结构化执行记录。`green-gate-r<n>.json` 必须包含 test command、cwd、exit code、started/finished 时间，以及有边界的 stdout/stderr tail。 | Repair context 只引用精简日志摘要；完整日志如需保存应作为单独 artifact，避免把长日志塞进 maker prompt。 |
