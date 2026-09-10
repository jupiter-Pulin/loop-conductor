# Tech Spec: Router Conductor —— 极简内核 + router 管理员 + 两道人闸

> 状态：提案 v3，待人审。首稿 2026-09-09；v2 / v3 修订 2026-09-10（见文末「修订记录」）。取代 2026-09-05 的同名草案（该稿未入库已丢失）。
> 读者：审批人（你）与实现 subagent。实现按 conductor-infra-fix-mode（记忆）直派，不走 conductor 开单。

## Summary

把 conductor 从「固定转移的状态机 + 八个角色 + 五道人闸」重构为三层：**内核**只产事实、守上限、记案卷；**router agent** 在闭集动作里选下一步；**人**只在两道闸出现——spec 审批与 merge 审批。角色收敛为 router / spec / maker / reviewer 四个。删除 spec-verifier、committer、feasibility、setup、test-gate、per-AC 探针、maker miss 阶梯、spec epoch 冷启动、续跑腿、crash 恢复额度。

大任务按 **工作包** 拆给多个 maker：spec 提议方案并与完整 spec 一并交人审，或由 router 在执行中发起 `plan` 让 spec-agent 补方案、内核校验；router 只读结构化清单与执行状态来调度并行或串行；内核负责建 worktree、并发 spawn、提交与集成。修复由**整体审核驱动**：各包集成到任务分支后，reviewer 审整份代码、全部 AC 与包间协作，问题交主责包的 maker 修，再集成、再整体审，通过后 precommit。包的完成、文件边界、上游变化都不是验收条件。

merge 的唯一依据是**版本规则**——整体 review ok 与 precommit ok 都必须对着当前任务分支 HEAD 与当前 base HEAD，人的 notes 不能豁免。precommit 在 merge 候选上按「构建 → 启动服务 → 对应层级测试」三步验证集成后的系统能正常工作，不只是跑测试命令。五小时限额进 FAILED_BOX，重置后由人手动恢复，永不自动续跑。

为什么是现在：dossier 17 个任务 $249，其中 7 个失败任务烧掉 $149、产出代码 0 行；失败全部发生在「机械阶梯替代判断」与「限流当任务失败」两处，而模型侧 maker 一轮过 16/17，原为弱模型设计的阶梯已不再触发。

## Context

### 现状

状态流、角色、数据位置以 [README.md](../../../README.md) 为准。关键事实：

| 指标 | 值 | 来源 |
| --- | --- | --- |
| 任务总数 / done / failed | 17 / 10 / 7 | `node tools/dossier-stats.mjs` |
| 总花费 / 失败任务花费 | $248.67 / $148.60 | 同上 |
| spec↔spec-verifier 打乒乒耗尽 | 3 任务 $87.20，AC 数 19–35，finding 数逐轮 11→9→7→7→5→4 仍被 MAX_MISS×2 epoch 杀掉 | `dossier/task-20260829-001`、`-20260802-002`、`-20260801-001` |
| 五小时限额被当瞬态 429 退避 7 次后收箱 | 2 任务 $61.40，spec 均已人审通过 | `dossier/task-20260829-00{2,3}/maker-r1.stream.jsonl`：`rateLimitType:"five_hour"`, `resetsAt` |
| maker r1 一轮通过 / 截断 | 16/17 / 0/14 | dossier-stats |
| test-gate vacuous 拦截 | 0/17 | dossier-stats |
| `agents/maker-agent.md` 中服务 test-gate 的篇幅 | 约 40% | 文件本身 |

### 复用的内核面

| 模块 | 复用点 |
| --- | --- |
| `conductor/lib/claude.mjs` | `runClaudeStream` / `buildClaudeArgs` / 瞬态重试封装；需新增 `rate_limit_event` 解析 |
| `conductor/lib/state.mjs` | `dossierPath`、`appendTimeline`、`appendEvent`、`transitionState`、`writeJsonAtomic`、`enumerateAcceptanceCriteria` |
| `conductor/lib/git.mjs` | `ensureWorktree`、`addDetachedWorktree`、`removeWorktree`、`commitAll`、`mergeBranch`、`diffAgainstBase`、`diffNameStatusAgainstBase`、`mergeBaseWith` |
| `conductor/lib/spec-contract.mjs` | `validateSpecDoc`（spec 文件格式的唯一裁判，沿用） |
| `conductor/lib/failure-signature.mjs` | `buildSignature`（保险丝复用） |
| `conductor/lib/lock.mjs` | 全局锁（precommit 串行复用） |
| `conductor/hooks/spec-write-guard.mjs`、`maker-git-guard.mjs`、`check-spec.mjs` | 写白名单、git 护栏、Stop hook 骨架（`stop_hook_active` 只拦一次） |
| `conductor/lib/scheduler.mjs`、`task-lock.mjs` | 并发、任务锁、run 预算 |
| `conductor/dashboard/` | 看板与人闸 UI |

## Goals

- MUST 状态机收敛为 `ROUTING ⇄ AWAIT_HUMAN → DONE`，外加 `FAILED_BOX`；原有 stage 全部降为 router 的动作。
- MUST router 只读 brief、执行记录、内核事实、已生效的结构化工作包清单与执行状态；永不读 spec 正文、diff、代码。
- MUST 每个 agent 的唯一交付信号是 `dossier/<id>/<role>[-P-xxx]-r<n>.log.json`；内核读文件、不推断、不自动重派。
- MUST 恰好两道强制人闸：spec 存在时的 spec 审批；任何任务的 merge 审批。此外只有 router 或内核发起的 `help` 求助。
- MUST spec 覆盖 brief 的完整需求；范围疑问与拆分方案在**同一次** spec 审批里与完整 spec 一并展示；人裁决过的事项 router 不得再次求助。
- MUST 支持一个任务下多个 maker 按工作包并行：spec 提议或 router 执行中 `plan` 补方案、router 调度、内核执行；同轮无依赖且声明文件无交集的包可并行，否则串行；每个并行 maker 独立 worktree 与 log。
- MUST 修复由整体审核驱动：集成后 reviewer 审全部 AC 与包间协作，fail 的 AC 交主责包 maker；不因文件相交、越界修改或上游重集成而强制局部复审或重做。
- MUST 包完成不代替任务完成：merge 的唯一依据是版本规则（整体 review ok @HEAD 且 precommit ok @HEAD/base），人的 notes、包状态、文件边界都不能豁免或替代。
- MUST precommit 在合并候选上依次验证构建、服务启动、对应层级测试；适用步骤任一失败即 precommit 失败；服务进程必被清理。
- MUST 五小时/周限额 → FAILED_BOX，带 `resets_at`；只有人的 `retry` 能恢复，且必须在重置时刻之后。
- MUST 任何代码路径都不执行 `git push`；router 不直接执行任何 git 命令。
- SHOULD 每个角色的固定 prompt 上下文尽量短，判断力通过 few-shot 传递；few-shot 来自 dossier 真实案卷。

## Non-goals

- 不自动 push；不自动合并到 base 分支（merge 闸由人点）；不在限额重置后自动续跑。
- 不做 feasibility / setup / committer / spec-verifier / test-agent 角色，不做 per-AC 探针与 ac-tests.json 映射，不做 codex / reviewer shadow。
- 不保留 `autoApproveSpec*`、`autoMerge*`、`specMaxAcs` 规模闸、`crashAutoRecoveryLimit`、续跑腿（`-r` resume）。
- 不做包级复审、包级 precommit、包级人闸；不维护 `stale` 之类的派生状态；不因越界修改文件撤销改动或重审范围。
- 不允许借拆包裁剪需求：任何方案必须覆盖已批准 spec 的全部 AC；不支持替换已生效的方案（只能逐包重做）。
- 不做跨任务的工作包（一个包只属于一个任务）；不做包级预算。
- 不改 target 仓库自身的测试组织、构建脚本或服务启动方式；precommit 各步命令由人在 target-profile 里手写。
- 不迁移已在 `state/done|failed` 的旧任务；旧 dossier 保持可读即可。
- 不在本 spec 内更新 `.claude/skills/loop-task`；它随实现完成后另起一单调整（`--kind`、bugfix 写 spec.md 等步骤失效）。

## Contract

### Core Invariants

1. **副作用与终止权在内核。** 只有内核 spawn、commit、merge、集成、转移 stage；router 只能从闭集里选动作；router 不执行任何 git 命令；没有任何角色、任何路径能 push。
2. **router 的输入闭合。** router prompt 只含 brief、记录列表、内核事实、已生效的结构化工作包清单（id / title / acs / files / depends_on）与执行状态；spec 正文、工作包的 goal / interfaces 文字、diff、代码不进 router 上下文。
3. **案卷只增不改；log 文件是 agent→内核的唯一通道。** 内核从不修改 agent 写的 `.log.json`；缺失或非法只是记录里的一个字段（`product`），不是异常路径，不触发自动重派（唯一例外见「router 失效连击」）。
4. **被合并的 == 被测过的。** merge 审批通过时，base 分支 HEAD 必须等于最近一次 precommit ok 记录的 `base_sha`，任务分支 HEAD 必须等于其 `head_sha`；否则拒绝并回到 ROUTING。
5. **人闸种类封闭。** `AWAIT_HUMAN.kind ∈ {spec, merge, help}`；spec 与 merge 由内核依机械事实开启，help 由 router 或内核失效逻辑开启。
6. **版本规则是 merge 的唯一依据。** 记 `H` = 任务分支当前 HEAD，`B` = base 分支当前 HEAD：需要 review ⇔ 不存在 `outcome=ok ∧ head_sha=H` 的 reviewer 记录；需要 precommit ⇔ 不存在 `outcome=ok ∧ head_sha=H ∧ base_sha=B` 的 precommit 记录；两者都不需要时才允许申请 merge。人的 notes、`human_intervened`、包状态、越界文件都不能替代这两条。
7. **一次裁决一次有效。** 人在 spec 闸或 help 闸给出的裁决进入「已裁决事项」；router 不得对同一事项再次 `human`；内核机械拒绝与既有 help 记录 summary 逐字相同的 `human` 动作。
8. **方案不改范围。** 无论来自 spec 闸还是 `plan` 动作，工作包方案的 AC 集合必须恰好等于已批准 spec 的全部 AC；内核以此校验，不通过即不生效。

### 状态机

```text
new ──► ROUTING ──(router 选动作，内核执行，记录)──► ROUTING …
ROUTING ──spec 文件（含可选工作包方案）通过校验──► AWAIT_HUMAN(spec) ──approve [--no-packages] / reject──► ROUTING
ROUTING ──router: merge 且版本规则满足──► AWAIT_HUMAN(merge) ──approve──► DONE
                                                              └──reject --notes──► ROUTING
ROUTING ──router: human──► AWAIT_HUMAN(help) ──resume [--notes]──► ROUTING
ROUTING ──限额 rejected──► FAILED_BOX(rate_limited) ──retry（≥ resets_at）──► ROUTING
ROUTING ──保险丝同签名连击──► FAILED_BOX(fuse_no_progress) ──retry──► ROUTING
ROUTING ──预算耗尽──► FAILED_BOX(budget_exhausted) ──retry──► ROUTING
ROUTING ──router: abandon──► FAILED_BOX(abandoned)
```

内核自行发起的转移只有上面枚举的这几条，其余一切转移都由 router 的动作触发。`runtime.json` 字段：`stage`、`current_round`（router 轮次）、`awaiting`（`{kind, round}` 或 null）、`spec_approved`（bool）、`plan_active`（bool，方案已生效）、`plan_source`（`spec | router | null`）、`rate_limit`（见 §限额）、`spent_usd`、`last_failure_type`。删除全部 miss / inval / epoch 计数字段。

### router 动作闭集

router 的 log 除四个通用字段外有三个专属字段：`action`（必填）、`tier`（`precommit` 时必填）、`packages`（`P-xxx` 数组；`plan_active=true` 时 `maker` 必填；其余动作与无方案任务禁止出现）。

| action | 参数 | 内核执行 | 内核前置（违反 → `action_rejected` 事实，不产生副作用） |
| --- | --- | --- | --- |
| `spec` | — | 在一次性只读 worktree 内 spawn spec-agent；结束后 `specs/<id>.md` 通过 `validateSpecDoc`、且若存在 `specs/<id>.packages.json` 则通过 `validatePackages` → `AWAIT_HUMAN(spec)`；否则记 `spec_invalid` 事实回 ROUTING | 无 |
| `plan` | — | 在任务分支 HEAD 的一次性只读 worktree 内以**方案模式** spawn spec-agent，只允许写 `specs/<id>.packages.json` 与 log；结束后对冻结 spec 的 AC 集校验 `validatePackages` → 通过则冻结方案、初始化状态表、`plan_active=true`、`plan_source=router`、事件 `plan_created`；不通过记 `plan_invalid` 事实回 ROUTING | `spec_approved=true`；`plan_active=false`；`packagesEnabled=true` |
| `maker` | `packages?` | **无方案**：懒创建任务 worktree（分支 `task/<id>`）；spawn maker；`commitAll("task <id>: maker r<n>")`。**有方案**：对列出的每个包建包 worktree 与包分支、并发 spawn（≤ `maxParallelPackages`）、逐包 commit、按拓扑序集成（见 §工作包） | brief 存在；曾产出 spec 则 `spec_approved`；`plan_active` 时 `packages` 非空、每包处于 `ready / returned / conflict / integrated`、同轮包两两声明文件无交集、`depends_on` 全部 `integrated`、数量 ≤ `maxParallelPackages` |
| `review` | — | spawn reviewer（只读 + Write log）于任务 worktree，给全部 AC 与 diff；有方案时另附各包接口约定供其审包间协作 | 任务分支相对 base 有非空 diff |
| `precommit` | `tier` | 建合并候选，依次构建、启动服务、按 `tier` 累加跑测试，合成 `precommit-r<n>.json`（见 §precommit） | 存在 `head_sha=H` 的 reviewer 记录；`tier ≥` 该记录的 tier |
| `human` | — | 写 `human-r<n>.json{kind:help}`，→ `AWAIT_HUMAN(help)`；router 的 `summary` 即人看到的话 | summary 不得与本任务任一既有 help 记录逐字相同（Invariant 7） |
| `merge` | — | → `AWAIT_HUMAN(merge)` | 版本规则（Invariant 6）：`need_review=false ∧ need_precommit=false` |
| `abandon` | — | → `FAILED_BOX(abandoned)` | 无 |

**router 失效连击**（Invariant 3 的唯一例外）：router 记录 `product ≠ ok`，或动作被 `action_rejected`，视为一次失效；内核把失效原因写进事实并再 spawn router；连续 2 次失效 → 内核开启 `AWAIT_HUMAN(help, requested_by: kernel)`。理由：router 是唯一的裁判，裁判缺席时没有别人可以判断。

