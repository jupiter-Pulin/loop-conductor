# Dashboard screenshot checklist

A shot list for publishing screenshots of the Loop Conductor dashboard — five screens, how to reach each one, what it should show, and exactly which fields have to be redacted first.

The dashboard renders host-machine absolute paths, target repository paths, and branch names in several places. None of it is secret to you; all of it is leaked the moment a screenshot is published. Work through the **Must redact** column for every shot before it leaves your machine.

## Before you start

- Start the dashboard from the repository root: `npm run dashboard`. It listens on `http://127.0.0.1:4400` by default (`--port` changes it).
- **The interface is entirely in Chinese.** Every published screenshot needs an English caption explaining what the reader is looking at; the interface itself will not tell them. Chinese interface strings are quoted verbatim below and must not be translated inside the product — translate only in your caption.
- You need real tasks in `state/` and `dossier/` for anything to render. A fresh clone shows an empty board.
- Ideally capture with at least one task at a human gate, so the `⚑ needs you` flag ("needs you") is visible on the board.
- Redact by solid-filling the region, not by blurring — blurred short paths are recoverable.

## Screen 1 — Board

| | |
| --- | --- |
| **How to reach it** | `http://127.0.0.1:4400/` (empty hash), or click `看板` ("Board") in the header nav. |
| **What to show** | The six lanes — `setup` / `feasibility` / `spec` / `maker` / `verify` / `merge` — with task cards distributed across them. Each card carries the task id, kind, title, spend, a round gauge, and the `⚑ needs you` flag when it is waiting on a human. The header carries five stats: `target repo`, `base branch`, `queue/done/failed`, `done 花费` ("done spend"), `刷新于` ("refreshed at"). |
| **Must redact** | The header `target repo` stat. It shows `.` when the conductor is running on itself, but for a cross-repository task (`new --repo <path>`) it is a **host absolute path**. Also redact any private repository name visible in a task title. |
| **Safe to keep** | Lane names, task ids, kinds, dollar amounts, round gauges, the `queue/done/failed` counts, `done 花费`, `刷新于`, the `⚑ needs you` flag, and the `base branch` stat when it is a generic name such as `main`. |

## Screen 2 — Detail drawer (peek)

| | |
| --- | --- |
| **How to reach it** | On the board, click a card for a task that is actively running (not one flagged `⚑ needs you`). The narrow drawer slides in over the board. |
| **What to show** | The monitoring half of the detail view: current stage, round number, live stream tail, and the Timeline. Note in your caption that this pane is deliberately **read-only** — it has no decision buttons at all. Every human decision lives on the full-screen review page (Screen 3). |
| **Must redact** | The stream tail and the Timeline. Both relay raw conductor output and command-line messages and can contain **host absolute paths, branch names, and private repository names**. Read every visible line before publishing; do not assume a scrolled-off region is safe once you have cropped. |
| **Safe to keep** | Stage names, round counters, elapsed times, spend, task id, and Timeline entries that carry only stage transitions and gate verdicts. |

## Screen 3 — Full-screen review page

| | |
| --- | --- |
| **How to reach it** | Hash route `#/task/<id>`, or click a card flagged `⚑ needs you` on the board. |
| **What to show** | The screen where humans actually decide. Depending on the stage it renders: the feasibility memo with its option cards, the setup profile, the spec draft alongside the spec-verifier's report, or the verifier's ruling alongside a per-file diff. The action bar at the bottom carries the approve / reject / merge / retry buttons. This is the best single screenshot for showing what a human gate looks like. |
| **Must redact** | The diff panel and the verifier ruling: **file paths, branch names, and spec text quoted back verbatim** all appear as-is, so any private repository leaks through them. Also redact the result box under the action bar, which echoes command-line messages that may contain absolute paths. If the VS Code jump button was used, see Screen 3a below. |
| **Safe to keep** | The verdict conclusion (pass / fail) and its per-criterion breakdown, criterion identifiers, round counts, spend, task id, stage name, and the shape and labels of the decision action bar. |

### Screen 3a — VS Code jump button status text

The review page has a button that opens the task worktree in VS Code. Its status text has **three distinct forms**, and they are not equally safe:

| Situation | What is rendered | Verdict |
| --- | --- | --- |
| Success, inline text | The literal string `已打开` ("opened") — **no path** | **Safe to keep.** |
| Success, hover tooltip | The tooltip is the server message `已在 VS Code 打开 <worktree absolute path>` ("opened `<path>` in VS Code"). It is not visible unless hovered. | **Must redact** if the screenshot captured the hover state. Simplest fix: re-take the shot without hovering. |
| Failure, inline text | The server message is shown inline. When the worktree is gone it reads `worktree 不存在或已清理：<absolute path>（任务已合并归档，或尚未进入 maker 阶段）` ("worktree missing or already cleaned: `<path>` — the task was merged and archived, or has not reached the maker stage yet") | **Must redact** — the absolute path is inline and plainly visible. |

## Screen 4 — Metrics view

| | |
| --- | --- |
| **How to reach it** | Click `指标` ("Metrics") in the header nav → hash route `#/metrics`. |
| **What to show** | The aggregate view over all tasks: spend quantiles, yield rate, per-lane duration p50/p90, and the per-task detail table. This is the strongest screenshot for the "what does an agent loop actually cost" argument, because every number is machine-derived from the dossiers rather than hand-tallied. |
| **Must redact** | The header `target repo` stat, which is present on this screen too. Task titles in the detail table, if any name a private repository or an unreleased feature. |
| **Safe to keep** | All of the numbers — spend quantiles and totals, yield rate, per-lane p50/p90 durations, round counts, stage names, verdict outcomes, and task ids. Task ids are date-and-sequence strings and reveal nothing. |

## Screen 5 — New task panel

| | |
| --- | --- |
| **How to reach it** | Click `+ 新建任务` ("New task") in the header. The panel opens over the board. |
| **What to show** | How a task is created: the two kind cards (`bugfix 修 bug` / `feature 加功能`), the Feasibility gate choice — which only appears once `feature` is selected — the Title and Brief inputs, and the collapsed `高级参数（只读）` ("Advanced parameters (read-only)") section. Expand that section for the screenshot only if you are redacting it — it is what makes the point that these values are inherited from configuration, not typed per task. |
| **Must redact** | Everything inside `高级参数（只读）`: `target repo`, `base branch`, and `test command`. The first is a **host absolute path** for any cross-repository task, and the test command can expose internal tooling names. Also redact the Brief textarea if you pre-filled it with a real internal requirement. |
| **Safe to keep** | The `高级参数（只读）` heading itself, the kind cards, the feasibility toggle, the field labels `target repo` / `base branch` / `test command`, and a Title/Brief you wrote specifically for the screenshot. |

## Final pass before publishing

1. Re-read every screenshot for absolute-path fragments — anything starting at your home directory root — including inside the diff panel, the Timeline, and any tooltip you did not intend to capture.
2. Confirm no private repository or branch name survives in the board cards, the diff header, or the metrics table.
3. Confirm each image has an English caption — the interface will not carry the reader.
4. Costs, round counts, stage names, verdict outcomes, and task ids are the point of the showcase. Do not redact those.
