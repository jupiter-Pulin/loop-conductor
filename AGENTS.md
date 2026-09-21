# Loop Conductor · agent index

面向 agent 的项目索引。本文件只做路由，不做长说明；当前事实源是代码和测试。没有被这里链接的文档视为历史材料，不作为实现依据。

面向人的英文总览见 [`README.md`](README.md)。

内核只产事实、守上限、记案卷、守放行条件；**router agent** 是任务负责人——读摘要、按引用回到 spec 原文 / 代码 / diff / 执行产物，用 `dispatch` 把具体指导逐字交给多个 subagent，依据回来的证据调整计划；**人**只在两道闸出现——spec 审批与 merge 审批（外加显式 help）。角色是 router / spec / digest / maker / worker / reviewer 六个。

router 能调整的是**怎么实现**（拆分、顺序、方法、调查、人员分配、修复方式）；**改不了 spec**：目标、AC、约束、非目标只有人能批，冻结稿按内容哈希逐轮复核，被动过内核即停。设计取舍、保证边界、额度配置理由、恢复与接续操作见 [`docs/features/router-guidance/2-design-and-operations.md`](docs/features/router-guidance/2-design-and-operations.md)。

> **静态工作包方案（P2b：`plan` 动作 / `packages.json`）没有实现，也不会再实现——已被 `dispatch`（动态委派）取代。** `packagesEnabled` 恒为 false：`plan` 动作被 `action_rejected`、spec prompt 不含工作包段、写白名单不放行 `specs/<id>.packages.json`、router log 里出现 `packages` 字段即判 invalid。`agents/` 里残留的工作包段（maker 的 `package*`、spec 的 `packages*` / `plan-mode`）注入不到，只为既有测试保留。spec 里的「工作包」小节只是给 router 的提议，由摘要标成 `proposal`。

## 入口

