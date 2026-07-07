# Codex verifier shadow 设计（R4-E11）

状态：spike 已落地（opt-in，默认关闭），等待真实对照样本。
假设：Codex（GPT 系）verifier 在不降低验收正确率、不增加协议失败、不提高 false pass 风险的前提下，降低 verifier 成本和/或耗时。

## Q1 当前 verifier 的完整输入（`shared.mjs::buildVerifierPrompt`，verify.mjs:43）

1. 角色 prompt：`agents/verifier-agent.md` 全文。
2. 冻结 spec 全文：`dossier/<id>/spec.md`（唯一契约）。
3. AC 枚举：conductor 从冻结 spec 机械枚举（`AC-xxx: text` 行，verifier 必须无缺无多逐条裁决）。
4. worktree diff：`git diff <base>...HEAD` 内嵌；超 `verifierDiffMaxBytes`（200KB）降级为 name-status 清单 + 按文件自查指令。
5. test gate 探针机械事实：`test-gate-r<n>.json` 去 stdout/stderr tail 后内嵌（存在时）。
6. verdict 契约骨架：`verifier-verdict/v1` 字段骨架由 `decisions.mjs` 生成内嵌。
7. 输出纪律：最终回复首字符 `{` 尾字符 `}`，无围栏无叙事。
运行时约束：cwd=任务 worktree；工具硬限制 `VERIFIER_TOOLS`（只读 + git diff/log）；不许跑测试；model=`models.verifier`（现 opus-4.8）。

## Q2 Codex 能否接收同等输入 —— 能（真机已证）

- 传输形态：`codex exec`（CLI 非交互）而非 codex MCP server。理由：conductor 是无头编排器，MCP 接入需内嵌 JSON-RPC client；`codex exec` 是同一 Codex 引擎的批处理形态，参数一一对应：prompt 走 stdin（`-` 哨兵，同 claude.mjs 防 argv 上限）、`-s read-only` 只读沙箱（对应 VERIFIER_TOOLS 只读约束）、`-C <worktree>`（同 cwd）、`--json` JSONL 事件流（同 stream-json）、`-o` 最终回复落文件、`-m` 模型覆盖。
- 本机 codex-cli 0.142.1；真机 smoke（2026-07-07）：read-only 沙箱下 6.0s 返回严格 JSON，usage 事件可捞（input 13983 / output 158 tokens）。
- prompt 完全复用主 verifier 的 `buildVerifierPrompt` 输出——同输入不同引擎，是干净的对照实验设计。

## Q3 输出能否稳定转换为 verifier-verdict/v1 —— 同一份校验器裁决

- shadow 输出走与主 verifier 完全相同的 `parseStrictJson + validateVerifierVerdict(expectedAcIds)`；只有过契约的 verdict 才落 `verify-r<n>.codex-shadow.verdict.json`。
- 不过契约 → `verify-r<n>.codex-shadow.invalid.json`（kind=protocol，含 errors + raw）——这本身就是「JSON invalid 率」指标的数据。
- 备选强化（未启用）：`codex exec --output-schema <file>` 可用 JSON Schema 钉死最终回复形状，若协议失败率高再加。

## Q4 adapter 位置

- `conductor/lib/codex.mjs`：codex exec 薄封装（与 claude.mjs 同构；刻意无重试阶梯、无 inactivity 监控——shadow 是 best-effort 观测）。
- 挂点：`conductor/stages/verify.mjs::runVerifierShadow`，在主 verdict 落盘后、状态路由前同步执行；任何失败（spawn/协议/异常）吞掉只留证据。

## Q5 shadow 落盘（全部在 dossier/<id>/，不碰 runtime/stage）

| 产物 | 含义 |
| --- | --- |
| `verify-r<n>.codex-shadow.verdict.json` | 过契约的 shadow verdict |
| `verify-r<n>.codex-shadow.md` | conductor 渲染的人读报告（同 renderVerifyReport） |
| `verify-r<n>.codex-shadow.invalid.json` | 基建（infra）/协议（protocol）失败证据 |
| `verify-r<n>.codex-shadow.stream.jsonl` | codex 事件流 |
| `verify-r<n>.codex-shadow.last-message.txt` | `-o` 原始最终回复 |
| `verify-r<n>.shadow-compare.json` | 逐 AC 对照（切换裁决的数据源） |

硬边界（集成测试钉死）：默认配置零调用零产物；开启后 stage 由主 verdict 独家决定；shadow 协议失败不计 `verifier_invalid_count`；不产生 repair-context；幂等（compare 已存在不重跑）。

## Q6 对照口径（shadow-compare.json + 聚合）

每轮：`agreement.total_acs / agreed / disagreements[{ac_id, main, shadow, high_risk}] / high_risk_count`；`high_risk` = 主裁 fail/unknown 而 shadow 裁 pass（false-pass 风险形态）。成本：main 记 USD（claude 报价），shadow 记 token usage + duration_ms（codex 不报 USD，按牌价折算）。unknown 率、invalid 率从 verdict/invalid 产物聚合。win/tie/lose 需第三方裁决（人工或高配裁判读 disagreement 双方 evidence），只对 disagreement case 做，不全量。

## Q7 切换样本门（用户给定，作为质量门固化）

满足其一才允许提切换建议：≥20 个 AC-level verdict 对照 或 ≥5 个真实 verifier round；出现 3 个 high-risk disagreement → 停止实验不切换。
另加（切换前必须全过）：shadow JSON invalid 率 ≤ 主 verifier（当前基线 0）；unknown 率不高于主 verifier；对照期内无一例「shadow pass / 主 fail / 人工复核判主对」。

## 配置（conductor.config.json，全部有默认值，默认行为不变）

```json
{
  "verifierShadowEnabled": false,
  "verifierShadowBackend": "codex-exec",
  "verifierShadowModel": null,
  "verifierShadowTimeoutMs": 1800000
}
```

## 开启方式（等真实 verifier round 时）

用户 config 置 `"verifierShadowEnabled": true` 即可；对照数据看 `dossier/<id>/verify-r<n>.shadow-compare.json`，聚合后续可并入 `tools/dossier-stats.mjs`。
