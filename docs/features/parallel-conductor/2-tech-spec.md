# Tech Spec: Parallel Conductor —— sync→async+streaming 运行时重构

## Summary

把 conductor 的 agent spawn 与 green gate 从同步阻塞(`spawnSync`)重构为异步流式(`spawn` + `--output-format stream-json`),在此地基上一次性解锁三件事:**多任务并行推进**(一个长 maker 不再挡住全队列)、**spy 观测**(运行中的 agent 不再是黑箱)、**活性检测**(inactivity 判死挂起,不误杀合法长任务)。同时先行落地两项并发正确性的前置修复:**JSON 原子落盘**与**box/stage 僵尸巡检**,并重做并行化暴露的四处单写者假设:全局锁自愈、per-task 变更锁、预算账本口径、setup gate 竞态。

为什么是现在:当前 `spawnSync` 无任何 wall-clock 机制,一个挂死的 claude CLI 或死循环测试会让 conductor 永久挂起且锁不释放;预算闸的成本入账发生在调用返回之后,对挂起完全盲(`conductor/lib/claude.mjs::runClaude` + `conductor/stages/shared.mjs::addCost`)。这是"能否无人值守持续运行"的第一道门槛,且并行、spy、活性检测三者依赖同一个 async/streaming 地基,分开做会重复推翻。

## Context

现状(事实源为代码与测试,详见 README 索引):

- **入口与 drain**:`conductor/conductor.mjs::cmdRun` 持全局锁(`state/.lock`,mkdir 原子),串行遍历 queue 任务逐个调 stage handler,一轮无 `changed` 即停;`maxDrainSteps` 是全局步数上限。
- **spawn**:`conductor/lib/claude.mjs::runClaude` 用 `spawnSync` 阻塞调用 claude CLI(`--output-format json`),无 timeout;`runClaudeWithRetry` 对瞬态失败(403/408/429/5xx/spawn error)退避重试,能续会话就续。
- **green gate**:`conductor/stages/shared.mjs::runGreenGate` 用 `spawnSync(shell:true)` 跑 `testCommand`,无 timeout,只认 exit code。
- **状态落盘**:`conductor/lib/state.mjs::saveRuntime/writeJson/writeFileEnsured` 直接 `writeFileSync`(非原子);`transitionState` 先写 `stage` 再 rename 目录,两步之间崩溃会留下「queue 里 stage=FAILED_BOX」的僵尸(FAILED_BOX handler 是 no-op,`cmdRetry` 的 queue 分支不重置 stage,永久卡死)。
- **锁**:`conductor/lib/lock.mjs`,stale(mtime>30min)只告警不自愈;kill -9 后锁残留需人工删除。
- **CLI 变更命令**:`approve/approve-setup/reject/merge/retry` 直接读写 runtime.json,不持任何锁——串行世界里靠"人在两次 run 之间操作"成立,并行长 run 下出现多写者竞争。
- **setup gate**:`conductor/stages/needs_target_setup.mjs` 以"draft 文件是否存在"防重复 spawn,串行下天然成立,并行下两个任务可并发各 spawn 一个 setup-agent。
- **预算**:per-task `spent_usd`,只在 spawn 前检查(`budgetExceeded`);成本入账在调用返回后。
- **测试挂载点**:`CLAUDE_BIN` 环境变量指向 `tests/fixtures/fake-claude.mjs`,全部集成测试零 token。

## Goals

- MUST:任何 agent spawn 与 green gate 都有确定性的退出路径——正常结束、inactivity 判死、wall-clock 兜底三者必居其一;conductor 进程不可能因子进程挂起而永久阻塞。
- MUST:多个任务可并行推进,受 `maxConcurrentTasks` 约束;单任务视角的状态机语义(阶梯、计数、路由、幂等重入)与现状完全一致。
- MUST:运行中每个 agent 的输出流式落盘 dossier,`conductor spy` 可在 run 进行中只读查看各任务的阶段、活动角色与最近活动时间。
- MUST:所有 JSON/文本落盘原子化(tmp+rename);`run` 启动时自动修复 box/stage 不一致的僵尸任务。
- MUST:全局锁具备 pid 活性自愈与心跳;CLI 变更命令与调度器之间以 per-task 锁串行化。
- SHOULD:run 级预算池(`runBudgetUsd`,默认关闭)在本 run 累计成本达到上限时停止发起新 spawn。

