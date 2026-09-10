# will-workflow / Loop Conductor

面向 agent 的项目索引。本文件只做路由，不做长说明；当前事实源是代码和测试。没有被这里链接的文档视为历史材料，不作为实现依据。

English readers: see [`README.en.md`](README.en.md) for a human-facing overview of this project.

内核只产事实、守上限、记案卷；**router agent** 在闭集动作里选下一步；**人**只在两道闸出现——spec 审批与 merge 审批。角色是 router / spec / maker / reviewer 四个。

> **P2b（工作包 / `plan` 动作）尚未落地，`packagesEnabled` 默认 false。**
> 关着的时候：`plan` 动作被 `action_rejected`、spec prompt 不含工作包段、写白名单不放行 `specs/<id>.packages.json`、router log 里出现 `packages` 字段即判 invalid、`approve --no-packages` 被忽略。
> 因此 `conductor/lib/packages.mjs`、`conductor/lib/integration.mjs`、`conductor/stages/actions/plan.mjs` 目前**不存在**——`agents/` 里的工作包段与条件段已写好但注入不到，等 P2b 接线。

## 入口

| 你要找 | 打开 |
| --- | --- |
| CLI、配置默认值、人闸动词、遗留任务闸 | `conductor/conductor.mjs` |
| ROUTING 每轮：拼 prompt → spawn router → 校前置 → 执行 | `conductor/stages/routing.mjs` |
| AWAIT_HUMAN（停车位，只等 CLI 裁决） | `conductor/stages/await_human.mjs` |
| 内核面：spawn 留档、开人闸、保险丝/预算收箱、产物清理、taskCfg | `conductor/stages/router-kernel.mjs` |
| 四个动作（spec / maker / review / precommit） | `conductor/stages/actions/*.mjs` |
| 成本入账、限额收箱、failToBox | `conductor/stages/shared.mjs` |
| stage 集合与几个零 IO 判据 | `conductor/stages/decisions.mjs` |
| 执行 log 契约（`validateLog`、动作闭集、角色/字段规则） | `conductor/lib/log-contract.mjs` |
| 记录合成 + router 事实段渲染 | `conductor/lib/records.mjs` |
| 版本规则（`needReview` / `needPrecommit` / `mergeAllowed`） | `conductor/lib/version-gate.mjs` |
| precommit 三步（候选 worktree / build / service / 分层测试 / 全局锁） | `conductor/lib/precommit.mjs` |
| 保险丝（同签名连击） | `conductor/lib/fuse.mjs` |
| 模型可用性探测 + 版本键缓存 | `conductor/lib/model-probe.mjs` |
| 四角色 prompt 拼装 | `conductor/lib/prompts.mjs` |
| 每轮 spawn 参数、写白名单、Stop hook、maxTurns | `conductor/lib/agent-settings.mjs` |
| agent hook 脚本（写白名单 / log 契约预检 / spec 契约预检 / maker git 护栏） | `conductor/hooks/` |
| Claude CLI 封装、瞬态重试、限额事件解析 | `conductor/lib/claude.mjs` |
| worktree、diff、commit、merge | `conductor/lib/git.mjs` |
| spec 交付契约（spec-doc/v1，AC 枚举/校验） | `conductor/lib/spec-contract.mjs` |
| target profile（含 `precommit` 段读取与校验） | `conductor/lib/profile.mjs` |
| 状态布局、dossier helper、事件流 | `conductor/lib/state.mjs` |
| 四角色 prompt 与 few-shot | `agents/*.md`、`agents/fewshot/*.md` |
| 看板与人闸 UI | `conductor/dashboard/` |
| 本地配置样例 | `conductor.config.json` |
| commit / 分支规范 | `.claude/skills/git-conventions/SKILL.md` |
| 冷 session 发起任务的入口 skill | `.claude/skills/loop-task/SKILL.md` |
| 行为 case | `tests/integration/*.test.mjs` |
| 单元级不变量 | `tests/unit/*.test.mjs` |
| 跨任务失败分布/成本/轮次聚合 CLI | `tools/dossier-stats.mjs`（`node tools/dossier-stats.mjs [--json] [--task <id>]`） |
| 当前设计与验收标准 | `docs/features/router-conductor/2-tech-spec.md` |

