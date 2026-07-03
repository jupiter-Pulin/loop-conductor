# Request Log: Setup Profile And Spec Verifier Loop

## Scope

Implement the agreed demo-framework additions:

- Add a repo-level setup-agent gate before feature/bugfix task flow when the target repo has no approved setup profile.
- Add a spec-agent/spec-verifier loop before human spec approval.
- Allow two spec repair rounds; on the third spec-verifier fail, cold-start a new spec-agent with prior review context and feasibility-study placeholder context.
- Keep prompt engineering as placeholders and preserve existing maker/verifier behavior.

Non-goals:

- Do not implement a real feasibility-study agent yet.
- Do not add deterministic source evidence validation for verifier line ranges.
- Do not replace maker/verifier green-gate semantics.

## Controlling Docs

- Current user implementation brief in this thread.
- Repo instructions from `AGENTS.md`.
- `$maker-ai-workflow` execution, AC traceability, testing strategy, and request log references.

## AC Evidence

| AC ID | Status | Proof | Files | Notes |
| --- | --- | --- | --- | --- |
| AC-001 | pass | `npm test` includes `首次 target repo 无 approved setup profile：setup-agent → approve-setup → 原任务流程` | `conductor/lib/profile.mjs`, `conductor/stages/needs_target_setup.mjs`, `conductor/stages/await_setup_approval.mjs`, `tests/integration/setup-spec-loop.test.mjs` | Proves missing setup profile routes to setup-agent, waits for human approval, then resumes original bugfix flow. |
| AC-002 | pass | `npm test` includes feature flow tests with spec-agent + spec-verifier before `AWAIT_SPEC_APPROVAL` | `conductor/stages/needs_spec.mjs`, `conductor/stages/spec_verify.mjs`, `conductor/stages/spec_fixing.mjs`, `tests/integration/feature-flow.test.mjs` | Proves feature specs are generated, verified, then human-approved before maker starts. |
| AC-003 | pass | `npm test` includes `spec-verifier fail 两次修复，第三次 fail 冷启动新 spec-agent 并注入报告上下文` | `conductor/stages/spec_verify.mjs`, `conductor/stages/shared.mjs`, `tests/integration/setup-spec-loop.test.mjs` | Proves two repair attempts, third fail cold restart, prior report injection, and feasibility placeholder injection. |
| AC-004 | pass | `npm test` includes `validateSpecVerifierVerdict` unit coverage | `conductor/stages/decisions.mjs`, `tests/unit/decisions.test.mjs` | Proves spec-verifier verdict schema has machine routing fields plus human/spec-agent report fields. |
| AC-005 | pass | `npm test` full suite passes existing maker/verifier retry, green gate, invalid verifier, budget, crash, worktree tests | `conductor/stages/ready.mjs`, `conductor/stages/fixing.mjs`, `conductor/stages/verify.mjs`, `tests/integration/*.test.mjs` | Guards existing behavior while adding setup/spec stages. |

## Changes

- Added repo-level setup profile helpers and target profile storage under `target-profiles/<repo>/`.
- Added setup-agent and spec-agent/spec-verifier placeholder prompts.
- Added `NEEDS_TARGET_SETUP`, `AWAIT_SETUP_APPROVAL`, `SPEC_VERIFY`, and `SPEC_FIXING` handlers.
- Updated `NEEDS_SPEC` to spawn spec-agent, then route through spec-verifier before human spec approval.
- Added spec-verifier verdict schema validation, invalid retry handling, spec repair contexts, report rendering, and cold-restart escalation.
- Updated CLI with `approve-setup` and setup-aware `new`.
- Updated README and test helpers.

## Verification

```bash
npm test
```

Result: pass, 83 tests.

## Blockers

None.

## Remaining Work

- Add a real feasibility-study agent and feed its approved output into spec-agent/spec-verifier prompts.
- Consider applying the shared conductor lock to all mutating human commands.
- Older loop/state-contract docs were removed; keep README as the routing index and code/tests as the source of truth.
