# Feasibility Study: Web Dashboard（任务状态 + 人审闸门 UI 化）

## Engineer Reading Guide

如果你在实现本 feature，读 `Summary`、`Recommendation`、`Validation Plan`、`Open Questions`，然后以 `./2-tech-spec.md`（待写）为实现事实源。选项对比只在推翻当前方向时回看。

## Summary

给 loop conductor 加一个本地 Web 仪表盘：展示 queue/done/failed 全部任务及其 stage，并把 5 个人审闸门（setup / feasibility option / spec / merge / retry）做成可点击操作。结论：**可行且成本低**。全部状态已经是磁盘上的原子写 JSON/Markdown，读侧零风险；写侧只要复用现有 CLI（shell-out），锁与校验逻辑天然不重复实现。推荐 Option A：零依赖 Node 本地 server + 单页静态 UI，读直读文件、写透传 CLI。

## Decision Needed

| Question | Why It Matters | Default / Owner |
| --- | --- | --- |
| 写路径走 shell-out CLI 还是 import 内部函数 | 决定是否要重构 conductor.mjs 导出 cmd core | 默认 shell-out（零重构）/ Pulin |
| merge/retry 这类长动作是否进 v1 | merge 会 spawn committer agent，分钟级，HTTP 同步等待会超时 | 默认 v1 只读 + 四个快闸门，merge 做异步触发或留 CLI / Pulin |
| 是否引入前端框架 | 与项目零依赖风格冲突 | 默认不引入，原生 HTML/JS 单页 / Pulin |

## Background

现状：看任务全貌要 `conductor status` / `spy`，审批要记 5 组 CLI 子命令与参数（如 `approve-feasibility <id> --option O-X`），且 feasibility memo、spec 草稿、timeline 分散在 `state/`、`specs/`、`dossier/` 三处，非熟悉状态机的人无法操作。目标是把「看全局 + 过闸门」这两件事 UI 化，降低人审门槛。

## Evidence Checked

| Area | Finding | Source |
| --- | --- | --- |
| 状态读取 | 全部任务状态即 `state/{queue,failed,done}/<id>/{task,runtime}.json`，`listTaskStates` 已容忍坏目录；写侧全走 tmp+rename 原子落盘，外部读者永远读到完整文件 | `conductor/lib/state.mjs::writeFileAtomic/listTaskStates` |
| 审批写入 | 5 个人审动作都是「读 task → 校验 → 改 runtime.json 字段 + append timeline」，且被 per-task 锁（`dossier/<id>/.lock`）包住 | `conductor/conductor.mjs::cmdApprove/cmdApproveSetup/cmdApproveFeasibility/cmdReject*/cmdRetry` |
| option 枚举 | approve-feasibility 的合法 option 列表可由 `validateFeasibilityDoc(md).options` 机器枚举——UI 下拉框数据源现成 | `conductor/lib/feasibility-contract.mjs`，`conductor.mjs:398-407` |
| 运行模型 | `run` 是带全局锁的一次性 drain；审批只翻 runtime 标志位，下次 run 生效。dashboard 写标志位不需要 conductor 在跑，也不会与 run 竞争（有 task lock + run 全局锁） | `conductor.mjs::cmdRun`, `lib/lock.mjs`, `lib/task-lock.mjs` |
| 实时活动 | 「哪个 agent 正在跑」已有实现：dossier spawn 记录 + stream 文件 mtime | `conductor.mjs::latestActiveSpawn/cmdSpy` |
| 依赖风格 | package.json 零 dependencies，整个项目 node: 内置模块 | `package.json` |

## Constraints

| Constraint | Detail | Hard / Soft |
| --- | --- | --- |
| 状态一致性 | 不得绕过 task lock / option 校验另写一套审批逻辑；事实源只能有一份 | hard |
| 依赖 | 不引入 npm 依赖（与项目零依赖风格一致）；至多静态单页 + node:http | soft |
| 安全 | server 仅 bind 127.0.0.1，无鉴权即无远程暴露 | hard |
| 长动作 | merge 内嵌 committer agent（分钟级）、retry 可能触发 worktree 重建，不能在 HTTP 请求内同步等待 | hard |

## Option Comparison

