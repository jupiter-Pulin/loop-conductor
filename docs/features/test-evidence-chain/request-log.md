# Request Log: 测试证据链三分落地（A 批 prompt 层 + B 批 per-AC 机械探针）

## Scope

按一次性任务 spec（`~/.claude/tmp/2-tech-spec-test-evidence-chain.md`，不入仓库文档体系）落地：

- A 批（prompt / 约定层）：spec 逐 AC 声明验证级别尾注（spec-agent 产出、spec-verifier 审核）；verifier 增加逐 AC 测试证明力审计维度；`buildVerifierPrompt` 嵌入当轮 test gate 探针机械记录。
- B 批（机械层）：maker 在 worktree 写 `.will-workflow/ac-tests.json`（AC→测试映射，harness exclude 覆盖）；conductor test gate 探针升级为逐 AC 定向探测（方向感知：`fail_on_baseline` 基线必须红 / `pass_on_baseline` 基线必须绿），映射缺失/非法降级 v1 suite 模式。

Non-goals（未做，按 spec）：无新 agent 角色 / stage / spawn；spec-doc/v1、verifier-verdict/v1 不动；无 coverage/mutation；miss 阶梯语义与 `makerRound` 不变量不动；无映射原地重试通道。

## Controlling Docs

- `~/.claude/tmp/2-tech-spec-test-evidence-chain.md`（本次唯一任务契约，AC-001~014）。
- `AGENTS.md` / `README.md` 仓库铁律（单一裁判、测试先行、npm test、原子落盘、README 只做索引）。

## AC Evidence

| AC ID | Status | Proof | Files | Notes |
| --- | --- | --- | --- | --- |
| AC-001 | pass | `npm test` 全绿（155 tests，无既有断言改动） | `agents/spec-agent.md` | 验收标准写作规则新增「（验证级别：X）」逐字尾注 + 五值枚举 + 选择判据（下游 API/数据库/外部服务 → 集成或 E2E；行为保持 → 回归守卫）。 |
| AC-002 | pass | 纯 prompt 改动，人工核对 | `agents/spec-verifier-agent.md` | 新增维度 7「测试级别匹配度」：判据含下游 API、数据库变更两条；要求 finding 引用具体 AC 编号。 |
| AC-003 | pass | 纯 prompt 改动，人工核对 | `agents/verifier-agent.md` | 新增「逐 AC 测试证明力审计」段：对照声明级别静态读测试、判 mock 边界与断言质量，用现有 fail/unknown + reason + evidence（测试文件行号）表达；「不跑测试」原文保留。 |
| AC-004 | pass | `tests/integration/test-gate.test.mjs`（探针段两形态断言）+ `tests/integration/test-gate-per-ac.test.mjs` | `conductor/stages/shared.mjs::buildVerifierPrompt` | 记录存在 → 固定标题段（去 stdout/stderr tail）；`testGateEnabled=false` → 无该段。 |
| AC-005 | pass | `git diff` 核对：`conductor/lib/spec-contract.mjs` 零变更；`decisions.mjs` 仅新增纯函数（validateVerifierVerdict 未动）；runtime.json 无新字段；dossier 文件名集合不变 | — | `test-gate-r<n>.json` 仅增量字段（schema_version 保持 1）。 |
| AC-006 | pass | `node --test tests/unit/test-gate.test.mjs`：合法分支 + 全部非法分支（非对象/schema_version≠1/entries 非数组/ac_id·command 非法/expect 非枚举/ac_id 重复/越界）绝不抛错 | `conductor/lib/test-gate.mjs`（`AC_TESTS_MAPPING_PATH`、`validateAcTestsMapping`）, `tests/unit/test-gate.test.mjs` | 单一裁判，零 IO。 |
| AC-007 | pass | `tests/integration/test-gate-per-ac.test.mjs`「映射不进 diff 不进 merge」case | `agents/maker-agent.md`, `tests/integration/test-gate-per-ac.test.mjs` | maker prompt 按尾注写映射（回归守卫 → pass_on_baseline，不可自动化 → 不写条目）；断言 diff 无 `.will-workflow/`、merge 后 target 主分支无该目录。 |
| AC-008 | pass | 同上 case：`mode='per-ac'`、逐条 exit code、`exit_code=null`（不再跑全量基线复跑） | `conductor/stages/shared.mjs::runTestGateProbe` | 映射有效时在 merge-base detached worktree（含测试 overlay）逐条执行 `entries[].command`。 |
| AC-009 | pass | per-ac vacuous case（FIXING miss=1 + repair prompt 点名 ac_id）+ 阶梯耗尽 case（FAILED_BOX/maker_misses_exhausted）+ `tests/unit/shared.test.mjs` | `conductor/stages/shared.mjs::buildRepairContext`, `conductor/stages/ready.mjs`, `conductor/stages/fixing.mjs` | `failed_criteria` 精确到 ac_id；fake-claude 日志断言 FIXING prompt 含该 ac_id 与 per_ac 摘要。 |
| AC-010 | pass | `tests/integration/test-gate.test.mjs`（missing → suite，vacuous 仍按 v1 block）+ per-ac 文件「映射非法」case（invalid + mapping_errors，miss=0） | `conductor/stages/shared.mjs` | 两种降级均不因映射本身 miss++。 |
| AC-011 | pass | per-ac 文件「fail-open」两 case + `tests/unit/test-gate.test.mjs` 方向表 | `conductor/stages/decisions.mjs::perAcProbeVerdict/perAcGateVerdict` | worktree 创建失败 → 顶层 error 放行；单条超时 → 该条 error 不计 block；guard_broken/unmapped 放行留痕。 |
| AC-012 | pass | per-ac 文件：混合场景（falsifies+guard_holds → VERIFY）与 vacuous 场景（→ FIXING miss=1） | `tests/integration/test-gate-per-ac.test.mjs` | fake-claude 剧本 `actions.writeFile` 落映射与测试文件。 |
| AC-013 | pass | per-ac 文件：`per_ac` 记 `{ac_id, verdict:'unmapped'}` 且 verifier prompt 含 `"verdict": "unmapped"` | `conductor/stages/shared.mjs` | 不 block，经 AC-004 嵌入段可达 verifier。 |
| AC-014 | pass | 本文件 + README 入口/case 表增行 | `README.md` | 无新增长说明文档。 |

