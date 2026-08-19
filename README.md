# will-workflow / Loop Conductor

面向 agent 的项目索引。本文件只做路由，不做长说明；当前事实源是代码和测试。没有被这里链接的文档视为历史材料，不作为实现依据。

English readers: see [`README.en.md`](README.en.md) for a human-facing overview of this project.
## 入口

| 你要找 | 打开 |
| --- | --- |
| CLI、配置默认值、stage 分发 | `conductor/conductor.mjs` |
| 本地配置样例 | `conductor.config.json` |
| 状态布局、dossier helper | `conductor/lib/state.mjs` |
| Claude CLI 封装、瞬态重试 | `conductor/lib/claude.mjs` |
| Codex CLI 封装（verifier shadow 后端，opt-in） | `conductor/lib/codex.mjs`（设计：`docs/features/fable-loop-optimization/codex-shadow-design.md`） |
| worktree、diff、commit、merge | `conductor/lib/git.mjs` |
| setup profile 存储 | `conductor/lib/profile.mjs` |
| spec 交付契约（spec-doc/v1，AC 枚举/校验） | `conductor/lib/spec-contract.mjs` |
| feasibility 交付契约（feasibility-doc/v1，option 枚举/校验） | `conductor/lib/feasibility-contract.mjs` |
| test gate 纯函数（测试 glob / 变更分类 / AC→测试映射校验） | `conductor/lib/test-gate.mjs` |
| agent hook 脚本（spec 写白名单、Stop 契约预检、maker git 护栏） | `conductor/hooks/` |
| 纯路由和 schema 判断 | `conductor/stages/decisions.mjs` |
| agent 角色 prompt | `agents/*.md` |
| commit / 分支规范（committer 提案的规范源） | `.claude/skills/git-conventions/SKILL.md` |
| 冷 session 发起任务的入口 skill（蒸馏 brief → new → run → 监控） | `.claude/skills/loop-task/SKILL.md` |
| 行为 case | `tests/integration/*.test.mjs` |
| 单元级不变量 | `tests/unit/*.test.mjs` |
| 跨任务失败分布/成本/轮次聚合 CLI | `tools/dossier-stats.mjs`（`node tools/dossier-stats.mjs [--json]`） |
| 最近一次实现证据 | `docs/features/committer-merge-message/request-log.md` |

## 当前角色

| 角色 | Prompt | Spawn 位置 | 职责 |
| --- | --- | --- | --- |
| setup | `agents/setup-agent.md` | `conductor/stages/needs_target_setup.mjs` | 只读探索 target repo，产出可复用 setup profile。 |
| feasibility | `agents/feasibility-agent.md` | `conductor/stages/needs_feasibility.mjs` | 直写任务目录 feasibility-study.md（决策 memo：证据 + O-X option 对比 + 推荐 + 开放问题；hook 写白名单 + Stop 预检 + conductor 契约门终审），人按 option ID 点名裁决。 |
| spec | `agents/spec-agent.md` | `conductor/stages/needs_spec.mjs`, `conductor/stages/spec_fixing.mjs` | 直写 `specs/<id>.md`（唯一交付物，hook 写白名单 + Stop 预检 + conductor 契约门终审）；吃 brief / 冻结 feasibility memo / 已选 option。 |
| spec-verifier | `agents/spec-verifier-agent.md` | `conductor/stages/spec_verify.mjs` | 用严格 JSON 审查 spec 质量。 |
| maker | `agents/maker-agent.md` | `conductor/stages/ready.mjs`, `conductor/stages/fixing.mjs` | 修改任务 worktree，使冻结 spec 全部满足（git 破坏性操作由逐轮 settings hook 拦截）。 |
| verifier | `agents/verifier-agent.md` | `conductor/stages/verify.mjs` | 冷读 spec + diff，逐条裁决 AC。 |
| committer | `agents/committer-agent.md` | `conductor/conductor.mjs::cmdMerge` | 起草 merge commit 文案（提案制，`validateCommitMessage` 终审，两次不过降级机器文案）。 |
| reviewer | `agents/reviewer-agent.md` | `conductor/stages/verify.mjs`（shadow，`reviewStage` 默认 off） | 与 verifier 同 diff 独立正确性审查，只落对照产物，不影响主链。 |

## 状态流

