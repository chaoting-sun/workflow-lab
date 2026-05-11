# Timeout and death detection

Three independent mechanisms protect the worker pipeline against different failure modes. They look similar from the outside (all of them eventually free a stuck slot), but each one catches a class of failure the others can't see. This doc explains what they are, why each exists, and how they compose so the system never gets wedged.

## The problem

A task in flight can fail in two distinct ways, and it took the design a while to notice they're different:

1. **The worker is dead.** Process killed, OS crashed, host network-partitioned, GC stalled past every reasonable threshold. The worker isn't producing progress because it physically cannot.
2. **The worker is alive but stuck.** The process is up, the event loop is running, the heartbeat is firing — but `doWork` itself is wedged: an infinite loop, a regex catastrophic backtrack, a hung SSH session that the kernel hasn't given up on, a bug in a new code path.

These need different detection mechanisms. A liveness probe (heartbeat) catches the first but not the second — a stuck task happily heartbeats forever. A wall-clock timeout catches the second but not the first — a dead process can't enforce its own timeout.

The system therefore runs **three** mechanisms in parallel, each owning one slice of the problem.

## Three mechanisms, three failure modes

| Failure                       | Worker heartbeating? | Caught by               |
| ----------------------------- | -------------------- | ----------------------- |
| Process killed / OS crash     | no                   | reaper (lease expires)  |
| Network partition to DB       | no (heartbeat fails) | reaper                  |
| GC pause longer than lease TTL| no (effectively)     | reaper                  |
| `doWork` hangs in user code   | yes                  | `withTimeout`           |
| Bug-induced infinite loop     | yes                  | `withTimeout`           |
| Misconfigured `lockDuration`  | (either)             | BullMQ (last-resort)    |

The three mechanisms cover disjoint scenarios. Removing any one of them leaves a gap.

## Mechanism 1 — Lease + heartbeat + reaper

**What it catches:** the worker stops existing.

**How it works:**

- Scheduler sets `tasks.lease_token`, `lease_expires_at = now() + LEASE_TTL_MS`, and `lease_heartbeat_at = now()` at dispatch (single UPDATE inside `reserveOneTask`).
- Worker runs `startHeartbeat`, which bumps `lease_heartbeat_at` and `lease_expires_at` every `LEASE_HEARTBEAT_MS`, gated on `lease_token = $messageToken` so a released lease is a no-op.
- Reaper, running once per scheduler tick *before* dispatch, finds tasks where `lease_expires_at < now() AND status IN ('queued','running')`, resets the task to `pending` (or `failed` if attempts are exhausted), and clears the lease columns.

**Why it lives in the DB, not in BullMQ:** the DB is the system's source of truth for what's running. BullMQ has its own death-detection (`lockDuration`), but trusting it would mean letting BullMQ decide when to re-dispatch — splitting the dispatch policy across two systems and breaking the fairness guarantees enforced by the scheduler.

**Why the reaper *doesn't* bump `attempts`:** the next `claimTask` increments `attempts` atomically when it claims the reset task. If both the reaper and the claim bumped, an honest worker that resumed after a brief pause and finalized successfully would burn one extra attempt against `max_attempts`. Optimistic-locking on `attempts` is the safety net against the worker-resumes-after-reaper race.

## Mechanism 2 — `withTimeout` (Promise.race)

**What it catches:** the worker is alive but `doWork` is stuck.

**How it works:**

- Every worker handler wraps `doWork` in `withTimeout(work, *_TIMEOUT_MS)`, which races the work against a `setTimeout` that rejects with `TimeoutError`.
- On timeout, the catch path calls `recordFailure`, which writes `failure_reason='timeout'`, transitions the task to `pending` (retryable) or `failed` (terminal), and releases the lease.
- The handler resolves cleanly — BullMQ sees a finished job and is immediately ready for the next message.

**Why heartbeat alone isn't enough:** a stuck `doWork` doesn't stop the heartbeat — the `setInterval` lives on the event loop and fires regardless of what the work coroutine is doing. From the reaper's point of view, the lease is healthy. The wedged task would hold its slot forever.

**`*_TIMEOUT_MS` as a contract, not a heuristic:** the timeout values aren't tuned to "how long do we expect this to take." They're an upper bound: "no legitimate task of this kind should *ever* take longer than this." `SSH_TIMEOUT_MS=5000` against `SSH_SLEEP_MS=1000` gives 5× headroom — enough to absorb GC pauses, network jitter, and DB stalls, but not so much that a real wedge takes minutes to surface. A timeout firing in production is itself the signal worth investigating, which is why `failure_reason='timeout'` exists as a first-class column rather than a generic error string.

