---
name: loop-task
description: 把对话里聊清楚的需求/bug 蒸馏成 brief，交给 Loop Conductor 状态机实现。用户以 /loop-task 或「交给 loop」「开个 task」触发；带 --auto 时为该任务打开 conductor 侧 spec 机器放行。
---

# loop-task：把讨论变成 Loop Conductor 任务

Loop Conductor 是本机的 agent 开发状态机，仓库在 `$HOME/ai-experiment/will-workflow`（下称 `$CONDUCTOR_ROOT`）。角色分离（spec→审→实现→冷验收→合并文案）、状态流、命令、数据位置的**唯一事实源是 `$CONDUCTOR_ROOT/README.md`**，本 skill 不复述。你只需要记住闸门：人审共三处——setup profile、spec（或 feasibility option）、merge——全部在 dashboard 里点，不在你手里。

## 你的角色（铁律）

你是**发起人 + 监控者**：蒸馏 brief、开任务、起 run、盯进度、到站播报。

你**不是裁决者**：永远不执行 `approve` / `reject` / `approve-feasibility` / `approve-setup` / `merge`，也不改 `state/`、`dossier/` 既有产物、不动任务 worktree。你写的 brief 衍生出的 spec 不能由你自己批。`--auto` 不是授权你裁决：它只是在 `new` 时带上 `--auto-approve-spec`，由 conductor 侧机械谓词（fail-closed）代替「人在 spec 闸门点章」这一步；merge 闸门与 reject 通道永远留人。

## 工作流

1. **前置自检**（一次即可）：

   ```bash
   CONDUCTOR_ROOT="$HOME/ai-experiment/will-workflow"
   eval "$(bash "$CONDUCTOR_ROOT/.claude/skills/loop-task/scripts/precheck.sh")"
   ```

   非零退出说明环境不可用，把 stderr 原因报给用户，停。

2. **蒸馏 brief** 写到临时文件，结构：`# 标题` + `## 背景` / `## 问题 / 目标` / `## 非目标` / `## 约束` / `## 验收线索` / `## 开放问题`（每条开放问题必须带 safe default）。**全文贴给用户过目再继续**；brief 忠实记录讨论即可，纠偏交给下游闸门——唯一例外是规模：下游闸门只能对超规模 spec 喊停，不能替人拆分（task-20260802-002 教训：30+ AC 的 brief 在 spec 链烧 $31 打地鼠致死）。蒸馏时估一下验收线索会衍生的 AC 量级，闻起来超过 conductor `specMaxAcs`（当前 12）就先向用户提议拆成任务链再开单，一单一事。

3. **选 kind**：行为错误有修复方向 → `bugfix`；新能力方案已收敛 → `feature`；方案未收敛 → `feature` + `--feasibility`；只调查不动代码 → `probe`。

4. **开任务**：

   ```bash
   cd "$CONDUCTOR_ROOT"
   npm run conductor -- new --kind <kind> --title "<一句话>" --brief <file> \
     [--repo <目标仓库绝对路径>] [--feasibility] [--auto-approve-spec]
   ```

   跨仓库用 `--repo`（该仓库首次会走 setup gate）。`--auto-approve-spec` 仅在用户以 `--auto` 调用本 skill 时携带。bugfix 档：`new` 后把「## 验收标准」写进 `state/queue/<id>/spec.md`（每条 `- AC-xxx: 可验证描述`），**AC 列表先贴给用户看**。

5. **起 run + 报坐标**：`npm run conductor -- run`（后台跑，一次 run 推进到下一个闸门）。回报 task id、当前 stage、dashboard 地址（`http://127.0.0.1:4401`；未起则 `node conductor/dashboard/server.mjs --port 4401`）。成本量级引用 `node tools/dossier-stats.mjs` 的历史分布，不要凭记忆报数。

6. **监控**：`status` / `dossier/<id>/timeline.md`。停在 `AWAIT_*` → 播报"到站，去 dashboard 裁决"+该闸门在裁什么；`FAILED_BOX` → 复述 timeline 里的原因并建议 `retry`（retry 不是裁决，你可以执行）。人在 dashboard 点完闸门后：dashboard 默认 auto-run 会自动续转；若它是 `--no-auto-run` 起的（本机 dev 配置如此），由你看到裁决落 timeline 后再拉一次 `run`。