内核事实段直接给 router 两个布尔量与两个 sha：`need_review`、`need_precommit`、`H`、`B`，router 不必自己推导版本规则。

### 执行 log 契约（六条，已定稿）

**一、log 是文件，不是回复。** 每个 agent 结束前把 log 写到 `dossier/<id>/<role>[-P-xxx]-r<n>.log.json`，绝对路径由内核写进 prompt。不放 worktree，所以不污染 diff。截断的会话没有最终回复，文件已经在盘上。工作包 maker 的文件名带包段（`maker-P-001-r1.log.json`）；方案模式的 spec-agent 用 `spec-plan-r<n>.log.json`；reviewer 永远是整体复审，不带包段。

**二、四个字段，内核盖第五个。**

```jsonc
{
  "role": "router | spec | maker | reviewer",        // 必填，须等于内核派出的角色（方案模式仍为 spec）
  "outcome": "ok | fail | needs_human",              // 必填。spec: ok|needs_human；maker: 三者；reviewer: ok|fail；router: ok
  "tier": "unit | integration | e2e",                // reviewer 必填；router 选 precommit 时必填；其余角色出现即非法
  "action": "spec|plan|maker|review|precommit|human|merge|abandon", // router 必填；其余角色出现即非法
  "packages": ["P-001", "P-002"],                    // router 专属；仅 plan_active 且 action=maker 时合法且必填
  "summary": "string，非空，≤ 2000 字符"
}
```

`tier` 只有 reviewer 填，因为只有它冷读过 diff。router 的 `action` / `tier` / `packages` 是它存在的意义，是 router 专属字段。`cost_usd`、`truncated`（撞 max-turns）、`duration_ms`、`session_id`、`package`、`mode`、`head_sha`、`base_sha` 由内核从 CLI 结果与派出参数盖章；盖章不改 `.log.json`，而是在读取时与 `<role>[-P-xxx]-r<n>.json` spawn 记录合成一条**记录**（见下）。precommit 没有 agent，内核跑完三步自己合成同构的一条。未知字段 → 非法。maker 的 log **不**写 `package`：包由内核派出时指定并从文件路径得知，agent 不重复申报。

**三、summary 只写 router 决定下一步要用的东西。** 判据：删掉这句，router 的决策会不会变。每个角色一好一坏两个样例当规则（见 §Agent 提示词）：spec 写 AC 数、触及路径、工作包数与待决问题数；maker 写实现了哪些 AC、加了什么测试、测试结果、未完成的 AC；reviewer 每条 AC 一行，fail 必带 `文件:行号`，包间协作问题以 `note:` 行附在末尾。

**四、reviewer 增量写，判完一条写一条。** 每次用 Write 重写整份合法 JSON；未判完时 `outcome` 固定为 `fail`，summary 末行写 `未判: AC-004, AC-005`；全部判完再写终态。截断留下的是带「未判」清单的合法记录，而不是空文件。

**五、格式由 Stop hook 在会话内保障。** `conductor/hooks/check-log.mjs --log <path> --role <role> [--has-plan] --report <path>`：文件缺失或不合 schema → exit 2，错误喂回 stderr 当场自修；`stop_hook_active=true` → exit 0 放行（只拦一次）。会话内多一轮近乎免费，冷重派是完整一轮的钱。每个 prompt 配套一句「用 Write 工具写」，防 Read-before-Write 撞墙。

**六、内核观察，router 判断。** 内核读文件：不存在记 `product: "missing"`，JSON 非法或不合 schema 记 `product: "invalid"` 并附错误；两种情况都原样交给 router。内核不推断 outcome、不自动重派。缺字段和「花了多少钱」「被截断了」一样，只是记录里的一条信息。

### 记录（router 与 dashboard 读到的合成体）

```jsonc
{
  "round": 1, "role": "maker", "package": "P-001",          // package: 无方案任务为 null
  "mode": null,                                             // spec 方案模式为 "plan"
  "product": "ok | missing | invalid", "product_error": null,
  "outcome": "ok", "tier": null, "action": null, "packages": null,
  "head_sha": "…", "base_sha": null,                        // reviewer / precommit 派出时的任务分支 HEAD；precommit 另有 base_sha
  "summary": "AC-001..004 done；新增 test/launch/Factory.t.sol 6 用例；forge test 88/88 绿",
  "cost_usd": 8.10, "truncated": false, "duration_ms": 612000, "session_id": "…", "written_at": "…"
}
```

人的裁决也进记录列表：`{ "round": 1, "role": "human", "kind": "spec", "decision": "approved | rejected | resumed", "notes": "…", "no_packages": false }`。

router prompt 中记录按时间渲染为紧凑文本，一条两行：

```text
r1 spec           outcome=ok  cost=$3.65  truncated=no  product=ok
   AC×19；触及 src/launch/**（5 合约）+ test/launch/**；工作包 4；待决 2
r1 human          kind=spec  decision=approved  notes="按 4 包做；待决 1 取 A、待决 2 取默认"
r1 maker P-001    outcome=ok  cost=$8.10  truncated=no  product=ok
   AC-001..004 done；新增 test/launch/Factory.t.sol 6 用例；forge test 88/88 绿
r1 maker P-002    outcome=ok  cost=$9.40  truncated=no  product=ok
   AC-005..009 done；新增 test/launch/Curve.t.sol 11 用例；forge test 99/99 绿
r1 reviewer       outcome=fail  tier=integration  head=a1b2c3  cost=$4.10  product=ok
   AC-001 pass … AC-005 fail src/launch/Curve.sol:412 sweep 未扣 pendingCreatorFee …
   note: P-002 调用 P-001 的 createToken 少传 quoteToken，接口约定不一致
```

内核事实段（单独渲染，不混进记录）：当前 stage 与轮次；`H`、`B`、`need_review`、`need_precommit`；worktree 是否有 diff；最近 `action_rejected` 原因；限额/预算状态；**已裁决事项**（每条 human 记录的 kind / decision / notes 原文）；**工作包状态表**（见下，含每条 AC 的主责包）。

### 工作包（一个任务、多个 maker）

职责分工：**spec 提议，router 调度，内核执行，整体审核驱动修复。**

| 角色 | 能读 | 负责 |
| --- | --- | --- |
| spec-agent | brief、target 仓代码（只读 worktree）；方案模式下另读冻结 spec 与任务分支现状 | 是否拆包；每包的目标、AC 覆盖、预期修改文件、接口约定、依赖；待决问题 |
| 人（spec 闸） | 完整 spec、工作包方案、待决问题 | 一次审完：批准 / 弃方案单包 / 打回；notes 成为「已裁决事项」与「人审补充约束」 |
| router | 已生效方案的结构化清单（id / title / acs / files / depends_on）与状态表 | 哪些包开工、并行还是串行、整体 review 后把 fail 的 AC 交主责包重做、何时 precommit；单 maker 任务做不完时发起 `plan` |
| 内核 | 一切 | 校验方案、建包 worktree 与分支、并发 spawn、提交、拓扑序集成、冲突检测、状态维护 |
| reviewer | 冻结 spec、任务分支 diff、各包接口约定 | 整体审核：全部 AC + 包间协作 |

**方案文件** `specs/<id>.packages.json`（spec-agent 写，白名单放行；生效时冻结为 `dossier/<id>/packages.json`）：

```jsonc
{
  "schema_version": 1,
  "packages": [
    {
      "id": "P-001",                                  // ^P-\d{3}$，唯一
      "title": "Factory + Token",                     // ≤ 40 字
      "goal": "一句话目标（maker 读，router 不读）",
      "acs": ["AC-001", "AC-002", "AC-003", "AC-004"], // 该包主责的 AC；全部包对 spec 全部 AC 构成划分（每条恰在一包）；允许为空（纯脚手架包）
      "files": ["src/launch/Factory.sol", "src/launch/Token.sol", "test/launch/Factory.t.sol"], // 预期修改/新增路径，允许 glob，非空；只用于并行调度，不是验收边界
      "interfaces": "对外接口约定：签名、事件、返回值——下游包依赖的契约（maker、reviewer 读，router 不读）",
      "depends_on": []                                // 必须先 integrated 的包
    }
  ]
}
```

`conductor/lib/packages.mjs::validatePackages(plan, acIds)`：id 唯一且合法；`acs` 对 `acIds` 构成划分；`files` 非空；`depends_on` 引用存在且无环；包数 ≤ `maxPackages`（默认 12）。`acIds` 取自将要生效的 spec：spec 闸取 `specs/<id>.md`，`plan` 动作取冻结的 `dossier/<id>/spec.md`（Invariant 8）。无方案 = 单包任务：maker 直接在任务分支 `task/<id>` 工作，不建包分支，`packages` 参数禁止出现。人 `approve --no-packages` 等价于删除方案；此后 router 仍可用 `plan` 让 spec-agent 重新出方案（内核校验，不再过人闸，因为范围已由 AC 划分锁定）。

**两个入口**：

- **spec 闸**：spec-agent 与 spec 一并提交方案，人一次审完；`approve` 生效，`plan_source=spec`。
- **`plan` 动作**：单 maker 任务执行中 router 判断一轮做不完（maker 记录报「未完成的 AC」或被截断），选 `plan`；内核在任务分支 HEAD 的只读 worktree 上以方案模式 spawn spec-agent，prompt 给冻结 spec 全文、既有 maker 记录 summary、任务分支相对 base 的 `--stat`；spec-agent 只能写 `specs/<id>.packages.json` 与 log；内核校验后生效，`plan_source=router`，事件 `plan_created`。已有单 maker 工作留在任务分支上，成为全部包的起点。

**状态**（内核维护于 `dossier/<id>/packages-status.json`，router 以表格形式读到）：

| 状态 | 含义 | 进入 | 离开 |
| --- | --- | --- | --- |
| `pending` | 依赖未全部 integrated | 方案生效 | 依赖齐 → `ready` |
| `ready` | 可调度 | 依赖齐 | router `maker` → `running` |
| `running` | maker 在包 worktree 里工作 | spawn | maker 返回 |
| `returned` | maker 返回但未集成（outcome ≠ ok，或 product ≠ ok，或崩溃/限额中断） | maker 返回 | router 再 `maker` → `running` |
| `conflict` | 集成到任务分支时冲突，分支保留 | 集成失败 | router 再 `maker` → `running` |
| `integrated` | 已合入任务分支 | 集成成功 | router 因整体 review 的 fail AC 再 `maker` → `running` |

没有派生状态：上游包重新集成、他包越界修改、文件相交都不改变任何包的状态，也不产生重做要求。`integrated` 是粘性的，只有 router 依据整体 review 的结果把它派回 `running`。

状态表每行渲染：`P-002 Curve  acs=AC-005..009  deps=P-001  files=src/launch/Curve.sol,test/launch/Curve.t.sol  state=integrated@e4f5  rounds=1  cost=$9.40  note=-`；`note` 承载 `conflict_files` / `undeclared_files`（只作参考）。

**调度约束**（`maker` 动作前置，内核执行）：同轮 listed 包两两 `files` 无交集（glob 展开后比对声明）；`depends_on` 全部 `integrated`；数量 ≤ `maxParallelPackages`（默认 2）。声明相交或有依赖的包只能分轮串行。`maker` 动作在一个 router 轮次内同步完成（spawn 全部 → 等待 → 提交 → 集成），不存在跨轮并发，因此只需比对同轮包。

**执行**：对每个 listed 包，内核在任务分支当前 HEAD 上建 `worktrees/<id>--P-xxx`（分支 `task/<id>--P-xxx`；已存在且状态为 `returned` 的包 worktree 直接复用，让 maker 续做），并发 spawn（信号量 = `maxParallelPackages`），每包独立 log 与 spawn 记录（含 `package`、`base_sha`）。maker 返回后逐包 `commitAll("task <id>: maker P-xxx r<n>")`，记录 `touched_files` 与 `undeclared_files`（触及但未在 `files` 声明；只记录，不阻塞、不撤销、不重审）。

**集成**：同一轮返回的包按 `depends_on` 拓扑序、同层按 id 序，逐个 `git merge --no-ff -m "task <id>: integrate P-xxx r<n>" task/<id>--P-xxx` 到 `task/<id>`。只有 `outcome=ok ∧ product=ok` 的包进入集成；其余置 `returned`，分支与 worktree 保留。集成冲突 → `merge --abort`，状态 `conflict`，记 `conflict_files`，分支保留，后续包继续尝试集成。集成成功 → `integrated`，记 `integrated_sha`，删除包 worktree（分支保留至任务 DONE 时一并删除）；依赖它的 `pending` 包在全部依赖 `integrated` 后置 `ready`。

**整体审核驱动修复**：包集成后由 router 选 `review`；reviewer 审全部 AC 与包间协作（接口约定不一致记在相关 AC 的 fail 行或 `note:` 行）。状态表给出每条 AC 的主责包（Q13：恰一个），router 把 fail 的 AC 映射到主责包再 `maker packages=[…]`；跨包协作问题由 router 判断交哪一包（或两包分轮）。重做的包从任务分支当前 HEAD 新建 worktree（已含全部已集成代码），prompt 附整体 review 中本包 AC 的 fail 行与 `note:` 行；结果作为新 merge 再集成，**不 revert** 旧提交（Q14）。再集成形成新 `H`，`need_review` 自动为 true → 再整体 review → 通过后 precommit。

**限制与预算**：`maxParallelPackages` 默认 2；系统总并发 spawn ≤ `maxConcurrentTasks × maxParallelPackages`；任务级 `budgetUsd` 累计包含全部包与全部角色，超出 → `FAILED_BOX(budget_exhausted)`（沿用 `overBudget`）；不设包级预算。限额命中时全部在飞包的 spawn 都以 `rate_limited` 返回，任务 → `FAILED_BOX(rate_limited)`，这些包置 `returned`（记录 `product=missing`），worktree 保留；人 `retry` 后 router 见状态表自行再派。

**整体完成**：包状态不参与 merge 前置。任务只有在整体 review ok @H 且 precommit ok @H/B 后才能申请 merge，随后由人审批。

### precommit（产品承诺：集成后的系统能构建、能启动、能通过对应层级的测试）

precommit 不是「跑一条测试命令」，而是在 merge 候选上依次证明三件事。任一**适用**步骤失败即 `outcome: fail`，其后步骤记 `not_run`；未配置的步骤记 `skipped`，不影响裁决。

