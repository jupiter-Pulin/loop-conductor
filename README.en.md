# Loop Conductor (will-workflow)

A minimal kernel that runs an agent loop end to end: a **router agent** picks the next action from a closed set, the kernel executes it, records the facts, and stops at the two gates where a human has to decide — approving the spec, and approving the merge. Everything else — retries, budget, worktrees, the pre-commit regression, branch cleanup — is machine-owned.

> The Chinese [`README.md`](README.md) is the routing index used by agents working inside this repo. This document is the human-facing tour.

> **Work packages (parallel makers) and the `plan` action are not implemented yet.** `packagesEnabled` defaults to `false`: the `plan` action is rejected, the spec prompt carries no work-package section, `specs/<id>.packages.json` is not writable, and a `packages` field in a router log is invalid. Everything below describes the single-maker path, which is the whole system today.

## What this is

`will-workflow` is a single-machine orchestrator for Claude CLI agents. A task enters as one line of intent and leaves as a merged branch, or as an archived failure with a full paper trail. It is deliberately small:

- **Zero third-party dependencies.** `package.json` has no `dependencies` and no `devDependencies`, and there is no lockfile. The runtime is Node plus the Claude CLI.
- **The kernel produces facts; the router decides; the human judges twice.** The kernel never infers intent and never re-dispatches an agent on its own. It spawns, commits, merges, records, and enforces ceilings. The router only picks one action from `spec | plan | maker | review | precommit | human | merge | abandon`.
- **Roles are separated by construction, not by prompting.** Four agent prompts (`agents/*.md`), each spawned in its own session with its own tool allowlist. The reviewer is hard-limited to `Read` / `Grep` / `Glob` / `Bash(git diff|log|show:*)` / `Write` (`conductor/lib/agent-settings.mjs`), so it physically cannot run the code it is judging. The router gets `Write` and nothing else — it cannot run git, cannot read the spec text or the diff, and cannot approve anything.
- **One file is the whole delivery channel.** Every agent ends by writing `dossier/<id>/<role>-r<n>.log.json`; the kernel reads that file and nothing else — not the final chat message. A missing or malformed log is not an exception path, it is one field on the record (`product: missing | invalid`) handed to the router as-is.
- **The version rule is the only ground for merging.** With `H` = task-branch HEAD and `B` = base-branch HEAD: a review is needed unless a reviewer record exists with `outcome=ok ∧ head_sha=H`; a pre-commit run is needed unless a record exists with `outcome=ok ∧ head_sha=H ∧ base_sha=B`. Human notes cannot waive either one, and both are recomputed at the moment of approval.
- **The paper trail is the product.** Every round writes into `dossier/<id>/` — spawn records, execution logs, raw streams, per-round hook settings, pre-commit step results, human gate requests, timeline, and a structured `events.jsonl`. Cost and round counts are recoverable per task after the fact.

