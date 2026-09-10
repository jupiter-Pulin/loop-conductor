---
name: git-conventions
description: 团队 git 提交与分支命名规范：选 commit type、写 subject/body、起草 merge commit 文案、开新分支或重命名分支时加载。Use when 用户或 loop 说「写 commit」「commit message」「提交这次改动」「规范化 commit」「开分支」「checkout -b」「分支怎么命名」，或任何要产出 commit 文案 / 分支名的场景。Not for conductor 在 target 仓库产生的机器轮次 commit（`task <id>: maker r<n>`，状态机产物，禁止改写），也不用于撰写 PR 描述正文。
---

# Git Conventions（commit 与分支规范）

用本 skill 产出 commit 文案与分支名。核心原则与仓库 AGENTS.md 索引哲学同构：**commit 记「为什么 + 契约边界」，索引（AGENTS.md case 表 / request-log）管「去哪找」，代码和测试是事实源**。三层各干各的，不互相复述。

## Scope

适用：人工 commit、/loop commit、merge commit 文案（conductor committer 提案）、开分支/重命名分支。

不适用（豁免，禁止「规范化」它们）：

- conductor 在 target 仓库的轮次 commit `task <id>: maker r<n> (mode)`——状态机产物，green gate / verifier diff / merge 都以它为锚。
- git stash / WIP 本地暂存——不许 push。

## Commit type 决策表

| 改动性质 | type | 辨析 |
| --- | --- | --- |
| 新行为 / 新能力 | `feat` | 行为变了就是 feat，哪怕动机是「优化体验」 |
| 修 bug | `fix` | |
| 结构调整、行为不变 | `refactor` | 行为变了就不是 refactor |
| 性能优化 | `perf` | 「优化」里唯一有专属 type 的 |
| 只动测试 | `test` | |
| 只动文档/索引 | `docs` | |
| 构建、依赖、脚手架、杂务 | `chore` | |

不要发明 type（如 `optimize`、`update`）；「优化」按上表拆归 `perf` / `refactor` / `feat`。

## Subject（一行结论）

格式逐字：`type(scope): 行为级结论`，scope 可省。

- 写「行为变了什么」，不写「改了哪些文件」（文件列表 git 自己会给）。
- 描述部分 ≤72 字符；单行；无首尾空白；不含 WIP。
- 语言**一律英文**（团队政策 2026-07-08；conductor 侧由 `commitLanguage: 'en'` 语言门机械执行，中文提案判 invalid——F13/task-20260708-006）。历史中文 commit 不追改。
- scope 用子系统名（如 `conductor`、`agents`、`test-gate`），供 `git log --grep '^feat(test-gate)'` 检索。

## Body（四要素，各 1–3 行，行宽 ≤100 字符）

| 要素 | 回答的问题 |
| --- | --- |
| 为什么 | 不改会出什么事故（代码永远记不住这个） |
| 契约边界 | 动了/没动哪些不变量、schema、config；「无新字段」这类否定声明同样值钱 |
| 验证 | `npm test N/N` + 新增 case 名 |
| 索引指针 | AGENTS.md case 行 / request-log 路径，指过去，不复述 |

反例清单（出现即返工）：

- 多文件改动 + 空 body。
- body 罗列文件清单或整段复述 request-log / spec。
- 一个 commit 混多题（feat 顺手夹 refactor）。
- subject 带 WIP / 句末句号 / 超长。

## 分支命名

格式：`type/kebab-主题`，type 与 commit type 同一词表（另加 `spike/` 做实验）。

- 一支一题：分支名就是 PR 列表里的第一行索引。
- 工具生成的分支名（`claude/*`、`codex/*` 等随机名）push 前必须重命名：`git branch -m <type>/<主题>`。
- 合并后删除分支。PR 建议 squash merge，PR 标题按 subject 公式写，使 main 每行一题。

## 查找 recipes

- 时间轴索引：`git log --oneline --grep '^feat('`、`git log --grep 'test-gate'`。
- 空间索引：AGENTS.md「Case 索引」表 → 测试文件；「最近一次实现证据」→ request-log。

## 机器裁决（conductor committer 用）

conductor `cmdMerge` 会把本文全文嵌入 committer agent prompt，要求输出严格 JSON
`{"subject": "...", "body": "..."}`；唯一程序级裁判是
`conductor/stages/decisions.mjs::validateCommitMessage`（type 白名单 + 描述 ≤72 + body 行宽
≤100 + 非空 body + 禁 WIP）。校验不过重试一次，再不过降级机器文案——格式问题绝不 block merge。

## Output

产出 commit 文案时，最终给出完整的 subject + body（或 JSON 形态，按调用方要求）；产出分支名时给出单个 `type/kebab-主题`。不确定 type 时先问改动是否改变行为，再查决策表。