## 当前角色

| 角色 | Prompt | cwd | `--tools` | 写白名单 | maxTurns | 职责 |
| --- | --- | --- | --- | --- | --- | --- |
| router | `agents/router-agent.md` | conductor root | `Write` | 只有自己的 log | 4 | 读 brief + 记录 + 内核事实，从闭集选一个动作。永不读 spec 正文、diff、代码。 |
| spec | `agents/spec-agent.md` | `worktrees/<id>.spec-ro`（一次性 detached @ base） | 只读三件 + `git log/blame/show` + `Write,Edit` | spec 路径 + log | 40 | 把 brief 写成 spec，覆盖全部需求；范围疑问进「待决问题」，不自行裁剪。 |
| maker | `agents/maker-agent.md` | `worktrees/<id>`（分支 `task/<id>`） | 全部（`Bash` 免审批） | 走 maker-git-guard，不走白名单 | 70 | 实现 AC，让 `testCommand` 全绿；不删不跳既有测试。 |
| reviewer | `agents/reviewer-agent.md` | `worktrees/<id>` | 只读三件 + `git diff/log/show` + `Write` | 只有自己的 log | 40 | 冷读 spec/brief 与整份 diff，逐条 AC 判 pass/fail，声明 tier。 |

判断力靠 `agents/fewshot/*.md` 传，固定上下文越短越好。每个 agent 的唯一交付信号是 `dossier/<id>/<role>-r<n>.log.json`——内核读文件、不推断、不自动重派。

## 状态流

```text
new ──► ROUTING ──(router 选动作，内核执行，记录)──► ROUTING …
ROUTING ──spec 文件通过 validateSpecDoc──► AWAIT_HUMAN(spec) ──approve / reject --notes──► ROUTING
ROUTING ──router: merge 且版本规则满足──► AWAIT_HUMAN(merge) ──approve──► DONE
                                                              └──reject --notes──► ROUTING
ROUTING ──router: human──► AWAIT_HUMAN(help) ──resume [--notes]──► ROUTING
ROUTING ──限额 rejected──► FAILED_BOX(rate_limited) ──retry（≥ resets_at）──► ROUTING
ROUTING ──保险丝同签名连击──► FAILED_BOX(fuse_no_progress) ──retry──► ROUTING
ROUTING ──预算耗尽──► FAILED_BOX(budget_exhausted) ──retry──► ROUTING
ROUTING ──router: abandon──► FAILED_BOX(abandoned) ──retry──► ROUTING
ROUTING ──router 连续 2 次失效──► AWAIT_HUMAN(help, requested_by=kernel)
```

内核自行发起的转移只有上面这几条（`tests/unit/decisions.test.mjs` 静态枚举 `transitionState` 的全部调用点执法），其余一切转移都由 router 的动作触发。

**动作闭集**：`spec | plan | maker | review | precommit | human | merge | abandon`。前置违反 → 记 `action_rejected` 事实、零副作用、下一轮把原因喂回 router。

**版本规则是 merge 的唯一依据**：记 `H` = 任务分支 HEAD，`B` = base 分支 HEAD。需要 review ⇔ 不存在 `outcome=ok ∧ head_sha=H` 的 reviewer 记录；需要 precommit ⇔ 不存在 `outcome=ok ∧ head_sha=H ∧ base_sha=B` 的 precommit 记录。人的 notes 不豁免任何一条，`approve` 在批准时刻重算一次。

**P3 之前建的遗留任务只保留可读性**：queue 里出现遗留 stage 名 → scheduler 打印「未知 stage，跳过」；任何动词对它们都返回 `legacy task, not operable by this conductor` 并保持状态不变；dashboard 与 `dossier-stats` 照常渲染它们的案卷。

## 常用命令

