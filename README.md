# will-workflow / Loop Conductor

demo 级 agent loop 最小框架：确定性、可重入、幂等的 **conductor**（Node 单文件状态机，非 agent）驱动文件状态机 `state/queue/*.md`，headless spawn claude agent（plan / maker / verifier），agent 之间只传案卷（`dossier/<id>/`）不对话。

契约（已批准冻结）：`docs/features/loop-conductor/2-tech-spec.html`。

- Node ≥ 20，ESM，**零 npm 依赖**（无安装步骤）。
- 状态机：`NEEDS_SPEC → AWAIT_SPEC_APPROVAL → READY → VERIFY → FIXING → AWAIT_HUMAN_MERGE | FAILED_BOX`。
- 两个人类闸门（spec 审批、最终 merge）都是异步状态转移，conductor 绝不阻塞等待。

## 快速上手（bugfix 全流程）

```bash
# 0) 看一眼空队列
node conductor/conductor.mjs status

# 1) 建任务（bugfix 初始 READY；feature 初始 NEEDS_SPEC）
node conductor/conductor.mjs new --kind bugfix --title "median 偶数分支返回错误"
# → 输出 id: task-YYYYMMDD-NNN
# 编辑 state/queue/task-….md 的「## 验收标准」段——它就是 bugfix 档的 spec

# 2) 推进（drain：循环推进所有任务直到无状态变化；cron/CI 的唯一入口）
node conductor/conductor.mjs run
# READY: spawn maker → conductor 亲跑测试（green gate）→ VERIFY: spawn verifier
# verdict pass → AWAIT_HUMAN_MERGE（人类闸门，自然停住）
# verdict fail → 1/2/3 重试阶梯（resume 原 maker → 冷启动带全案卷 → FAILED_BOX）

# 3) 人工验收 + 合入
cd worktrees/task-YYYYMMDD-NNN && git diff main...HEAD   # 看 diff
cat dossier/task-YYYYMMDD-NNN/verify-r1.verdict.json     # 看裁决
node conductor/conductor.mjs merge task-YYYYMMDD-NNN     # 合入 + 归档 state/done/ + 清 worktree
```

feature 档多一个 spec 审批闸门：

```bash
node conductor/conductor.mjs new --kind feature --title "…"
node conductor/conductor.mjs run          # plan-agent 产出 specs/<id>.md 草稿后停住
# 人审 specs/<id>.md，然后二选一：
node conductor/conductor.mjs approve <id>                       # 批准 → 下次 run 冻结进 dossier、进 READY
node conductor/conductor.mjs reject <id> --notes "验收标准太含糊"  # 打回 → 下次 run 重新出稿
```

其他命令：`status`（任务表）、`retry <id>`（FAILED_BOX → READY，重置 miss、保留案卷——崩溃 / 预算超限 / 重试阶梯用尽收箱的任务都从这里复活）。

## 跑测试

```bash
node --test tests/        # 或 npm test；零 token，全部走 fake-claude stub
```

任何测试都不调用真 claude 二进制：`lib/claude.mjs` 以 `CLAUDE_BIN` 环境变量为挂载点，测试注入 `tests/fixtures/fake-claude.mjs`（按调用序回放脚本化 JSON）。真 E2E（花钱）由人工执行：`target/` 已预埋 bug（`lib/stats.mjs` 的 median 偶数分支）和会挂的 `node --test` 测试，直接走上面的快速上手即可。

注意：不要在仓库根目录裸跑 `node --test`（会把 `target/` 的预埋挂测试也扫进来），始终带 `tests/` 参数。

## 把 targetRepo 指向真实仓库（试点：example-org/example-service）

1. 改 `conductor.config.json`：

```json
{
  "budgetUsd": 5,
  "maxTurns": 30,
  "testCommand": "npm test",
  "targetRepo": "/absolute/path/to/example-org/example-service",
  "models": { "plan": null, "maker": null, "verifier": null }
}
```

- `targetRepo`：相对路径基于本仓库根，建议直接写绝对路径；必须是干净的 git 仓库（conductor 会在里面建 `task/<id>` 分支和 worktree，merge 时合回当前分支）。
- `testCommand`：conductor 在 worktree 里亲自跑的 green gate 命令，只认 exit code。
- `models`：各角色留 `null` 继承 claude CLI 默认；可分别指定。
- 预算：`budgetUsd` 每任务累计上限（从 claude JSON 的 `total_cost_usd` 累加），`maxTurns` 每次 spawn 上限。

2. `node conductor/conductor.mjs new --kind feature --title "market-api 降本：okx api 降本还有什么优化点与建议"`，然后 `run` → 审批 spec → 照常走闸门。

## 目录结构

```
conductor/conductor.mjs   CLI 入口 + drain 循环（run/new/approve/reject/status/merge/retry）
conductor/lib/            state.mjs(frontmatter) claude.mjs(CLI 封装) lock.mjs git.mjs
conductor/stages/         每个 stage 一个 handler；decisions.mjs 是纯函数转移逻辑
conductor.config.json     预算/测试命令/target 仓库/模型
agents/                   plan / maker / verifier 的占位 prompt（prompt 工程不在本期）
state/queue|done|failed/  任务文件（唯一事实源）：YAML frontmatter + Markdown 正文
specs/<id>.md             feature 档 spec 草稿（审批后冻结副本进 dossier）
dossier/<id>/             案卷：spec.md、<role>-r<n>.json（plan/maker/verifier spawn 留档，
                          含原始 CLI JSON + started/done 双标记）、verify-r<n>.{md,verdict.json}、timeline.md
worktrees/<id>/           target 仓库的任务级 worktree（gitignore）
target/                   demo 用目标仓库（独立 git repo，预埋 bug；gitignore）
tests/                    node:test 单测 + fake-claude 集成测试
```

可靠性机制速览：先产物后状态（崩溃最坏重复读产物）；`mkdir state/.lock` 原子并发锁（mtime 30 分钟 stale 告警，人工删）；spawn 双标记 `started/done`（孤儿 started = 上次崩溃 → 转 FAILED_BOX（原因 crashed），`retry` 恢复，不留滞留任务）；green gate 不信 agent 口供；预算闸超限直接 FAILED_BOX；drain 步数上限（`maxDrainSteps`，默认 20/次 run）耗尽显式记日志，下次 run 续推。
