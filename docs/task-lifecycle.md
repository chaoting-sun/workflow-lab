# Task lifecycle and shutdown semantics

This doc captures how `tasks.status` transitions are produced, which writers touch `attempts`, and what graceful shutdown actually does. It exists because a `running → queued` transition with **no change to `attempts`** looks impossible at first reading — there is no direct writer for it. The transition is real, and is always the composition of two separate writes.

## Status transitions and their writers

| From → To           | Writer                                          | Touches `attempts`? |
| ------------------- | ----------------------------------------------- | ------------------- |
| pending → queued    | `reserveOneTask` (`lib/scheduler.ts`)           | No                  |
| queued  → running   | `claimTask` (`lib/worker.ts`)                   | **Yes (+1)**        |
| running → succeeded | `finalize*Success` (`lib/worker.ts`)            | No                  |
| running → pending   | `finalizeTaskFailure` retryable arm (`lib/worker.ts`) | No            |
| running → failed    | `finalizeTaskFailure` terminal arm (`lib/worker.ts`)  | No            |
| running → pending   | `reapExpiredLeases` (`lib/scheduler.ts`)        | **No (by design)**  |
| running → queued    | **No direct writer. Two-step path only.**       | —                   |

## Invariant: `attempts` is incremented only by the claim

Reaper deliberately does NOT bump `attempts` (`lib/scheduler.ts`). The rationale, kept in code comments at that site:

> A worker that briefly stalls past lease TTL but still finalizes successfully would otherwise be charged an extra attempt against `max_attempts`. The next `claimTask` is the single point where attempts increase.

This is the diagnostic fingerprint for the rest of this doc: if you see a status flip with `attempts` unchanged, it cannot have gone through `claimTask`.

## The "running → queued" puzzle

**Symptom.** A task observed as `(status='running', attempts=N)` later appears as `(status='queued', attempts=N)`. No writer in the codebase performs this transition directly.

**Mechanism.** The transition is always two writes, in this order:

```
running  ──reap───────►  pending  ──dispatch──►  queued
         (lease TTL              (reserveOneTask,
          elapsed,                attempts unchanged)
          attempts unchanged)
```

- **Step 1 (reap).** `reapExpiredLeases` (`lib/scheduler.ts`) selects tasks where `lease_expires_at < now() AND status IN ('queued','running')`, sets the task to `pending`, and clears the lease columns (`lease_token`, `lease_expires_at`, `lease_heartbeat_at`). Heartbeats normally keep `lease_expires_at` ahead of `now()`, but a stalled heartbeat (DB blip, event-loop pause, chained tick blocked on a slow `UPDATE`) will let it slip.
- **Step 2 (dispatch).** The same scheduler tick (or a subsequent one) runs `dispatchKind` → `reserveOneTask`, which selects on `status='pending'` and writes `status='queued'` plus a fresh `lease_token` / `lease_expires_at` / `lease_heartbeat_at` in the same UPDATE.

Both writes preserve `attempts`, so the row's `attempts` value is the same as before the cycle.

## When the two-step path can fire

The dispatch step (`reserveOneTask`) requires the scheduler process running its tick loop — there is no other entry point in the codebase that calls it. Two scenarios produce the observed transition:

1. **Final tick during graceful shutdown of the scheduler.** The scheduler shutdown handler (`scheduler/index.ts`) runs `await loop.stop()` first. `loop.stop()` clears the next-tick timer but **awaits the in-flight tick** so it can finish its `reapExpiredLeases` + parallel `dispatchKind` work. If a heartbeat had stalled long enough for a lease to expire, this final tick reaps the task to `pending` and dispatches it back to `queued` before shutdown progresses.
2. **Restart inside the lease TTL window.** If the scheduler (or a worker) is killed (graceful or hard), heartbeats stop, and a fresh scheduler tick fires before any external observer queries, that tick reaps the orphaned lease (`status='running'` from the previous owner), flips it to `pending`, then dispatches to `queued` — same two-step path, just spanning a process boundary.

The two scenarios are indistinguishable from the current `tasks` row alone — and after ADR-0001 the row no longer keeps the per-attempt lease history that used to disambiguate them. See Diagnostics below for what can still be inferred and where logs become the source of truth.

## Graceful shutdown contract

Scheduler and workers run as separate processes; each has its own SIGTERM / SIGINT handler.

**Scheduler process** (`scheduler/index.ts`) shuts down in this order:

1. `loop.stop()` — sets stopped flag, clears next-tick timer, **awaits the in-flight tick**. A reap+dispatch cycle already in motion will complete.
2. `closeQueues()` — closes BullMQ queue producers used by `dispatchKind`.
3. `lock.release()` — releases the Postgres advisory lock so a replacement scheduler can boot.
4. `closeDb()`, `process.exit(0)`.

**Worker process** (`worker/index.ts`) shuts down in this order:

1. For each kind in the role (cpu / ssh / training): `worker.close()` — BullMQ default (`force=false`), each one **waits for its in-flight job to finalize** (no timeout). This is why `running` rows drain to `succeeded`/`pending`/`failed` over seconds rather than dropping instantly.
2. `closeQueues()`, `closeDb()`, `process.exit(0)`.

There is no active "running → queued" requeue logic in either shutdown path. Recovery of orphaned leases is passive, via `reapExpiredLeases` on the next scheduler tick (the scheduler's final tick before exit, or the next scheduler instance's first tick after restart).

What the shutdown path does **not** currently do:

- No timeout / force-exit fallback on a wedged in-flight job. If a task hangs past `worker.close()`'s implicit wait, the worker process stays up until BullMQ's `lockDuration` lets the job stall.
- No cancellation token threaded into `runCpuTask` / `runSshTask` / `runTrainingTask`. The handlers run to completion regardless of the shutdown signal.
- No `uncaughtException` / `unhandledRejection` handler.

## Diagnostics

After ADR-0001 (lease columns merged into `tasks`), each fresh dispatch overwrites the previous `lease_token` / `lease_expires_at` / `lease_heartbeat_at` — there is no longer a per-attempt lease history persisted on the row. The single-row fingerprint is therefore weaker than it used to be: from `tasks` alone, a `(running → queued)` flip cannot be definitively attributed to the reaper vs a retryable `finalizeTaskFailure` cycle.

```sql
SELECT id, status, attempts, max_attempts,
       lease_token, lease_expires_at, lease_heartbeat_at,
       failure_reason, started_at, finished_at
  FROM tasks
 WHERE id = '<task-id>';
```

What you can still infer:

- **`status='queued'` with `attempts=N` matching a prior observation** — the row went through some path back to `queued` without a successful claim (claim would have bumped `attempts`).
- **`failure_reason IS NOT NULL`** — at some prior cycle the worker entered `finalizeTaskFailure`. Neither the reaper nor `reserveOneTask` clears `failure_reason`, so its presence does not prove the *most recent* cycle was a finalize-failure — only that a finalize-failure happened at some point. Cross-reference with worker logs to attribute the current cycle.
- **`failure_reason IS NULL` and `attempts > 0`** — every prior cycle reached `running` and was reaped (the worker never entered the failure path).

If you need authoritative attribution of a specific reap-vs-finalize event, treat application logs (the reaper logs the count it reset; `recordFailure` logs the exception) as the source of truth — the row alone won't tell you.

## Related docs

- `docs/timeout-and-death-detection.md` — how heartbeat, reaper, and `withTimeout` compose to detect a dead vs. wedged worker.
- `docs/queue-architecture-tradeoffs.md` — why dispatch state lives in Postgres rather than being driven by BullMQ.