**候选**：`addDetachedWorktree(targetRepo, worktrees/<id>.precommit, <B>)` → `git merge --no-ff -m "precommit candidate" task/<id>`。冲突 → `git merge --abort`，记录 `outcome: fail`、`conflict_files`，三步都 `not_run`。候选 worktree 在 finally 必移除。

**profile 配置**（`target-profiles/<repo>/setup-profile.json` 的 `precommit` 段；`new` 时校验）：

```jsonc
{
  "precommit": {
    "build":   "npm run build",                       // 可选。缺省 → build 步 skipped
    "service": {                                      // 可选。缺省 → service 步 skipped（库、CLI、纯合约仓库属此类）
      "start": "npm run start",                       // 在候选 worktree 内以独立进程组启动，stdout/stderr 落 dossier
      "ready": { "url": "http://127.0.0.1:3000/health" }, // 或 { "command": "curl -sf http://127.0.0.1:3000/health" }；二选一，必填
      "ready_timeout_ms": 60000,                      // 默认 60000
      "env": { "PORT": "3000", "NODE_ENV": "test" },  // 可选，叠加在进程环境上
      "stop_grace_ms": 10000                          // 默认 10000：SIGTERM 进程组，超时 SIGKILL
    },
    "unit": "npm test",                               // 缺省回落 task.testCommand；两者皆无 → new 拒绝
    "integration": "npm run test:integration",        // 可选
    "e2e": "npm run test:e2e"                         // 可选
  }
}
```

**步骤**（顺序固定）：

| 步 | 适用 | 成功条件 | 超时 | 失败时 |
| --- | --- | --- | --- | --- |
| 1 build | 配置了 `build` | 命令 exit 0 | `precommitStepTimeoutMs`（默认 = `greenGateTimeoutMs`） | fail；service 与测试 `not_run` |
| 2 service | 配置了 `service` | 进程启动后，在 `ready_timeout_ms` 内 `ready.url` 返回 2xx 或 `ready.command` exit 0（每 1s 轮询一次），且进程仍存活 | `ready_timeout_ms` | fail（记 `ready_ms=null`、进程退出码、输出 tail）；测试 `not_run` |
| 3 测试 | 总是适用（至少有 `unit`） | `tier=unit` 跑 `unit`；`integration` 跑 `unit`+`integration`；`e2e` 跑三层；已执行命令全部 exit 0 | 每条命令 `precommitStepTimeoutMs` | fail；tier 内后续命令 `not_run`；缺省层记 `skipped_tiers` |

服务在测试期间保持运行（集成/E2E 测试可依赖它），无论结果在 finally 按 `stop_grace_ms` 终止整个进程组并记录 `stopped: true`；服务输出 tail 落进记录。**precommit 全局串行**：通过 `state/.precommit.lock` 保证同一时刻只有一个候选在跑（端口、数据库等共享资源），等锁超过 `precommitLockTimeoutMs`（默认 30 分钟）→ `outcome: fail`，原因 `lock_timeout`，router 可直接重试。

**记录** `dossier/<id>/precommit-r<n>.json`：与 agent 记录同构（`role: "precommit"`, `outcome`, `tier`, `summary`, `cost_usd: 0`）+ 事实：`base_sha`（= B）、`head_sha`（= H）、`candidate_sha`、`steps: [{step: build|service|unit|integration|e2e, command, status: ok|fail|skipped|not_run, exit_code, timed_out, duration_ms, ready_ms?, tail}]`、`skipped_tiers`、`conflict_files`。`tail` 受 `greenGateOutputTailBytes` 约束。`summary` 由内核生成：`build ok 42s；service ready 3.1s；unit 41/41 ok；integration 2 fail: <首行>`。

**不适用情形**：无构建步的解释型仓库不配 `build`；库、CLI、合约仓库不配 `service`；只有单元测试的仓库不配 `integration`/`e2e`，reviewer 声明更高层级时记 `skipped_tiers` 并在 summary 注明。`new` 打印的样例包含全部键并注明哪些可删。

### 人闸

| 动作 | CLI | 内核行为 |
| --- | --- | --- |
| spec 批准 | `approve <id> [--notes "…"] [--no-packages]` | 冻结 `specs/<id>.md` → `dossier/<id>/spec.md`；有方案且无 `--no-packages` → 冻结 `specs/<id>.packages.json` → `dossier/<id>/packages.json`，初始化状态表，`plan_active=true`、`plan_source=spec`；`--no-packages` → 方案归档不生效；`spec_approved=true`；记录 human（notes 原文），→ ROUTING |
| spec 打回 | `reject <id> --notes "…"` | 记录 human(rejected, notes)，→ ROUTING（router 见 notes 自行决定，通常再派 spec） |
| merge 批准 | `approve <id> [--message "…"]` | 校验 Invariant 4 / 6；`mergeBranch(base, task/<id>, message)`；删任务分支、包分支与 worktree；→ DONE。**不 push。** |
| merge 打回 | `reject <id> --notes "…"` | 记录 human(rejected, notes)，→ ROUTING |
| help 恢复 | `resume <id> [--notes "…"]` | 事件 `human_intervened{notes}`，记录 human(resumed)，→ ROUTING。**不改写任何 reviewer / precommit 记录，不豁免版本规则** |
| 限额恢复 | `retry <id>` / `retry --rate-limited` | 见 §限额 |

`human-r<n>.json`：`{ "kind": "spec|merge|help", "requested_by": "kernel|router", "summary": "…", "refs": ["specs/<id>.md", "specs/<id>.packages.json", "dossier/<id>/…"] }`。dashboard 只渲染这一种东西：kind、summary、refs、可用按钮。spec 闸页面**同屏**展示完整 spec、工作包方案表、`## 待决问题` 段；merge 闸页面额外展示最近 reviewer 记录、precommit 记录（含三步结果）、diff 与状态表。

spec 闸的 notes 有两个去向：作为 human 记录进 router 的「已裁决事项」；作为「人审补充约束」逐字注入之后每个 maker / reviewer / 方案模式 spec-agent 的 prompt。

merge commit 文案为机器文案 `task <id>: <title>`（与轮次 commit 同属状态机产物，不受 git-conventions 约束）；人可用 `--message` 覆盖。

### 限额（已定稿：进箱，人手动恢复，永不自动续跑）

- `runClaudeStream` 解析 stream 中 `type: "rate_limit_event"` 且 `rate_limit_info.status === "rejected"` 的事件，在返回值上暴露 `rate_limit: { type, resets_at, status }`（`resets_at` 为 Unix 秒）。
- 瞬态重试封装：结果带 rejected `rate_limit` → **零重试，立即停止**，直接返回 `rate_limited: true`。其余 403/408/5xx 及无 `rate_limit` 的 429 保留瞬态退避，阶梯为 3 档（15s/30s/60s）。
- 内核：任务 → `FAILED_BOX`，`last_failure_type: "rate_limited"`，`runtime.rate_limit = { type, resets_at, hit_at, resume_stage: "ROUTING" }`；timeline 与事件 `rate_limited`。本次 `run` 内不再发起任何新 spawn（`cfg.__rateLimited = resets_at`），未开跑的任务留在原 stage 不受影响并各记一条 `spawn skipped: rate limited until <iso>`。
- 恢复：`retry <id>` 在 `now < resets_at` 时拒绝，输出本地时间的重置时刻，exit 非 0，`--force` 可越过；`now ≥ resets_at` → 回 ROUTING，不归档任何轮次产物、不改任何计数；`retry --rate-limited` 批量恢复全部此类任务。恢复后由人执行 `run`。
- **没有任何代码路径会在无人操作时把 `rate_limited` 任务移出 FAILED_BOX**：无 cron、无 scheduler 自动搬运、dashboard 的 auto-run 不对 FAILED_BOX 生效。
- dashboard：FAILED_BOX 卡片显示 `限额 <type>，重置于 <本地时间>`；`now ≥ resets_at` 时才启用「恢复」按钮，按钮语义等同 CLI `retry`。

### 保险丝（已定：连续 3 次同因失败停止）

不数步数，数「无进展」。内核为每条 `precommit` 记录计算签名（复用 `buildSignature`，输入为失败步骤名 + 命令 + tail），为每条 `reviewer` 记录计算签名（`tier` + 排序后的 fail AC 编号 + 各 fail 首行），为每条 `maker` 记录按 `(package, outcome, summary 首行)` 计算签名。同一 `(role, package)` 连续 `fuseStreak`（默认 3）条记录签名相同 → `FAILED_BOX(fuse_no_progress)`，`retry` 恢复。`fuseStreak: 0` 关闭。正经工作每轮改变事实，死循环不改变；这根保险丝不会误杀正经花费。`maxStepsPerTask` 保留为调度切片长度，不再承担失败语义。

### 角色、工具、hook、模型

| 角色 | cwd | `--tools` | PreToolUse 白名单 | Stop hook | maxTurns |
| --- | --- | --- | --- | --- | --- |
| router | conductor root | `Write` | 只允许写自己的 log 路径 | check-log（含 action / tier / packages 校验） | 4 |
| spec（写 spec） | 一次性只读 worktree @ base（沿用 spec 链隔离） | `Read,Grep,Glob,Bash(git log:*),Bash(git blame:*),Bash(git show:*),Write,Edit` | spec 路径 + packages 路径 + log 路径 | check-log + validateSpecDoc + validatePackages（沿用 check-spec 扩展） | 40 |
| spec（方案模式） | 一次性只读 worktree @ 任务分支 H | 同上 | **仅** packages 路径 + log 路径 | check-log + validatePackages（对冻结 spec） | 25 |
| maker | 任务 worktree，或包 worktree | 全部（`Bash` 免审批） | maker-git-guard（沿用） | check-log | 70 |
| reviewer | 任务 worktree | `Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Write` | 只允许写自己的 log 路径 | check-log（含 tier 必填） | 40 |

**模型**：`models: { router, spec, maker, reviewer }` 可配置；默认沿用现配置（四角色均 `claude-opus-5`），任何角色可改为其他可用模型。`run` 启动时对配置中每个尚未验证过的模型 id 做一次可用性探测（`--max-turns 1`、无工具、提示词「reply ok」），结果按 `模型 id + claude 二进制版本` 缓存在 `state/.model-probe.json`；探测返回模型不存在/不可用类错误 → 终止本次 `run` 并列出不可用的 id，不改任何任务状态；探测撞限额 → 终止本次 `run` 并打印重置时刻，不改任何任务状态。本文不对模型间成本或质量差异做承诺。

config：`models`、`maxTurns: { router, spec, plan, maker, reviewer }`、`maxParallelPackages`（默认 2）、`maxPackages`（默认 12）、`packagesEnabled`（阶段闸，P2b 前默认 false：spec prompt 不含工作包段、`plan` 动作被拒、`new` 拒绝已有方案文件；P3 移除该键恒开）、`fuseStreak`（默认 3）、`precommitStepTimeoutMs`（默认 = `greenGateTimeoutMs`）、`precommitLockTimeoutMs`（默认 1800000）、`greenGateTimeoutMs`、`greenGateOutputTailBytes`、`maxConcurrentTasks`、`budgetUsd`、`runBudgetUsd`、`spawnBackoffMs`（3 档）。删除：`specMaxAcs`、`autoApproveSpec*`、`autoMerge*`、`testGate*`、`testChangeGuardEnabled`、`verifierShadow*`、`verifierEvidenceAnchorsMode`、`reviewStage`、`crashAutoRecoveryLimit`、`feasibilityEnabled`、`specChainIsolationEnabled`（恒开）。`loadCfg` 对遗留键打印一次警告。

`new` CLI：`new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]`；删除 `--kind`、`--feasibility`、`--auto-approve-spec`。目标仓无 `target-profiles/<repo>/setup-profile.json`、无 `precommit` 段、或 `unit` 与 `testCommand` 皆缺时 `new` 失败并打印完整样例让人手写。

### 案卷布局

| 文件 | 写入者 | 含义 |
| --- | --- | --- |
| `state/queue|failed|done/<id>/task.json` / `runtime.json` | 内核 | 不可变快照 / 可变状态 |
| `state/queue/<id>/brief.md` | `new` | 需求原文 |
| `state/.precommit.lock`、`state/.model-probe.json` | 内核 | precommit 全局串行锁；模型可用性缓存 |
| `specs/<id>.md`、`dossier/<id>/spec.md` | spec-agent / 内核冻结 | 草稿 / 已批准冻结稿 |
| `specs/<id>.packages.json`、`dossier/<id>/packages.json` | spec-agent（含方案模式）/ 内核冻结 | 工作包方案草稿 / 已生效方案 |
| `dossier/<id>/packages-status.json` | 内核 | 包状态表（state、rounds、cost、branch、base_sha、integrated_sha、touched_files、undeclared_files、conflict_files） |
| `dossier/<id>/<role>[-P-xxx]-r<n>.log.json`、`spec-plan-r<n>.log.json` | agent | 执行 log（契约见上） |
| `dossier/<id>/<role>[-P-xxx]-r<n>.log.hook.json` | Stop hook | 会话内校验报告 |
| `dossier/<id>/<role>[-P-xxx]-r<n>.json`、`.stream.jsonl`、`.settings.json` | 内核 | spawn 记录（含 cost / truncated / package / mode / head_sha / base_sha）、原始流、逐轮 hook 设置 |
| `dossier/<id>/precommit-r<n>.json`、`precommit-r<n>.service.log` | 内核 | 三步回归结果；服务进程输出 |
| `dossier/<id>/human-r<n>.json` | 内核 | 人闸请求（kind / summary / refs） |
| `dossier/<id>/timeline.md`、`events.jsonl` | 内核 | 只增日志；事件类型：`router_decision`、`action_rejected`、`human_gate_opened`、`human_decision`、`human_intervened`、`plan_created`、`plan_invalid`、`package_started`、`package_returned`、`package_integrated`、`package_conflict`、`precommit_result`、`rate_limited`、`fuse_tripped`、`budget_exhausted`、`merged` |
| `worktrees/<id>/`、`worktrees/<id>--P-xxx/`、`worktrees/<id>.spec-ro/`、`worktrees/<id>.plan-ro/`、`worktrees/<id>.precommit/` | 内核 | 任务 worktree（分支 `task/<id>`）/ 包 worktree（分支 `task/<id>--P-xxx`）/ spec 只读 worktree / 方案模式只读 worktree / 合并候选（用毕即删） |

## Agent 提示词与 few-shot（待审查的正文）

约定：`{{…}}` 为内核注入的占位；「固定上下文」指去掉模板、few-shot 与注入内容后的指令文字。few-shot 每条标注来源案卷；没有真实案卷的以「构造」标注。prompt 文件位于 `agents/<role>-agent.md`，few-shot 位于 `agents/fewshot/<role>.md`，由 `conductor/lib/prompts.mjs` 拼装。所有 prompt 中的 JSON 示例都是要 agent 逐字遵守的形状。