There is also a local web dashboard (`npm run dashboard`) for watching the loop and making the human decisions in a browser instead of on the command line. Its interface strings are Chinese; see [Screenshots](#screenshots).

## State machine

Four stages, and the stage name is the literal value in `state/<box>/<id>/runtime.json`.

```text
new ──► ROUTING ──(router picks an action, kernel executes it, records it)──► ROUTING …

ROUTING ──spec file passes validateSpecDoc──► AWAIT_HUMAN(spec) ──approve / reject --notes──► ROUTING
ROUTING ──router: merge, version rule satisfied──► AWAIT_HUMAN(merge) ──approve──► DONE
                                                                     └──reject --notes──► ROUTING
ROUTING ──router: human──► AWAIT_HUMAN(help) ──resume [--notes]──► ROUTING
ROUTING ──rate limit rejected──► FAILED_BOX(rate_limited) ──retry (≥ resets_at)──► ROUTING
ROUTING ──fuse: same signature N times──► FAILED_BOX(fuse_no_progress) ──retry──► ROUTING
ROUTING ──budget exhausted──► FAILED_BOX(budget_exhausted) ──retry──► ROUTING
ROUTING ──router: abandon──► FAILED_BOX(abandoned) ──retry──► ROUTING
ROUTING ──router fails twice in a row──► AWAIT_HUMAN(help, requested_by=kernel)
```

Three things worth naming explicitly:

- **Those are the only transitions the kernel starts by itself.** A unit test (`tests/unit/decisions.test.mjs`) statically enumerates every `transitionState` call site in the state machine and in the CLI and fails if a new one appears. Everything else is a router action.
- **A rejected action costs nothing.** If the router picks an action whose preconditions do not hold — `merge` while a review is still needed, `precommit` at a tier below what the reviewer declared, `review` with no diff, `maker` before an existing spec has been approved — the kernel records `action_rejected{reason}`, produces no side effect, and feeds the reason back into the next round's fact section. Two consecutive router failures (an invalid log, or a rejected action) open a help gate: the router is the only judge, and when the judge is absent nobody else can decide.
- **`FAILED_BOX` is a real terminal state, not a crash.** Everything is preserved — worktrees, branches, the whole dossier — so `retry` puts the task back into `ROUTING` exactly where it was. Nothing moves a task out of `FAILED_BOX` without a human: no cron, no scheduler sweep, and the dashboard's auto-run does not apply to it.

## Roles

Four agent prompts. Judgement is carried by few-shot examples drawn from real dossiers (`agents/fewshot/*.md`), not by long instructions — the fixed context of each prompt is a few hundred characters.

| Role | Prompt | cwd | Tools | Max turns | What it does |
| --- | --- | --- | --- | --- | --- |
| router | `agents/router-agent.md` | conductor root | `Write` | 4 | Reads the brief, the record list, and the kernel's facts, then picks one action from the closed set. It never sees the spec text, the diff, or the code. |
| spec | `agents/spec-agent.md` | `worktrees/<id>.spec-ro` (throwaway detached worktree at base) | `Read` `Grep` `Glob` + `git log/blame/show` + `Write` `Edit` | 40 | Turns the brief into a spec that covers **all** of it. Scope questions go into an `## 待决问题` ("open questions") table with a safe default — it may not quietly trim requirements. |
| maker | `agents/maker-agent.md` | `worktrees/<id>` (branch `task/<id>`) | all (`Bash` pre-approved) | 70 | Implements the acceptance criteria until the test command is green. Destructive git operations are blocked by a per-round hook. |
| reviewer | `agents/reviewer-agent.md` | `worktrees/<id>` | `Read` `Grep` `Glob` + `git diff/log/show` + `Write` | 40 | Reads the frozen spec and the whole branch diff cold — no execution — rules on every criterion individually, and declares the test tier the diff reaches. |

Deleted along the way, and not coming back: setup, feasibility, spec-verifier, verifier, committer, the test-gate probe, the per-criterion evidence mapping, the maker miss ladder, and the session-resume leg. They were designed for weaker models and for a state machine that tried to substitute mechanical ladders for judgement; they burned $149 across seven failed tasks and produced zero lines of code.

## Human gates

Exactly **two mandatory stops**, plus one the router can open on demand:

| Gate | The question | CLI |
| --- | --- | --- |
| `AWAIT_HUMAN(spec)` | Is this spec the thing we want, and are its acceptance criteria the ones we want to be held to? Approving freezes it into `dossier/<id>/spec.md`; every later agent is judged against that text. | `approve <id> [--notes "…"]` / `reject <id> --notes "…"` |
| `AWAIT_HUMAN(merge)` | Ship it. The version rule is recomputed at this moment; if `H` or `B` moved, the approval is refused and the task goes back to `ROUTING`. The merge is local. **The conductor never pushes.** | `approve <id> [--message "…"]` / `reject <id> --notes "…"` |
| `AWAIT_HUMAN(help)` | Opened by the router (or by the kernel after two router failures) when a decision is genuinely outside the machine's authority. | `resume <id> [--notes "…"]` |

Notes have exactly two destinations, and they are not interchangeable. Notes given when **approving** a spec are injected verbatim into every later maker and reviewer prompt as an extra constraint. Notes given when **rejecting** a spec are rewriting instructions for the spec agent, and the rejected draft is archived on the spot so the kernel can never re-open the gate with a version a human already refused.

A task with no spec is legitimate: for a bug fix with a reproduction and an expected behaviour, the router can go straight to `maker` and the brief is the contract. In that case the spec gate never opens, and the merge gate is the only stop.

**There is no machine rubber-stamping.** `autoApproveSpec*` and `autoMerge*` are gone from the codebase, not merely defaulted to `false`.

## Gates that are not human gates

Two mechanical gates run without anyone's attention, and neither can be waived by a human note:

- **`precommit`** proves, on the actual **merge candidate** (`base` checked out detached, task branch merged `--no-ff` into it), that the integrated system still builds, still starts, and still passes the tests at the declared tier — in that order: `build → service → unit [+ integration [+ e2e]]`. Steps that are not configured are recorded as `skipped`; the first applicable step that fails makes the whole run `fail` and the rest `not_run`. The service is started in its own process group and terminated in a `finally` block, so a stuck server cannot poison the next task. The candidate worktree is always removed. Only one pre-commit runs at a time machine-wide (`state/.precommit.lock`), because ports and databases are shared. The three commands are written by a human in `target-profiles/<repo>/setup-profile.json`; the kernel never guesses them, and a repo without at least a unit command cannot create a task at all.
- **The fuse** counts *lack of progress*, not steps. The kernel computes a signature for each reviewer, maker, and pre-commit record; `fuseStreak` (default 3) identical signatures in a row for the same role sends the task to `FAILED_BOX(fuse_no_progress)`. Real work changes the facts every round; a loop does not.

Rate limits get their own treatment, learned the expensive way: a five-hour or weekly limit is **not** a transient error. The retry wrapper stops at zero attempts, the task goes to `FAILED_BOX(rate_limited)` carrying `resets_at`, no further spawn goes out for the rest of that run, and only a human `retry` — at or after the reset moment — brings it back. The dashboard card shows the reset time and keeps the button disabled until then.

## What it actually cost

Snapshot: **2026-09-09**, taken from the author's own dossiers, before this rewrite landed. Refresh with:

```bash
node tools/dossier-stats.mjs
```

| Metric | Value |
| --- | --- |
| Tasks | 17 (done 10 / failed 7) |
| Total spend | $248.67 |
| Spend on the seven failed tasks | $148.60, for zero lines of shipped code |
| maker r1 one-shot pass | 16/17 |
| maker r1 max-turns cutoff | 0/14 |
| test-gate vacuous blocks (in its entire lifetime) | 0/17 |

Read that as: the model side rarely failed. Every one of the seven failures came from the machinery around it — three tasks ($87) burned in a spec ↔ spec-verifier ping-pong that shrank findings 11 → 9 → 7 → 7 → 5 → 4 and still hit a hard ceiling, and two ($61) died because a five-hour rate limit was retried as if it were a transient 429, on specs a human had already approved. That is what the current architecture is a response to: fewer ladders, fewer roles, two human gates, and limits treated as limits.

**Where these numbers come from, and what you can reproduce.**

They are runtime dossiers, read out of two directories: `state/` (task snapshots and state-machine records) and `dossier/` (per-task spawn records, execution logs, gate results, timelines). **Both directories are in `.gitignore` and are not distributed with the public repository** — only empty skeletons are checked in.

That has a direct consequence: `node tools/dossier-stats.mjs` **only produces non-zero output for someone who has actually run the loop on their own machine**. Run it in a fresh clone of this repository and the output is `0` tasks and `$0`, because there are no dossiers to read. That is a data boundary, not a bug.

So treat this snapshot as **self-reported numbers plus a methodology you can re-run against your own loop**. What is reproducible is the *methodology*: every metric is one line of output from `renderMarkdown` in `tools/dossier-stats.mjs`, which reads both eras of dossier — router rounds, actions, pre-commit steps and tiers, human gates and their decisions, per-role cost — alongside the older counters. Nothing here is estimated and nothing is hand-aggregated; read the function and you can see exactly what each number counts.

The snapshot also goes stale by design — it moves with every task that runs. **Take the output of the refresh command over the table above.**

## Run your first task

Prerequisites:

- **Node 24 or newer.** The conductor warns on older majors but does not block; the test suite expects 24.
- **No `npm install`.** There are zero third-party dependencies and no lockfile — clone and run.
- **A working Claude CLI on your machine**, logged in and callable as `claude`. The conductor spawns it for every agent role; without it nothing runs. At the start of every `run` it probes each configured model once and aborts the run — changing no task state — if a model is unavailable.
- **A pre-commit profile for your target repository.** `target-profiles/<repo>/setup-profile.json` must carry a `precommit` section. `new` refuses to create a task without it and prints a fully-keyed example, annotated with which keys you may delete.

Then, from the repository root:

```bash
# 0. sanity check
npm test

# 1. create a task — one title, one brief file. No kind, no gates to pre-select.
npm run conductor -- new --title "add a --json flag to the stats CLI" --brief brief.md
# another repository, or a different base branch:
npm run conductor -- new --title "…" --brief brief.md --repo ../other-repo --base-branch develop

# 2. drive the loop; it runs until it needs you or finishes
npm run conductor -- run

# 3. see where everything is
npm run conductor -- status
npm run conductor -- spy          # read-only: which role is running right now

# 4a. the spec gate
npm run conductor -- approve <id> --notes "ship the safe default for open question 2"
npm run conductor -- reject  <id> --notes "AC-002 is not observable; rewrite it as a behaviour"

# 4b. the help gate
npm run conductor -- resume  <id> --notes "rebased the conflict by hand and ran the unit tests"

# 5. the terminal gate: merge locally and archive. Never pushes.
npm run conductor -- approve <id> --message "optional override of the machine commit message"

# when something is in the failed box
npm run conductor -- retry <id> [--force]
npm run conductor -- retry --rate-limited        # every rate-limited task at once
npm run conductor -- abandon <id>
```

`run` is re-entrant. Interrupt it, run it again, and it picks up from the persisted stage — state lives on disk, not in the process.

To watch it in a browser instead:

```bash
npm run dashboard   # http://127.0.0.1:4400
```

The dashboard shows the four-column board (`ROUTING` / `AWAIT_HUMAN` / `FAILED_BOX` / `DONE`), a read-only monitoring drawer per task, a full-screen review page carrying the same buttons as the CLI, and a metrics view. Its interface is in Chinese.

## Screenshots

The dashboard is the most legible part of this system and the hardest to publish safely — it renders absolute host paths, private repository names, and branch names. [`docs/showcase/screenshot-checklist.md`](docs/showcase/screenshot-checklist.md) lists every screen worth capturing, how to reach it, and exactly which fields have to be redacted before a screenshot leaves your machine.

## Repository layout

| Path | What lives there |
| --- | --- |
| `conductor/conductor.mjs` | Command-line interface, configuration defaults, the human-gate verbs. |
| `conductor/stages/` | `routing.mjs` (the loop), `await_human.mjs` (a parking space), `router-kernel.mjs` (spawn, gates, cleanup), `actions/` (one file per action). |
| `conductor/lib/` | The execution-log contract, record synthesis, the version rule, pre-commit, the fuse, prompt assembly, git and worktree operations, state layout. |
| `conductor/hooks/` | Per-round agent hooks: write allowlist, log-contract pre-check, spec-contract pre-check, maker git guard. |
| `conductor/dashboard/` | The local web dashboard (a thin `node:http` layer plus a static front end). |
| `agents/` | Four role prompts plus `fewshot/` — the judgement transfer surface. |
| `tests/` | `integration/` for behavioural cases, `unit/` for invariants. |
| `tools/dossier-stats.mjs` | Cross-task aggregation of cost, rounds, gates, and failure distribution. |
| `docs/features/router-conductor/2-tech-spec.md` | The current design and its acceptance criteria. |
| `state/`, `dossier/` | Runtime data. Git-ignored; not distributed. |
