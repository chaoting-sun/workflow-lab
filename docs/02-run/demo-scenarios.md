# Demo scenarios

Six chaos scenarios double as acceptance tests. Each flips one knob and observes the dashboard. Full procedures and expected behaviour: [`SPEC.md §9`](../../SPEC.md#9-testing-strategy).

| # | Scenario | Chaos knob | Mode | What to watch |
|---|---|---|---|---|
| 9.1 | Happy path | (all = 0) | A or B | All 200 pipelines complete; one training artifact; job status = completed. |
| 9.2 | CPU worker crash | `CHAOS_CPU_CRASH_RATE=0.10` | **B** | ~10% of CPU tasks call `process.exit(1)`. Leases expire after `LEASE_TTL_MS`; reaper resets them to pending; `attempts` increments; pm2 restarts the dead replica; job still completes. |
| 9.3 | SSH timeout | `CHAOS_SSH_TIMEOUT_RATE=0.05` | A or B | `Promise.race` rejects on timeout; retry up to `MAX_ATTEMPTS`, then fail. Worker is never stuck; lease released cleanly. |
| 9.4 | Missing artifact | `CHAOS_SSH_MISSING_ARTIFACT_RATE=0.05` | A or B | `verifyArtifact` throws → retry. Barrier counts only on-disk artifacts, so training never starts prematurely. |
| 9.5 | Multi-user fairness | (none — submit jobs from 3 users within ~2s) | **B** | Fairness panel's per-user CPU counts converge to within 1. With `GLOBAL_CPU_SLOTS=4` + 3 users → 2/1/1, with the extra slot rotating as tasks finish. |
| 9.6 | Backpressure | `GLOBAL_SSH_SLOTS=5`, `SSH_BACKPRESSURE_THRESHOLD=15` | **B** | When SSH backlog (pending + queued + running) hits 15, scheduler stops dispatching new CPU tasks; SSH drains; CPU resumes. No unbounded growth. |

Mode **B** is required for the scenarios that exercise process-level death-recovery (9.2) and multi-replica fairness (9.5, 9.6) — Mode A's single worker per role can't show them.

## How to flip a knob

All chaos knobs live in `.env`. Edit, restart the affected process, submit a job:

```bash
# example: enable CPU crash injection
sed -i '' 's/^CHAOS_CPU_CRASH_RATE=.*/CHAOS_CPU_CRASH_RATE=0.10/' .env
pnpm supervisor:stop && pnpm supervisor:start
```

See [`configuration.md`](./configuration.md) for the full set of knobs.
