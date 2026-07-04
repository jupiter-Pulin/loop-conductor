# Request Log: merge commit 文案提案制（committer agent + git-conventions skill）

## Scope

- 新增仓库本地 skill `.claude/skills/git-conventions/SKILL.md`：commit type 决策表、subject/body 规则、分支命名、机器 commit 豁免——人工 commit、/loop commit 与 conductor committer 共用同一份规范源。
- `cmdMerge` 时 spawn committer agent（可配 `models.committer`），prompt = 规范全文 + 冻结 spec AC + `git diff --stat`，输出严格 JSON `{subject, body}`；唯一裁判 `decisions.mjs::validateCommitMessage`；校验不过重试一次，再不过 / 预算超限降级原机器文案（fail-open，绝不 block merge）。
- 铁律：轮次 commit 不丢——merge 保持 `--no-ff`，任务分支 `task <id>: maker r<n>` 颗粒度原样保留。

Non-goals：不改轮次 commit 文案（状态机产物）；不加 commitlint/husky 硬约束；不写 PR 描述。

## Controlling Docs

- 本 thread 用户实现指令（「agent 提案，conductor 裁决」形态 + fail-open 伦理 + 轮次 commit 保留）。
- `AGENTS.md` / `README.md` 仓库铁律。

## AC Evidence

| AC | Status | Proof | Files |
| --- | --- | --- | --- |
| skill 规范源存在且被 committer prompt 嵌入 | pass | 集成 case「提案有效」断言 prompt 含 skill 全文 | `.claude/skills/git-conventions/SKILL.md`, `conductor/stages/shared.mjs::buildCommitterPrompt` |
| validateCommitMessage 单一裁判（regex/行宽/禁 WIP，绝不抛错） | pass | `tests/unit/commit-message.test.mjs` 全分支 | `conductor/stages/decisions.mjs` |
| 提案有效 → merge commit 用提案文案 | pass | 集成 case「提案有效」（git log -1 %B 断言） | `conductor/conductor.mjs::cmdMerge`, `conductor/stages/shared.mjs::runCommitterProposal` |
| 轮次 commit 不丢 | pass | 同 case 断言 main 历史含 `task <id>: maker r1 (cold)` | — |
| 两次 invalid → 降级机器文案，不 block merge | pass | 集成 case「两次 invalid」 | — |
| 预算超限 → 跳过 spawn 直接降级 | pass | 集成 case「budget 已超」 | — |
| models.committer 可配 | pass | 集成断言 argv `--model haiku-test` | `conductor/conductor.mjs::loadCfg`, `conductor.config.json` |

## Verification

```bash
npm test
```

Result: pass，162 tests。

## Remaining Work

- committer 提案目前只用于 conductor 的 merge commit；人工/loop commit 直接触发 git-conventions skill。
- 若后续想让 main 每行一题，考虑 GitHub squash merge + PR 标题按 subject 公式（流程约定，非代码）。