| 角色 | 固定上下文（字） | few-shot（组） | 注入内容 |
| --- | --- | --- | --- |
| router | 约 330 | 22 好 + 6 坏 | brief、记录列表、内核事实（含已裁决事项、工作包状态表与 AC 主责包）、log 路径 |
| spec | 约 230 + 模板 + 方案模式段 | 7 组 | brief、reject notes（若有）、spec 路径、packages 路径、log 路径；方案模式另注入冻结 spec、maker 记录 summary、分支 `--stat` |
| maker | 约 170 + 条件段 | 5 组 | spec 或 brief、人审补充约束、修复记录（若有）、工作包段（若有）、testCommand、log 路径 |
| reviewer | 约 230 + 条件段 | 7 组 | 全部 AC、人审补充约束、各包接口约定（若有）、diff、log 路径 |

### router

**固定上下文**

```text
你是任务 {{id}} 的管理员。只读下面的 brief、记录、内核事实、工作包状态表，从动作闭集选一个，用 Write 工具写到 {{log_path}}：
{"role":"router","outcome":"ok","action":"<动作>","tier":"<仅 precommit 时填>","packages":["<仅有生效方案且动作为 maker 时填>"],"summary":"<一行理由>"}

动作闭集：spec | plan | maker | review | precommit | human | merge | abandon
spec 产出后内核自动送人审，你不会读到它。plan 让 spec-agent 为已批准的 spec 补一份工作包方案，内核校验后直接生效，不再过人审。有方案时 maker 必须点名 packages；同轮点名的包声明文件不能相交、依赖必须已 integrated。review 永远审整份代码与全部 AC；review 判 fail 的 AC 按状态表里的主责包派回对应 maker。precommit 的 tier 不得低于 reviewer 声明的。merge 只在内核事实 need_review=false 且 need_precommit=false 时被接受；人的 notes 不改变这两个值。已裁决事项里出现过的问题不得再 human，只有新事实才可以。你不能 push、不能批 spec、不能执行 git、不能改任何文件。human 时 summary 就是人看到的全部。
```

**few-shot**（记录 / 事实 → 决定）

```text
1. 记录为空；brief 含复现步骤与期望行为（「STATUS.md 里出现 /Users/<name>/…，期望落盘前替换为 ~」）
   → {"action":"maker","summary":"bugfix 有复现与期望行为，brief 即 spec，直接实现"}
   来源：task-20260802-004（$3.69，一轮 done）

2. 记录为空；brief 是新能力、跨多个文件并定义新接口（「实现 LaunchFactory/LaunchDeployer/BondingCurve…」）
   → {"action":"spec","summary":"新能力且改接口，先出 spec 交人审"}
   来源：task-20260829-001

3. r1 spec outcome=ok「AC×19；工作包 4；待决 2」；r1 human kind=spec approved notes="按 4 包做；待决 1 取 A"；
   状态表：P-001 ready，P-002/P-003 pending(deps=P-001)，P-004 pending(deps=P-002,P-003)
   → {"action":"maker","packages":["P-001"],"summary":"方案已生效，只有 P-001 就绪，先做它"}
   来源：构造（task-20260829-001 若有方案会走的路）

4. r1 human kind=spec decision=rejected notes="AC-007 与现有 Non-goal 冲突，删掉；补一条回滚路径 AC"
   → {"action":"spec","summary":"人打回 spec，按 notes 修：删 AC-007、补回滚 AC"}
   来源：构造（对应现有 reject 通道）

5. 无方案任务；r1 maker outcome=ok「AC-001..004 done；新增 test/redact.test.mjs 3 用例；npm test 41/41 绿」
   → {"action":"review","summary":"maker 报全部 AC 完成且测试绿，整体冷审"}
   来源：task-20260802-004

6. r1 reviewer outcome=fail tier=e2e「… AC-013 fail src/run.mjs:88 真实 RSS 路径无任何产物证明跑通；其余 pass」（本任务首次 review fail，无方案）
   → {"action":"maker","summary":"review 首次 fail，只修 AC-013，保持其余 AC 不动"}
   来源：task-20260801-002 verify-r1（r2 pass）

7. r2 reviewer outcome=fail「AC-013 fail src/run.mjs:88 …」与 r1 同一 AC 同一原因
   → {"action":"human","summary":"AC-013 连续两轮同一原因 fail（真实 RSS 路径无证据），maker 修不动，请裁决：放宽为 mock 验证、或人手跑一次 dry-run 留证"}
   来源：构造（第二次同因 fail 的通用规则）

8. r1 reviewer outcome=ok tier=integration head=H；事实 need_review=false need_precommit=true
   → {"action":"precommit","tier":"integration","summary":"整体 review 全 pass，reviewer 声明 integration，跑 build/service/unit+integration"}
   来源：构造

9. r1 precommit outcome=fail tier=unit「build ok；service ready 2.9s；unit 3 fail: test/parse.test.mjs › 空板块不抛错」conflict_files=[]（首次）
   → {"action":"maker","summary":"precommit 首次红在 unit，按 tail 修 test/parse.test.mjs 三条失败"}
   来源：构造（对应现有 green_gate 修复路径，17 任务零失手）

10. r1 precommit outcome=fail conflict_files=["src/index.mjs"]（合并候选与 base 冲突）
    → {"action":"human","summary":"合并候选与 base 分支在 src/index.mjs 冲突，请人处理：在 worktree 里 rebase 后 resume"}
    来源：构造（Q2：与 base 的冲突求助）

11. r1 maker product=missing truncated=yes cost=$6.20；事实：worktree 有 diff、H 已变
    → {"action":"maker","summary":"上轮撞 max-turns 无 log，worktree 已有改动；续做剩余 AC 并补 log"}
    来源：构造（契约第六条的典型场景）

12. 事实 need_review=false need_precommit=false
    → {"action":"merge","summary":"整体 review ok 与 precommit ok 均对当前 H/B，申请合并"}

13. r1 human kind=help decision=resumed notes="已在 worktree 里改好 src/index.mjs 冲突并跑过 unit"；事实：H 已变，need_review=true
    → {"action":"review","summary":"人介入后 HEAD 变化，当前版本没有整体 review，先冷审"}
    来源：构造（版本规则：notes 不豁免）

14. r2 reviewer outcome=ok tier=integration head=H；事实 need_review=false need_precommit=true（precommit 记录的 base_sha ≠ B，base 分支已前进）
    → {"action":"precommit","tier":"integration","summary":"review 对当前版本 ok，但 precommit 基线已过期，重跑"}
    来源：构造（版本规则）

15. r1 maker outcome=needs_human「spec AC-002 要求 getAmountOut 与 pons-baseline 逐位相同，但同 spec 要求溢出时不 revert，两者不可同时满足」
    → {"action":"human","summary":"maker 发现 spec 自相矛盾（AC-002 逐位相同 vs 溢出不 revert），请裁决取哪一边"}
    来源：task-20260829-001 spec-verify r1 blocker（同类矛盾）

16. 状态表：P-001 integrated；P-002 ready files=src/launch/Curve.sol,…；P-003 ready files=src/launch/Fees.sol,…（声明不相交、无互相依赖）
    → {"action":"maker","packages":["P-002","P-003"],"summary":"P-002/P-003 就绪且声明文件不相交，并行"}

17. 状态表：P-003 ready files=src/launch/Fees.sol,src/launch/Curve.sol；P-004 ready files=src/launch/Curve.sol,…（相交于 Curve.sol）
    → {"action":"maker","packages":["P-003"],"summary":"P-003 与 P-004 都声明 Curve.sol，先做 P-003，下一轮再做 P-004"}

18. 状态表：P-002 conflict note=conflict_files:src/launch/Types.sol
    → {"action":"maker","packages":["P-002"],"summary":"P-002 集成冲突在 Types.sol，在当前任务分支上重做（旧分支可参考）"}
    来源：构造（Q2：包间冲突先交 maker）

19. 状态表：四包全部 integrated；r1 reviewer outcome=fail「AC-007 fail src/launch/Curve.sol:210 …；其余 pass；note: P-002 调 P-001.createToken 少传 quoteToken」；状态表 AC-007 主责 P-002
    → {"action":"maker","packages":["P-002"],"summary":"整体 review 只有 AC-007 fail 且协作问题也在 P-002 的调用侧，重做该包"}
    来源：构造（Q10：整体审核驱动修复）

20. 已裁决事项：human kind=spec approved notes="按 4 包做，不再拆细"；状态表 P-004 acs=AC-013..019（7 条）
    → 不得 human 询问是否拆细 P-004；→ {"action":"maker","packages":["P-004"],"summary":"P-004 就绪，按已生效方案执行"}
    来源：构造（Invariant 7）

21. 无方案任务，spec 已批（AC×19）；r1 maker outcome=fail「AC-001..006 done；AC-007..019 未动，一轮做不完；forge test 全绿」
    → {"action":"plan","summary":"单 maker 一轮只完成 6/19，让 spec-agent 出工作包方案再并行"}
    来源：构造（Q15）

22. r1 spec(plan) outcome=ok「工作包 4；P-001 覆盖已完成的 AC-001..006」；状态表 P-001 ready，其余 pending
    → {"action":"maker","packages":["P-001"],"summary":"方案生效；P-001 对应已完成部分，先让 maker 补齐并集成，再解锁下游"}
    来源：构造（Q15）

坏决定（不要这样做）：
- reviewer 声明 integration 却选 {"action":"precommit","tier":"unit"}：内核会拒绝，白烧一轮。
- need_review=true 或 need_precommit=true 时选 merge：内核会拒绝。人的 notes 说「我看过了」也一样。
- 第三次派 maker 修同一条同因 fail 的 AC：第二次就该叫人。
- 对已裁决事项再次 human（「要不要拆包」「取 A 还是 B」）：只有新事实才能重新求助。
- 有方案的任务选 maker 不带 packages，或一轮点名两个声明文件相交的包：内核会拒绝。
- 因为某包越界改了别包的文件、或上游包重做过，就派 review 或 maker 去「复查」它：越界与上游变化不是问题，整体 review 才是。
```

### spec

**固定上下文**

```text
把 brief 写成 spec，用 Write 工具写到 {{spec_path}}，按下面模板。必须覆盖 brief 的全部需求，不得因规模大而只写一部分或把需求挪进 Non-goals；范围上的疑问写进「待决问题」并给 safe default。每条 AC 是可观察行为：给定什么状态、做什么、能检验什么结果。引用的文件与函数必须在仓库里真实存在，新增的标「新增」。
改动大到一个 maker 一轮做不完时，另写工作包方案到 {{packages_path}}（格式见下）：每包写目标、主责的 AC、预期修改文件、接口约定、依赖；全部包的 AC 合起来恰好等于 spec 全部 AC。
结束前用 Write 把 log 写到 {{log_path}}：
{"role":"spec","outcome":"ok|needs_human","summary":"AC 数；触及路径；工作包数；待决问题数"}
needs_human 只用于 brief 自相矛盾或无法成文；范围与拆分不是 needs_human，人会在审批时一并看到。
```

**条件段：方案模式**（`plan` 动作时整段替换上面的固定上下文）

```text
spec 已批准冻结（全文在下），不要改它。为它写工作包方案到 {{packages_path}}：每包写目标、主责的 AC、预期修改文件、接口约定、依赖；全部包的 AC 合起来必须恰好等于 spec 全部 AC，一条不多一条不少——你的工作是拆分，不是裁剪。任务分支上已有部分实现（下面的 maker 记录与 diff --stat），把已完成的部分归入对应的包，让它们能先集成。
结束前用 Write 把 log 写到 {{log_path}}：
{"role":"spec","outcome":"ok|needs_human","summary":"工作包数；哪些包覆盖已完成的 AC；依赖链"}
needs_human 只用于 spec 的 AC 无法划分（如两条 AC 互相依赖到无法分包）。
```

**模板**

```markdown
# <标题>

## Summary
<一段：改什么、为谁、为什么是现在>

## 现状
<现在的行为与相关代码流，落到文件与函数>

## Goals
- MUST …
- SHOULD …

## Non-goals
- <明确不做的、不许重设计的既有行为；不得把 brief 要求的内容放在这里>

## 契约
<触及 API / 数据 / 错误行为 / 兼容性时写；核心不变量 2–5 条>

## 验收标准
- AC-001: <给定…，当…，则…>
- AC-002: …

## 验证方式
<每条 AC 由哪个测试文件或命令证明，属于 unit / integration / e2e 哪一层>

## 工作包
<有方案时写：每包一行 id / 标题 / 主责 AC / 依赖；与 packages.json 一致。无方案时删除本节>

## 待决问题
| 问题 | safe default | 影响 |
| --- | --- | --- |
| <需要人裁决的范围、取舍、外部依赖> | <不扩大范围、可回退的默认> | <另选时改变什么> |
```

**packages.json 格式**（写进 prompt 的精简版）

```jsonc
{"schema_version":1,"packages":[{"id":"P-001","title":"…","goal":"…","acs":["AC-001"],"files":["src/…"],"interfaces":"…","depends_on":[]}]}
```

**few-shot**

