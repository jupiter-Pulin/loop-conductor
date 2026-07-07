# Subagent 行为规范附录（弱模型适用）

> 用途：追加到任意 subagent prompt 末尾，把 dossier 中实测的协议失败模式固化成硬规则，
> 让较弱模型跑出接近强模型的协议成功率。每条规则都对应一个真实事故（括号内为证据）。
> 本文件不被 conductor 自动加载；由 prompt 组装方按角色选段追加。

## 通用（所有角色）

1. **交付物之外零输出**。你的最终回复会被机器解析：要求 JSON 就只有 JSON（首字符 `{`，尾字符 `}`），要求 Markdown 全文就只有 Markdown 全文。任何解释、道歉、前后缀都是协议失败。（verifier 三连 invalid，task-20260705-001）
2. **轮次预算是硬约束**。撞上限时会话被当场截断，半成品直接进机械闸门。感觉任务做不完时，优先把当前改动收敛到「可编译、测试可跑」的最小闭合状态，再继续下一块。（11 个 maker r1 里 8 个 error_max_turns 截断）
3. **只信 prompt 里给的结构化输入**（冻结 spec、repair-context JSON、契约错误清单），不要去读人读叙事（verify-r\<n\>.md、timeline）自行推断。（契约 §7 纪律）
4. **不要重排已发编号**。AC-xxx / O-x 一经产出即冻结；修订时只能追加新编号，不得复用、重排旧编号——下游按编号点名裁决。
5. **拿不准就少做**：范围内做全，范围外一行不碰。「顺手修复」在这条流水线上等于制造额外验收面。

## 轮次预算极小的角色（committer 等 ≤4 轮）

6. **默认零工具直接产出**。prompt 已给全材料（规范全文、AC 枚举、diff --stat）；确需核对至多 1 次只读调用，然后立即输出交付物。在输出前耗尽轮次 = 浪费一次机会。（committer 两任务双 invalid 降级，task-20260706-004 / 20260707-001）

## maker 专属

7. **测试必须钉住新行为**：为新行为写的测试必须「基线红、实现绿」。写完自问：把我的实现改动撤掉，这个测试会挂吗？不会挂就是空转测试，test gate 会实测拦截并消耗一次 miss。（test gate vacuous，task-20260705-003）
8. **`.will-workflow/ac-tests.json` 每条 AC 都尽量给映射**：`ac_id` 必须逐字匹配 spec 枚举，`expect` 只有 `fail_on_baseline`（新行为）/ `pass_on_baseline`（回归守卫）两个值。映射缺失不 block，但 verifier 会对无机械证明的 AC 从严审计。
9. **repair-context 点名了 `ac_id` 就只修这些**：其余已 pass 的 AC 一行不动；绿灯换来的手段（删测试、削弱断言、跳过用例）一律禁止。

## 严格 JSON 裁决类角色（verifier / spec-verifier）

10. **先在心里把骨架填满再输出**：`criteria_results` 必须覆盖 prompt 给的 AC 枚举——不缺、不多、不重、不改序；每条 pass/fail 至少 1 条 evidence，evidence 的 file/line 必须真实存在（输出前自查一遍路径）。
11. **overall 与逐条一致**：全部 pass 才是 pass；任何 fail/unknown 时 overall 必须 fail。机械校验会核对这条一致性，不一致直接 invalid。

## 模型/引擎分工（R4 起，指导 prompt 组装方与实验设计，非 agent 行为规则）

12. **裁决类角色（verifier / spec-verifier）当前留强模型**：裁错的代价是 false pass 直达人审。替换低成本引擎必须先过 shadow 对照质量门（见下），未过门前只做观测不做裁决。
13. **格式化产出类角色（committer / 文案 / 机械转换）适合低成本模型**：材料已在 prompt 内给全、有确定性终审兜底（validateCommitMessage 降级机器文案）——错的代价是降级不是事故。
14. **探索/实现类角色（maker / setup）中配模型 + 强 harness**：真实约束是轮次预算与闸门（green/test gate），不是模型上限；提升手段优先给「续跑、repair-context 精准化」这类 harness 能力，其次才是换更强模型。

## shadow 实验通用模板（换任何角色引擎前照抄）

- 同输入：复用主角色的 prompt 构造函数，不给 shadow 单独写 prompt（否则对照失效）。
- 同契约：shadow 输出过与主链完全相同的校验器；invalid 本身就是对照指标，不重试打捞。
- 零影响：主产物落盘后才跑 shadow；shadow 一切失败只留证据文件与 timeline，不碰 runtime 计数、stage、repair-context。
- 逐项对照落盘：`*.shadow-compare.json` 记 per-item 一致/分歧/high-risk（shadow 更宽松即 false-pass 风险形态）。
- 切换质量门（全过才提切换）：≥20 item 级对照或 ≥5 真实轮；3 个 high-risk 分歧即停；shadow invalid 率 ≤ 主链；unknown 率不升；无一例「shadow 宽松且人工复核判主链对」。
