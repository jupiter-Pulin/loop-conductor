# Dashboard v2 设计语言(冻结版 · Claude Dark)

本文档是 dashboard v2 全部五期任务的**唯一视觉事实源**。spec 写 AC 时引用本文档的 token 名与规则;maker 实现时逐字取值,不得自行发明颜色/字号/动效。评审员(人审代理)会对照本文档逐条验收 UI。

当前主题:**Claude Dark**(暖炭灰底 + 珊瑚橙单一强调色),与 fin-daily / KB_Pulin 前端视觉统一。v1 冻结版曾用的浅色「墨水仪表纸面」配色已废弃,不再是实现依据——本节及以下颜色/层次定义为唯一现行事实源。

## 0. 定位与立场

- 主体:loop conductor 的**监工控制台**。用户是单人监工,任务是「看清 loop 在干什么」+「安全过闸门」。
- 设计立场:**暗面仪表(instrument on charcoal)**。界面结构一律暖炭灰/暖白墨色系,层次靠表面色阶(page → card → hover)而非阴影;**彩色是稀缺资源,只授予活着的状态**(正在工作 / 等人审 / 裁决结果)。用户扫一眼,有颜色的地方就是需要注意的地方。
- 签名元素:**回路刻度(loop gauge)**——一条 setup→feasibility→spec→maker→verify→merge 的六段轨道。卡片上是缩略形态;详情抽屉里放大为带轮次刻度的仪表。它把「loop」这个主题直接画在界面上,是本设计唯一允许张扬的地方,其余一切克制。
- 反面清单(出现即打回):渐变大色块、彩色泳道背景、无语义的图标堆砌、装饰性 emoji、超过本文档 token 的新颜色、为动而动的动画。

## 1. 颜色 token(CSS 自定义属性,写进 tokens.css)

结构层(无状态,永远暖灰/暖白墨色;层次由三级表面色阶构成,不靠阴影):

```css
--paper:         #1F1E1B;  /* 页面底(暖炭灰) */
--surface:       #262521;  /* 卡片/抽屉/面板面 */
--surface-hover: #2E2D28;  /* 卡片/行/按钮 hover 抬升面 */
--ink:           #F5F4EF;  /* 主文字(暖白) */
--ink-2:         #B8B5AD;  /* 次级文字/标签 */
--ink-3:         #8A877F;  /* 弱化文字/占位 */
--line:          rgba(255,255,255,.08);  /* 发丝线:分隔线/描边 */
--line-heavy:    rgba(255,255,255,.16);  /* 强描边(表头、轨道未达段) */
```

状态层(唯一允许出现彩色的地方;强调色只用一个,其余语义色在暗底上调亮保对比度,不新增色相):

```css
--live:       #D97757;  /* 唯一强调色(Claude 珊瑚橙):主行动按钮 / 焦点环 / working:agent 正在跑 */
--live-bg:    rgba(217,119,87,.16);
--attn:       #E49D67;  /* needs-human:等待人审(全站最高优先级色);沿用原琥珀色相,暗底调亮 */
--attn-bg:    rgba(228,157,103,.16);
--pass:       #6BC78D;  /* 通过/绿门 pass/done;沿用原绿色相,暗底调亮 */
--pass-bg:    rgba(107,199,141,.16);
--fail:       #DA6262;  /* 失败/打回/failed box;沿用原红色相,暗底调亮 */
--fail-bg:    rgba(218,98,98,.16);
--unknown:    #AB97D8;  /* verifier unknown/待定;沿用原紫色相,暗底调亮 */
--unknown-bg: rgba(171,151,216,.16);
```

规则:
- 状态色只能用于:状态徽章、回路刻度的当前段、裁决 chip(pass/fail/unknown)、beacon 动效、进度指示。**禁止**用状态色做标题、边框装饰、大面积底色(只允许 `*-bg` 做徽章/chip 底)。
- kind 徽章(bugfix/feature/probe)不占彩色:用墨色描边徽章(`--ink-2` 文字 + `--line-heavy` 描边),因为 kind 不是「活着的状态」。这是对 v1 的显式修正。
- `--live` 是全站唯一强调色,三处专用:主行动按钮底色、`:focus-visible` 焦点环、working/live 徽章与 beacon。不得为其它用途另开新的彩色。
- **填色徽章的前景色**:任何以状态色作**实心底**(而非 `*-bg` 半透明底)的徽章/按钮(如 `.btn-primary`、`.card .needs-you`),前景文字一律用 `--paper`(暗色)而非白色——状态色在暗主题下已调亮至高明度,白字对比度不足 4.5:1,`--paper` 对比度约 5.3~8:1(§7)。半透明 `*-bg` 徽章(chip/round-tick 等)前景仍用对应状态色本身,无需改前景色。

### 1.1 表面层次(elevation)

三级表面色阶承担 v1 阴影承担的层次感;暗色下阴影本身应几乎不可见(见 §3):

1. `--paper` — 页面基底。
2. `--surface` — 卡片、抽屉、面板、弹层等一切「浮起」的容器。
3. `--surface-hover` — 上述容器被 hover/交互时的抬升色,过渡 150–250ms ease(§5)。

嵌套只读块(`pre.readonly`、`.metric-bar-track`、`.diff-file-header` 等)反向使用 `--paper` 作为「凹陷」底色,与浮起容器的 `--surface` 形成凹凸对比,替代阴影表达层次。

## 2. 字体与字号

系统栈,零依赖、零外链字体:

