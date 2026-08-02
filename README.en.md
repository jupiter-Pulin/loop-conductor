# Loop Conductor (will-workflow)

A state machine that runs an agent loop end to end: it writes the spec, reviews the spec, implements the change, verifies the diff cold, and stops at the gates where a human has to decide. Everything else — retries, budget, worktrees, test gates, commit messages — is machine-owned.

> The Chinese [`README.md`](README.md) is the routing index used by agents working inside this repo. This document is the human-facing tour.

## What this is

`will-workflow` is a single-machine orchestrator for Claude CLI agents. A task enters as one line of intent and leaves as a merged branch, or as an archived failure with a full paper trail. It is deliberately small:

- **Zero third-party dependencies.** `package.json` has no `dependencies` and no `devDependencies`, and there is no lockfile. The runtime is Node plus the Claude CLI.
- **Roles are separated by construction, not by prompting.** There are eight agent prompts (`agents/*.md`); each is spawned in its own session with its own tool allowlist. The verifier, for example, is hard-limited to `Read` / `Grep` / `Glob` / `Bash(git diff:*)` / `Bash(git log:*)` (`conductor/stages/shared.mjs`), so it physically cannot run the code it is judging — it reads the frozen spec and the diff, nothing else.
- **The frozen spec is the only contract.** Once a human approves it, the spec is copied into `dossier/<id>/spec.md` and every downstream agent is judged against that text. Implementers never renegotiate the acceptance criteria.
- **Evidence is mechanical.** The conductor re-runs the test command itself (the green gate); it does not take the implementer's word for it. It then replays the changed tests against the pre-change baseline (the test gate) and rejects tests that pass on the old code, because those prove nothing.
- **The paper trail is the product.** Every round writes into `dossier/<id>/` — spawn records, verdicts, repair contexts, gate results, timeline. Cost and round counts are recoverable per task after the fact, which is what makes the numbers in [What it actually cost](#what-it-actually-cost) possible.

Three task kinds exist: `bugfix` (goes straight to implementation from a human-written spec), `feature` (gets the full spec-authoring and spec-review chain), and `probe` (investigation only — it ends in a report, never a merge).

There is also a local web dashboard (`npm run dashboard`) for watching the loop and making the human decisions in a browser instead of on the command line. Its interface strings are Chinese; see [Screenshots](#screenshots).

## State machine

Stage names below are the literal values written into `state/<box>/<id>/runtime.json`.

```text
optional setup gate:
NEEDS_TARGET_SETUP -> AWAIT_SETUP_APPROVAL -> natural task stage

optional feasibility gate (feature + new --feasibility / config.feasibilityEnabled):
NEEDS_FEASIBILITY -> AWAIT_FEASIBILITY_APPROVAL --approve-feasibility --option O-X--> NEEDS_SPEC
contract gate fail -> retry the feasibility agent in place; misses exhausted -> FAILED_BOX
reject-feasibility -> NEEDS_FEASIBILITY (notes are fed into the next round's prompt)

feature:
NEEDS_SPEC -> SPEC_VERIFY -> SPEC_FIXING -> SPEC_VERIFY -> AWAIT_SPEC_APPROVAL -> READY
contract gate fail -> retry the spec agent in place; misses exhausted -> FAILED_BOX

bugfix:
READY

probe:
investigation report -> AWAIT_PROBE_CLOSE --close--> DONE   (no merge, ever)

implement / verify:
READY -> VERIFY -> AWAIT_HUMAN_MERGE -> DONE
READY/FIXING green-gate fail (the conductor runs the test command itself) -> FIXING
READY/FIXING optional gate commands, any non-zero exit -> FIXING
READY/FIXING test-gate vacuous (the new tests also pass on the pre-change baseline) -> FIXING
VERIFY verdict fail -> FIXING
verifier returned a protocol-invalid verdict -> VERIFY (retry)
budget / retry / crash exhausted -> FAILED_BOX
FAILED_BOX --retry--> READY or NEEDS_SPEC
```

Two things worth naming explicitly:

- **`FIXING` is the only repair path, and it is fed structured data.** Whatever failed — green gate, gate commands, test gate, or the verifier — the conductor writes a repair context and hands the implementer that, not a human-readable narrative. The implementer never reads the verifier's prose.
- **`FAILED_BOX` is a real terminal state, not a crash.** Tasks that exhaust their miss ladder are archived with their whole dossier intact and can be re-entered with `retry`. Two of the eleven tasks in the snapshot below ended here.

## Roles

Eight agent prompts, each spawned by a different stage:

| Role | Prompt | What it does |
| --- | --- | --- |
| setup | `agents/setup-agent.md` | Explores the target repo read-only and produces a reusable setup profile (build/test commands, layout, conventions). |
| feasibility | `agents/feasibility-agent.md` | Writes a decision memo: evidence, competing options `O-1`…`O-n`, a recommendation, open questions. The human picks an option by ID. |
| spec | `agents/spec-agent.md` | Writes the task spec — goals, non-goals, contract, invariants, numbered acceptance criteria — from the brief and the chosen option. |
| spec-verifier | `agents/spec-verifier-agent.md` | Audits that spec for testability, contradictions, and scope, and returns a strict JSON verdict with severity-tagged findings. |
| maker | `agents/maker-agent.md` | Implements inside the task worktree until every acceptance criterion holds. Destructive git operations are blocked by a per-round hook. |
| verifier | `agents/verifier-agent.md` | Reads the frozen spec and the diff cold — no execution — and rules on each acceptance criterion individually. |
| committer | `agents/committer-agent.md` | Drafts the merge commit message. It is a proposal: a mechanical validator has the final say, and after two rejected drafts the conductor falls back to a machine-generated message. |
| reviewer | `agents/reviewer-agent.md` | Shadow role, **off by default** (`reviewStage` defaults to `off`). When enabled it reviews the same diff independently of the verifier and only writes comparison artifacts — it never affects the state machine. |

## Human gates

The state machine has exactly four stopping points that wait on a person:

| Stage | The question |
| --- | --- |
| `AWAIT_SETUP_APPROVAL` | Is this profile of the target repo correct? Once approved it is reused by every later task on that repo. |
| `AWAIT_FEASIBILITY_APPROVAL` | Which option are we building? Approved by ID: `approve-feasibility <id> --option O-X`. |
| `AWAIT_SPEC_APPROVAL` | Is this spec the thing we want, and are its acceptance criteria the ones we want to be held to? Approving freezes it. |
| `AWAIT_HUMAN_MERGE` | Ship it. The conductor never pushes; merge is local and manual. |

For a person actually running the loop, that is **three decisions per task**:

1. **Setup profile** — one-time per target repo, not per task.
2. **Spec direction** — either picking a feasibility option or approving the spec. Which one you get depends on whether the feasibility gate is enabled; you do not do both for the same task.
3. **Merge** — the terminal gate.

Everything between those points runs without a human, including all repair rounds.

**Machine rubber-stamping is off by default.** Two config switches can collapse a gate, and both default to `false` in `loadCfg` (`conductor/conductor.mjs`):

- `autoApproveSpecEnabled` — `false`. When enabled, a spec whose verdict is clean (no blocker, major, or advisory findings, and under the criteria-count ceiling) can be frozen without a human.
- `autoMergeEnabled` — `false`. When enabled, a passing verdict on a low-risk diff can be merged locally without a human. It never pushes.

Also off by default: `reviewStage` (`'off'`) and `verifierShadowEnabled` (`false`). The `conductor.config.json` checked into the repo is one machine's sample configuration and opts into some of these — it is not the default set. `loadCfg` is the source of truth for defaults.

## What it actually cost

Snapshot date: **2026-08-02**. Refresh with:

```bash
node tools/dossier-stats.mjs
```

| Metric | Value |
| --- | --- |
| Tasks | 11 (queue 2 / done 7 / failed 2) |
| Total spend | $127.557105 |
| maker r1 max-turns cutoff rate | 0/9 (0%) |
| maker rounds using continuation | 1/10; cold-degraded: 0 |
| Tasks needing r2+ | 1/11 (9%) |
| verifier | 8 rounds (fail 1, protocol-invalid 0) |
| test gate | vacuous blocks 0, per-AC mode 8 rounds |
| committer | first draft accepted 3/7 (43%), degraded 1 |
| Failure types | `spec_misses_exhausted` ×2 |

Read that as: eleven tasks, seven merged, two still queued, two archived as failures — for about $128 in model spend. Nine of the eleven reached implementation; only one of them needed a second implementation round, and none of them hit the turn ceiling on the first round. The two failures both died in spec authoring, before writing a line of code, which is the cheap place to fail.

**Where these numbers come from, and what you can reproduce.**

They are the author's own runtime dossiers, read out of two directories: `state/` (task snapshots and state-machine records) and `dossier/` (per-task spawn records, verdicts, gate results, timelines). **Both directories are in `.gitignore` and are not distributed with the public repository** — only empty skeletons are checked in.

That has a direct consequence: `node tools/dossier-stats.mjs` **only produces non-zero output for someone who has actually run the loop on their own machine**. Run it in a fresh clone of this repository and the output is `0` tasks and `$0`, because there are no dossiers to read. That is a data boundary, not a bug.

So treat this snapshot as **self-reported numbers plus a methodology you can re-run against your own loop**. What is reproducible is the *methodology*: every metric above is one line of output from `renderMarkdown` in `tools/dossier-stats.mjs` — the task/box counts and total spend, the maker cutoff and continuation rates, the r2+ share, the verifier round counts, the test-gate counters, the committer first-pass rate, and the failure-type distribution, in that order. Nothing here is an estimate and nothing is hand-aggregated; read the function and you can see exactly what each number counts.

The snapshot also goes stale by design — it moves with every task that runs, including the one that produced this document. **Take the output of the refresh command over the table above.**

## Run your first task

Prerequisites:

- **Node 24 or newer.** The conductor warns on older majors but does not block; the test suite expects 24.
- **No `npm install`.** There are zero third-party dependencies and no lockfile — clone and run.
- **A working Claude CLI on your machine**, logged in and callable as `claude`. The conductor spawns it for every agent role; without it nothing runs.

Then, from the repository root:

```bash
# 0. sanity check
npm test

# 1. create a task
npm run conductor -- new --kind feature --title "add a --json flag to the stats CLI"
# bugfix form, when you already know the fix:
npm run conductor -- new --kind bugfix --title "fix off-by-one in the round counter"
# optional: hand it a written brief and turn on the feasibility gate
npm run conductor -- new --kind feature --title "..." --brief brief.md --feasibility

# 2. drive the loop; it runs until it needs you or finishes
npm run conductor -- run

# 3. see where everything is
npm run conductor -- status

# 4. approve the frozen spec when it stops at AWAIT_SPEC_APPROVAL
npm run conductor -- approve <id>
# or send it back with notes
npm run conductor -- reject <id> --notes "..."

# 5. the terminal gate: merge locally and archive
npm run conductor -- merge <id>
```

Other gates, if you enabled them: `approve-setup <id>` and `approve-feasibility <id> --option O-X`. A task that landed in `FAILED_BOX` goes back with `retry <id>`.

`run` is re-entrant. Interrupt it, run it again, and it picks up from the persisted stage — state lives on disk, not in the process.

To watch it in a browser instead:

```bash
npm run dashboard   # http://127.0.0.1:4400
```

The dashboard shows the six-lane board, per-task detail with the diff and the verifier's ruling, and the same human decisions as buttons. Its interface is in Chinese.

## Screenshots

The dashboard is the most legible part of this system and the hardest to publish safely — it renders absolute host paths, private repository names, and branch names. [`docs/showcase/screenshot-checklist.md`](docs/showcase/screenshot-checklist.md) lists every screen worth capturing, how to reach it, and exactly which fields have to be redacted before a screenshot leaves your machine.

## Repository layout

| Path | What lives there |
| --- | --- |
| `conductor/conductor.mjs` | Command-line interface, configuration defaults, stage dispatch. |
| `conductor/stages/` | One module per stage, plus `decisions.mjs` for pure routing and schema judgments. |
| `conductor/lib/` | State layout, Claude CLI wrapper, git and worktree operations, spec and feasibility contracts, test-gate helpers. |
| `conductor/dashboard/` | The local web dashboard (a thin `node:http` layer plus a static front end). |
| `agents/` | The eight role prompts. |
| `tests/` | `integration/` for behavioural cases, `unit/` for invariants. |
| `tools/dossier-stats.mjs` | Cross-task aggregation of cost, rounds, and failure distribution. |
| `state/`, `dossier/` | Runtime data. Git-ignored; not distributed. |