| 你要找 | 打开 |
| --- | --- |
| CLI、配置默认值、人闸动词、遗留任务闸 | `conductor/conductor.mjs` |
| ROUTING 每轮：拼 prompt → spawn router → 校前置 → 执行 | `conductor/stages/routing.mjs` |
| AWAIT_HUMAN（停车位，只等 CLI 裁决） | `conductor/stages/await_human.mjs` |
| 内核面：spawn 留档、开人闸、保险丝/预算收箱、产物清理、taskCfg | `conductor/stages/router-kernel.mjs` |
| 动作实现（spec / maker / dispatch / review / precommit）与内核动作 digest | `conductor/stages/actions/*.mjs` |
| 委派契约（assignment 字段、权限档 profile、并行写入的路径重叠检查） | `conductor/lib/assignment-contract.mjs` |
| 委派台账（dispatch 的预写日志，恢复依据） | `conductor/lib/dispatch-ledger.mjs` |
| spec 版本身份（内容哈希）、冻结稿完整性复核 | `conductor/lib/spec-version.mjs` |
| 摘要的机械校验 / 落盘布局与「当前版本可不可用」判定 | `conductor/lib/digest-contract.mjs`、`conductor/lib/digest-store.mjs` |
| reviewer 逐条 AC 判决台账（分轮续审、按版本合并、覆盖率） | `conductor/lib/review-ledger.mjs` |
| router 的可恢复工作记忆（校验、逐轮快照、写坏还原） | `conductor/lib/router-notes.mjs` |
| 崩溃恢复（收割残留 agent、收尾未关账的 dispatch、merge 意图、成本对账） | `conductor/lib/recovery.mjs`、`conductor/lib/proc.mjs` |
| 执行后的机械核对（历史案卷 / 冻结 spec / 人闸裁决 / 内核策略被动过即还原、伪造记录隔离） | `conductor/lib/integrity.mjs` |
| 来不及写 log 时内核观察到的执行事实（salvage） | `conductor/lib/salvage.mjs` |
| 运行账本（runBudget 跨批次 / 跨重启累计）与停止请求 | `conductor/lib/run-session.mjs` |
| 任务现状聚合（阶段、停止原因、恢复入口；CLI `show` / `status` 与看板共用） | `conductor/lib/task-view.mjs` |
| 成本入账、限额收箱、failToBox | `conductor/stages/shared.mjs` |
| stage 集合与几个零 IO 判据 | `conductor/stages/decisions.mjs` |
| 执行 log 契约（`validateLog`、动作闭集、角色/字段规则） | `conductor/lib/log-contract.mjs` |
| 记录合成 + router 事实段渲染 | `conductor/lib/records.mjs` |
| 版本规则（`needReview` / `needPrecommit` / `mergeAllowed`） | `conductor/lib/version-gate.mjs` |
| precommit 三步（候选 worktree / build / service / 分层测试 / 全局锁） | `conductor/lib/precommit.mjs` |
| 保险丝（同签名连击） | `conductor/lib/fuse.mjs` |
| 模型可用性探测 + 版本键缓存 | `conductor/lib/model-probe.mjs` |
| 各角色 prompt 拼装 | `conductor/lib/prompts.mjs` |
| 每轮 spawn 参数、写白名单、Stop hook、maxTurns | `conductor/lib/agent-settings.mjs` |
| agent hook 脚本（写白名单 / 读范围 / log 契约预检 / spec 契约预检 / 摘要机械校验 / 执行角色的 git 与嵌套 CLI 护栏） | `conductor/hooks/` |
| Claude CLI 封装、瞬态重试、限额事件解析 | `conductor/lib/claude.mjs` |
| worktree、diff、commit、merge | `conductor/lib/git.mjs` |
| spec 交付契约（spec-doc/v1，AC 枚举/校验） | `conductor/lib/spec-contract.mjs` |
| target profile（含 `precommit` 段读取与校验） | `conductor/lib/profile.mjs` |
| 状态布局、dossier helper、事件流 | `conductor/lib/state.mjs` |
| 各角色 prompt 与 few-shot（digest / worker 只有固定 prompt，不配 few-shot） | `agents/*.md`、`agents/fewshot/*.md` |
| 看板与人闸 UI | `conductor/dashboard/` |
| 本地配置样例 | `conductor.config.json` |
| commit / 分支规范 | `.claude/skills/git-conventions/SKILL.md` |
| 冷 session 发起任务的入口 skill | `.claude/skills/loop-task/SKILL.md` |
| 行为 case | `tests/integration/*.test.mjs` |
| 单元级不变量 | `tests/unit/*.test.mjs` |
| 跨任务失败分布/成本/轮次聚合 CLI | `tools/dossier-stats.mjs`（`node tools/dossier-stats.mjs [--json] [--task <id>]`） |
| 当前设计、保证边界、额度配置与恢复操作 | `docs/features/router-guidance/2-design-and-operations.md` |
| 上一代设计（四角色、router 不读原文；其限制已被本次升级取代，仅作历史参考） | `docs/features/router-conductor/2-tech-spec.md` |

## 当前角色

权限按**真实副作用**分档，不按角色名分档。「无执行」= `--tools` 里根本没有 Bash（宿主 CLI 保证），写入只能走 Write / Edit 并被 write-guard 的绝对路径白名单收口；「有执行」= 显式工具白名单 `Bash,Read,Edit,Write,Grep,Glob,NotebookEdit,WebFetch,WebSearch`（没有 Task / Cron / RemoteTrigger / SendMessage 之类旁路）+ git 与嵌套 claude CLI 的命令文本护栏（尽力而为，不是隔离）+ 每次执行后的机械核对；真正的文件 / 网络隔离要开 `workerSandbox`（宿主 OS 沙盒，默认关）。

