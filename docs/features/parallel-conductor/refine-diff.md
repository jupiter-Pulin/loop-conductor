# Refine Diff: Parallel Conductor Runtime

## Verdict

Keep as-is. The diff is large because it replaces the runtime transport and scheduler foundation, but the added pieces map directly to the spec invariants and AC tests. I did not find a behavior-preserving simplification with enough payoff to justify more churn after the review-green baseline.

## Keep

- `conductor/lib/scheduler.mjs`: The chain/semaphore/task-lock split is justified by the per-task serialization and maxConcurrentTasks requirements.
- `conductor/lib/claude.mjs`: The explicit stream parser, inactivity timer, wall-clock timer, and process-group kill logic are worth keeping local to the Claude wrapper.
- `conductor/stages/needs_target_setup.mjs`: The local keyed mutex is narrow and avoids pushing setup-specific policy into generic scheduler code.
- `tests/integration/*.test.mjs`: The additional scenario files are AC-shaped rather than shared mega-tests, which keeps failures easy to map back to the spec.

## Not Worth Changing

- A few low-value cleanup opportunities exist, such as cosmetic indentation in some async CLI wrappers and small local variables in the stream wrapper. They do not obscure behavior or duplicate project-level helpers enough to merit touching the reviewed runtime diff.