## Non-goals

- 不做执行沙箱(maker/green gate 仍在宿主机执行)——独立议题,接真实仓库前另立项。
- 不做测试篡改防护(maker 改测试文件的守卫)——独立议题。
- 不改 `ensureDossierSpec` 的 fallback spec 行为——独立议题(已知隐患,另行修复)。
- 不做多 conductor 进程并行(并行发生在单进程调度器内部;全局锁仍保证同一 state 目录只有一个 run)。
- 不做真模型 eval、prompt 工程、mid-flight 预算熔断(成本只能在事件粒度观测,killed spawn 成本按未知处理)。
- 不改 agents/*.md 的角色契约、verdict/spec 契约 schema、dossier 既有产物的文件名与字段语义。

## Contract

### Core Invariants

- `conductor/stages/decisions.mjs` 保持纯同步、零 IO;全部转移决策语义不变。并发只改变"谁在何时调 handler",不改变"handler 调决策后落什么盘"。
- **per-task 串行链**:同一任务同一时刻至多一个 step 在执行;run 期间该任务的 runtime.json 仅由其自身 chain 写入(CLI 变更命令经 per-task 锁串行化)。
- **先产物后状态**不变;所有 JSON/文本落盘经 tmp+rename 原子完成,任何时刻磁盘上不存在半写的 task.json/runtime.json/verdict/spec。
- dossier 契约只增不改:既有 `<role>-r<n>.json` 双标记(started/done)、verdict、green-gate、repair-context 的文件名与字段不变;新增 `<role>-r<n>.stream.jsonl` 与 spawn record 的 `killed`/`cost_unknown` 可选字段。
- green gate 只认 exit code,超时视为 fail(exit_code=null + timed_out=true),不发明第二真相源;人类闸门(approve/reject/merge)仍是唯一推过闸门的方式。
- 所有 console 输出行携带 `[<task-id>]` 前缀(并行下日志交错仍可归因)。

### API / Entry Points

| Endpoint / Function | Change | Notes |
| --- | --- | --- |
| `lib/claude.mjs::runClaude` | modify → `async runClaudeStream` | `spawn` + stream-json;新增 opts:`streamFile`、`inactivityTimeoutMs`、`wallClockMs`;返回形态兼容(`ok/exitCode/sessionId/costUsd/result/raw/error`)并新增 `killed: null\|'inactivity'\|'wall_clock'` |
| `lib/claude.mjs::runClaudeWithRetry` | modify → async | 阶梯语义不变;`isTransientFailure` 扩展:`killed` 非空视为瞬态;killed spawn 的部分流中解析出 session_id 且 num_turns>1 时按现有逻辑 resume |
| `lib/claude.mjs::buildClaudeArgs` | modify | `--output-format stream-json --verbose`;其余 flag 不变 |
| `stages/shared.mjs::runGreenGate` | modify → async | 新增 `greenGateTimeoutMs`;超时 kill 进程组,返回 `{ exitCode: null, timedOut: true, stdout, stderr }` |
| `stages/*.mjs` 全部 9 个 handler | modify → async | 签名 `(ts, cfg) => Promise<{changed}>`,内部逻辑与路由不变 |
| `conductor.mjs::cmdRun` | modify | drain 循环替换为调度器(见下);锁获取/释放与 status 收尾不变 |
| `conductor.mjs::cmdSpy`(`conductor spy`) | add | 只读快照:每个 queue 任务的 stage/活动角色/轮次/最近活动/spent |
| `conductor.mjs::cmdApprove/ApproveSetup/Reject/Merge/Retry` | modify | 变更前后持 per-task 锁;busy 时短重试后 exit 1 并明确提示 |
| `lib/state.mjs::writeJsonAtomic` / `writeFileAtomic` | add | tmp+rename;`saveRuntime/writeJson/writeFileEnsured/writeNewTask` 全部改走此路径 |
| `lib/state.mjs::patrolBoxStageConsistency` | add | run 启动时巡检:queue 中 stage=FAILED_BOX → 补搬 failed;stage=DONE → 补搬 done;记 timeline |
| `lib/lock.mjs::acquireLock` | modify | info.pid 不存活 → 自动清锁重获(stderr 记自愈);存活则维持现状拒绝 |
| `lib/lock.mjs`(心跳) | add | run 期间周期 touch 锁 mtime(`lockHeartbeatMs`),stale 判定基于心跳 |
| `lib/task-lock.mjs` | add | per-task mkdir 锁,路径 `dossier/<id>/.lock`(跨 box 移动稳定);调度器 step 与 CLI 变更命令共用 |
| `lib/scheduler.mjs` | add | 并发 chain 调度:eligibility、semaphore(maxConcurrentTasks)、keyed mutex(setupProfileKey)、run 级成本账本、quiescence 终止 |
| `tests/fixtures/fake-claude.mjs` | modify | 支持 stream-json 输出;新增场景开关:挂起(hang)、慢而活着(slow-alive)、超长(wall-clock) |

### 调度器语义(替代 drain 循环)

- 每个 queue 任务一条 **chain**:`while (steps < maxStepsPerTask) { r = await handler(ts, cfg); if (!r.changed) break; }`。chain 内严格串行,天然保住单任务幂等与单写者。
- 同时运行的 chain 数 ≤ `maxConcurrentTasks`;超出的任务排队等槽位。
- 终止条件(quiescence):所有 chain 结束且无排队任务 → run 退出(等价现 drain 的"一轮无变化即停",人类闸门天然停住)。
- `maxStepsPerTask` 耗尽:显式日志 + 状态已落盘 + 下次 run 续推(对齐现 `maxDrainSteps` 语义,原全局键废弃,配置中出现时告警一次并忽略)。
- handler 抛异常:记日志、park 该 chain,不影响其他任务(对齐现行为)。
- **setup keyed mutex**:`NEEDS_TARGET_SETUP` 的 spawn 段以 `setupProfileKey(cfg)` 为 key 互斥;获得锁后必须重查 `hasApprovedSetupProfile` 与 draft 存在性再决定是否 spawn。
- **run 级账本**:调度器持有本 run 成本累加器;`runBudgetUsd` 非 null 且累计达到上限 → 不再发起新 spawn(在飞的照常完成),显式日志;per-task `budgetUsd` 闸门不变。

### 活性检测与 kill 语义

- **inactivity**:子进程连续 `inactivityTimeoutMs` 无任何 stdout/stderr 字节 → 判死。慢而活着的任务持续产生 stream 事件,不会命中。
- **wall-clock 兜底**:总时长超 `spawnWallClockMs` 即使有输出也判死(防"活着但永远绕圈")。
- kill 顺序:SIGTERM → 宽限 10s → SIGKILL,针对进程组(spawn 时 `detached: true`)。
- 判死后果:视为**瞬态失败**进 `runClaudeWithRetry` 阶梯(重试可能恢复;耗尽走既有 `spawn_transient_exhausted` 收箱)。**不是** maker miss,不算 verifier invalid。
- green gate 超时是**独立语义**:它是 maker 产物的属性(死循环测试),不是基础设施故障 → 按 gate fail 走 miss 阶梯(repair-context source=green_gate 不变,green-gate record 携带 timed_out),绝不按 crashed 收箱。

### Data / Cache / External Services

- 新增数据:`dossier/<id>/<role>-r<n>.stream.jsonl`(原始 stream-json 逐行追加,append-only,spy 与人工排查用;状态决策绝不解析它——决策仍只依据最终 result 事件与既有产物)。
- spawn record 新增可选字段:`killed`(判死原因)、`cost_unknown: true`(killed/不可解析时成本按 0 入账并在 timeline 说明;预算口径明确为**下界**)。
- green-gate record 新增可选字段:`timed_out: true`(此时 `exit_code: null`)。
- 配置新键(`loadCfg` defaults):`maxConcurrentTasks: 3`、`inactivityTimeoutMs: 600000`、`spawnWallClockMs: 14400000`、`greenGateTimeoutMs: 1800000`、`lockHeartbeatMs: 60000`、`maxStepsPerTask: 20`、`runBudgetUsd: null`。
- 错误行为:claude CLI 不支持 stream-json(旧版本)→ 首事件解析失败即 fail-fast,错误信息明确指出 CLI 版本问题,不静默降级。

### Compatibility

- 状态机语义、runtime.json 字段、dossier 既有产物、agents/*.md、verdict/spec 契约:全部不变。既有 integration case 必须在新运行时下全绿(见 AC-018)。
- 配置:新键全部有默认值;`maxDrainSteps` 废弃(出现时告警一次并忽略)。
- CLI:新增 `spy` 子命令;既有子命令行为不变,仅变更命令新增 busy 时的明确失败路径。
- 迁移:无数据迁移。旧任务目录/dossier 原样可用;stream 文件只对新 spawn 产生。

## Acceptance Criteria

分组:AC-001~004 为 P0 前置(可独立先行合入),AC-005~018 为 P1 运行时(见 Rollout / Phasing)。

- [ ] AC-001: `state.mjs` 全部落盘走 tmp+rename:单测断言写入后目标目录无 `*.tmp*` 残留、内容完整,且 `saveRuntime/writeJson/writeFileEnsured/writeNewTask` 均经原子路径(直接 `writeFileSync` 目标文件的旧路径不再存在)。
- [ ] AC-002: 构造 queue 中 stage=FAILED_BOX 的任务目录(模拟 rename 前崩溃),`conductor run` 启动巡检自动将其补搬到 `state/failed/` 并记 timeline;随后 `conductor retry` 正常复活。stage=DONE 同理补搬 `state/done/`。
- [ ] AC-003: 锁 info.json 的 pid 不存活时,新 `conductor run` 自动清除残锁、正常获锁并在 stderr 说明自愈;pid 存活时维持现状(拒绝并退出,exit 1)。
- [ ] AC-004: run 期间锁 mtime 以 `lockHeartbeatMs` 周期刷新(测试经注入的心跳间隔观测);长 run(超过 30 分钟等价条件)不再被误判 stale。
- [ ] AC-005: 每次 agent spawn 产生 `dossier/<id>/<role>-r<n>.stream.jsonl`(逐事件追加);spawn record `<role>-r<n>.json` 的既有字段(started/done/ok/session_id/cost_usd/raw)形态与现有测试断言完全一致。
- [ ] AC-006: 子进程连续 `inactivityTimeoutMs` 无输出 → 被 kill(进程组),spawn record 记 `killed:'inactivity'`,判为瞬态进重试阶梯;部分流含 session_id 且 num_turns>1 时重试以 `-r` 续会话;重试耗尽走既有 `spawn_transient_exhausted` 收箱。
- [ ] AC-007: 持续有输出但总时长超 `spawnWallClockMs` → 被 kill,`killed:'wall_clock'`,同瞬态处理。
- [ ] AC-008: 慢而活着不误杀:输出间隔 < inactivity、总时长 > inactivity 且 < wall-clock 的 spawn 正常完成,`killed:null`,任务正常推进。
- [ ] AC-009: green gate 超过 `greenGateTimeoutMs` → kill 进程组,`green-gate-r<n>.json` 记 `timed_out:true`、`exit_code:null`,按 gate fail 走 maker miss 阶梯(写 repair-context source=green_gate),不收箱为 crashed、不判瞬态。
- [ ] AC-010: 两个 READY 任务、`maxConcurrentTasks>=2` 时并行推进(fake-claude 记录的 spawn 时间窗重叠证明并发);`maxConcurrentTasks:1` 时退化为串行且所有既有 case 语义不变。
- [ ] AC-011: 同一任务的相邻 step 不重叠(调度器单测:慢 handler 期间该任务不被再次调度);run 期间任务 runtime.json 仅由其 chain 写入。
- [ ] AC-012: 所有任务停在人类闸门/终态后 run 自然退出;`maxStepsPerTask` 耗尽时显式日志、状态落盘、下次 run 续推;配置含废弃键 `maxDrainSteps` 时告警一次并忽略。
- [ ] AC-013: 某任务 step 进行中,对该任务执行 `approve/retry/merge` → 短重试后 exit 1 并明确提示"任务正被推进";无 step 进行时 CLI 行为与现状一致;任何情况下不产生 runtime.json 半写或丢失更新。
- [ ] AC-014: 同 repo 两个任务同时处于 NEEDS_TARGET_SETUP → 仅 spawn 一次 setup-agent,两任务都停在 AWAIT_SETUP_APPROVAL;`approve-setup` 后两任务各自进入自然入口。
- [ ] AC-015: killed/不可解析 spawn 的 record 记 `cost_unknown:true`、成本按 0 入账且 timeline 注明"成本未知(下界口径)";per-task `budgetUsd` 闸门行为不变(既有 budget case 全绿)。
- [ ] AC-016: 配置 `runBudgetUsd` 后,本 run 累计成本达到上限 → 不再发起新 spawn(在飞的完成),显式日志;默认 null 时无任何行为变化。
- [ ] AC-017: run 进行中另开进程执行 `conductor spy` → 输出每个 queue 任务的 id/stage/活动角色与轮次/最近活动时间/spent;纯只读,不取锁,不影响 run。
- [ ] AC-018: 既有全部 integration case(happy-path、feature-flow、setup-spec-loop、spec-contract-gate、green-gate、verifier-fail、verifier-invalid、retry-ladder、crash-reentry、budget、worktree-harness、verifier-diff-cap、transient-retry、lock、drain-cap 的续推语义)在新运行时下断言语义不变地通过(fake-claude 适配 stream 输出属测试基建,不得放宽断言)。

## Implementation Notes

| Area | Files | Notes |
| --- | --- | --- |
| 原子落盘 + 巡检 | `conductor/lib/state.mjs` | `writeJsonAtomic/writeFileAtomic`(同目录 tmp,`fs.renameSync`);`patrolBoxStageConsistency(cfg)` 在 `cmdRun` 获锁后调用 |
| 锁自愈 + 心跳 | `conductor/lib/lock.mjs` | `process.kill(pid, 0)` 探活(ESRCH → 清锁);心跳 interval 在 run 内启动、finally 清理;间隔可注入供测试 |
| 流式 spawn | `conductor/lib/claude.mjs` | `spawn(detached:true)` + readline 逐行;每行刷新 lastActivity 并 append 到 streamFile;`result` 事件组装既有返回形态;两个 timer(inactivity 滑动、wall-clock 固定);kill 走进程组 |
| per-task 锁 | `conductor/lib/task-lock.mjs`(新) | mkdir `dossier/<id>/.lock`;`withTaskLock(cfg, id, fn)`;CLI 侧 3×200ms 重试后失败 |
| 调度器 | `conductor/lib/scheduler.mjs`(新) | chain/semaphore/keyed-mutex/账本;不含任何 stage 业务逻辑;可单测(注入 fake handler) |
| handler async 化 | `conductor/stages/*.mjs`、`stages/shared.mjs` | 机械 async/await 化;`runGreenGate` 改 async+timeout;`runMakerRound` 传入 streamFile 与活性参数;路由逻辑零改动 |
| CLI | `conductor/conductor.mjs` | `cmdRun` 换调度器;`cmdSpy` 新增;变更命令包 `withTaskLock`;config 新键与废弃键告警 |
| 测试基建 | `tests/fixtures/fake-claude.mjs`、`tests/helpers/env.mjs` | fake 支持 stream-json + hang/slow-alive/wall 场景开关(环境变量);活性阈值在测试里调到毫秒级 |
| 新测试 | `tests/integration/{parallel-scheduling,liveness-kill,green-gate-timeout,crash-patrol,cli-task-lock,setup-race,spy,run-budget}.test.mjs`、`tests/unit/{scheduler,task-lock,state-atomic,lock-liveness}.test.mjs` | 对应 AC 分组;`drain-cap.test.mjs` 重构为 steps-per-task 语义 |

不可改动:`conductor/stages/decisions.mjs` 的纯函数性与全部路由语义;`agents/*.md`;dossier 既有产物 schema;`conductor/hooks/*` 与 spec 契约门逻辑。

## Edge Cases

| Case | Expected Behavior |
| --- | --- |
| maker 被 inactivity kill,worktree 半改 | 与现有非瞬态硬失败一致:重试(可能 resume);耗尽收箱 `spawn_transient_exhausted`;绝不静默丢弃 worktree 改动 |
| stream 文件半行/损坏 | spy 容忍(跳过坏行);状态决策不受影响(只依据 result 事件与既有产物);无 result 事件 = spawn 失败 |
| claude CLI 版本不支持 stream-json | 首事件解析失败 fail-fast,错误信息指明 CLI 版本;不静默回退 json 模式 |
| kill 时进程已自然退出(竞态) | 以进程退出事件为准,`killed` 不标记;结果按正常路径解析 |
| 巡检发现的僵尸目录同名已存在于目标 box | 不覆盖:告警并跳过,留人工处理(与"任务目录损坏"同级) |
| approve 与调度器同瞬间转移进 AWAIT_SPEC_APPROVAL | per-task 锁串行化;approval flag 落盘后由下一次 step 消费,语义与现状一致 |
| 两个 conductor run 同时启动 | 全局锁拒绝第二个(现状不变);pid 死锁残留则自愈后获锁 |
| runBudgetUsd 达上限时有在飞 spawn | 在飞的完成并入账;仅阻止新 spawn;任务停留原 stage 等下次 run |
| `maxConcurrentTasks` 配 0 或负数 | 按 1 处理并告警(不成为静默停摆) |

## Verification Plan

- 单测:`tests/unit/state-atomic.test.mjs`(AC-001)、`tests/unit/lock-liveness.test.mjs`(AC-003/004)、`tests/unit/scheduler.test.mjs`(AC-011/012 的调度语义)、`tests/unit/task-lock.test.mjs`(AC-013 锁原语)、`tests/unit/claude.test.mjs` 扩展(stream 解析、killed 判定、transient 扩展,支撑 AC-006/007/008)。
- 集成:`crash-patrol`(AC-002)、`liveness-kill`(AC-006/007/008,fake-claude hang/slow-alive 场景 + 毫秒级阈值)、`green-gate-timeout`(AC-009,死循环测试命令)、`parallel-scheduling`(AC-010,fake 记录时间戳断言重叠)、`cli-task-lock`(AC-013)、`setup-race`(AC-014)、`run-budget`(AC-015/016)、`spy`(AC-017)。
- 回归:全量既有 integration 套件在新运行时下跑通(AC-018);特别对照 `transient-retry`(阶梯语义)、`crash-reentry`(双标记语义)、`budget`(per-task 闸门)。

```bash
npm test                                   # 全量(根目录跑,勿裸 node --test)
node --test tests/integration/liveness-kill.test.mjs   # 单独验活性
```

## Rollout / Phasing

1. **P0(AC-001~004)先行合入**:原子落盘、巡检、锁自愈/心跳。纯加固,不改行为面,现有测试全绿即可合。它们是并发正确性的前置条件。
2. **P1 运行时(AC-005~018)一个分支完成**:claude.mjs 流式化 → fake-claude 适配 → handler async 化 → 调度器替换 drain → CLI 锁与 spy。P1 内部不可拆分合入(半异步半同步的中间态没有可绿的测试基线)。

## Open Questions

| Question | Default Decision | Impact |
| --- | --- | --- |
| inactivity 默认阈值 | 600s(可配) | 过小误杀深思考的 agent;过大延迟发现挂起。流式事件粒度下 600s 已非常保守 |
| spy 是否带 `--watch` 轮询 | 本期一次性快照;watch 后续再加 | 只影响观测体验,不影响契约 |
| killed maker 是否总是 resume | 沿用现有瞬态逻辑(有 session_id 且 num_turns>1 才 resume) | 改为总是冷启动会浪费已有进展;改为总是 resume 可能续到坏状态 |
| `runBudgetUsd` 是否本期实装 | 实装但默认 null(关闭) | 不实装则并行下缺 run 级总闸,只有 per-task 闸 |
| per-task 锁位置 | `dossier/<id>/.lock`(跨 box 移动稳定) | 放 state/<box>/<id>/ 会随 rename 移动,复杂化 |
