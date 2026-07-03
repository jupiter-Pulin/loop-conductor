# Tech Spec: Test Gate —— 基线空转测试探针（vacuous-test probe）

## Summary

green gate 只证明「测试绿」（`conductor/stages/shared.mjs::runGreenGate` 只认 exit code），verifier 只做静态对照且被禁跑测试（`agents/verifier-agent.md`）。两者合起来仍然证明不了一件事：maker 为 AC 补的测试**真的能区分改前改后**。一个空转（vacuous）测试——mock 掉了变更路径、或者干脆断言了旧行为——在新旧代码上都绿，green gate 与 verifier 都拦不住；更糟的对抗情形是 maker 削弱或删除既有红测试来换绿灯。

本特性引入第二道确定性闸「test gate」：green gate 通过后，conductor 在 `task.json` 的 `baseBranch` 基线上开一个临时 detached git worktree，把任务 worktree 中**被改动的测试文件**叠加过去，复跑同一 `testCommand`。基线上仍然 exit 0 ⇒ 当前测试套件区分不了新旧代码 ⇒ 判 vacuous，不进 VERIFY，走 maker miss 阶梯退回修复。思路来自 will-session-workflow 的 `test-gate` skill（`skills/test-gate/scripts/probe-ac-tests.mjs`），机械化为 conductor 的整套件口径。

## 关键设计决策（对应立项四问）

1. **新 stage 还是 VERIFY 前置步骤？都不是。** test gate 是 READY / FIXING handler 内、green gate 通过之后的第二道 gate，与 green gate 完全同构：确定性、conductor 亲跑、只认 exit code、无 agent spawn、无人类闸门。本状态机中 stage 是 spawn / 审批 / 崩溃恢复的幂等单元，test gate 三者皆无，不值得一个 stage；放进 VERIFY handler 则会让 verifier 协议失败重试重复跑探针，且幂等分支（verdict 已存在直接消费）会绕过探针。落点保证：每个 maker 轮次恰好探测一次，短路顺序 green gate → test gate → verifier。
2. **失败走哪条阶梯？** vacuous 与 green gate fail、verdict fail 共用同一条 maker miss 阶梯（`makerMissNext` / `maxMakerMisses`），不新增计数器。一个轮次至多消耗一次 miss（先失败者短路，后面的 gate 不再跑）。阶梯未耗尽 → FIXING（miss==1 仍是 resume 档）；耗尽 → FAILED_BOX（`maker_misses_exhausted`）。vacuous 轮不得 spawn verifier（省钱且防止静态对照给空转测试背书）。
3. **产物落 dossier 什么文件？** 每次探针（无论 verdict）写 `dossier/<id>/test-gate-r<n>.json`：round、command、base_branch、base_commit（`merge-base(baseBranch, HEAD)`）、overlay（globs / copied / deleted）、exit_code、timed_out、verdict（`vacuous|falsifies|error`）、stdout/stderr tail（沿用 `greenGateOutputTailBytes` 上限）、started/finished_at。vacuous 时另写 `repair-context-r<n>.json`，`source: "test_gate"`、`failed_criteria: []`、只存 `test_gate_ref`（存储层去重，prompt 层展开摘要——与 green_gate_ref 同构）。`conductor retry` 时随其他轮次产物归档进 `attempts/<ts>/`。
4. **与 maxMakerMisses 阶梯的关系？** 完全并入：见第 2 条。`runtime.json` 不新增字段。

## 实验语义

- **实验 = 基线代码 + 当前测试。** 测试文件识别：`git diff --name-status base...HEAD` 的路径 ∩ `testGateTestGlobs`（默认 `['test/**','tests/**','**/*.test.*','**/*.spec.*']`）。A/M/T 复制进探针 worktree，D 在探针 worktree 删除，R 旧路径删、新路径复制。非测试文件一律不动（保持基线代码）。
- overlay 为空（maker 没动测试）时就是在基线上跑现有套件：bugfix 预置红测试的场景天然 falsifies——套件本身已能区分新旧。
- **单侧闸门**：只有「基线上 exit 0」才 block（vacuous）。基线红、超时、探针基建失败（`git worktree add` 失败等，verdict `error`）一律放行进 VERIFY，产物与 timeline 留痕供人工归因——绝不因基线本身烂或环境抖动误伤 maker。这与 skill 版 gate 语义一致（blocked 仅由 vacuous 触发）。
- 覆盖的对抗面：空转新测试、削弱既有断言、删除红测试（哪怕补个 trivial 绿测试）都会让「基线 + 当前测试」全绿而被拦截。

## Non-goals

- 不做 per-AC 粒度探针（conductor 没有 ac-evidence.json；整套件口径证明「套件区分基线与 HEAD」，不证明「每条 AC 各有钉住它的测试」）。
- 不做 mock-boundary 判断（skill 里那一步是人工判断，无法机械化）、不做 coverage 对照。
- 不喂 verifier：verifier 契约、prompt、verdict schema 全部不变。
- 不做 per-task 开关（先只做全局 `testGateEnabled`；task.json 不可变快照不加字段）。