```text
A. AC 写法
   坏：AC-005: 主循环收到 amountSpecified - creatorFee。
       —— 循环入参不出现在返回值、事件或存储里，验收者无法观察。（task-20260829-002 spec-verify r1）
   好：AC-005: 给定 amountSpecified=1000、creatorFeeBps=100 的 buy，返回的 amountIn 等于 1000，且 creatorFees(quote) 增加 10。

   坏：AC-003: 处理路径泄漏。
   好：AC-003: 构造含 /Users/fakeuser/logs/x.log 与真实 process.env.HOME 拼接路径的 Error message，走真实写盘管道（可注入临时目录），断言落盘产物 0 命中 /Users/ 且 HOME 实际值不出现。（task-20260802-004）

B. 事实接地
   坏：AC-003 要求验证第三方经 NonfungiblePositionManager.createAndInitializePoolIfNecessary() 建池 revert
       —— 该函数在仓库 periphery 中不存在，全仓 grep 为零。（task-20260829-002 spec-verify r1 blocker）
   好：先 Grep 确认入口存在；不存在则写「新增 createAndInitializePoolIfNecessary()」或改用仓库里真实存在的建池入口。

C. 范围与拆分
   坏：brief 覆盖 5 个核心合约 → 只写 Factory + Token 的 8 条 AC，其余挪进 Non-goals，log 报 needs_human 建议拆单。
       —— 需求被 spec 自行裁剪，人要为「做不做」再审一次，router 事后还会为拆分求助。
   坏：19 条 AC 一单交付、不给方案 → 单 maker 一轮做不完。（task-20260829-001，六轮打不平 $44 收箱）
   好：19 条 AC 全写；packages.json 给 4 包（P-001 Factory+Token AC-001..004 / P-002 Curve AC-005..009 deps=P-001 / P-003 Fees AC-010..012 deps=P-001 / P-004 Graduation AC-013..019 deps=P-002,P-003）；
       「待决问题」列「snipe 税默认值 0 还是沿用 Pons 的 50？safe default 0」；log {"outcome":"ok","summary":"AC×19；触及 src/launch/**、test/launch/**；工作包 4；待决 2"}。

D. 保护性 AC
   坏：只写新行为，不写「哪些现有行为不许变」。
   好：AC-004: 现有 mean/sum 的返回值与调用签名保持不变。

E. 工作包声明
   坏：files:["src/**"]，depends_on 空，四个包全这样写。
       —— 内核无法判断能否并行，四个包只能串行；接口约定缺失，下游包只能猜。
   好：files 精确到文件；interfaces 写「P-001 暴露 ILaunchFactory.createToken(LaunchParams) returns (address token, address curve)；P-002 只依赖此签名」；depends_on 只列真实依赖。

F. 方案模式（plan）
   坏：看到任务分支已实现 AC-001..006，就把方案写成只覆盖 AC-007..019 的 3 包。
       —— AC 集合与冻结 spec 不等，内核拒绝生效；已完成部分也需要一个包来集成。
   好：4 包覆盖全部 19 条；P-001 主责 AC-001..006 并在 goal 写「任务分支已实现，补测试与遗漏后集成」；其余按依赖排。
       log {"outcome":"ok","summary":"工作包 4；P-001 覆盖已完成的 AC-001..006；P-002/P-003 依赖 P-001，P-004 依赖 P-002/P-003"}

G. log summary
   好：AC×19；触及 src/launch/**、test/launch/**；工作包 4；待决 2
   坏：已完成 spec 撰写，涵盖全部需求，请审阅。
       —— router 不知道规模、位置、是否有方案，等于没写。
```

### maker

**固定上下文**

```text
在当前 worktree 实现下面 {{spec 或 brief}} 中你负责的全部 AC，让 `{{testCommand}}` 全绿。不许删除、跳过或削弱既有测试；新行为要有在旧代码上会失败的测试。破坏性 git 操作会被拦截，恢复单个文件用 git show HEAD:<path> > <path>。
结束前用 Write 把 log 写到 {{log_path}}：
{"role":"maker","outcome":"ok|fail|needs_human","summary":"实现了哪些 AC；加了什么测试；测试结果；未完成的 AC"}
```

**条件段**（内核按情形拼入，可叠加）

```text
[人审补充约束] {{spec 闸 human notes 原文}}

[工作包] 本轮只做 {{P-xxx}}「{{title}}」：{{goal}}
  主责 AC：{{acs}}（spec 全文在下，其余 AC 由其他包负责，不要做）
  预期修改：{{files}}
  接口约定：{{interfaces}}
  同时进行中的其他包及其声明文件：{{并行包 files}}——改到这些文件时集成阶段会合并；确有需要就改，并在 summary 写明文件与原因。
  {{若为重做}} 整体 review 对本包 AC 的判决：{{fail 行与 note 行}}；{{若 conflict}} 上一轮集成冲突：{{conflict_files}}，旧分支 task/<id>--P-xxx 保留，可 git diff task/<id>...task/<id>--P-xxx 参考。

[修复轮] 只修下面记录指出的问题，已通过的 AC 不动：
{{最近一条 reviewer 记录的 summary，或 precommit 记录的失败步骤 tail}}

[无 spec] brief 即 spec：先写一个在当前代码上失败的复现测试，再修到绿。
```

**few-shot**

```text
A. 测试钉住行为
   坏：assert(mockFetch.calledOnce)
       —— 只证明调用发生；把实现换成空函数照样绿。
   好：assert.equal(parseStatus(readFileSync('data/snapshot/STATUS.md','utf8')).block, 25657439)
       —— 用真实输入断言真实输出，旧代码上会失败。（task-20260801-003 AC-003）

B. 改动范围
   坏：修 AC-002 时顺手重写相邻模块的错误处理并改了 3 个无关测试。
   好：diff 里每个 hunk 都能指向一条 AC；风格、命名对齐仓库现状。

C. 何时 needs_human
   坏：spec 与仓库现实冲突时自己换一个方向实现。
   好：outcome=needs_human，summary 写清冲突点（「AC-002 要求逐位相同，AC-004 要求溢出不 revert，pons 基线溢出即 revert，二者不可同时满足」），不动方向。（task-20260829-001 同类矛盾）

D. 工作包内的越界修改
   坏：做 P-001 时需要 Curve.sol 一个 getter，因为 Curve.sol 是 P-002 的文件就绕道复制一份逻辑到 Factory.sol。
   好：直接在 Curve.sol 加那个 view getter，summary 写「AC-003 需要 Curve.sol 新增 view creatorFeeBps()，3 行」——内核只记录 undeclared_files，集成时按 git 合并，质量由整体 review 判。

E. log summary
   好：AC-001..004 done；新增 test/redact.test.mjs 3 用例；npm test 41/41 绿
   好：AC-001..006 done；AC-007..019 未动，一轮做不完；forge test 88/88 绿
       —— 「未完成的 AC」让 router 能判断该 plan 还是再派一轮。
   坏：实现完成，所有测试通过。
       —— router 不知道哪几条 AC、加了什么测试、绿了多少。
```

### reviewer

**固定上下文**

```text
冷读下面的 {{spec 或 brief}} 与 diff（整份任务分支相对 base）。不跑测试，不改代码。逐条 AC 判 pass 或 fail，fail 必须带 文件:行号；同时判断测试是否钉住该 AC。声明本次 diff 触及的最高测试层级 tier。
有工作包接口约定时，另检查包与包之间的协作：调用签名、事件、返回值是否与约定一致，不一致记在相关 AC 的 fail 行，或以 note: 开头的独立行。文件边界不是判据：某包改了别包声明的文件不算问题，只看行为。
用 Write 增量写 {{log_path}}：判完一条就重写整份 JSON；未判完时 outcome=fail 且 summary 末行写「未判: AC-…」；全部 AC pass 才 ok。
{"role":"reviewer","outcome":"ok|fail","tier":"unit|integration|e2e","summary":"AC-001 pass\nAC-002 fail src/x.mjs:40 <原因>\nnote: <协作问题>"}
无 spec 时按 brief 的目标与验收线索逐条判，编号 B-001…。
```

**条件段**

```text
[人审补充约束] {{spec 闸 human notes 原文}}

[工作包接口约定] {{每包一行：P-xxx title — interfaces}}
```

**few-shot**

```text
A. tier 判定
   unit：改动只在 lib/redact.mjs 一个纯函数及其测试；没有跨模块调用、没有 I/O 边界变化。
   integration：改了 LaunchFactory.createToken 的签名且 Router.sol 调用它；或新增 DB 列 / 改了对外部 HTTP 客户端的调用参数。
   e2e：改了从 CLI 入口到落盘报告的整条流程，或 AC 本身要求「跑 npm run dry 命中真实 RSS 并生成含第 4 板块的报告」。（task-20260801-002 AC-013）
   规则：取本次 diff 触及的最高一层；拿不准时取高一层。

B. 证明力
   坏：AC 声明「fetch 超时后进入 degraded」，测试把 fetch 换成立即 resolve 的 mock，永远走不到超时分支 → AC fail，写出测试文件行号。
   好：测试注入 1ms 超时的假服务，用 AbortController 触发中止，断言状态为 degraded。（task-20260801-003 AC-005/006）

C. fail 写法
   好：AC-006 fail src/fetch.mjs:12 未设置超时；test/fetch.test.mjs:30 只断言成功路径
   坏：AC-006 fail 超时处理不完善
       —— maker 拿到这句无法定位，等于没审。

D. 无法判定
   坏：status=unknown（旧契约）。
   好：fail，原因写「静态证据不足：reports/ 下无任何含融资板块的产物」并给出你查过的路径。（task-20260801-002 verify-r1 AC-013）

E. 「保持不变」类 AC
   坏：diff 里没出现该路径就 pass。
   好：追到调用链确认语义未变；若 diff 削弱、删除或跳过了钉住该 AC 的测试，不能仅凭实现代码 pass。

F. 包间协作
   坏：因为 P-002 改了 P-001 声明的 Types.sol 就判 P-001 的 AC fail。
   好：只看行为：P-002 调用 createToken 时少传 quoteToken 导致 P-001 的 AC-002「返回的 curve 绑定正确 quote」在协作路径上不成立 → AC-002 fail src/launch/Curve.sol:88，并加一行 note: 接口约定要求传 quoteToken。

G. log summary（增量示例：判到第 3 条时的文件内容）
   {"role":"reviewer","outcome":"fail","tier":"integration","summary":"AC-001 pass\nAC-002 pass\nAC-003 fail src/launch/Curve.sol:412 sweep 未扣 pendingCreatorFee；test/launch/Sweep.t.sol:57 断言了错误的期望值\n未判: AC-004, AC-005"}
```

## Acceptance Criteria

编号自实现开始后不重排；新增用新编号追加。AC-001–030 为首稿编号、AC-031–045 为 v2 编号，v3 修订处文字已更新（AC-038 / 039 语义反转，编号保留）；AC-046 起为 v3 新增。

**A. 状态机与内核**

- AC-001: `STAGES` 只含 `ROUTING`、`AWAIT_HUMAN`、`FAILED_BOX`、`DONE`；`new --title --brief [--repo] [--base-branch]` 创建的任务处于 `ROUTING`，`runtime.json` 含 `spec_approved`、`plan_active`、`plan_source`、`awaiting`，不含任何 miss / inval / epoch 计数字段；queue 中出现遗留 stage 名的任务被跳过并打印警告，不抛错。
- AC-002: `ROUTING` handler 每轮：用 brief + 记录列表 + 内核事实（含 `H`、`B`、`need_review`、`need_precommit`、已裁决事项、工作包状态表与每条 AC 的主责包）拼装 router prompt，以 `--tools Write` 与只允许写 `router-r<n>.log.json` 的 PreToolUse 白名单 spawn router；读取其 log，`action` 在闭集内且前置满足时执行该动作；每轮追加 timeline 与事件 `router_decision{action, tier, packages, summary}`。
- AC-003: 前置校验按「router 动作闭集」表执行：`merge` 在 `need_review=true` 或 `need_precommit=true` 时被拒；`precommit` 在不存在 `head_sha=H` 的 reviewer 记录、或 `tier` 低于该记录时被拒；`review` 在任务分支无 diff 时被拒；`plan` 在 `spec_approved=false` 或 `plan_active=true` 时被拒；`maker` 的包相关前置见 AC-035。被拒不产生副作用，写事件 `action_rejected{reason}`，下一轮 router 的内核事实段包含该原因。
- AC-004: router 记录 `product ≠ ok` 或动作被拒各计一次失效；连续 2 次失效 → `AWAIT_HUMAN(help, requested_by: "kernel")`，`human-r<n>.json.summary` 含两次失效原因；任一次成功决策把连击清零。
- AC-005: 内核自行发起的 stage 转移只有：spec（含可选方案）通过校验 → `AWAIT_HUMAN(spec)`；merge 批准 → `DONE`；限额 → `FAILED_BOX(rate_limited)`；保险丝 → `FAILED_BOX(fuse_no_progress)`；预算 → `FAILED_BOX(budget_exhausted)`；router 失效连击 → `AWAIT_HUMAN(help)`。单测枚举 `transitionState` 的全部调用点与之一致；`plan` 生效不产生 stage 转移。
- AC-006: 仓库内没有任何代码路径执行 `git push`（静态 grep 测试覆盖 `conductor/`、`tools/`、`.claude/`）；router 的工具集不含 Bash，maker 的 git 护栏对 `push` 及其变体继续 exit 2。

**B. 执行 log 契约**

- AC-007: 每个 agent prompt 含其 log 的绝对路径；`conductor/lib/log-contract.mjs::validateLog(obj, role, ctx)` 按 §执行 log 契约 校验：`role` 必须等于期望角色（方案模式仍为 `spec`）；`outcome` 取值按角色限定；`tier` 仅 reviewer 必填、router 选 `precommit` 时必填、其余角色出现即非法；`action` 仅 router 必填且 ∈ {spec, plan, maker, review, precommit, human, merge, abandon}；`packages` 仅 router 可出现，且仅当 `ctx.planActive=true ∧ action=maker` 时合法且必填，元素匹配 `^P-\d{3}$`；`summary` 非空且 ≤ 2000 字符；未知字段非法。
- AC-008: Stop hook `conductor/hooks/check-log.mjs --log <p> --role <r> [--has-plan] --report <p>`：文件缺失或 `validateLog` 不通过 → exit 2，stderr 列出错误；stdin `stop_hook_active=true` → exit 0；无论结果都写 `<role>[-P-xxx]-r<n>.log.hook.json`（ok、errors、blocked、stop_hook_active）。
- AC-009: 记录合成 `conductor/lib/records.mjs::composeRecords(cfg, id)`：对每个 spawn 记录合成一条记录；log 文件不存在 → `product: "missing"`，非法 → `product: "invalid"` 且 `product_error` 为校验错误；`cost_usd`、`truncated`、`duration_ms`、`session_id`、`package`、`mode`、`head_sha`、`base_sha` 来自 spawn 记录；合成过程不写任何文件；`product ≠ ok` 不触发任何自动 spawn（AC-004 的 router 例外除外）。
- AC-010: reviewer 增量协议：fake-claude 场景中 reviewer 在写出含「未判: AC-004, AC-005」的合法 JSON 后被截断（撞 max-turns）→ 记录 `product: ok`、`outcome: fail`、`truncated: true`，summary 含该未判清单；router prompt 中该记录完整可见；`need_review` 保持 true。
- AC-011: precommit 记录 `precommit-r<n>.json` 通过 `validateLog(obj, "precommit")` 的同构校验（`role: "precommit"`, `outcome ∈ ok|fail`, `tier` 必填, `summary` 非空, `cost_usd: 0`），并含 `base_sha`、`head_sha`、`candidate_sha`、`steps[]`（每项 `step ∈ build|service|unit|integration|e2e`、`status ∈ ok|fail|skipped|not_run`、`command`、`exit_code`、`timed_out`、`duration_ms`、`tail`，service 项另含 `ready_ms`、`pid`、`stopped`）、`skipped_tiers`、`conflict_files`。

