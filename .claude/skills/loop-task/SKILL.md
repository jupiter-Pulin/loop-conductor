---
name: loop-task
description: "把对话里聊清楚的需求/bug 蒸馏成 brief ，交给 loop Conductor 实现。use when: 用户明确本次需要实现的目标，有明确的交付条件。use not when: 用户未明确方向或者探索某个可能性"
---

Loop Conductor 仓库就是本 skill 所在的仓库（下称 `$CONDUCTOR_ROOT`，由前置自检从 skill 目录推出，软链接会先解析成真实路径）。角色、状态流、命令、数据位置的唯一事实源是 `$CONDUCTOR_ROOT/AGENTS.md`，本 skill 不复述。

你只做一件事：把对话里已经聊清楚的需求原样蒸馏成 brief，开单，起 run。路线（spec 还是 maker、拆不拆、何时 review / merge）全部由 router 与人闸决定，brief 里不写路线指令，也不按 AC 数量拆单。

brief 模版:

```markdown
# <一句话标题>
## 背景        现状 + 落到文件
## 目标        说清楚用户希望实现的目标，如果在之前的探讨中包含了一些问题，可以如实的在这里写。
```

brief 全文不超过 100 字。

## 工作流

1. 前置自检（一次即可）：

   ```bash
   eval "$(bash "<本 skill 的 Base directory>/scripts/precheck.sh")"
   ```

   非零退出说明环境不可用，把 stderr 原因报给用户，停。自检输出的 export 行（含 `CONDUCTOR_ROOT`）要带进后续每条命令，shell 状态不跨命令保留。

2. 蒸馏 brief 写到临时文件，全文贴给用户过目。

3. 开任务：

   ```bash
   cd "$CONDUCTOR_ROOT"
   npm run conductor -- new --title "<一句话>" --brief <file> [--repo <目标仓绝对路径>] [--base-branch <b>]
   ```

   目标仓须已有 `target-profiles/<repo>/setup-profile.json` 的 `precommit` 段；缺了 `new` 会拒绝并打印样例，把样例贴给用户填，不替他猜命令。

4. 起 run：`npm run conductor -- run`（后台）。回报 task id 与 dashboard `http://127.0.0.1:4401`（未起则 `node conductor/dashboard/server.mjs --port 4401 --no-auto-run`）