| 角色 | Prompt | cwd | 执行能力 | 写白名单 | maxTurns | 职责 |
| --- | --- | --- | --- | --- | --- | --- |
| router | `agents/router-agent.md` | `dossier/<id>/` | 无（`Read,Grep,Glob,Write`；读范围由 read-guard 收口在本任务案卷 / spec / worktree） | 自己的 log + `router-notes.json` | 40 | 负责人：读摘要与事实，需要时回原文 / 代码 / diff / 产物；从闭集选动作；用 `dispatch` 写具体委派；维护工作记忆。改不了 spec，也没有任何执行能力。 |
| digest | `agents/digest-agent.md`（固定，哈希留档） | `dossier/<id>/` | 无（只有 `Write`；spec 原文带行号内联，零读盘能力） | 这一版摘要 + log | 12 | 把一版 spec 压缩成带原文引用的索引。不批准需求、不裁剪范围、不定计划。默认快速模型（`models.digest`）。 |
| spec | `agents/spec-agent.md` | `worktrees/<id>.spec-ro`（一次性 detached @ base） | 无 | spec 路径 + log | 40 | 把 brief 写成 spec，覆盖全部需求；范围疑问进「待决问题」，不自行裁剪。 |
| maker | `agents/maker-agent.md` | `worktrees/<id>`（分支 `task/<id>`） | 有 | 走护栏 + 机械核对，不走白名单 | 70 | 简单任务的单执行者直通路径；router 可带 `guidance`。增量写 log（`partial` + `done` / `remaining`）。 |
| worker:read | `agents/worker-agent.md` | `worktrees/<id>.r-<key>`（派出时刻任务 HEAD 的只读快照） | 无 | report + log | 60 | 调查 / 设计 / 诊断 / 局部检查。 |
| worker:sandbox | 同上 | `worktrees/<id>.x-<key>`（一次性实验目录） | 有 | 同 maker | 120 | 装依赖、跑命令、codegen、探针——产物**不并入产品**，只有报告留案卷；结束后任务分支 ref 必须原样。 |
| worker:write | 同上 | 第一个：`worktrees/<id>`；同轮其余：`worktrees/<id>--<key>`（分支 `task/<id>--<key>`） | 有 | 同 maker | 150 | 改产品代码；内核负责提交与集成（冲突 → `conflict`，分支保留）。 |
| reviewer | `agents/reviewer-agent.md` | `worktrees/<id>` | 无 | log + `verdicts.json` + report | 60 | 冷读 spec 原文与整份 diff，逐条 AC 判 pass/fail，声明 tier。有 spec 的任务把判决增量写进台账，可分轮续审；无 spec 时按 `diff --stat` 分诊（测试审 / 全审）。 |

判断力靠 `agents/fewshot/*.md` 传，固定上下文越短越好。每个 agent 的交付信号是 `dossier/<id>/<base>-r<n>.log.json`（summary ≤ 2000 字符）；长内容走完整产物：worker 的 `.report.md`、reviewer 的 `.verdicts.json`、内核的 `.salvage.json`。内核读文件、不推断 outcome；**自动续接**只在「撞会话上限 + 有可核实进展 + 额度内」这一种机械情形发生，其余一律交回 router。

**三个结论严格分开**：子任务退出（worker 的 log）≠ 集成成功（委派台账的 `integrated`）≠ 产品验收（版本门）。

## 状态流

```text
new ──► ROUTING ──(router 选动作，内核执行，记录)──► ROUTING …
ROUTING ──spec 文件通过 validateSpecDoc──► AWAIT_HUMAN(spec) ──approve / reject --notes──► ROUTING
ROUTING ──router: merge 且版本规则满足──► AWAIT_HUMAN(merge) ──approve──► DONE
                                                              └──reject --notes──► ROUTING
ROUTING ──router: human──► AWAIT_HUMAN(help) ──resume [--notes]──► ROUTING
ROUTING ──限额 rejected──► FAILED_BOX(rate_limited) ──retry（≥ resets_at）──► ROUTING
ROUTING ──保险丝：同签名连击 / 连续 N 轮无硬进展──► FAILED_BOX(fuse_no_progress) ──retry──► ROUTING
ROUTING ──预算耗尽──► FAILED_BOX(budget_exhausted) ──retry──► ROUTING
ROUTING ──轮次上限（maxRoundsPerTask）──► FAILED_BOX(round_cap) ──retry──► ROUTING
ROUTING ──router: abandon──► FAILED_BOX(abandoned) ──retry──► ROUTING
ROUTING ──router 连续 2 次失效 / 获批 spec 被动过 / 执行越过授权边界──► AWAIT_HUMAN(help, requested_by=kernel)
```

每个 ROUTING 步的开头，内核先做四件机械的事：**恢复**上一个 runner 没收尾的事（`lib/recovery.mjs`）→ **复核**获批 spec 的哈希 → **补齐**当前适用版本 spec 的摘要（有界尝试，用尽即显式降级为「router 直接读原文」）→ 预算 / 轮次 / 停滞闸。