**C. 人闸**

- AC-012: 任何 `AWAIT_HUMAN` 进入时写 `dossier/<id>/human-r<n>.json{kind, requested_by, summary, refs}`，`kind ∈ {spec, merge, help}`，spec 闸的 `refs` 含 `specs/<id>.md` 与（存在时）`specs/<id>.packages.json`；`runtime.awaiting = {kind, round}`；离开时置 null 并把人的裁决作为 `role: "human"` 记录进入记录列表（decision ∈ approved | rejected | resumed，notes 原文，`no_packages` 布尔）。
- AC-013: `spec` 动作结束后：`specs/<id>.md` 通过 `validateSpecDoc` 且（若存在 `specs/<id>.packages.json`）以该 spec 的 AC 集通过 `validatePackages` → `AWAIT_HUMAN(spec)`，与 spec log 的 outcome 无关；任一不通过 → 事件 `spec_invalid{errors}`，停留 ROUTING，不开人闸。`approve` → 冻结 spec 到 `dossier/<id>/spec.md`、有方案且无 `--no-packages` 时再次校验 AC 集相等后冻结方案到 `dossier/<id>/packages.json` 并初始化 `packages-status.json`（无依赖的包 `ready`，其余 `pending`）、`spec_approved=true`、`plan_active` 与 `plan_source=spec` 按情形置位、回 ROUTING；`reject --notes` → 回 ROUTING，notes 进记录。
- AC-014: merge 批准：`need_review=true` 或 `need_precommit=true`（Invariant 6，按批准时刻的 H 与 B 重新计算）→ 拒绝，事件 `main_moved` 或 `stale_review`，回 ROUTING；通过 → `mergeBranch` 以 `--message` 或默认 `task <id>: <title>` 合并到 base 分支，删任务分支、全部包分支与 worktree，→ DONE；过程中不调用 `git push`。
- AC-015: `resume <id> [--notes]` 只在 `AWAIT_HUMAN(help)` 可用：写事件 `human_intervened{notes}`、human 记录 decision=resumed，→ ROUTING；对其他 stage 报错退出。`resume` 不创建、不修改任何 reviewer / precommit 记录；集成测试：人在 help 闸期间向任务分支追加 commit 并 `resume --notes "已验证"` 后，router 选 `merge` 被拒（`need_review=true`），依次完成整体 `review` 与 `precommit` 后 `merge` 才被接受。
- AC-016: 对 `spec_approved=true` 的任务，`maker`、`reviewer` 与方案模式 `spec` 的 prompt 使用 `dossier/<id>/spec.md` 冻结稿，并逐字注入 spec 闸 human 记录的 notes 为「人审补充约束」段；无 spec 的任务 maker / reviewer 以 brief 为契约且无该段。

**D. precommit**

- AC-017: `precommit` 动作在 `worktrees/<id>.precommit`（detached @ B）上 `git merge --no-ff` 任务分支；成功则依次执行 build、service、测试三步（见 AC-048–051）；冲突则 `merge --abort`、记录 `conflict_files`、`outcome: fail`、三步全部 `not_run`；无论结果候选 worktree 在结束时不存在。
- AC-018: 测试步层级累加：`unit` 只跑 `precommit.unit`；`integration` 跑 `unit` + `integration`；`e2e` 跑三层；`precommit.unit` 缺省回落 task `testCommand`；其余层缺省记入 `skipped_tiers` 且不影响已执行命令的裁决；任一已执行命令 exit ≠ 0 或超时（`precommitStepTimeoutMs`）→ `fail`，同层后续命令 `not_run`；`tail` 长度 ≤ `greenGateOutputTailBytes`。
- AC-019: `new` 在目标仓 `target-profiles/<repo>/setup-profile.json` 缺失、无 `precommit` 段、或 `precommit.unit` 与 `testCommand` 皆缺时失败，stderr 含包含 `build`、`service`、`unit`、`integration`、`e2e` 全部键并注明可删项的样例；配置齐全时任务可创建。

**E. 限额**

- AC-020: `runClaudeStream` 返回值含 `rate_limit: {type, resets_at, status}`，取自 stream 中最后一条 `type: "rate_limit_event"` 且 `status: "rejected"` 的事件；无此事件为 null。瞬态重试封装遇 `rate_limit.status === "rejected"` 时不做任何重试，返回 `rate_limited: true`；其余瞬态状态退避阶梯为 15s / 30s / 60s 三档。
- AC-021: 任一 spawn 返回 `rate_limited` → 该任务 `FAILED_BOX`，`last_failure_type: "rate_limited"`，`runtime.rate_limit = {type, resets_at, hit_at, resume_stage: "ROUTING"}`，事件 `rate_limited`；同一次 `run` 内其余任务不再发起 spawn，各自 timeline 记 `spawn skipped: rate limited until <iso>` 且 stage 不变。
- AC-022: `retry <id>` 对 `rate_limited` 任务：`now < resets_at` → exit 非 0，stdout 含本地时间的重置时刻，状态不变，`--force` 可越过；`now ≥ resets_at` → 回 `ROUTING`，`current_round` 不变，无产物归档；`retry --rate-limited` 对全部此类任务执行同一逻辑。
- AC-023: 在 `resets_at` 已过的前提下连续执行两次 `run`，`rate_limited` 任务仍在 FAILED_BOX；dashboard 的 auto-run 与 `tools/alerts-scan.mjs` 都不会移动它。dashboard 卡片显示重置时刻，`now ≥ resets_at` 前「恢复」按钮 disabled。

**F. 保险丝**

- AC-024: `fuseStreak`（默认 3）：同一 `(role, package)` 连续 N 条记录签名相同 → `FAILED_BOX(fuse_no_progress)`，事件 `fuse_tripped{role, package, signature}`；`retry` 回 ROUTING；`fuseStreak: 0` 时任何连击都不收箱。签名：precommit 为失败步骤名 + 命令 + `buildSignature(tail)`；reviewer 为 `tier` + 排序 fail AC 编号 + 各 fail 首行；maker 为 `(package, outcome, summary 首行)`。

**G. 角色、工具、hook、模型**

- AC-025: 各角色的 cwd、`--tools`、PreToolUse 白名单、Stop hook、maxTurns 与 §角色表逐项一致：router 只有 `Write`；reviewer 只读三件 + `Bash(git diff|log|show:*)` + `Write`；spec 写 spec 时白名单为 spec 路径 + packages 路径 + log 路径，方案模式时**仅** packages 路径 + log 路径（对 spec 路径的 Write/Edit 被拒）；reviewer 与 router 的白名单仅 log 路径；maker 沿用 git 护栏。逐轮 `.settings.json` 落盘 dossier。
- AC-026: `agents/` 只含 `router-agent.md`、`spec-agent.md`、`maker-agent.md`、`reviewer-agent.md` 与 `fewshot/{router,spec,maker,reviewer}.md`；`conductor/lib/prompts.mjs` 拼装后不残留 `{{`；每个 prompt 含对应 log 绝对路径与「用 Write 工具」字样；maker 修复轮 prompt 含最近 reviewer 记录 summary 或 precommit 失败步骤 tail；包 maker prompt 含 `[工作包]` 段（id、title、goal、acs、files、interfaces、并行包声明文件；重做时含整体 review 对本包 AC 的 fail 行与 note 行，或 conflict_files 与旧分支参考语句）；无 spec 时含「先写一个在当前代码上失败的复现测试」段；`plan_active` 时 reviewer prompt 含 `[工作包接口约定]` 段且 AC 清单为全部 AC；方案模式 spec prompt 含冻结 spec 全文、maker 记录 summary 与 `git diff --stat`。
- AC-027: `loadCfg` 对 §config 列出的每个遗留键打印一次 `legacy config key ignored: <key>` 警告；`models` 缺键回落 `claude-opus-5`；`maxTurns` 含 `plan` 键；`maxParallelPackages` 默认 2、`maxPackages` 默认 12、`packagesEnabled` 默认 false（P3 移除）、`fuseStreak` 默认 3、`precommitStepTimeoutMs` 默认等于 `greenGateTimeoutMs`、`precommitLockTimeoutMs` 默认 1800000。

**H. 删除与兼容**

- AC-028: §删除清单中的 stage、lib、hook、agent 文件与测试从仓库移除，`decisions.mjs` 不再导出任一 miss / verdictNext / specMissNext / approvalNext 类路由谓词；`npm test` 全绿。
- AC-029: dashboard 对 `state/done|failed` 中带遗留 stage 名与遗留产物（`verify-r*.verdict.json`、`spec-verify-r*.md`、`test-gate-r*.json`）的旧任务正常渲染列表与详情，不报错；`tools/dossier-stats.mjs` 在含新旧两类 dossier 的仓库上运行成功，并统计 router 轮次、precommit 各步与 tier 分布、包数、并行轮数、`plan` 次数。
- AC-030: README 的入口表、角色表、状态流、常用命令、数据位置与 case 索引更新为本 spec 的口径；不再链接任何被删除的模块。

**I. 工作包**

- AC-031: `conductor/lib/packages.mjs::validatePackages(plan, acIds)`：`schema_version=1`；`id` 匹配 `^P-\d{3}$` 且唯一；`title` 非空 ≤ 40 字；`files` 非空字符串数组；`acs` 元素都在 `acIds` 内、全部包的 `acs` 两两不交且并集等于 `acIds`（允许某包 `acs` 为空）；`depends_on` 引用存在且无环；包数 ≤ `maxPackages`。每条规则各有失败用例。
- AC-032: `spec` 动作后 `specs/<id>.packages.json` 存在但 `validatePackages` 不通过 → 事件 `spec_invalid{errors}`，不开人闸；spec-agent 的 Stop hook 对该文件执行同一校验并在首次失败时 exit 2。
- AC-033: `approve --no-packages`：方案文件归档到 `specs/archive/`，不写 `dossier/<id>/packages.json`，`plan_active=false`、`plan_source=null`；此后 router 的 `packages` 字段出现即 `product: invalid`；maker 直接在任务分支工作，不建包分支；router 仍可在之后选 `plan`。
- AC-034: 有方案任务的 `maker packages=[…]`：对每个包在任务分支当前 HEAD 上建 `worktrees/<id>--P-xxx` 与分支 `task/<id>--P-xxx`（`returned` 包复用既有 worktree）；同时在飞的 spawn 数 ≤ `maxParallelPackages`（fake-claude 计数验证）；每包独立 `maker-P-xxx-r<n>.log.json` 与 spawn 记录（含 `package`、`base_sha`）；每包 `commitAll("task <id>: maker P-xxx r<n>")`；状态 `running` → `returned` 或进入集成。
- AC-035: 包调度前置：`packages` 中任一包状态不在 `{ready, returned, conflict, integrated}`、任一 `depends_on` 未 `integrated`、同轮包两两 `files`（glob 展开）相交、数量 > `maxParallelPackages`、`plan_active` 却未给 `packages` → `action_rejected` 并写明原因；比对只在同轮 listed 包之间进行，不引入已集成包的 `touched_files`；无方案任务出现 `packages` → log `product: invalid`。
- AC-036: 集成：同一轮返回的包按 `depends_on` 拓扑序、同层按 id 序依次 `git merge --no-ff -m "task <id>: integrate P-xxx r<n>"` 到 `task/<id>`；仅 `outcome=ok ∧ product=ok` 的包进入集成，其余置 `returned` 且分支、worktree 保留；集成成功 → `integrated`、记 `integrated_sha`、删除包 worktree、包分支保留至 DONE；事件 `package_integrated`。依赖该包的 `pending` 包在其全部依赖 `integrated` 后置 `ready`。
- AC-037: 集成冲突：`merge --abort`，状态 `conflict`，记 `conflict_files`，分支保留，同轮后续包继续尝试集成；对 `conflict` 包再次 `maker` 时内核从任务分支当前 HEAD 新建 worktree，prompt 含 `conflict_files` 与旧分支参考语句；重做结果作为新 merge 集成，历史不 revert。
- AC-038: 包 P-a 重新集成（第 2 轮及以后）不改变任何其他包的状态、不写任何「需重做」标记、不产生额外事件（仅 `package_integrated`）；`packages-status.json` 无 `stale` 取值、无 `stale_reason` / `upstream_changed` 字段；集成后依赖 P-a 的 `pending` 包按 AC-036 置 `ready`。
- AC-039: `review` 动作不接受 `packages`：router log 中 `action=review` 且含 `packages` → `product: invalid`；reviewer 记录无 `scope` 字段；`need_review` 只看 `outcome=ok ∧ head_sha=H`；`plan_active` 时 reviewer prompt 的 AC 清单为 spec 全部 AC 并附 `[工作包接口约定]` 段。
- AC-040: 每包 maker 返回后内核记录 `touched_files`（`git diff --name-only base_sha..HEAD` 于包分支）与 `undeclared_files`（touched − files 展开集）到 `packages-status.json`；存在 `undeclared_files` 的包照常进入集成（集成测试：P-001 改了 P-002 声明的文件仍 `integrated`）；router 事实段的状态表每行含 state / rounds / cost / note（`conflict_files`、`undeclared_files`），并列出每条 AC 的主责包。
- AC-041: 并行包进行中命中限额：全部在飞 spawn 以 `rate_limited` 返回，任务 → `FAILED_BOX(rate_limited)`，涉及的包置 `returned` 且记录 `product=missing`，包 worktree 保留；人 `retry` 后 router 事实段状态表显示这些包为 `returned`，再次 `maker` 复用其 worktree。
- AC-042: Invariant 7：router `human` 的 summary 与本任务任一既有 `human-r<n>.json{kind:help}` 的 summary 逐字相同 → `action_rejected{reason: duplicate_help}`；内核事实段「已裁决事项」逐条列出全部 human 记录的 kind / decision / notes 原文；集成测试：人 approve spec 并 notes「按 4 包做，不再拆细」后，fake router 连续两次以相同 summary 求助 → 第一次开闸、第二次被拒。
- AC-043: spec 闸 dashboard 页面同屏渲染 spec 全文、方案表（id / title / acs / files / depends_on）、`## 待决问题` 段与三个按钮（approve / approve --no-packages / reject）；无方案时不渲染方案表且隐藏 `--no-packages`；merge 闸页面渲染状态表与 precommit 三步结果。
- AC-044: `packagesEnabled=false` 时：spec prompt 不含工作包段与 packages 路径、白名单不放行 packages 路径、`validatePackages` 不被调用、`approve` 忽略 `--no-packages`、`plan` 动作被 `action_rejected`、router log 出现 `packages` 即 invalid；置 true 后上述全部生效。单测覆盖两种取值。
- AC-045: 任务 → DONE 或 `abandon` 时内核删除全部 `task/<id>--P-xxx` 分支与残留包 worktree、`worktrees/<id>.plan-ro`、`worktrees/<id>.precommit`；`FAILED_BOX` 保留一切以便 `retry`。