```css
--font-ui:   -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
--font-data: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
```

角色分工(对 v1「标题全等宽」的修正):
- `--font-ui`:一切自然语言(标题、正文、按钮、说明、timeline 正文)。
- `--font-data`:一切机器标识(task id、stage 名、分支名、文件路径、金额、耗时、轮次号)。金额/计数一律 `font-variant-numeric: tabular-nums`。

字阶(只许用这些档位):

```css
--t-display: 600 22px/1.3;   /* 抽屉任务标题 */
--t-h1:      650 17px/1.4;   /* 页面标题 */
--t-h2:      600 14px/1.4;   /* 区块标题(全大写字母时 letter-spacing:.06em) */
--t-body:    400 13.5px/1.6; /* 正文 */
--t-data:    450 12.5px/1.5; /* 等宽数据 */
--t-caption: 400 11.5px/1.5; /* 辅助说明,颜色 --ink-2 */
```

## 3. 布局与密度

- 页面最大宽 1160px 居中;间距只用 4 的倍数:4/8/12/16/24/32。
- 圆角(Claude Dark 整体上调,层级关系不变):卡片/抽屉/面板 16px,按钮 12px,徽章/chip 10px。阴影至多一层且极轻(暗色下阴影几乎不可见,层次主要靠 §1.1 表面色阶):`0 1px 2px rgba(0,0,0,.24)`。
- **闲置塌缩**(对 v1 满屏空泳道的修正):无任务的泳道折叠成一行 32px 高的静默条(泳道名 + 「0」计数,`--ink-3`);有任务的泳道才展开。全部泳道皆空时显示一个居中的全局空态。
- 全局页头必须提供监工上下文:target repo、base branch、queue/done/failed 计数、总花费(done 合计 spent_usd)、最近一次状态刷新时间。页头是仪表,不是装饰。
- 抽屉宽度自适应:`min(1280px, 90vw)`;视口宽 ≤768px 时抽屉宽度改为 100vw(全屏)。遮罩背景色 `rgba(0,0,0,.6)`(暗主题下用纯黑半透明压深浮层,与 §1.1 表面色阶拉开层次)。

## 4. 回路刻度(loop gauge)规格

- 形态:水平六段轨道,段间以 2px 缺口分隔,段高 4px(卡片)/ 6px(抽屉)。
- 段状态:已通过段 = `--ink` 实心;当前段 = 状态色实心(working→`--live`,等人审→`--attn`,failed→`--fail`)且叠加呼吸动效;未来段 = `--line-heavy` 空心(1px 描边)。DONE 任务全段 `--pass`;probe 类任务只渲染其实际经过的段。
- 抽屉放大形态:每段下方标注 stage 名(`--font-data`, `--t-caption`);maker/verify 段上以刻度点标注轮次(r1、r2…),打回轮刻度点用 `--fail`,通过轮用 `--pass`。
- 悬停段显示 tooltip:stage 名 + 进入时间(来自 timeline)。

## 5. 动效

### 5.1 基线交互过渡(所有可点元素默认遵守)

- 过渡时长 150–250ms,统一 `ease`;颜色/背景/描边/transform 变化都走 `transition`,不新写 `@keyframes`。
- **hover 背景抬升**:卡片、行、按钮、可点摘要行等 hover 时背景切到 `--surface-hover`(或用 `filter: brightness()` 对已有色块整体提亮),不新增描边或位移之外的视觉噪音。
- **点按反馈**:可点元素 `:active` 施加 `transform: scale(.98)`(如已有 hover 位移,叠加而非替换,如 `translateY(-2px) scale(.98)`)。
- 状态徽章(`.badge`/`.chip`/`.activity-badge`/`.round-tick`/`.box-toggle` 等)背景色、文字色、描边色变化时过渡 150–200ms,避免生硬跳变。
- 以上均受 `prefers-reduced-motion: reduce` 统一降级(见下方全局规则),不单独处理。

### 5.2 专用动画(仅限以下三种 `@keyframes`,全部尊重 `prefers-reduced-motion: reduce`)

1. **呼吸 beacon**:needs-human 卡片与回路刻度当前段,2.6s ease-in-out 透明度 0.55↔1 循环。全页面同时呼吸的元素 ≤3 个。
2. **入场**:新卡片/面板 fade-up 0.3s(opacity 0→1 + translateY 8px→0),一次性。
3. **展开**:抽屉/折叠区 0.25s ease。

禁止:hover 位移超过 2px、旋转、无限 loading 动画以外的循环动效。

## 6. 文案

- 界面自然语言**统一中文**,机器标识(stage 名、task id、分支)保留英文等宽。修正 v1 的中英混排页头(「Tasks · by agent」→「回路看板」)。
- 按钮动词写结果:「通过 spec」「打回并留言」「合并到 <branch>」,不写「提交」「确认」。
- 空态给指路不给情绪:说明为什么空 + 下一步动作(如「队列为空 — 用『新建任务』投递第一个任务」)。
- 错误态三要素:发生了什么、原始 stderr(等宽、可折叠)、下一步能做什么。禁止「出错了,请重试」。

## 7. 可达性底线

- 正文对比度 ≥ 4.5:1;状态含义不得只靠颜色,必须伴随文字或形状(pass ✓ / fail ✗ / unknown ?)。
- 全部可点元素有可见 focus 样式(2px `--live` outline,offset 2px)。
- 抽屉可用 Esc 关闭;打开时焦点移入,关闭后焦点还原。