内核自行发起的转移只有上面这几条（`tests/unit/decisions.test.mjs` 静态枚举 `transitionState` 的全部调用点执法），其余一切转移都由 router 的动作触发。

**动作闭集**：`spec | plan | maker | dispatch | review | precommit | human | merge | abandon`（`plan` 恒被拒，见上）。前置违反 → 记 `action_rejected` 事实、零副作用、下一轮把原因喂回 router。`dispatch` 的前置：曾产出 spec 则必须已批准；同轮 ≥2 个 `write` 必须各自声明 `paths` 且保守判定不重叠；`continue_from` 必须是台账里标出的可续接轮次。`precommit` 可先于 review 当集成检查跑。

**版本规则是 merge 的唯一依据**：记 `H` = 任务分支 HEAD，`B` = base 分支 HEAD，`S` = 获批 spec 的内容哈希。需要 review ⇔ 当前 `(H, S)` 上没有「判全且全 pass」的整体 review——有 spec 的任务按判决台账对照冻结 spec 枚举出的**全部** AC 计算，reviewer 自述 ok、判了一半、对旧 H 或旧 S 的判决都不算数；无 spec 的任务沿用 `outcome=ok ∧ head_sha=H`。需要 precommit ⇔ 不存在 `outcome=ok ∧ head_sha=H ∧ base_sha=B` 且 tier 不低于 reviewer 在 H 上声明层级的 precommit 记录。人的 notes、子任务完成、局部检查都不豁免，`approve` 在批准时刻重算一次并复核冻结 spec。

**P3 之前建的遗留任务只保留可读性**：queue 里出现遗留 stage 名 → scheduler 打印「未知 stage，跳过」；任何动词对它们都返回 `legacy task, not operable by this conductor` 并保持状态不变；dashboard 与 `dossier-stats` 照常渲染它们的案卷。

## 常用命令

```bash
npm test                                     # 必须用 node 24；不要在仓库根裸跑 node --test
npm run dashboard                            # 看板 + 人闸 UI（默认 4400）

npm run conductor -- new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]
npm run conductor -- run                     # 跑一个调度批次（启动先探 models，再恢复上一个 runner 的残留）
npm run conductor -- run --continuous        # 批次接批次跑到没有可执行的工作（等人 / 收箱 / 完成）或必须停下
npm run conductor -- run --watch             # 同上，空闲也不退出：轮询新工作（人批准 / retry / 新任务）接着跑
npm run conductor -- stop [--now]            # 请 runner 停下（--now 连在飞的 agent 一起收割，已落盘的工作保留）
npm run conductor -- recover [--dry-run]     # 只做恢复巡检（run 启动时自动执行同一件事）
npm run conductor -- status                  # 三箱任务表；PHASE 列：运行中 / 等待结果 / 可恢复中断 / 等待资源 / 等待人 / 已终止
npm run conductor -- show <id> [--json]      # 单任务现状：阶段与停止原因、目标与计划、活动 agent、委派、摘要、验收门、额度、怎么继续
npm run conductor -- spy                     # 只读查看 queue 里正在跑的角色与最近活动
npm run conductor -- digest <id> [--force]   # 为当前适用版本的 spec 补齐 / 重做摘要
npm run conductor -- pause <id> | unpause <id>

npm run conductor -- approve <id> [--notes "…"] [--message "…"]   # spec 闸冻结 / merge 闸本地合并
npm run conductor -- reject  <id> --notes "…"                     # spec / merge 闸打回 → ROUTING
npm run conductor -- resume  <id> [--notes "…"]                   # help 闸恢复 → ROUTING
npm run conductor -- abandon <id>                                 # → FAILED_BOX(abandoned)
npm run conductor -- retry   <id> [--force]                       # FAILED_BOX(rate_limited|fuse_no_progress|budget_exhausted|round_cap|abandoned) → ROUTING
npm run conductor -- retry --rate-limited [--force]               # 批量恢复限额收箱的任务
```

`runBudgetUsd`（一次运行的额度）与 `budgetUsd`（单任务预算）都跨批次累计；runner 崩溃后重启的进程接管上一份运行账本（`state/.run-session.json`），额度不清零；正常收尾后人再次手动 `run` 才是新授权。限额收箱仍然只由人 `retry` 恢复，内核不自动续跑、不提额。