**The race doesn't cancel the loser.** When `withTimeout` rejects, `doWork` keeps running in the background. `withTimeout` attaches a no-op `.catch` to suppress the eventual unhandled rejection; the late resolution is silently dropped. This is acceptable because the work is idempotent (artifact paths are deterministic per `taskId`, optimistic-lock guards every DB write) and because cancellation across a Postgres query / fs write isn't free. Cancellation could be added later via `AbortController`, but isn't required for correctness.

## Mechanism 3 — BullMQ `lockDuration`

**What it catches:** misalignment between the other two mechanisms.

**How it works:** BullMQ holds a per-job lock with TTL `lockDuration`. If the worker doesn't extend the lock within that window, BullMQ assumes the worker died and re-delivers the job to another worker. This is BullMQ's own liveness check, completely independent of our DB-side reaper.

**The double-delivery hazard:** if `lockDuration` is shorter than the worst-case task time, BullMQ will re-deliver a job that's still running. Our atomic-claim (`attempts=$expected AND status='queued' AND lease_token=$messageToken`) catches the duplicate and silently aborts — but it's the *last* line of defence, not the first. We want to make double-delivery impossible by construction, not just survivable.

**The alignment rule:**

```
BULLMQ_LOCK_DURATION_MS  >=  max(*_TIMEOUT_MS) + 5000
```

The `+5000` is slack for the things that happen *after* `withTimeout` fires:

- `recordFailure` opens a DB transaction, writes `failure_reason`, releases the lease.
- DB round-trips occasionally hiccup; an extra few hundred milliseconds isn't unusual under load.
- The event loop has its own scheduling jitter; `setTimeout(_, 5000)` does not fire at exactly 5000ms.

Without the slack, "our timeout fires and we start cleaning up" can race "BullMQ decides we're dead and re-delivers." With it, the order is guaranteed: **our timeout always fires first, BullMQ is always the last resort.**

A boot-time cross-field check in `getConfig` enforces this invariant — startup rejects the config if the inequality is violated. The check is fail-fast on purpose; misalignment is the kind of bug you want to catch at startup, not in production at 3am.

## How they compose

A timeline for a CPU task with `CPU_TIMEOUT_MS=15000`, `LEASE_TTL_MS=30000`, `LEASE_HEARTBEAT_MS=5000`, `BULLMQ_LOCK_DURATION_MS=20000`:

```
t=0       task claimed (lease_expires_at = t+30000)
t=0..15s  doWork running; heartbeat bumps lease_expires_at every 5s
t=15s     withTimeout rejects → recordFailure starts
t=15.x    task → pending (or failed); lease columns cleared
t=20s     BullMQ would consider re-delivering — but lease_token has been
          cleared and the task is no longer 'queued'/'running', so any
          re-claim is a silent no-op via the atomic-claim guard
```

The same task, but the *worker process* dies at t=10s (no `withTimeout` involvement):

```
t=0       task claimed (lease_expires_at = t+30000)
t=0..10s  heartbeat fires
t=10s     process dies; heartbeat stops; lease_expires_at frozen at t+15000
t=15s     lease has expired; reaper picks it up on the next scheduler tick
t=15.x    task → pending; lease columns cleared; re-dispatched on a future tick
```

Each mechanism owns its scenario and stays out of the others' way.

## What not to do

- **Do not set `BULLMQ_LOCK_DURATION_MS` equal to (or below) `max(*_TIMEOUT_MS)`.** That's the double-delivery race the `+5000` slack exists to prevent.
- **Do not omit `withTimeout` and rely only on the heartbeat/reaper.** A stuck-but-heartbeating task will hold its slot until the process dies, possibly forever.
- **Do not omit the heartbeat and rely only on `withTimeout`.** A dead process can't enforce its own timeout. `expires_at` would never advance, but no one would notice without the reaper either — without heartbeat there's no way to distinguish "worker doing legitimate slow work" from "worker died."
- **Do not let the reaper bump `attempts`.** The next `claimTask` does that atomically; doubling up burns retries on healthy tasks that briefly stalled.
- **Do not move the timeout-induced failure write outside the catch path.** The `try/catch` around `withTimeout(...)` is also what catches `StaleAttemptError` and other doWork errors; keeping a single failure path keeps the optimistic-lock semantics consistent across all error types.

## Where each piece lives

- Heartbeat: `startHeartbeat` in `lib/worker.ts`.
- Reaper: `reapExpiredLeases` in `lib/scheduler.ts`, called once per `runSchedulerLoop` tick before dispatch.
- Timeout wrapper: `withTimeout` in `lib/timeout.ts`, applied in `worker/cpu.ts`, `worker/ssh.ts`, `worker/training.ts`.
- Failure finalize: `finalizeTaskFailure` and `recordFailure` in `lib/worker.ts`.
- BullMQ alignment validation: `getConfig` cross-field check.
