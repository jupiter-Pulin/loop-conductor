# Web Dashboard 线框稿（人类定稿，实现以此为 UI 事实源）

来源：人工线框图三张，本文件是其文字转写。视觉基调：米白背景、卡片圆角、等宽字体标题、蓝=推进类动作（Approve/Merge/Create），红=退回类动作（Reject/Retry）。

## 屏 1：任务看板（Tasks · by agent）

布局：**每行一个 agent 泳道**，任务卡片落在当前持有它的 agent 那一行——最直白地回答「现在该谁做」。

- 顶部：标题 `Tasks · by agent`；右上角蓝色按钮 `+ 新建任务`。
- 顶部次行：两个折叠盒 `✓ Done · N`（绿）与 `✕ Failed · N`（红），已结束任务收在里面，点开展开列表。
- 泳道自上而下固定顺序：`setup` / `feasibility` / `spec` / `maker` / `verify` / `merge`（merge 行标注 `you · merge`，因为动作人是人类）。
- stage → 泳道映射：
  - `NEEDS_TARGET_SETUP`、`AWAIT_SETUP_APPROVAL` → setup
  - `NEEDS_FEASIBILITY`、`AWAIT_FEASIBILITY_APPROVAL` → feasibility
  - `NEEDS_SPEC`、`SPEC_VERIFY`、`SPEC_FIXING`、`AWAIT_SPEC_APPROVAL` → spec
  - `READY`、`FIXING` → maker
  - `VERIFY` → verify
  - `AWAIT_HUMAN_MERGE` → merge
  - `DONE` / `FAILED_BOX` → 顶部两个折叠盒
- 泳道无任务时显示虚线占位卡 `idle · 无任务`。
- 泳道标题旁若有任务处于人审 stage，加一面橙色小旗 ⚑。
- 任务卡片：任务 ID 短徽章、KIND 徽章（FEATURE 蓝 / BUGFIX 红）、右上角累计花费 `$x.xx`、标题一行。
  - 人审 stage 的卡片：橙色左边条 + `⚑ needs you` 徽章 + 橙色 `Review →` 按钮（点击打开屏 2 抽屉）。
  - agent 正在推进的卡片：灰字 `↻ working…`。

## 屏 2：任务详情抽屉（同一容器，按 stage 换内容）

点 `Review →` 或任意卡片打开。左侧主栏 + 右侧 TIMELINE 栏。

- 头部：任务 ID、KIND 徽章、标题、当前 stage 名、`⚑ needs you` 徽章、右上角关闭 ×。
- stage 进度点：`setup → feasibility → spec → maker → verify → merge` 六个圆点连线，已完成实心灰、当前实心橙、未来空心。
- 主栏内容按 stage 变化：
  - **AWAIT_FEASIBILITY_APPROVAL**：memo 只读渲染区（含 Options considered 列表）；下方「YOUR DECISION · PICK AN OPTION」：每个 option 一张单选卡（O-X 编号 + 一句话摘要），备注 textarea（optional，给 agent 的补充说明）；底部大蓝按钮 `Approve · 选 O-X 继续`（按钮文案随选中项变化）+ 红边 `Reject` 按钮。
  - **AWAIT_SETUP_APPROVAL**：setup profile 摘要只读渲染 + 蓝 `Approve`。
  - **AWAIT_SPEC_APPROVAL**：spec 草稿只读渲染 + 蓝 `Approve` + 红 `Reject`（Reject 需填 notes）。
  - **AWAIT_HUMAN_MERGE**：diff 摘要（`+128 −34 · 3 files` 形式）+ 蓝 `Merge`。
  - **FAILED_BOX**：失败原因（如 `verify failed — 2 tests red, max retries hit`）红字 + 红边 `↻ Retry`。
  - 非人审 stage：只读展示当前产物与 `working…` 状态。
- 右侧 TIMELINE 栏：垂直时间线，已完成节点（实心+✓+时间+一句话）、当前节点（橙旗 `now`）、未来节点（空心灰）。数据来自 dossier timeline。

## 屏 3：新建任务面板（点「+ 新建任务」打开，分步）

- **① Kind**：两张大卡二选一：`bugfix 修bug` / `feature 加功能`。
- **② Feasibility gate**（仅 kind=feature 时出现）：单选二choice：
  - `Skip feasibility → 直接产出 spec`：更快，少一轮人工，适合需求已明确的改动。
  - `Run feasibility gate first`：多一轮，AI 产出决策 memo，人选 option 再进 spec。
- **③ Title & Brief**：标题单行输入；brief 多行 textarea（说明文案：这段作为任务的原始需求描述，创建后随任务一起保存 → 落盘 brief.md）。
- **高级参数**（默认收起）：target repo / base branch / test command，留给需要覆盖默认值的场景。
- 底部：大蓝按钮 `创建并运行 · Create & Run` + `取消`。