建单唯一前置是目标仓的 `precommit` 段（`target-profiles/<repo>/setup-profile.json`）：三步命令由人手写，内核不猜；缺了 `new` 直接拒绝并打印含全部键的样例。任何代码路径都不执行 `git push`（`tests/integration/no-push-grep.test.mjs` 静态执法）。

## 数据位置

| 文件 | 写入者 | 含义 |
| --- | --- | --- |
| `state/queue|failed|done/<id>/task.json` / `runtime.json` | 内核 | 不可变快照 / 可变状态 |
| `state/queue/<id>/brief.md` | `new` | 需求原文 |
| `state/.precommit.lock`、`state/.model-probe.json` | 内核 | precommit 全局串行锁；模型可用性缓存（键 = 模型 id + claude 二进制版本） |
| `state/.run-session.json`、`state/.stop` | 内核 / `conductor stop` | 运行账本（runBudget 已花、批次数、结束原因；未收尾的会被下一次 run 接管）；停止请求 |
| `state/queue/<id>/PAUSED` | `conductor pause` | 单任务暂停标记（存在即暂停） |
| `specs/<id>.md`、`dossier/<id>/spec.md` | spec-agent / 内核冻结 | 草稿 / 已批准冻结稿（草稿批准后移入 `specs/archive/`） |
| `dossier/<id>/<role>-r<n>.log.json`、`worker-<key>-r<n>.log.json` | agent | 执行 log（交付信号，契约见 `conductor/lib/log-contract.mjs`；maker / worker 增量写，带 `done` / `remaining`） |
| `dossier/<id>/worker-<key>-r<n>.report.md`、`reviewer-r<n>.verdicts.json` | agent | 完整产物：不受短 log 长度限制的报告 / 逐条 AC 判决台账 |
| `dossier/<id>/<base>-r<n>.salvage.json` | 内核 | 没有合格 log 时内核从原始流与 git 观察到的事实 + 明确的未知清单（没有 outcome） |
| `dossier/<id>/digest/<sha12>.json`、`.meta.json`、`.source.md` | digest agent / 内核 / 内核 | 摘要本体（内核只读不改）/ 来源版本、prompt 哈希、模型、逐次尝试与校验结果 / 该版本 spec 原文快照（引用坐标系） |
| `dossier/<id>/dispatch-r<n>.json` | 内核 | 委派台账：每个 assignment 的绑定版本（`base_head`、`spec_sha`）、placement、逐次 spawn、提交与集成状态；`closed=false` = 需要恢复收尾 |
| `dossier/<id>/router-notes.json`、`router-notes/r<n>.json` | router / 内核 | router 的工作记忆 / 逐轮快照（写坏的留 `.invalid.json`） |
| `dossier/<id>/views/<head12>.patch` | 内核 | 任务分支相对 base 的完整 diff（reviewer / router 按需 Read） |
| `dossier/<id>/merge-intent.json`、`quarantine/` | 内核 | merge 的预写意图（崩溃后据此认出「已合并未归档」）；被隔离的伪造案卷文件 |
| `dossier/<id>/<role>-r<n>.log.hook.json` | Stop hook | 会话内校验报告 |
| `dossier/<id>/<role>-r<n>.json`、`.stream.jsonl`、`.settings.json` | 内核 | spawn 记录（cost / accounted_usd / killed / interrupted / pid 身份 / head_sha / base_sha / spec_sha / isolation / progress / integration）、原始流、逐轮 hook 设置 |
| `dossier/<id>/precommit-r<n>.json`、`precommit-r<n>.service.log` | 内核 | 三步回归结果；服务进程输出 |
| `dossier/<id>/human-r<n>.json` | 内核 | 人闸请求与裁决（kind / summary / refs / decision / notes） |
| `dossier/<id>/router-state.json` | 内核 | ROUTING 的私有状态（失效连击、最近 action_rejected、保险丝复位轮次、硬进展指纹与连续无进展轮数） |
| `dossier/<id>/timeline.md`、`events.jsonl` | 内核 | 只增日志；事件：`router_decision`、`action_rejected`、`spec_invalid`、`human_gate_opened`、`human_decision`、`human_intervened`、`precommit_result`、`stale_review`、`main_moved`、`rate_limited`、`fuse_tripped`、`budget_exhausted`、`round_cap_reached`、`merged`、`digest_ready` / `digest_invalid` / `digest_failed`、`dispatch_result`、`boundary_violation`、`spec_tampered`、`recovered`、`paused` / `unpaused`、`stage`（`stage` 归 `eventsLogEnabled` 开关，其余恒写） |
| `worktrees/<id>/`、`worktrees/<id>.spec-ro/`、`worktrees/<id>.precommit/` | 内核 | 任务 worktree（分支 `task/<id>`）/ spec 只读 worktree / 合并候选（用毕即删） |
| `worktrees/<id>--<key>/`、`worktrees/<id>.r-<key>/`、`worktrees/<id>.x-<key>/` | 内核 | 并行 write 委派的独立 worktree（分支 `task/<id>--<key>`，集成后删；冲突则分支保留）/ read 的只读快照 / sandbox 的实验目录（用毕即删；可续接时保留） |
| `target-profiles/<repo>/setup-profile.json` | 人 | 目标仓的 `precommit: {build?, service?, unit, integration?, e2e?}` 段 |
| `target/` | — | demo target repo |