## Changes

- `conductor/lib/test-gate.mjs`：新增 `AC_TESTS_MAPPING_PATH`、`AC_TEST_EXPECTS`、`validateAcTestsMapping`（映射校验唯一裁判，零 IO、绝不抛错）。
- `conductor/stages/decisions.mjs`：新增 `perAcProbeVerdict`（方向表）与 `perAcGateVerdict`（顶层聚合：任一 vacuous → vacuous）。
- `conductor/stages/shared.mjs`：`runTestGateProbe` 读映射走 per-AC 定向探测 / 降级 suite（record 增量字段 mode/mapping_status/mapping_errors/per_ac）；`buildRepairContext(test_gate)` per-ac 模式填充 `failed_criteria`；`repairContextForPrompt` 展开附 per_ac 摘要；`buildVerifierPrompt` 嵌探针机械事实段。
- `conductor/stages/ready.mjs` / `fixing.mjs`：把 probe 传入 `buildRepairContext`（路由分支结构零改动）。
- `agents/spec-agent.md` / `spec-verifier-agent.md` / `verifier-agent.md` / `maker-agent.md`：A 批三份维度 + B 批 maker 映射指示。
- 测试：`tests/unit/test-gate.test.mjs`、`tests/unit/shared.test.mjs` 扩展；`tests/integration/test-gate.test.mjs` 补 AC-004/010 断言；新增 `tests/integration/test-gate-per-ac.test.mjs`（6 case）。

## Verification

```bash
npm test
```

Result: pass，155 tests（A 批与 B 批完成后各全量跑一次，最终一次 155/155 全绿）。

## Blockers

None.

## Remaining Work

- Open questions 按 spec 默认决定落地：per-AC 模式不跑全量基线复跑、guard_broken 不 block、unmapped 不 block（先收集 dossier 数据）、验证级别尾注不进 spec-doc/v2。
- 手工 demo（`npm run conductor -- new/run`）未跑：需真 Claude CLI 消耗 token，测试链已用 fake-claude 覆盖全部机械路径。
