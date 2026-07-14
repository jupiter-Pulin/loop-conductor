# Dashboard v2 设计语言(冻结版)

本文档是 dashboard v2 全部五期任务的**唯一视觉事实源**。spec 写 AC 时引用本文档的 token 名与规则;maker 实现时逐字取值,不得自行发明颜色/字号/动效。评审员(人审代理)会对照本文档逐条验收 UI。

## 0. 定位与立场

- 主体:loop conductor 的**监工控制台**。用户是单人监工,任务是「看清 loop 在干什么」+「安全过闸门」。
- 设计立场:**墨水仪表纸面(ink instrument on paper)**。界面结构一律墨色系;**彩色是稀缺资源,只授予活着的状态**(正在工作 / 等人审 / 裁决结果)。用户扫一眼,有颜色的地方就是需要注意的地方。
- 签名元素:**回路刻度(loop gauge)**——一条 setup→feasibility→spec→maker→verify→merge 的六段轨道。卡片上是缩略形态;详情抽屉里放大为带轮次刻度的仪表。它把「loop」这个主题直接画在界面上,是本设计唯一允许张扬的地方,其余一切克制。
- 反面清单(出现即打回):渐变大色块、彩色泳道背景、无语义的图标堆砌、装饰性 emoji、超过本文档 token 的新颜色、为动而动的动画。

## 1. 颜色 token(CSS 自定义属性,写进 tokens.css)

结构层(无状态,永远墨色):

```css
--paper:      #FAF9F5;  /* 页面底 */
--surface:    #FFFFFF;  /* 卡片/抽屉面 */
--ink:        #211F1A;  /* 主文字 */
--ink-2:      #6B675D;  /* 次级文字/标签 */
--ink-3:      #A6A196;  /* 弱化文字/占位 */
--line:       #E5E2D9;  /* 分隔线/描边 */
--line-heavy: #C9C5B8;  /* 强描边(表头、轨道未达段) */
```

状态层(唯一允许出现彩色的地方):

```css
--live:       #1D4ED8;  /* working:agent 正在跑 */
--live-bg:    #EFF4FE;
--attn:       #B45309;  /* needs-human:等待人审(全站最高优先级色) */
--attn-bg:    #FDF3E7;
--pass:       #15803D;  /* 通过/绿门 pass/done */
--pass-bg:    #ECF6EE;
--fail:       #B91C1C;  /* 失败/打回/failed box */
--fail-bg:    #FBEFED;
--unknown:    #7C6F9B;  /* verifier unknown/待定 */
--unknown-bg: #F3F0F9;
```

规则:
- 状态色只能用于:状态徽章、回路刻度的当前段、裁决 chip(pass/fail/unknown)、beacon 动效、进度指示。**禁止**用状态色做标题、边框装饰、大面积底色(只允许 `*-bg` 做徽章/chip 底)。
- kind 徽章(bugfix/feature/probe)不占彩色:用墨色描边徽章(`--ink-2` 文字 + `--line-heavy` 描边),因为 kind 不是「活着的状态」。这是对 v1 的显式修正。

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
- 圆角:卡片与抽屉 10px,徽章/chip 6px,按钮 8px。阴影至多一层:`0 1px 3px rgba(33,31,26,.08)`。
- **闲置塌缩**(对 v1 满屏空泳道的修正):无任务的泳道折叠成一行 32px 高的静默条(泳道名 + 「0」计数,`--ink-3`);有任务的泳道才展开。全部泳道皆空时显示一个居中的全局空态。
- 全局页头必须提供监工上下文:target repo、base branch、queue/done/failed 计数、总花费(done 合计 spent_usd)、最近一次状态刷新时间。页头是仪表,不是装饰。
- 抽屉宽度自适应:`min(1280px, 90vw)`;视口宽 ≤768px 时抽屉宽度改为 100vw(全屏)。遮罩背景色 `rgba(33,31,26,.5)`。

## 4. 回路刻度(loop gauge)规格

- 形态:水平六段轨道,段间以 2px 缺口分隔,段高 4px(卡片)/ 6px(抽屉)。
- 段状态:已通过段 = `--ink` 实心;当前段 = 状态色实心(working→`--live`,等人审→`--attn`,failed→`--fail`)且叠加呼吸动效;未来段 = `--line-heavy` 空心(1px 描边)。DONE 任务全段 `--pass`;probe 类任务只渲染其实际经过的段。
- 抽屉放大形态:每段下方标注 stage 名(`--font-data`, `--t-caption`);maker/verify 段上以刻度点标注轮次(r1、r2…),打回轮刻度点用 `--fail`,通过轮用 `--pass`。
- 悬停段显示 tooltip:stage 名 + 进入时间(来自 timeline)。

## 5. 动效

只允许三种,全部尊重 `prefers-reduced-motion: reduce`(降级为静态):
1. **呼吸 beacon**:needs-human 卡片与回路刻度当前段,2.6s ease-in-out 透明度 0.55↔1 循环。全页面同时呼吸的元素 ≤3 个。
2. **入场**:新卡片 fade-up 0.3s,一次性。
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
