# Request Log: Parallel Conductor Runtime

## Scope

Implement `docs/features/parallel-conductor/2-tech-spec.md`: async stream-json Claude runtime, green gate timeout, per-task/concurrent scheduler, atomic writes, box/stage patrol, global lock liveness/heartbeat, per-task CLI locks, setup keyed mutex, run budget, spy, and regression tests. Non-goals from the spec remain out of scope.

## Controlling Docs

- `docs/features/parallel-conductor/2-tech-spec.md`
- `AGENTS.md`
- `README.md`
- Maker AI Workflow references: execution protocol, AC traceability, testing strategy, request log template.

## AC Evidence

| AC ID | Status | Proof | Files | Notes |
| --- | --- | --- | --- | --- |
| AC-001 | pass | `npm test`; `tests/unit/state.test.mjs` atomic write test | `conductor/lib/state.mjs`, `conductor/lib/profile.mjs`, `tests/unit/state.test.mjs` | Verifies tmp+rename paths and no tmp residue. |
| AC-002 | pass | `npm test`; `tests/integration/crash-patrol.test.mjs` | `conductor/lib/state.mjs`, `conductor/conductor.mjs`, `tests/integration/crash-patrol.test.mjs` | FAILED_BOX and DONE queue zombies are repaired; retry works for failed. |
| AC-003 | pass | `npm test`; `tests/integration/lock.test.mjs` | `conductor/lib/lock.mjs`, `conductor/conductor.mjs`, `tests/integration/lock.test.mjs` | Live pid remains blocking; dead pid self-heals. |
| AC-004 | pass | `npm test`; `tests/unit/lock.test.mjs` heartbeat test | `conductor/lib/lock.mjs`, `conductor/conductor.mjs`, `tests/unit/lock.test.mjs` | Heartbeat refreshes lock mtime. |
| AC-005 | pass | `npm test`; `tests/integration/happy-path.test.mjs`, `tests/integration/liveness-kill.test.mjs` | `conductor/lib/claude.mjs`, `conductor/stages/shared.mjs`, `tests/fixtures/fake-claude.mjs` | Spawn records retain existing fields and add stream JSONL files. |
| AC-006 | pass | `npm test`; `tests/integration/liveness-kill.test.mjs` inactivity/resume cases | `conductor/lib/claude.mjs`, `conductor/stages/shared.mjs`, `tests/integration/liveness-kill.test.mjs` | Inactivity kill is transient, records killed, resumes when partial stream has session progress. |
| AC-007 | pass | `npm test`; `tests/integration/liveness-kill.test.mjs` wall-clock case | `conductor/lib/claude.mjs`, `tests/integration/liveness-kill.test.mjs` | Continuous output still dies at wall-clock limit. |
| AC-008 | pass | `npm test`; `tests/integration/liveness-kill.test.mjs` slow-alive case | `conductor/lib/claude.mjs`, `tests/fixtures/fake-claude.mjs`, `tests/integration/liveness-kill.test.mjs` | Slow active output avoids inactivity kill. |
| AC-009 | pass | `npm test`; `tests/integration/green-gate-timeout.test.mjs` | `conductor/stages/shared.mjs`, `conductor/stages/ready.mjs`, `conductor/stages/fixing.mjs`, `tests/integration/green-gate-timeout.test.mjs` | Timeout writes `timed_out:true`, `exit_code:null`, and routes to FIXING. |
| AC-010 | pass | `npm test`; `tests/integration/parallel-scheduling.test.mjs` | `conductor/lib/scheduler.mjs`, `conductor/conductor.mjs`, `tests/integration/parallel-scheduling.test.mjs` | Parallel starts overlap; maxConcurrentTasks=1 serializes. |
| AC-011 | pass | `npm test`; `tests/unit/scheduler.test.mjs` | `conductor/lib/scheduler.mjs`, `conductor/lib/task-lock.mjs`, `tests/unit/scheduler.test.mjs` | Single-task chain steps do not overlap and lock releases. |
| AC-012 | pass | `npm test`; `tests/integration/drain-cap.test.mjs` | `conductor/lib/scheduler.mjs`, `conductor/conductor.mjs`, `tests/integration/drain-cap.test.mjs` | maxStepsPerTask caps with continuation log; maxDrainSteps warns and is ignored. |
| AC-013 | pass | `npm test`; `tests/integration/cli-task-lock-spy.test.mjs`, `tests/unit/task-lock.test.mjs` | `conductor/lib/task-lock.mjs`, `conductor/conductor.mjs`, `tests/integration/cli-task-lock-spy.test.mjs` | CLI mutation fails while task step is active. |
| AC-014 | pass | `npm test`; `tests/integration/setup-race.test.mjs` | `conductor/stages/needs_target_setup.mjs`, `tests/integration/setup-race.test.mjs` | Same repo setup gate spawns once and both tasks wait for approval. |
| AC-015 | pass | `npm test`; `tests/integration/liveness-kill.test.mjs`, `tests/integration/budget.test.mjs` | `conductor/lib/claude.mjs`, `conductor/stages/shared.mjs`, `tests/integration/liveness-kill.test.mjs` | Killed/no-result spawn records `cost_unknown:true`, cost lower-bound remains 0, per-task budget still passes. |
| AC-016 | pass | `npm test`; `tests/integration/budget.test.mjs` runBudget case | `conductor/lib/scheduler.mjs`, `conductor/stages/shared.mjs`, `tests/integration/budget.test.mjs` | runBudget stops new spawn without FAILED_BOX. |
| AC-017 | pass | `npm test`; `tests/integration/cli-task-lock-spy.test.mjs` | `conductor/conductor.mjs`, `conductor/stages/shared.mjs`, `tests/integration/cli-task-lock-spy.test.mjs` | `conductor spy` is read-only and shows active role/round. |
| AC-018 | pass | `npm test` full suite: 130 tests passing | `tests/integration/*.test.mjs`, `tests/unit/*.test.mjs` | Existing integration semantics remain green after stream/async runtime. |

## Changes

- Added atomic state/profile writes and startup box/stage patrol.
- Added pid-aware global lock self-healing, heartbeat, per-task lock primitive, and CLI mutation lock wrapping.
- Replaced Claude spawn transport with async stream-json, stream dossier files, inactivity/wall-clock kill, killed/cost_unknown record fields, and async retry.
- Replaced drain loop with concurrent per-task scheduler, maxStepsPerTask, runBudget, and setup keyed mutex.
- Converted stage handlers and green gate to async with timeout-aware routing.
- Added `conductor spy`.
- Updated fake Claude and tests for stream-json, liveness, concurrency, task locks, setup race, run budget, and regression coverage.

## Verification

```bash
npm test
```

Result: pass, 130 tests.

```bash
node --test tests/unit/state.test.mjs tests/unit/lock.test.mjs tests/unit/task-lock.test.mjs tests/unit/scheduler.test.mjs tests/integration/crash-patrol.test.mjs tests/integration/liveness-kill.test.mjs tests/integration/green-gate-timeout.test.mjs tests/integration/parallel-scheduling.test.mjs tests/integration/setup-race.test.mjs tests/integration/budget.test.mjs tests/integration/cli-task-lock-spy.test.mjs
```

Result: pass during targeted validation.

## Blockers

- None.

## Remaining Work

- None for this spec pass.