```text
可选 setup gate:
NEEDS_TARGET_SETUP -> AWAIT_SETUP_APPROVAL -> natural task stage

可选 feasibility gate（feature + task.feasibility，new --feasibility / config.feasibilityEnabled）:
NEEDS_FEASIBILITY -> AWAIT_FEASIBILITY_APPROVAL --approve-feasibility --option O-X--> NEEDS_SPEC
feasibility 契约门（feasibility-doc/v1）fail -> 原地重试 feasibility-agent，耗尽 -> FAILED_BOX
reject-feasibility -> NEEDS_FEASIBILITY 重产（notes 进下轮 prompt）

feature:
NEEDS_SPEC -> SPEC_VERIFY -> SPEC_FIXING -> SPEC_VERIFY -> AWAIT_SPEC_APPROVAL -> READY
spec 契约门（spec-doc/v1）fail -> 原地重试 spec-agent，耗尽 -> FAILED_BOX
SPEC_VERIFY fail + 规模闸触发（AC 数 > specMaxAcs）且人未豁免 -> AWAIT_SCOPE_DECISION（本次 fail 挂起，不计 miss）
  --approve-scope--> 接受规模，挂起的 fail 按原 miss 阶梯入账（SPEC_FIXING / 冷启动 / 耗尽收箱），该任务此后不再升闸
  --reject-scope--> FAILED_BOX（last_failure_type=scope_split），人手工拆成多个任务重开
AWAIT_SPEC_APPROVAL 机器放行（autoApproveSpec / new --auto-approve-spec，默认关）：
  evaluateAutoApproveSpec 谓词全绿（verdict pass 无 blocker/major/advisory、AC 数 ≤ 上限）-> 代章进 READY；否则留人审（advisory=规模拆分建议，拆分与否必须人裁）

bugfix:
READY

实现/验收:
READY -> VERIFY -> AWAIT_HUMAN_MERGE -> DONE
READY/FIXING green-gate fail -> FIXING
READY/FIXING 可选 gateCommands（task.json 显式值 > target-profile 默认，缺省/空跳过）任一非 0 -> FIXING
READY/FIXING test-gate vacuous（测试在基线上仍全绿）-> FIXING
VERIFY verdict fail -> FIXING
verifier invalid -> VERIFY
READY/FIXING maker 孤儿腿（maker-r<n> 有 started 无 done）-> 有界自动恢复（crashAutoRecoveryLimit，默认 1，0=关）：
  孤儿产物移入 attempts/ + 原地重 spawn，stage 不动；额度用尽 -> FAILED_BOX（crashed，人工 retry 后额度复位）
budget/retry/crash exhausted -> FAILED_BOX
FAILED_BOX --retry--> READY or NEEDS_SPEC
```

`gateCommands` 含 `yarn run` 之类需要真实依赖的命令时，需 target-profile 保证任务 worktree 能跑该命令（本仓库不提供依赖 provisioning：worktree 是否可 `yarn run` 取决于 target repo 自身，不在 conductor 职责范围）。

## 常用命令

```bash
npm test
npm run conductor -- status
npm run conductor -- new --kind bugfix --title "..."
npm run conductor -- new --kind feature --title "..." [--brief <file>] [--feasibility] [--auto-approve-spec] [--repo <path>]
npm run conductor -- run
npm run conductor -- approve-setup <id>
npm run conductor -- approve-feasibility <id> --option O-X [--notes "..."]
npm run conductor -- reject-feasibility <id> --notes "..."
npm run conductor -- approve <id>
npm run conductor -- reject <id> --notes "..."
npm run conductor -- approve-scope <id>
npm run conductor -- reject-scope <id> --notes "..."
npm run conductor -- merge <id>
npm run conductor -- retry <id>
```

## 数据位置

| 路径 | 含义 |
| --- | --- |
| `state/queue|failed|done/<id>/task.json` | 不可变任务快照。 |
| `state/queue|failed|done/<id>/runtime.json` | 可变状态机记录。 |
| `state/queue/<id>/spec.md` | bugfix 冻结前的 spec 草稿。 |
| `state/queue/<id>/brief.md` | `new --brief` 落盘的需求原文（喂 feasibility/spec 链）。 |
| `state/queue/<id>/feasibility-study.md` | 人审前的 feasibility 决策 memo 草稿（归档进同目录 feasibility-archive/）。 |
| `target-profiles/<repo>/` | setup profile 草稿/批准稿；`setup-profile.json` 亦可携带可选 `gateCommands` 默认值（见下）。 |
| `specs/<id>.md` | feature 人审前的 spec 草稿。 |
| `dossier/<id>/` | 唯一 agent 交接媒介：冻结 spec、冻结 feasibility memo + 人审 decision（feasibility-study.md / feasibility-decision.json）、spawn 记录、verdict、repair context、契约门结果（spec-check-r\<n\>.json / feasibility-check-r\<n\>.json 为 conductor 终审、.hook.json 为沙箱内预检证据）、test gate 探针结果（test-gate-r\<n\>.json）、可选 gateCommands 探测结果（gate-\<name\>-r\<n\>.json，同构于 green-gate-r\<n\>.json）、逐轮 hook settings、timeline。 |
| `worktrees/<id>/` | target repo 的任务 worktree。 |
| `target/` | demo target repo。不要在仓库根裸跑 `node --test`；用 `npm test`。 |

