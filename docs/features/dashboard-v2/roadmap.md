# Dashboard v2 路线图

五期串行,全部经 loop conductor 自举实现;集成分支 `feat/dashboard-v2`,每期任务 merge 进集成分支,最终由人一次性合入 main。评审员由人审代理担任(setup/spec 闸门 + 阶段合入),终审 merge 到 main 归人。

视觉唯一事实源:[design-language.md](./design-language.md)。每期 spec 都必须引用它,UI 类 AC 以其 token/规则为验收口径。

| 期 | 主题 | 内容 | 对应最初改进方向 |
| --- | --- | --- | --- |
| P1 | 地基:模块化 + 设计系统落地 | index.html 拆静态模块目录、server 静态文件路由;tokens.css 设计系统;看板重设计(全局页头/闲置塌缩/空态/卡片回路刻度);集成测试端口冲突修复(port 0) | 方向 5(部分)+ 设计地基 |
| P2 | 人审信息密度 | merge 门分文件可折叠 diff;per-AC verdict 面板(verify-rN.verdict.json);spec 审批页并排 spec-verifier 意见;抽屉重设计 | 方向 1 |
| P3 | 轮次证据链 | 按 round 展开 maker/test-gate/verifier/green-gate 四道门结果、花费、打回原因;attempts/ 历史;timeline 按轮分组;抽屉回路刻度轮次刻度 | 方向 2 |
| P4 | 实时与长动作 | SSE 推送取代 1.5s 轮询;实时活动面(正在跑的 agent + stream tail);merge/retry 改异步 job 模型 | 方向 3 + 方向 5(merge 超时) |
| P5 | 运营指标层 | done/failed 全量 dossier 聚合:花费分布、miss/打回率、各阶段耗时;零依赖手绘 SVG 图表 | 方向 4 |

明确不做(记录即止):O-A→O-B(server 直调 cmd core)重构、鉴权/远程暴露、暗色主题、前端框架引入。
