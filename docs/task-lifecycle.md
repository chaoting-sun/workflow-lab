# Task lifecycle and shutdown semantics

This doc captures how `tasks.status` transitions are produced, which writers touch `attempts`, and what graceful shutdown actually does. It exists because a `running → queued` transition with **no change to `attempts`** looks impossible at first reading — there is no direct writer for it. The transition is real, and is always the composition of two separate writes.

## Status transitions and their writers

| From → To           | Writer                                          | Touches `attempts`? |
| ------------------- | ----------------------------------------------- | ------------------- |
| pending → queued    | `reserveOneTask` (`lib/scheduler.ts:82`)        | No                  |
| queued  → running   | `claimTaskForRun` (`lib/worker.ts:110`)         | **Yes (+1)**        |
| running → succeeded | `finalize*Success` (`lib/worker.ts:148`, `:188`, `:293`) | No         |
| running → pending   | `finalizeTaskFailure` retryable arm (`lib/worker.ts:225`) | No        |
| running → failed    | `finalizeTaskFailure` terminal arm (`lib/worker.ts:225`)  | No        |
| running → pending   | `reapExpiredLeases` (`lib/scheduler.ts:174`)    | **No (by design)**  |
| running → queued    | **No direct writer. Two-step path only.**       | —                   |

## Invariant: `attempts` is incremented only by the claim

Reaper deliberately does NOT bump `attempts` (`lib/scheduler.ts:145-148`). The rationale, kept in code comments at that site:

> A worker that briefly stalls past lease TTL but still finalizes successfully would otherwise be charged an extra attempt against `max_attempts`. The next `claimTaskForRun` is the single point where attempts increase.

This is the diagnostic fingerprint for the rest of this doc: if you see a status flip with `attempts` unchanged, it cannot have gone through `claimTaskForRun`.

## The "running → queued" puzzle

**Symptom.** A task observed as `(status='running', attempts=N)` later appears as `(status='queued', attempts=N)`. No writer in the codebase performs this transition directly.

**Mechanism.** The transition is always two writes, in this order:

```
running  ──reap───────►  pending  ──dispatch──►  queued
         (lease TTL              (reserveOneTask,
          elapsed,                attempts unchanged)
          attempts unchanged)
```

- **Step 1 (reap).** `reapExpiredLeases` (`lib/scheduler.ts:152`) selects leases where `released_at IS NULL AND expires_at < now()`, sets the task to `pending`, releases the old lease. Heartbeats normally keep `expires_at` ahead of `now()`, but a stalled heartbeat (DB blip, event-loop pause, chained `tick` blocked on a slow `UPDATE leases`) will let it slip.
- **Step 2 (dispatch).** The same scheduler tick (or a subsequent one) runs `dispatchKind` → `reserveOneTask`, which selects on `status='pending'` and writes `status='queued'` plus a fresh lease row.

Both writes preserve `attempts`, so the row's `attempts` value is the same as before the cycle.

## When the two-step path can fire

The dispatch step (`reserveOneTask`) requires a live worker process running the scheduler tick — there is no other entry point in the codebase that calls it. Two scenarios produce the observed transition:

1. **Final tick during graceful shutdown.** `worker/index.ts:90-107` runs `await loop.stop()` first. `loop.stop()` clears the next-tick timer but **awaits the in-flight tick** so it can finish its `reapExpiredLeases` + parallel `dispatchKind` work. If a heartbeat had stalled long enough for a lease to expire, this final tick reaps the task to `pending` and dispatches it back to `queued` before shutdown progresses.
2. **Restart inside the lease TTL window.** If the worker is killed (graceful or hard), heartbeats stop, and a fresh worker boots before any external observer queries, the new worker's first tick reaps the orphaned lease (`status='running'` from the previous process), flips it to `pending`, then dispatches to `queued` — same two-step path, just spanning a process boundary.

The two scenarios are indistinguishable from the `tasks` row alone; the `leases` table tells them apart (see Diagnostics below).

## Graceful shutdown contract

Ctrl+C / SIGTERM handler (`worker/index.ts:90-107`) runs in this order:

1. `loop.stop()` — sets stopped flag, clears next-tick timer, **awaits the in-flight tick**. A reap+dispatch cycle already in motion will complete.
2. `cpuWorker.close()` / `sshWorker.close()` / `trainingWorker.close()` — BullMQ default (`force=false`), each one **waits for its in-flight job to finalize** (no timeout). This is why `running` rows drain to `succeeded`/`pending`/`failed` over seconds rather than dropping instantly.
3. `closeQueues()`, `lock.release()`, `closeDb()`, `process.exit(0)`.

There is no active "running → queued" requeue logic in the shutdown path. Recovery of orphaned leases is passive, via `reapExpiredLeases` on the next tick (this process's final tick, or the next worker's first tick).

What the shutdown path does **not** currently do:

- No timeout / force-exit fallback on a wedged in-flight job. If a task hangs past `worker.close()`'s implicit wait, the process stays up until BullMQ's `lockDuration` lets the job stall.
- No cancellation token threaded into `runCpuTask` / `runSshTask` / `runTrainingTask`. The handlers run to completion regardless of the shutdown signal.
- No `uncaughtException` / `unhandledRejection` handler.

## Diagnostics

To confirm a `running → queued` event came through the reap path, query both tables:

```sql
SELECT t.id, t.status, t.attempts,
       l.id AS lease_id, l.created_at, l.expires_at, l.released_at
  FROM tasks t
  LEFT JOIN leases l ON l.task_id = t.id
 WHERE t.id = '<task-id>'
 ORDER BY l.created_at;
```

Expected fingerprint when the path fired:

- An older lease row with `released_at IS NOT NULL` and `expires_at < released_at` — reaper found it expired and released it.
- A newer lease row with `released_at IS NULL` — created by `reserveOneTask` during dispatch.
- `tasks.attempts` matches whatever was observed during the prior `running` state.

If the older lease's `expires_at` is in the future relative to `released_at`, the path was instead `running → pending → queued` via `finalizeTaskFailure` (retryable) followed by dispatch — which still leaves `attempts` unchanged but means the worker handler ran to a thrown error rather than the lease quietly aging out.

## Related docs

- `docs/timeout-and-death-detection.md` — how heartbeat, reaper, and `withTimeout` compose to detect a dead vs. wedged worker.
- `docs/queue-architecture-tradeoffs.md` — why dispatch state lives in Postgres rather than being driven by BullMQ.
