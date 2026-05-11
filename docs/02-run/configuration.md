# Configuration

`.env.example` documents the full set. Defaults target a developer laptop (4×4 slots).

## Knobs reviewers usually care about

```
PIPELINES_PER_JOB=200            # tasks per job, range 1..1000
GLOBAL_CPU_SLOTS=4               # also sets pm2 cpu-replica count
GLOBAL_SSH_SLOTS=4
GLOBAL_TRAINING_SLOTS=4
IO_WORKER_REPLICAS=4

CHAOS_CPU_CRASH_RATE=0
CHAOS_SSH_TIMEOUT_RATE=0
CHAOS_SSH_MISSING_ARTIFACT_RATE=0
```

## Timeout invariants — don't lower these blindly

Lease, timeout, and BullMQ-lock defaults satisfy two invariants that **prevent double-delivery** of a still-running task:

```
LEASE_TTL_MS              ≥ LEASE_HEARTBEAT_MS × ~6
BULLMQ_LOCK_DURATION_MS   ≥ max(*_TIMEOUT_MS) + 5000
```

See [`SPEC.md §3.10`](../../SPEC.md#310-bullmq-lock-alignment) and [`../03-design/timeout-and-death.md`](../03-design/timeout-and-death.md) for why. The startup config check fails fast if either invariant is violated.

## Where each knob is read

- Slot caps and replica counts: `lib/config.ts` at boot.
- Chaos rates: `lib/chaos.ts`, evaluated inside each task handler.
- Timeouts and lease windows: same `lib/config.ts`, cross-validated against BullMQ lock duration.

For deep design rationale, see [`../03-design/`](../03-design/).