```bash
npm test                                     # 必须用 node 24；不要在仓库根裸跑 node --test
npm run dashboard                            # 看板 + 人闸 UI（默认 4400）

npm run conductor -- new --title "…" --brief <file> [--repo <path>] [--base-branch <b>]
npm run conductor -- run                     # drain 一轮（启动先探一次 models 可用性）
npm run conductor -- status                  # 三箱任务表
npm run conductor -- spy                     # 只读查看 queue 里正在跑的角色与最近活动

npm run conductor -- approve <id> [--notes "…"] [--message "…"]   # spec 闸冻结 / merge 闸本地合并
npm run conductor -- reject  <id> --notes "…"                     # spec / merge 闸打回 → ROUTING
npm run conductor -- resume  <id> [--notes "…"]                   # help 闸恢复 → ROUTING
npm run conductor -- abandon <id>                                 # → FAILED_BOX(abandoned)
npm run conductor -- retry   <id> [--force]                       # FAILED_BOX → ROUTING
npm run conductor -- retry --rate-limited [--force]               # 批量恢复限额收箱的任务
```

建单唯一前置是目标仓的 `precommit` 段（`target-profiles/<repo>/setup-profile.json`）：三步命令由人手写，内核不猜；缺了 `new` 直接拒绝并打印含全部键的样例。任何代码路径都不执行 `git push`（`tests/integration/no-push-grep.test.mjs` 静态执法）。

## 数据位置

| 文件 | 写入者 | 含义 |
| --- | --- | --- |
| `state/queue|failed|done/<id>/task.json` / `runtime.json` | 内核 | 不可变快照 / 可变状态 |
| `state/queue/<id>/brief.md` | `new` | 需求原文 |
| `state/.precommit.lock`、`state/.model-probe.json` | 内核 | precommit 全局串行锁；模型可用性缓存（键 = 模型 id + claude 二进制版本） |
| `specs/<id>.md`、`dossier/<id>/spec.md` | spec-agent / 内核冻结 | 草稿 / 已批准冻结稿（草稿批准后移入 `specs/archive/`） |
| `dossier/<id>/<role>-r<n>.log.json` | agent | 执行 log（唯一交付信号，契约见 `conductor/lib/log-contract.mjs`） |
| `dossier/<id>/<role>-r<n>.log.hook.json` | Stop hook | 会话内校验报告 |
| `dossier/<id>/<role>-r<n>.json`、`.stream.jsonl`、`.settings.json` | 内核 | spawn 记录（cost / killed / head_sha / base_sha）、原始流、逐轮 hook 设置 |
| `dossier/<id>/precommit-r<n>.json`、`precommit-r<n>.service.log` | 内核 | 三步回归结果；服务进程输出 |
| `dossier/<id>/human-r<n>.json` | 内核 | 人闸请求与裁决（kind / summary / refs / decision / notes） |
| `dossier/<id>/router-state.json` | 内核 | ROUTING 的私有状态（失效连击、最近 action_rejected、保险丝复位轮次） |
| `dossier/<id>/timeline.md`、`events.jsonl` | 内核 | 只增日志；事件：`router_decision`、`action_rejected`、`spec_invalid`、`human_gate_opened`、`human_decision`、`human_intervened`、`precommit_result`、`stale_review`、`main_moved`、`rate_limited`、`fuse_tripped`、`budget_exhausted`、`merged`、`stage`（`stage` 归 `eventsLogEnabled` 开关，其余恒写） |
| `worktrees/<id>/`、`worktrees/<id>.spec-ro/`、`worktrees/<id>.precommit/` | 内核 | 任务 worktree（分支 `task/<id>`）/ spec 只读 worktree / 合并候选（用毕即删） |
| `target-profiles/<repo>/setup-profile.json` | 人 | 目标仓的 `precommit: {build?, service?, unit, integration?, e2e?}` 段 |
| `target/` | — | demo target repo |

## Case 索引

| Case | 测试 |
| --- | --- |
| 主链：brief → maker → review → precommit → merge 闸 → approve → DONE；spec 闸冻结后 maker 用冻结稿 | `tests/integration/router-flow.test.mjs` |
| 动作前置：review 无 diff / merge 版本规则未满足 / precommit tier 过低 / maker 未批 spec / plan 阶段闸；router 失效连击开 help 闸 | `tests/integration/router-preconditions.test.mjs` |
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

## 索引规则

- 不在 README 写长设计说明，只加能帮下一个 agent 快速定位的链接。
- 被代码/测试取代的设计文档直接删除，不保留互相竞争的事实源。
- 新增稳定 workflow 时，先补最小相关测试，再把 case 链到这里。