**J. plan 动作与范围锁定（v3 新增）**

- AC-046: `plan` 动作：前置 `spec_approved=true ∧ plan_active=false ∧ packagesEnabled=true`；内核在任务分支 H 建 `worktrees/<id>.plan-ro`（detached）作为 cwd，以方案模式 spawn spec-agent（白名单仅 `specs/<id>.packages.json` + log 路径，maxTurns 取 `maxTurns.plan`），prompt 含冻结 spec 全文、全部 maker 记录的 summary、`git diff --stat B...H`；返回后以冻结 spec 的 AC 集调用 `validatePackages`：通过 → 冻结到 `dossier/<id>/packages.json`、初始化状态表（依赖为空的包 `ready`）、`plan_active=true`、`plan_source=router`、事件 `plan_created`；不通过 → 事件 `plan_invalid{errors}`、无任何状态变化、停留 ROUTING；log 文件为 `spec-plan-r<n>.log.json`，记录 `mode=plan`。
- AC-047: 范围锁定（Invariant 8）：方案的 AC 并集缺少或多出任一冻结 spec 的 AC → spec 闸 `approve` 与 `plan` 动作都拒绝生效并列出差集；方案模式下对 `specs/<id>.md` 或 `dossier/<id>/spec.md` 的 Write/Edit 被白名单拒绝，`plan` 前后两文件字节不变；单测覆盖「已完成 AC 被遗漏」的方案被拒。

**K. precommit 三步（v3 新增）**

- AC-048: build 步：配置了 `precommit.build` 时在候选 worktree 执行该命令，exit 0 → `ok`，非 0 或超时（`precommitStepTimeoutMs`）→ `fail` 且 service 与测试步全部 `not_run`；未配置 → `skipped`，不影响裁决；记录含 `duration_ms` 与 `tail`。
- AC-049: service 步：配置了 `precommit.service` 时以独立进程组在候选 worktree 内启动 `start`（环境叠加 `env`），每 1 秒轮询 `ready.url`（2xx）或 `ready.command`（exit 0），在 `ready_timeout_ms` 内就绪且进程存活 → `ok` 并记 `ready_ms`；进程提前退出或超时 → `fail`（记退出码与输出 tail），测试步 `not_run`；服务在测试步期间保持运行；无论结果 finally 对进程组先 SIGTERM、`stop_grace_ms` 后 SIGKILL，记录 `stopped: true`；服务 stdout/stderr 落 `dossier/<id>/precommit-r<n>.service.log`；未配置 → `skipped`。集成测试用一个监听随机端口的假服务验证就绪、超时、崩溃与清理四条路径，结束后无残留进程。
- AC-050: precommit 全局串行：`state/.precommit.lock` 复用 `lib/lock.mjs`，锁内容含持有者 pid 与服务 pid；第二个任务的 precommit 等锁，超过 `precommitLockTimeoutMs` → `outcome: fail`、`steps` 全部 `not_run`、summary 为 `lock_timeout`，router 可直接重试；持有者进程已死的残锁被接管，接管时若锁内服务 pid 仍存活则先终止它。
- AC-051: 步骤语义：三步顺序固定 build → service → 测试；第一个适用且失败的步骤使 `outcome=fail`，其后步骤 `not_run`；全部适用步骤 `ok` → `outcome=ok`；`summary` 形如 `build ok 42s；service ready 3.1s；unit 41/41 ok；integration 2 fail: <首行>`，每个 `skipped` 步以 `<step> skipped` 出现；只有 `unit` 且无 build / service 的仓库，precommit 行为等价于跑一次 `unit` 命令。

**L. 模型可用性（v3 新增）**

- AC-052: `run` 启动时对 `models` 中每个未缓存的模型 id 做一次探测（`--max-turns 1`、无工具、提示词「reply ok」），结果按 `模型 id + claude 二进制版本` 写入 `state/.model-probe.json`；探测返回模型不存在/不可用类错误 → 本次 `run` 在处理任何任务前终止，stderr 列出不可用 id，任务状态零变化；探测撞限额 → 终止本次 `run` 并打印重置时刻，任务状态零变化；缓存命中不再探测。

## Implementation Notes

| 区域 | 文件 | 说明 |
| --- | --- | --- |
| log 契约 | `conductor/lib/log-contract.mjs`（新） | `validateLog(obj, role, ctx)`、`LOG_ROLES`、`ACTIONS`、`TIERS`、`PACKAGE_ID_RE`；零 IO 纯函数 |
| Stop hook | `conductor/hooks/check-log.mjs`（新） | 骨架照抄 `check-spec.mjs`；spec-agent 同时挂 check-spec（扩展校验 packages）与 check-log；方案模式只挂 packages 校验 + check-log |
| 写白名单 | `conductor/hooks/write-guard.mjs`（`spec-write-guard.mjs` 泛化，支持多个 `--allow`） | router / reviewer 只放 log 路径；spec 放 spec + packages + log；方案模式放 packages + log |
| 记录合成 | `conductor/lib/records.mjs`（新） | `composeRecords`、`renderRecordsForRouter`、`renderFacts`（已裁决事项、状态表、AC → 主责包）；dashboard 复用 |
| 版本规则 | `conductor/lib/version-gate.mjs`（新） | `needReview(records, H)`、`needPrecommit(records, H, B)` 纯函数；ROUTING 前置、merge 批准、事实段三处共用 |
| 工作包 | `conductor/lib/packages.mjs`（新） | `validatePackages`、`expandFiles(globs, repoFiles)`、`filesOverlap`、`topoOrder`、`readyPackages`、`primaryPackageOf(acId)`；状态表读写 |
| 集成 | `conductor/lib/integration.mjs`（新） | `integratePackage(repo, taskBranch, pkgBranch, message)` → `{ok, sha}` 或 `{conflict_files}`；复用 `git.mjs` |
| 限额 | `conductor/lib/claude.mjs` | 解析 `rate_limit_event`；重试封装短路；阶梯 15/30/60 |
| precommit | `conductor/lib/precommit.mjs`（新） | 候选 worktree、build 步、service 步（进程组启动 / 就绪轮询 / 清理）、测试步层级累加、全局锁、记录合成；复用 `runGreenGate` 跑单条命令 |
| 模型探测 | `conductor/lib/model-probe.mjs`（新） | 探测 + 缓存；`cmdRun` 开头调用 |
| 保险丝 | `conductor/lib/fuse.mjs`（新） | 复用 `failure-signature.mjs::buildSignature`；按 `(role, package)` 分组 |
| prompt | `conductor/lib/prompts.mjs`（新）、`agents/*.md`、`agents/fewshot/*.md` | 四个 builder + 条件段（人审补充约束 / 工作包 / 修复轮 / 无 spec / 方案模式 / 工作包接口约定）；其余 builder 删除 |
| stage | `conductor/stages/routing.mjs`、`await_human.mjs`、`actions/{spec,plan,maker,review,precommit}.mjs`（新） | `actions/maker.mjs` 含并发信号量、逐包 commit、拓扑序集成；`actions/plan.mjs` 建 plan-ro worktree 与方案模式 spawn；`shared.mjs` 保留 spawn 记录、成本、worktree、settings 生成 |
| 路由谓词 | `conductor/stages/decisions.mjs` | 只留 `STAGES`、`overBudget`、`parseNumstat`、`parseStrictJson`；其余删除 |
| CLI | `conductor/conductor.mjs` | 动词收敛：`new run approve reject resume retry abandon status spy`；`approve` 增 `--notes --no-packages --message`；删除 `approve-setup/approve-feasibility/reject-feasibility/approve-scope/reject-scope/merge/close` |
| dashboard | `conductor/dashboard/{server,model}.mjs`、`static/*` | 看板按四个 stage 分列；通用人闸页（spec 闸含方案表与待决问题，merge 闸含状态表与 precommit 三步）；限额恢复按钮；记录列表复用 `records.mjs` |
| profile | `target-profiles/<repo>/setup-profile.json` | 新增 `precommit: {build?, service?, unit, integration?, e2e?}` 段；`new` 校验 |
| 测试夹具 | `tests/fixtures/fake-claude.mjs`、`tests/fixtures/fake-service.mjs`（新） | fake-claude 新增 action：`writeLog`、`rateLimit`、`truncateAfterWrite`、`touchFiles`、并发计数探针；fake-service 提供可配置的就绪延迟 / 崩溃 / 永不就绪三种模式 |

沿用不动：`lib/state.mjs`、`lib/git.mjs`、`lib/lock.mjs`、`lib/task-lock.mjs`、`lib/scheduler.mjs`、`lib/spec-contract.mjs`、`hooks/maker-git-guard.mjs`。

### 删除清单

| 类别 | 删除 | 改写 | 保留 |
| --- | --- | --- | --- |
| agents | `committer-agent.md`、`feasibility-agent.md`、`setup-agent.md`、`spec-verifier-agent.md`、`verifier-agent.md`、`_weak-model-addendum.md` | `spec-agent.md`、`maker-agent.md`、`reviewer-agent.md`；新增 `router-agent.md`、`fewshot/*` | — |
| stages | `await_feasibility_approval`、`await_setup_approval`、`await_spec_approval`、`fixing`、`needs_feasibility`、`needs_spec`、`needs_target_setup`、`ready`、`spec_fixing`、`spec_verify`、`verify` | `shared.mjs`（瘦身）、`decisions.mjs`（只留四个导出） | — |
| lib | `codex.mjs`、`test-gate.mjs`、`feasibility-contract.mjs`、`task-cfg.mjs`（并入 precommit 读取） | `claude.mjs`、`profile.mjs`（读 `precommit` 段） | `state`、`git`、`lock`、`task-lock`、`scheduler`、`spec-contract`、`failure-signature` |
| hooks | `check-feasibility.mjs` | `spec-write-guard.mjs` → `write-guard.mjs`；`check-spec.mjs` 增 packages 校验 | `maker-git-guard.mjs` |
| 集成测试 | `auto-approve-spec`、`auto-merge`、`crash-auto-recovery`、`feasibility-flow`、`gate-commands`、`maker-max-turns-continuation`、`probe-chain`、`resume-transient-recovery`、`retry-ladder`、`retry-protocol-exhausted`、`review-shadow`、`setup-race`、`setup-spec-loop`、`spec-scale-gate`、`spec-scope-escalation`、`test-gate`、`test-gate-per-ac`、`test-gate-probe-concurrency`、`verifier-evidence-anchors`、`verifier-invalid`、`verifier-shadow`、`verifier-test-change-guard` | `feature-flow` → `router-flow`、`happy-path`、`verifier-fail` → `reviewer-fail`、`verifier-diff-cap` → `reviewer-diff-cap`、`verify-infra-failure` → `spawn-infra-failure`、`crash-reentry`、`crash-patrol`、`failure-signature-streak` → `fuse`、`spec-contract-gate`、`spec-chain-isolation`、`approve-spec-contract-guard`、`merge-branch-guard`、`transient-retry`、`budget`、`dashboard-server` | `lock`、`parallel-scheduling`、`cli-task-lock-spy`、`worktree-*`、`task-scoped-target-repo`、`events-log`、`liveness-kill`、`green-gate*`、`node-version-warning`、`spawn-deterministic-failure`、`unknown-spawn-cost`、`maker-git-guard` |
| 单元测试 | `codex`、`feasibility-contract`、`automerge`、`output-discipline`、`commit-message`（两处） | `decisions`、`shared`、`hooks`、`dossier-stats*`、`dashboard-*` | `claude`、`lock`、`scheduler`、`failure-signature*`、`profile-per-task`、`role-cost-estimate`、`deterministic-spawn-cost`、`alerts-scan` |
| 新增测试 | — | — | `unit/log-contract`、`unit/check-log-hook`、`unit/records`、`unit/version-gate`、`unit/packages`、`unit/prompts`、`unit/precommit-steps`、`unit/fuse`、`unit/model-probe`；`integration/router-flow`、`router-preconditions`、`human-gates`、`version-gate`、`one-decision`、`precommit`、`precommit-service`、`precommit-lock`、`rate-limit-box`、`fuse`、`reviewer-truncation`、`packages-parallel`、`packages-conflict-redo`、`packages-no-plan`、`plan-action`、`model-probe`、`no-push-grep`、`legacy-compat`、`cleanup` |

### 分阶段与代价（每阶段一组 PR，按 conductor-infra-fix-mode 直派）

| 阶段 | 内容 | 覆盖 AC | 边界与代价 |
| --- | --- | --- | --- |
| P0 | 限额处理，在现有状态机上先落地 | AC-020–023 | 独立于重构，立刻止血；`retry` 语义在旧状态机下回到 `resume_stage` 记录的原 stage |
| P1 | log 契约、check-log hook、write-guard、records 合成、version-gate、prompts.mjs 与四份 prompt/few-shot、fake-claude / fake-service 夹具 | AC-007–011、AC-025–026 | 纯新增，不动旧 stage；工作包与方案模式条件段随 P1 写好但 `packagesEnabled=false` 时不注入 |
| P2 | ROUTING / AWAIT_HUMAN / actions（单 maker 路径）/ precommit 三步 + 全局锁 / 模型探测 / 保险丝 / CLI / dashboard | AC-001–006、AC-012–019、AC-024、AC-027、AC-042、AC-045、AC-048–052 | 新状态机接管 `new`；`packagesEnabled=false`；旧 stage handler 仍注册以让旧 queue 任务跑完。precommit 三步与 service 清理是本阶段最大的新增面（约 300 行 + 3 个集成测试） |
| P2b | 工作包：`packages.mjs`、`integration.mjs`、`actions/maker.mjs` 并发与集成、`actions/plan.mjs`、状态表、spec 闸方案页、`--no-packages` | AC-031–041、AC-043–044、AC-046–047 | **在 P2 全绿且至少一个真实单 maker 任务走完后开始。** 估算新增：lib 约 350 行、actions 约 300 行、dashboard 约 150 行、测试 5 个集成文件 + 2 个单元文件；相当于 P2 工作量的 35–45%。风险面：并发 spawn 与 task lock 的交互、glob 展开的准确性、merge 语义（rename / 二进制）、限额中断时的包状态一致性、方案模式对已完成工作的归包 |
| P3 | 删除清单、测试清理、README、dossier-stats、移除 `packagesEnabled` | AC-028–030 | 需 queue 为空 |

