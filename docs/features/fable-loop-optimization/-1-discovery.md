# Discovery Memo：fable-loop-optimization（R1）

> 轻量 discovery：固定系统画像、主要瓶颈、实验矩阵、推荐路线。详细台账与逐轮进展在根目录 `fable-loop-STATE.md`，本文只在系统级 framing 变化时更新。
> 日期：2026-07-07。证据来源：dossier/*、state/*、git log、代码逐行核实、`npm test` 实测。

## 系统画像（一段话）

Loop Conductor 是文件系统状态机：conductor 无内存状态，per-task lock + worker 池推进 setup→feasibility→spec→spec-verify→maker→green gate→test gate→verifier→committer 链；契约门（spec-doc/v1、feasibility-doc/v1、verifier-verdict/v1、commit 文案）用「hook 预检 + conductor 机械终审」双层把关；幂等靠双标记（started/done）与 verdict 缓存。多仓 targetRepo 支持刚落地，已承接真实产品任务。防线（test gate、failure-signature 短路、git 护栏）在历史数据中均有效触发、无误伤。

## 主要瓶颈（按杠杆排序，全部有 dossier 证据）

1. **maker max-turns 截断循环**：11 个 r1 中 8 个（73%）以 `error_max_turns` 截断，半成品被送进 green gate → 必红 → 白付一轮 gate+repair+re-spawn（3-30min、$2-5/任务）。连带 bug：resume 轮截断被 shared.mjs:1247 误判为「resume 失败」→ cold-degraded 全量重启，丢会话上下文（20260705-003 连续三轮截断即此）。
2. **committer 协议失败**：maxTurns=4 + 只读工具自由度，sonnet 有时花完 turn 读代码没输出 JSON；9 次 merge 中 2 次双 invalid 降级机器文案，且 attempt-2 的反馈「提案不是对象」失真（模型从未输出过提案）。
3. **verifier 成本**：opus、$1.3-2.2/轮、6-38min，占 active 成本 35%。
4. **并发压到 1**：调度器/锁经测试证明支持 ≥2；真实约束是 API 429（历史上 4 连 429 耗尽 3.75min 退避阶梯后收箱等人工 retry）。
5. **per-AC 探针串行**（shared.mjs:308，共享 probeDir）：本仓 8 AC≈56s 无痛；外部 jest repo 每条命令秒-分钟级启动，AC 数线性放大。

非瓶颈（已收敛/设计使然）：verifier JSON 协议（钉死首字符后最近 9 任务 0 invalid）；人审等待占 wall-clock ~44%（产品设计）；test gate/失败签名防线均有效且无误伤记录。

## 实验矩阵（12 假设，详见 STATE §4）

| 进入实现（本轮） | 分析验证完成 | 待下轮/待裁决 |
| --- | --- | --- |
| E2=H1+H3 maker max-turns continuation（同会话续跑，不进 gate；resume 截断不再 cold-degraded） | H4 verifier 协议已稳（关闭） | H7 429 退避加长（默认值变更，待用户裁决） |
| E1=H2 committer turn 纪律 + 精准重试反馈 | H6 并发恢复安全性（测试已证，绑 H7） | H8 spec AC 自检清单、H10 maker turn 预算意识（需真实 spawn 对照） |
| E3=H5 per-AC 探针 opt-in 有界并发（默认串行不变） | | H9 mapping 反馈、H11 EACCES 特判、H12 stats 聚合 |

## 推荐路线

R1（本轮）：E1/E2/E3 实现 + 测试跑绿——全部是「高确定性、单失败模式、不动用户现场 config、不削弱测试」的改动。
R2：用下一个真实任务验证 E2 对返工率的实效；H7 裁决后建议恢复 maxConcurrentTasks=2-3；H8/H10 shadow prompt 对照。
长期：把已固化规则沉进 agent prompt 附录（STATE §7），让 sonnet 级 maker/committer 稳定跑出接近 fable 的协议成功率。