## Case 索引

| Case | 测试 |
| --- | --- |
| 摘要：快速模型 + 固定 prompt + 只有 Write；机械校验、有界修复、显式降级；人改稿后用获批版本；notes 独立在场 | `tests/integration/digest-flow.test.mjs` |
| dispatch：委派逐字到达、四档并行与汇合、子任务 ok ≠ 验收、共享写入被拒 / 真实冲突、证据改变下一步、工作记忆 | `tests/integration/dispatch-flow.test.mjs` |
| 长任务：撞上限自动续会话 / `continue_from` / 无 log 的 salvage / maker 增量 log；reviewer 分轮续审与版本失效；`run --continuous` 与 runBudget 跨批次、跨重启 | `tests/integration/long-task.test.mjs` |
| 崩溃恢复：真 SIGKILL runner + 残留 agent 收割；幂等提交 / 集成；过期结果标 stale；merge「已合并未归档」 | `tests/integration/crash-recovery.test.mjs` |
| 工程边界：越权写盘还原 / 伪造记录隔离、sandbox 不得碰产品、冻结 spec 被动过、预算 / 限额 / 暂停 / 停止对子委派生效、停滞保险丝、轮次上限、无响应 agent | `tests/integration/boundaries.test.mjs` |
| 升级兼容：停在 spec 闸的存量任务、升级前已批准的任务、简单任务直通、无 spec 的 dispatch、遗留任务仍只读 | `tests/integration/upgrade-compat.test.mjs` |
| 主链：brief → maker → review → precommit → merge 闸 → approve → DONE；spec 闸冻结后 maker 用冻结稿 | `tests/integration/router-flow.test.mjs` |
| 动作前置：review 无 diff / merge 版本规则未满足 / precommit 可先于 review 但 tier 下界两处把关 / maker 未批 spec / plan 阶段闸；router 失效连击开 help 闸 | `tests/integration/router-preconditions.test.mjs` |
| 人闸：`new` 的 precommit profile 闸、spec reject → ROUTING、resume 适用范围、merge reject | `tests/integration/human-gates.test.mjs` |
| 版本规则：人改过 HEAD / base 前进后 merge 被拒并回 ROUTING | `tests/integration/version-gate.test.mjs` |
| 一次裁决一次有效：同一句 help summary 第二次被 `duplicate_help` 拒 | `tests/integration/one-decision.test.mjs` |
| reviewer fail → 修复轮 prompt 带 reviewer summary，need_review 重新为真 | `tests/integration/reviewer-fail.test.mjs` |
| reviewer 增量写 + 撞 max-turns：记录 product=ok / truncated=true | `tests/integration/reviewer-truncation.test.mjs` |
| reviewer prompt 的 diff 字节上限降级 | `tests/integration/reviewer-diff-cap.test.mjs` |
| spec 直写交付 + 契约门（hook 护栏 / spec_invalid / 只看文件不看自评） | `tests/integration/spec-contract-gate.test.mjs` |
| approve 时 spec 契约终审（人工修订入口守门） | `tests/integration/approve-spec-contract-guard.test.mjs` |
| merge 闸的 git 护栏：分支不符 / merge 失败现场还原 / 成功归档 | `tests/integration/merge-branch-guard.test.mjs` |
| precommit 三步：候选建法、build 失败、层级累加、冲突、base 前进 | `tests/integration/precommit.test.mjs` |
| precommit service 步：就绪 / 超时 / 崩溃 / 进程组清理 | `tests/integration/precommit-service.test.mjs` |
| precommit 全局串行锁：等锁 / 超时 / 残锁接管 | `tests/integration/precommit-lock.test.mjs` |
| precommit 单步墙钟上限（装死命令被杀） | `tests/integration/precommit-timeout.test.mjs` |
| 限额收箱：进箱、本次 run 短路、retry 必须在重置时刻之后、无人操作不复活 | `tests/integration/rate-limit-box.test.mjs` |
| 保险丝：同签名连击收箱、签名变了断连击、`fuseStreak: 0` 关闭 | `tests/integration/fuse.test.mjs` |
| 预算耗尽 → FAILED_BOX(budget_exhausted) | `tests/integration/budget-box.test.mjs` |
| 模型可用性探测：不可用即终止 run、缓存命中不再探 | `tests/integration/model-probe-run.test.mjs` |
| spawn 基建失败：product=missing、内核不重派 | `tests/integration/spawn-infra-failure.test.mjs` |
| spawn 确定性失败（EACCES 类）不吃退避阶梯、不估计入账 | `tests/integration/spawn-deterministic-failure.test.mjs` |
| killed spawn 的成本估计入账（默认关 / 开启） | `tests/integration/unknown-spawn-cost.test.mjs` |
| 活性护栏：inactivity / wall-clock kill 与慢而活着 | `tests/integration/liveness-kill.test.mjs` |
| 产物清理：DONE / abandon 清干净，FAILED_BOX 保留一切 | `tests/integration/cleanup.test.mjs` |
| 全仓无 `git push`；router 无 Bash；maker git 护栏仍拦 | `tests/integration/no-push-grep.test.mjs` |
| maker git 护栏的 `--settings` 注入形态 | `tests/integration/maker-git-guard.test.mjs` |
| worktree harness exclude | `tests/integration/worktree-harness.test.mjs` |
| worktree 建自 `task.baseBranch`，不吃活体仓瞬时 HEAD | `tests/integration/worktree-base-branch.test.mjs` |
| 任务级 targetRepo：worktree / merge / 多仓共存 / 缺字段回退 | `tests/integration/task-scoped-target-repo.test.mjs` |
| 全局锁：双开退出、stale 告警、死 pid 残锁自愈 | `tests/integration/lock.test.mjs` |
| 调度并发与串行 | `tests/integration/parallel-scheduling.test.mjs` |
| per-task 锁 + spy | `tests/integration/cli-task-lock-spy.test.mjs` |
| `maxStepsPerTask` 耗尽记日志、下次 run 续推 | `tests/integration/drain-cap.test.mjs` |
| box/stage 崩溃巡检 | `tests/integration/crash-patrol.test.mjs` |
| 事件流：router 事实事件恒写、`stage` 事件归观测开关 | `tests/integration/events-log.test.mjs` |
| 遗留任务：配置键警告、未知 stage 跳过、动词一律拒绝、status/spy 并存 | `tests/integration/legacy-compat.test.mjs` |
| node 版本警告 | `tests/integration/node-version-warning.test.mjs` |
| web dashboard（看板聚合 + 详情 review + 同步/异步动作 + SSE） | `tests/integration/dashboard-server.test.mjs` |
| reviewer 分诊段只在无 spec 时注入，base 分支名与 `diff --stat` 段恒在 | `tests/unit/prompts.test.mjs` |
| dossier-stats 的 reviewer 分诊聚合（tests/full/未分诊的轮数、成本、时长；测试审后的 precommit 红与 merge 打回） | `tests/unit/dossier-stats.test.mjs` |

## 索引规则

- 不在 README 写长设计说明，只加能帮下一个 agent 快速定位的链接。
- 被代码/测试取代的设计文档直接删除，不保留互相竞争的事实源。
- 新增稳定 workflow 时，先补最小相关测试，再把 case 链到这里。