## Edge Cases

| 情形 | 期望行为 |
| --- | --- |
| agent 撞 max-turns，未写 log | 记录 `product: missing`、`truncated: true`、`cost_usd` 为实际值；router 决定（few-shot 11） |
| log 是合法 JSON 但 `role` 与派出角色不符 | `product: invalid`，错误写「role 不匹配」 |
| router log 合法但 `action` 不在闭集 | Stop hook 已拦一次；仍非法则 `product: invalid`，计一次失效 |
| router 连续 2 次失效 | `AWAIT_HUMAN(help, requested_by: kernel)`，summary 列两次原因 |
| `spec` 动作后文件存在但无 `## 验收标准`，或 packages.json 不构成 AC 划分 | `spec_invalid` 事实，停留 ROUTING，不开人闸 |
| 人 reject spec 后 router 又选 `maker` | 前置「曾产出 spec 则必须已批准」不满足 → `action_rejected` |
| 人 approve spec 并给 notes，随后 router 想再问同一问题 | 逐字相同 → `duplicate_help` 拒绝；措辞不同但同一事项 → 由 few-shot 20 约束，事实段已列已裁决事项 |
| precommit 期间 base 分支被人推进 | 记录的 `base_sha` 为旧值；`need_precommit` 变 true；router 选 `merge` 被拒，重跑 precommit；已进 merge 闸的任务在 approve 时同样被拒回 ROUTING |
| 人在 help 闸期间直接改了任务分支并 commit，`resume --notes "已看过"` | H 变化 → `need_review=true`；必须整体 `review` → `precommit` → `merge`；notes 只进记录 |
| 合并候选与 base 冲突 | `outcome: fail`、`conflict_files` 非空、三步 `not_run`；router 依 few-shot 10 求助 |
| 包集成冲突 | 状态 `conflict`，分支保留；router 依 few-shot 18 先交 maker 重做 |
| maker 触及未声明文件 | 记 `undeclared_files`，照常集成；不撤销、不重审、不阻塞后续调度；质量由整体 review 与 precommit 判 |
| 同轮两个包声明文件相交 | router 同轮点名 → `action_rejected`；分轮串行 |
| 上游包重做并再集成，下游包已 integrated | 下游状态不变、无事件、无重做要求；整体 review 若发现协作问题，router 把 fail AC 派回主责包（few-shot 19） |
| 整体 review 只 fail 某包的 AC | router 重做该包；其他包状态不变；再集成后 `need_review` 自动为 true |
| 整体 review 的 fail 落在两个包的协作路径上 | router 依 fail 行的主责包与 note 行判断交一包或分轮交两包；内核不介入 |
| 单 maker 任务一轮做不完 | maker 记录写「未完成的 AC」；router 选 `plan`（few-shot 21）；方案生效后已完成工作留在任务分支作为起点 |
| `plan` 产出的方案漏掉已完成的 AC | `validatePackages` 差集非空 → `plan_invalid`，状态零变化；router 可再 `plan` 或 `human` |
| `plan` 前置不满足（spec 未批 / 已有方案 / 阶段闸关） | `action_rejected`，计一次失效 |
| 方案模式 spec-agent 试图改 spec.md | 白名单拒绝；spec 字节不变 |
| profile 只有 `unit`，reviewer 声明 `e2e` | build / service `skipped`；跑 `unit`，`skipped_tiers: ["integration","e2e"]`，summary 注明；裁决只看已执行步骤 |
| build 失败 | `outcome: fail`，service 与测试 `not_run`；router 通常派 maker 带 build tail |
| 服务启动后在 ready 前崩溃 | service `fail`，记退出码与 tail，测试 `not_run`；进程组清理照常 |
| 服务就绪后测试期间崩溃 | 测试命令自身失败 → 对应 tier `fail`；finally 清理仍执行并记 `stopped` |
| 两个任务同时到 precommit | 第二个等 `state/.precommit.lock`；超过 `precommitLockTimeoutMs` → `lock_timeout` fail，router 可重试 |
| conductor 进程在 precommit 中被杀 | 残锁在下次 `run` 被接管；锁内服务 pid 存活则先终止；候选 worktree 由 `run` 启动清理 |
| 配置的模型 id 不可用 | `run` 启动探测失败，终止本次 run 并列出 id；任务零变化 |
| 五小时限额在并行包进行中命中 | 全部在飞 spawn 退出；任务 `FAILED_BOX(rate_limited)`；包置 `returned`，worktree 保留；恢复后 router 再派 |
| 三个并发任务同时命中限额 | 三个都进 FAILED_BOX，各带同一 `resets_at`；`retry --rate-limited` 一次恢复 |
| `retry` 早于 `resets_at` | 拒绝并打印本地重置时刻；`--force` 越过 |
| 保险丝触发后人 `retry` | 回 ROUTING，连击计数从零开始 |
| 任务预算耗尽（含全部包成本） | `FAILED_BOX(budget_exhausted)`；人 `retry` 需先调高 `budgetUsd` |
| `packagesEnabled=false` 时 spec-agent 仍写了 packages.json | 白名单拒绝写入；若绕过（旧文件残留），`new` 拒绝创建；`plan` 被拒 |
| 旧 dossier（verify-r*.verdict.json 等） | dashboard 与 dossier-stats 只读渲染，不参与新记录合成 |

## Verification Plan

- 单元：`tests/unit/log-contract.test.mjs`（AC-007）、`check-log-hook.test.mjs`（AC-008）、`records.test.mjs`（AC-009、AC-040 的状态表与主责包渲染）、`version-gate.test.mjs`（AC-003 / 014 的纯函数面）、`packages.test.mjs`（AC-031、035 的重叠与拓扑、047 的差集）、`prompts.test.mjs`（AC-026）、`precommit-steps.test.mjs`（AC-018、051 的顺序 / not_run / skipped 语义）、`fuse.test.mjs`（AC-024 签名）、`model-probe.test.mjs`（AC-052 缓存键与错误分类）、`decisions.test.mjs`（AC-005 转移点枚举、AC-028 导出面）、`claude.test.mjs`（AC-020）。
- 集成（fake-claude / fake-service）：`router-flow.test.mjs`（AC-001、002、012、013、016：brief → router → maker → review → precommit → merge 全链）、`router-preconditions.test.mjs`（AC-003、004、035、039）、`human-gates.test.mjs`（AC-012–015、033、043 的 API 面）、`version-gate.test.mjs`（AC-014、015）、`one-decision.test.mjs`（AC-042）、`precommit.test.mjs`（AC-011、017、048）、`precommit-service.test.mjs`（AC-049 四条路径与无残留进程）、`precommit-lock.test.mjs`（AC-050）、`rate-limit-box.test.mjs`（AC-021–023、041）、`fuse.test.mjs`（AC-024）、`reviewer-truncation.test.mjs`（AC-010）、`packages-parallel.test.mjs`（AC-034、036、040：两包并行、并发计数、拓扑序集成、越界文件照常集成）、`packages-conflict-redo.test.mjs`（AC-037、038：冲突重做；上游重集成后下游状态不变）、`packages-no-plan.test.mjs`（AC-033、044）、`plan-action.test.mjs`（AC-046、047：做不完 → plan → 方案生效；漏 AC 被拒；spec 字节不变）、`model-probe.test.mjs`（AC-052 run 终止路径）、`no-push-grep.test.mjs`（AC-006）、`dashboard-server.test.mjs`（AC-023、029、043）、`legacy-compat.test.mjs`（AC-001、027、029）、`cleanup.test.mjs`（AC-045）。
- 人工：README 对照（AC-030）；用真实 target 仓跑一单 bugfix 到 merge 闸，核对 `human-r<n>.json` 与 dashboard 页面一致，并确认 precommit 的 service 步在真实仓库上就绪与清理；P2b 后用一单 ≥ 3 包的 feature 走到 merge 闸，再用一单先单 maker 后 `plan` 的任务走到 merge 闸。

```bash
npm test
node --test tests/integration/router-flow.test.mjs
node --test tests/integration/precommit-service.test.mjs
node --test tests/integration/packages-parallel.test.mjs
node --test tests/integration/plan-action.test.mjs
node tools/dossier-stats.mjs
```

## Open Questions

本版无待人裁决项。下表记录 v2 提出、v3 收敛的决定，供实现时引用；实现期的其余工程细节由实现者自行决定，不再询问。

| 编号 | 决定 |
| --- | --- |
| Q1 | precommit 在合并候选上验证；人审批 merge，不审批 push |
| Q2 | 任务分支与 base 的冲突由 router 求助；包间集成冲突先交 maker 重做 |
| Q3 | 保险丝默认连续 3 次同因失败停止（`fuseStreak: 3`） |
| Q4 | merge 用机器文案 `task <id>: <title>`，人可 `--message` 覆盖 |
| Q5 | 不强制逐包复审；集成是中间步骤，整体 review 与 precommit 必须保留 |
| Q6 | 角色模型可配置，默认沿用现配置（四角色 `claude-opus-5`），`run` 启动探测可用性；不承诺成本差异 |
| Q7 | 普通瞬态错误保留 15 / 30 / 60 秒三档退避；限额立即停止、零重试 |
| Q8 | 不设 AC 数量硬上限 |
| Q9 | router 连续 2 次无效决策后求助 |
| Q10 | 整体审核驱动修复：集成 → 整体 review → fail AC 交主责包 → 再集成 → 再 review → precommit；无 `stale`、无局部复审、不因文件相交或上游变化强制重做 |
| Q11 | 每任务默认最多并行 2 个包 |
| Q12 | 越界修改只记录 `undeclared_files`，不阻塞集成、不撤销、不重审范围；文件边界不是验收条件 |
| Q13 | 每条 AC 恰属一个主责包；包间协作由整体审核覆盖 |
| Q14 | 重做在现有代码上修，不自动 revert 已集成提交 |
| Q15 | 允许单 maker 任务执行中由 router 发起 `plan`，spec-agent 方案模式出方案，内核按冻结 spec 的 AC 划分校验后直接生效；不能借拆包裁剪需求 |

实现期已定的工程细节（不再询问）：服务就绪轮询间隔 1 秒；`ready` 二选一（url 2xx / command exit 0）；服务以进程组启动并 SIGTERM → SIGKILL 清理；precommit 全局串行锁复用 `lib/lock.mjs`，残锁接管时终止锁内服务 pid；模型探测缓存键为 `模型 id + claude 二进制版本`；方案模式 spec-agent 的 maxTurns 独立配置（`maxTurns.plan`，默认 25）；文件相交比对用 glob 展开后的路径集合，rename / 二进制交给 git 默认 merge 行为，冲突即 `conflict`。

## 修订记录

### v3（2026-09-10，按已确认裁决整体修订）

**设计变化**

1. Q5 / Q10：删除 `stale` 状态、`stale_reason` / `upstream_changed` 字段、`package_stale` 事件与「局部复审」动作（`review` 不再接受 `packages`，记录无 `scope`）。修复流程改为整体审核驱动：集成 → 整体 review（全部 AC + 包间协作）→ fail AC 按主责包派回 maker → 再集成 → 再整体 review → precommit。router 事实段新增每条 AC 的主责包；reviewer prompt 新增 `[工作包接口约定]` 段与 `note:` 行约定。
2. Q12：`undeclared_files` 只记录；删除「已集成包 `touched_files` 计入并行比对」条款，比对只在同轮 listed 包之间；maker 工作包段与 few-shot D 改为「确有需要就改，写明即可」。
3. Q15：新增 router 动作 `plan` 与 Invariant 8「方案不改范围」：spec-agent 方案模式（只能写 packages.json，cwd 为任务分支 HEAD 的只读 worktree，注入冻结 spec、maker 记录、`--stat`），内核按冻结 spec 的 AC 划分校验后直接生效，`plan_source=router`；`packages_approved` 改名 `plan_active` 并新增 `plan_source`。
4. precommit 产品承诺：三步 build → service（启动、就绪轮询、进程组清理、输出落盘）→ tier 测试；适用步骤失败即 fail，其后 `not_run`，未配置 `skipped`；全局串行锁；profile 的 `precommit` 段扩为 `build / service / unit / integration / e2e`；记录 `commands[]` 改为 `steps[]`。
5. Q6：模型默认沿用现配置（四角色 `claude-opus-5`），新增 `run` 启动模型可用性探测与缓存；删除「成本降约 30%」等未经验证的表述。
6. Q1–Q4、Q7–Q9、Q11、Q13、Q14 由开放问题收敛为正文决定；Open Questions 表改为决定记录，本版无待人裁决项。

**一致性清理**：router few-shot 重排为 22 条（删除 stale / 局部复审条目，新增 plan 两条与「整体 review 后按主责包重做」），坏决定新增「因越界或上游变化去复查」；spec few-shot 新增方案模式一组；reviewer few-shot 新增包间协作一组；AC-038 / 039 语义反转并保留编号；AC-003 / 007 / 011 / 013 / 016 / 017 / 018 / 019 / 024 / 025 / 026 / 027 / 029 / 033 / 035 / 040 / 044 / 045 同步；Edge Cases 删除 stale 行、新增 plan 与 precommit 三步各路径；Verification Plan 新增 `plan-action`、`precommit-service`、`precommit-lock`、`model-probe`。

**新增工程范围（相对 v2）**：`actions/plan.mjs`、`lib/model-probe.mjs`、`lib/precommit.mjs` 的 service 步与全局锁、`tests/fixtures/fake-service.mjs`、`worktrees/<id>.plan-ro`、`state/.precommit.lock`、`state/.model-probe.json`、`precommit-r<n>.service.log`；新增 AC-046–052；config 新增 `precommitStepTimeoutMs`、`precommitLockTimeoutMs`、`maxTurns.plan`。删除的范围：`markStale`、局部复审的 prompt / 前置 / 记录字段。

### v2（2026-09-10）

spec 覆盖完整需求并随附工作包方案；Invariant 7 一次裁决一次有效；新增 §工作包（含当时的 stale 与局部复审，v3 已删）；Invariant 6 版本规则取代「人看过就不再 review」；预算耗尽显式转移；P2b 阶段与 `packagesEnabled` 阶段闸。

## 关联

- 现状与证据：`node tools/dossier-stats.mjs`、`dossier/task-20260829-00{1,2,3}/timeline.md`、`fable-loop-STATE.md` §2 F19 / §4 H14。
- 协作模式：conductor-infra-fix-mode（记忆），实现不走 conductor 开单。
- 后续单：`.claude/skills/loop-task` 适配新 CLI（`--kind` 移除、bugfix 不再手写 spec.md、`resume` 动词、`approve --no-packages`）。