| Option | Description | Pros | Cons / Risks | Unknowns | Verdict |
| --- | --- | --- | --- | --- | --- |
| O-A: 零依赖本地 server + CLI 透传 | node:http 起本地 server；读侧直读 state/dossier（复用 `lib/state.mjs` 解析）+ 轮询或 SSE；写侧 `child_process` 调 `conductor <cmd>`，透传 exit code / stderr | 锁、校验、timeline 单一事实源；零依赖零重构；读写天然崩溃安全 | 每次操作 spawn 进程（本地场景无感）；CLI stderr 文案即 UI 错误文案，偏原始 | SSE 与轮询选型（默认 1–2s 轮询即可） | **recommend** |
| O-B: server import conductor 内部函数 | 重构 conductor.mjs 导出 cmdApprove 等 core，server 直接调用 | 无进程开销；错误对象结构化 | 需要重构 CLI（cmd* 目前不导出且混杂 console/exitCode）；重构面波及全部集成测试 | 重构范围能否收敛在纯提取 | consider（作为 O-A 之后的演进，不作为起点） |
| O-C: 独立前端栈（Vite/React + Express/WS） | 常规 Web 工程 | 生态齐全、UI 上限高 | 引入两套依赖树，违背零依赖风格；对「本地单人审批面板」严重过配 | — | reject |

## Recommendation

推荐 **O-A**。

- 读侧证据充分：原子写保证外部读者永远一致，`listTaskStates` 连坏目录都有降级形态，dashboard 读层几乎是免费的。
- 写侧不复制逻辑：approve-feasibility 的 option 锚点校验、reject notes 落盘、timeline 追加全在 CLI 里，shell-out 让这些行为一个字都不用重写。
- 成本与风险最低：预计一个 server 文件 + 一个静态页即可交付 v1；O-B 的重构可等 UI 稳定后再做。

## Decision Risks

| Risk | Why It Matters | Mitigation / Decision |
| --- | --- | --- |
| merge/retry 长动作阻塞 HTTP | 请求超时 + 用户重复点击 → 重复触发 | v1 范围决策：四个快闸门（approve-setup / approve-feasibility / approve、reject 系 / retry）同步透传；merge 先不进 UI 或仅「后台触发 + timeline 轮询观察」 |
| 有人绕过 UI 并发操作 CLI | 双写同一任务 | 已由 task lock 兜底（CLI 侧 `TaskLockBusyError`），UI 只需把「任务正被推进」当正常错误展示 |
| dashboard 变成第二事实源 | UI 里另存任务状态/缓存漂移 | 决策：UI 无状态，每次渲染直读磁盘；禁止 UI 侧持久化任务数据 |

## Validation Plan

- [ ] 手动串一遍：`new --feasibility` → dashboard 里看到 AWAIT_FEASIBILITY_APPROVAL → UI 下拉选 option approve → `run` → 任务进 NEEDS_SPEC
- [ ] 验证 option 下拉数据源：对现有 feasibility-study.md 草稿调 `validateFeasibilityDoc`，确认 options 枚举与 CLI 拒绝行为一致
- [ ] 并发探针：UI 审批同时 `conductor run` 推同一任务，确认 TaskLockBusyError 透传为可读错误而非 500
- [ ] 确认 `spy` 的 latestActiveSpawn 逻辑可直接复用为「正在运行的 agent」面板（只读 dossier，无副作用）

## Follow-up Documents

- Requirements: 不需要（单人内部工具，场景已在本 memo 固定）
- Tech spec: `./2-tech-spec.md`（API 路由、SSE/轮询选型、页面信息架构、错误透传契约）
- Implementation plan: 暂不需要（预计 ≤3 个文件）

## Open Questions

| Question | Default If Unanswered | Impact |
| --- | --- | --- |
| dashboard 是否要能触发 `conductor run` 本身 | 默认不能，run 仍由人/cron 在终端触发 | 若要能，需处理 run 全局锁占用与输出流式展示，v1 复杂度 +50% |
| 是否展示 spec/feasibility 草稿全文供审阅 | 默认展示（只读渲染 Markdown，UI 审批前必看） | 不展示则 UI 审批形同盲签，价值大打折扣 |
| done/failed 任务的 dossier 明细要不要进 UI | 默认只列表 + 链接文件路径 | 全量渲染 dossier 会拖慢页面，且排查场景本来就在编辑器里 |