## Case 索引

| Case | 测试 |
| --- | --- |
| bugfix happy path + merge | `tests/integration/happy-path.test.mjs` |
| feature spec 审批路径 | `tests/integration/feature-flow.test.mjs` |
| setup gate + spec repair loop | `tests/integration/setup-spec-loop.test.mjs` |
| feasibility gate（option 人审 + 契约门 + brief 注入） | `tests/integration/feasibility-flow.test.mjs` |
| spec 直写交付 + 契约门（hook 护栏） | `tests/integration/spec-contract-gate.test.mjs` |
| maker git 护栏（--settings 注入形态） | `tests/integration/maker-git-guard.test.mjs` |
| green gate 修复路径 | `tests/integration/green-gate.test.mjs` |
| 可选 gateCommands（来源优先级 / 按序执行短路 / 复用回喂通道 / 默认空不变量） | `tests/integration/gate-commands.test.mjs` |
| test gate 空转测试拦截 | `tests/integration/test-gate.test.mjs` |
| test gate per-AC 定向探针（AC→测试映射） | `tests/integration/test-gate-per-ac.test.mjs` |
| merge commit 文案提案 + 降级 | `tests/integration/commit-message.test.mjs` |
| spec 审批门机器放行（默认关 / major finding 拦截 / 全绿代章 / AC 上限） | `tests/integration/auto-approve-spec.test.mjs` |
| spec 规模升闸（fail+超规模 → 人裁接受规模 / 拆分收箱，豁免持久） | `tests/integration/spec-scope-escalation.test.mjs` |
| verifier fail repair context | `tests/integration/verifier-fail.test.mjs` |
| verifier invalid 重试 | `tests/integration/verifier-invalid.test.mjs` |
| maker retry ladder | `tests/integration/retry-ladder.test.mjs` |
| maker max-turns 同会话续跑 | `tests/integration/maker-max-turns-continuation.test.mjs` |
| spawn 确定性失败快速收箱（EACCES 类） | `tests/integration/spawn-deterministic-failure.test.mjs` |
| approve 时 spec 契约终审（人工修订入口守门） | `tests/integration/approve-spec-contract-guard.test.mjs` |
| verifier shadow（默认关 / 不动 stage / 不污染主计数） | `tests/integration/verifier-shadow.test.mjs` |
| test gate per-AC 探针有界并发（opt-in） | `tests/integration/test-gate-probe-concurrency.test.mjs` |
| crash re-entry | `tests/integration/crash-reentry.test.mjs` |
| crashed 孤儿腿有界自动恢复（默认额度 / 用尽收箱 / 关闭退回旧行为 / retry 复位） | `tests/integration/crash-auto-recovery.test.mjs` |
| box/stage 崩溃巡检 | `tests/integration/crash-patrol.test.mjs` |
| budget gate | `tests/integration/budget.test.mjs` |
| liveness kill / slow alive | `tests/integration/liveness-kill.test.mjs` |
| green gate timeout | `tests/integration/green-gate-timeout.test.mjs` |
| parallel scheduling | `tests/integration/parallel-scheduling.test.mjs` |
| cli task lock + spy | `tests/integration/cli-task-lock-spy.test.mjs` |
| setup race | `tests/integration/setup-race.test.mjs` |
| worktree harness exclude | `tests/integration/worktree-harness.test.mjs` |
| verifier diff 上限降级 | `tests/integration/verifier-diff-cap.test.mjs` |
| web dashboard（看板聚合 + 详情 review + CLI 透传闸门） | `tests/integration/dashboard-server.test.mjs` |

## 索引规则

- 不在 README 写长设计说明，只加能帮下一个 agent 快速定位的链接。
- 被代码/测试取代的设计文档直接删除，不保留互相竞争的事实源。
- 新增稳定 workflow 时，先补最小相关测试，再把 case 链到这里。