## Contract

### Entry Points

| Function | Change | Notes |
| --- | --- | --- |
| `conductor/lib/test-gate.mjs` | add | 纯函数零 IO：`DEFAULT_TEST_GLOBS`、`matchesTestGlobs(path, globs)`、`classifyTestFileChanges(nameStatus, globs)` → `{ copy, remove }` |
| `stages/decisions.mjs::testGateVerdict` | add | 纯判定：`exitCode === 0 ? 'vacuous' : 'falsifies'` |
| `lib/git.mjs::mergeBaseWith` / `addDetachedWorktree` | add | 基线提交解析 + detached 探针 worktree；失败不抛（探针基建失败 → verdict `error`） |
| `stages/shared.mjs::runTestGateProbe(ts, cfg, round)` | add | 副作用探针：建/清 worktree、overlay、复用 `runGreenGate` 跑 testCommand、写 `test-gate-r<n>.json`；disabled 返回 null；worktree 在 finally 必清理 |
| `stages/shared.mjs::buildRepairContext` | modify | 新增 `source: 'test_gate'` 分支（`test_gate_ref`，指示 maker 补/强化在基线上会失败的测试） |
| `stages/shared.mjs` prompt 展开 | modify | repair prompt 层把 `test_gate_ref` 展开为摘要（command/base_commit/exit_code/overlay/tails），同 green_gate_ref |
| `stages/ready.mjs` / `stages/fixing.mjs` | modify | green pass 后插入探针：vacuous → repair-context(test_gate) + miss 阶梯路由；否则照常 → VERIFY |
| `conductor.mjs::loadCfg` | modify | 新默认：`testGateEnabled: true`、`testGateTestGlobs: DEFAULT_TEST_GLOBS` |
| `conductor.mjs::archiveRoundArtifacts` | modify | 归档正则纳入 `test-gate-r\d+\.json` |
| `agents/maker-agent.md` | modify | 声明 test gate 的存在与 `source: "test_gate"` 修复约束（测试必须在基线上失败；禁止削弱/删除既有测试换绿） |
| `tests/fixtures/fake-claude.mjs` | modify | 新 action `deleteFile`（对抗性删测试场景需要） |

### 不变量

- probe 绝不触碰任务 worktree 与 target 主 checkout：只在独立 detached worktree 内跑，结束（含异常路径）必移除。
- 状态决策仍全部在 `decisions.mjs` 纯函数；探针只产出 verdict 字符串，路由由 handler 依 `makerMissNext` 完成。
- `runtime.json` 无新字段；dossier 契约只增不改。
- `testGateEnabled: false` 时行为与现状完全一致（无探针产物、无额外测试运行）。

## Acceptance Criteria

- [ ] AC-001: green gate 通过后，conductor 在 `merge-base(baseBranch, HEAD)` 的 detached 探针 worktree 里按 glob 叠加/删除改动的测试文件并复跑 `testCommand`；无论结果都写 `dossier/<id>/test-gate-r<n>.json`（verdict/exit_code/overlay/base_commit/tails，tail 受 `greenGateOutputTailBytes` 约束）；探针 worktree 结束后不残留。
- [ ] AC-002: vacuous（基线 exit 0）→ 写 `repair-context-r<n>.json`（source=test_gate、failed_criteria=[]、存储层只存 test_gate_ref）→ 走 maker miss 阶梯：未耗尽 FIXING（miss==1 resume，repair prompt 内嵌展开的 test_gate 摘要），耗尽 FAILED_BOX（maker_misses_exhausted）；vacuous 轮不得 spawn verifier。
- [ ] AC-003: 测试删除/削弱同样被拦：把红测试删掉换成 trivial 绿测试 → 探针在基线同步删除/叠加 → vacuous。
- [ ] AC-004: falsifies（基线非 0 / 超时）不 block，照常进 VERIFY；探针基建失败（worktree add 失败）verdict=error，同样放行且产物可归因。
- [ ] AC-005: `testGateEnabled: false` 完全跳过：无 test-gate 产物，既有路径行为不变。
- [ ] AC-006: glob 匹配、name-status 分类、verdict 判定为零 IO 纯函数，单测直击（含 A/M/D/R 分支与非测试文件忽略）。
- [ ] AC-007: `conductor retry` 把 `test-gate-r<n>.json` 随轮次产物归档进 `attempts/`。

## Rollout

默认开启（新增第二道闸属于收紧型变更，demo target 与既有集成测试的基线均为红套件，falsifies 放行，无行为回归）。逃生舱：`conductor.config.json` 置 `testGateEnabled: false`。已知代价：每个 green 轮次多跑一遍 `testCommand`（在基线 worktree），沿用 `greenGateTimeoutMs`。
