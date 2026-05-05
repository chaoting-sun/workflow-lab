# Implementation Plan: Workflow Lab

## Overview

Build the simulated job-orchestration system specified in `SPEC.md`. The system demonstrates fair multi-user scheduling: users submit jobs (each fanning into N CPU→SSH pipelines + a final training task), and a single scheduler enforces fairness across users while a single Node worker process executes the work via BullMQ. Resilience (lease/heartbeat/reaper, atomic-claim, optimistic-lock, timeouts, backpressure) and chaos verification are first-class requirements.

The plan slices vertically: each phase ends with a working, demoable system at increasing levels of robustness. Resilience primitives (atomic-claim, optimistic-lock) are built in from the first worker so we never have to retrofit them.

## Architecture Decisions

(All from SPEC, restated here for traceability.)

- **DB = source of truth, BullMQ = delivery only.** Tasks live in Postgres; scheduler decides what enters Redis.
- **Single scheduler instance** enforced via `pg_try_advisory_lock`; BullMQ workers can be many within the one process.
- **Lease + heartbeat + reaper** is the death-detection mechanism. Reaper logic lives inside the scheduler tick.
- **Atomic-claim + optimistic-lock** in every worker handler — built in from the first slice, not retrofitted.
- **Barrier counts the `artifacts` table only.** No filesystem IO inside DB transactions.
- **`jobs.pipelines_count`** is snapshotted at creation; barrier compares against the row, not the env var.
- **Chaos knobs default to 0**; happy path must be green before any chaos is enabled.
- Tech stack locked: TypeScript strict, Next.js App Router, raw `pg`, BullMQ, pnpm, Tailwind, single `package.json`.

## Implementation order (vertical slices)

```
Phase 1: Foundation
  └─ scaffold + schema + DB client
Phase 2: Happy-path slice (1 user, no chaos)
  └─ POST job → scheduler → CPU worker → SSH worker → barrier → training → job done
Phase 3: Resilience layer
  └─ heartbeat + reaper + timeouts + backpressure + BullMQ lock alignment
Phase 4: Chaos & multi-user
  └─ chaos knobs + fairness dashboard + verify all 5 SPEC §9 scenarios
```

---

## Task List

### Phase 1: Foundation

#### Task 1: Project scaffold

**Description:** Bootstrap the Next.js + TypeScript + Tailwind + pnpm project with Docker Compose for Postgres and Redis. Add a typed env-config loader and package scripts. No business logic.

**Acceptance criteria:**
- [ ] `pnpm dev` boots Next.js on `:3000` and shows an empty page.
- [ ] `docker-compose up -d` starts Postgres (5432) and Redis (6379).
- [ ] `lib/config.ts` parses every env var listed in SPEC §7 with `zod`, exits with a clear error on missing/invalid values, and exports a typed config object.
- [ ] TypeScript strict mode is on; `pnpm typecheck` is clean.

**Verification:**
- [ ] `pnpm dev` → load `http://localhost:3000` → no errors in console.
- [ ] `docker compose ps` shows `postgres` and `redis` healthy.
- [ ] `pnpm typecheck` exits 0.
- [ ] Manual: temporarily delete a required env var → app exits with a readable zod error.

**Dependencies:** None

**Files likely touched:**
- `package.json`, `pnpm-lock.yaml`
- `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `app/globals.css`
- `app/layout.tsx`, `app/page.tsx` (placeholder)
- `docker-compose.yml`, `.env.example`, `.gitignore`
- `lib/config.ts`

**Estimated scope:** M (5–8 files but mostly config boilerplate)

---

#### Task 2: Database schema

> Amended by ADR-0001 (2026-05-04): `leases` table is being removed; lease state moves onto `tasks` via `lease_token`, `lease_expires_at`, `lease_heartbeat_at`. T22 lands the actual migration; this entry is updated so future re-verification matches the new shape.

**Description:** Author `db/schema.sql` containing every table, index, and unique constraint listed in SPEC §3.4 — including `UNIQUE (parent_task_id) WHERE kind='ssh'`, `UNIQUE (task_id)` on artifacts, and the `jobs.pipelines_count` column. Provide a one-shot apply script.

**Acceptance criteria:**
- [ ] Tables exist: `users`, `jobs`, `tasks`, `artifacts`. (`leases` removed per ADR-0001.)
- [ ] `tasks` has `attempts`, `max_attempts`, `failure_reason`, `parent_task_id`.
- [ ] `tasks` has `lease_token uuid`, `lease_expires_at timestamptz`, `lease_heartbeat_at timestamptz` (all nullable; NULL = no active lease).
- [ ] `jobs.pipelines_count` exists, NOT NULL, with a CHECK 1..1000.
- [ ] Partial unique index on `tasks(parent_task_id) WHERE kind='ssh'`.
- [ ] `UNIQUE (task_id)` on `artifacts`.
- [ ] Indexes for hot queries: `tasks (kind, status, user_id)`, `artifacts (task_id)`, partial `tasks (lease_expires_at) WHERE lease_expires_at IS NOT NULL` (for the reaper).

**Verification:**
- [ ] `psql -f db/schema.sql` against a fresh DB succeeds and is idempotent (DROP TABLE IF EXISTS… or guarded CREATEs).
- [ ] `\d+ tasks` shows the partial unique index AND the new partial lease-expiry index.
- [ ] Manual insert of two SSH tasks with the same `parent_task_id` fails with the expected unique-violation.

**Dependencies:** Task 1 (docker-compose for Postgres)

**Files likely touched:**
- `db/schema.sql`
- `package.json` (add `db:reset` script)

**Estimated scope:** S

---

#### Task 3: DB client + advisory-lock helper

**Description:** A thin `lib/db.ts` wrapping `pg.Pool` with a `tx()` helper for transactions, plus `lib/advisory-lock.ts` that acquires `pg_try_advisory_lock(hashtext('workflow-lab:scheduler'))` on a **dedicated** long-lived connection (not the pool — pool churn would release the lock).

**Acceptance criteria:**
- [ ] `db.query`, `db.tx(async (tx) => …)` exposed; `tx` rolls back on throw.
- [ ] `acquireSchedulerLock()` returns the held client and a `release()` that returns the lock + closes the connection.
- [ ] Calling `acquireSchedulerLock()` twice in the same process (or from a second process against the same DB) — the second call resolves to "lock not acquired" and returns null.

**Verification:**
- [ ] Unit-style script `scripts/test-lock.ts` opens lock, spawns a second connection trying to acquire, asserts it fails, then releases and second succeeds.
- [ ] `pnpm typecheck` clean.

**Dependencies:** Tasks 1, 2

**Files likely touched:**
- `lib/db.ts`
- `lib/advisory-lock.ts`
- `scripts/test-lock.ts` (throwaway, deletable)

**Estimated scope:** S

---

### Checkpoint A: Foundation

- [ ] Tasks 1–3 complete.
- [ ] `pnpm dev` + `docker compose up -d` + `pnpm db:reset` works on a fresh clone.
- [ ] `pnpm typecheck` is green.
- [ ] **Human review** before starting Phase 2.

---

### Phase 2: Happy-path vertical slice

Goal: one user submits one job, all N pipelines run to completion, training artifact is written, `jobs.status='completed'`. No chaos enabled. Atomic-claim + optimistic-lock are in place from this phase forward.

#### Task 4: Users & jobs API

**Description:** Implement `POST /api/users`, `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs`, `GET /api/users` per SPEC §4. `POST /api/jobs` inserts the job + N `pending` CPU tasks in one transaction, snapshotting `pipelines_count`. Validate input with `zod` (existing user 404, `pipelines_count` 1..1000).

**Acceptance criteria:**
- [ ] `POST /api/users {name}` → returns `{id, name}`.
- [ ] `POST /api/jobs {userId}` → returns `{jobId, status:'pending', pipelinesCount}` and inserts job + N tasks atomically.
- [ ] Unknown `userId` → 404, no rows inserted.
- [ ] `PIPELINES_PER_JOB=0` rejected with 400.
- [ ] `GET /api/jobs/:id` returns `progress: { cpu, ssh, training }` with done / total / failed counts.

**Verification:**
- [ ] `curl` create user A → POST job → SELECT count(*) FROM tasks WHERE job_id=… → equals `PIPELINES_PER_JOB`.
- [ ] `curl` POST job with bogus userId → 404, no orphan tasks.
- [ ] `pnpm typecheck` clean.

**Dependencies:** Tasks 1–3

**Files likely touched:**
- `app/api/users/route.ts`
- `app/api/jobs/route.ts`
- `app/api/jobs/[id]/route.ts`
- `lib/jobs.ts` (creation logic)
- `lib/types.ts`

**Estimated scope:** M

---

#### Task 5: Scheduler tick (CPU only) with single-instance lock

> Amended by ADR-0001 (2026-05-04): no separate `leases` row to INSERT — reserve becomes a single UPDATE on `tasks` setting `status='queued', lease_token=$new_uuid, lease_expires_at=now()+TTL, lease_heartbeat_at=now()`. Slot accounting and fairness subqueries count `tasks` rows where `lease_token IS NOT NULL`. BullMQ payload is `{taskId, leaseToken, attempts}`. Re-verify under T22.

**Description:** Build the scheduler loop in `lib/scheduler.ts`: acquire advisory lock; tick every `SCHEDULER_TICK_MS`; for CPU only, run the fairness SQL from SPEC §3.3 (adapted per ADR-0001 to read from `tasks.lease_*`), set the task to `queued` with a fresh `lease_token` and `lease_expires_at = now() + LEASE_TTL_MS`, enqueue `{taskId, leaseToken, attempts}` to BullMQ. Reaper, backpressure, SSH, and training scheduling are stubs (no-ops) at this stage. Wire it into `worker/index.ts` so `pnpm worker` boots scheduler + an empty BullMQ worker shell.

**Acceptance criteria:**
- [ ] On startup, refuses to run a second instance (advisory lock).
- [ ] Each tick, picks **at most** `GLOBAL_CPU_SLOTS - used` CPU tasks across all users, where `used = count(*) FROM tasks WHERE kind='cpu' AND lease_token IS NOT NULL AND lease_expires_at > now()`.
- [ ] Fairness SQL orders by `(running_cpu_count ASC, jobs.created_at ASC, tasks.created_at ASC)`, where `running_cpu_count` counts `tasks` self-joined on `user_id` with `lease_token IS NOT NULL`.
- [ ] Reserve UPDATE commits before BullMQ `add`; if `add` throws, the lease columns will be reaped later (no special handling required here).
- [ ] No CPU task is dispatched twice (verify: at most one row per task has `lease_token IS NOT NULL` at any moment).

**Verification:**
- [ ] Submit 1 job with `PIPELINES_PER_JOB=5`, `GLOBAL_CPU_SLOTS=2`. Watch `tasks.status` transitions: 5 pending → 2 queued → others stay pending until reaper would re-dispatch (but reaper is stub, so no recovery yet). Status changes from `pending` to `queued` for at most 2 at a time. (Note: with no worker handler yet, queued tasks pile in BullMQ — expected.)
- [ ] Run two `pnpm worker` instances → second exits with "scheduler already locked".

**Dependencies:** Task 4

**Files likely touched:**
- `lib/scheduler.ts`
- `lib/queues.ts` (BullMQ Queue init for cpu/ssh/training)
- `worker/index.ts`

**Estimated scope:** M

---

#### Task 6: CPU worker (with atomic-claim + optimistic-lock)

> Amended by ADR-0001 (2026-05-04): claim gates on `lease_token = $messageToken` (replacing the `EXISTS (SELECT 1 FROM leases ...)` subquery); release sets `lease_token = NULL, lease_expires_at = NULL` on the same UPDATE that flips status. BullMQ payload field renamed to `leaseToken`. Re-verify under T22.

**Description:** Implement `worker/cpu.ts` per SPEC §3.7 (adapted per ADR-0001). Atomic claim on receive; sleep `CPU_SLEEP_MIN_MS..CPU_SLEEP_MAX_MS`; write `artifacts/cpu-${taskId}.txt`; in one transaction with optimistic-lock, set task succeeded AND null out the lease columns, insert `artifacts` row, INSERT child SSH task with `ON CONFLICT (parent_task_id) DO NOTHING`. Helpers (`runWorkerHandler`, claim/release SQL) extracted to `lib/worker.ts` for reuse.

**Acceptance criteria:**
- [ ] BullMQ message `{taskId, leaseToken, attempts}` triggers the handler.
- [ ] Atomic claim refuses to proceed if `task.status != 'queued'`, `task.attempts != expected`, or `task.lease_token != $messageToken`. 0-row update → silent return.
- [ ] On success, `tasks.status='succeeded'`, `artifacts` row exists, `lease_token IS NULL` and `lease_expires_at IS NULL`, exactly one new pending SSH child exists.
- [ ] No artifact / no lease release / no child SSH if optimistic UPDATE returns 0 rows.

**Verification:**
- [ ] Submit job with `PIPELINES_PER_JOB=3`. Wait. SELECT shows 3 succeeded CPU tasks, 3 pending SSH tasks, 3 artifacts rows, 3 released leases.
- [ ] Manually corrupt `attempts` mid-flight via `psql` to test the optimistic-lock branch — handler returns silently, no double child.

**Dependencies:** Task 5

**Files likely touched:**
- `worker/cpu.ts`
- `worker/index.ts` (register worker)
- `lib/worker.ts` (shared claim / release helpers)
- `lib/artifacts.ts` (path helper, write helper)

**Estimated scope:** M

---

#### Task 7: SSH worker + barrier check

> Amended by ADR-0001 (2026-05-04): inherits the lease helper changes from T6 (claim by `lease_token`, release by NULLing lease columns). Barrier logic is untouched — it counts `artifacts` rows and never read `leases`. Re-verify under T22.

**Description:** Implement `worker/ssh.ts` and `lib/barrier.ts`. SSH handler: claim → sleep `SSH_SLEEP_MS` → write `artifacts/ssh-${taskId}.txt` → verify file exists (`fs.access` outside tx) → in tx, insert artifact row, mark task succeeded AND null out lease columns, run barrier check. Extend the scheduler from T5 to also dispatch SSH tasks (independent slot pool, no backpressure yet).

**Acceptance criteria:**
- [ ] SSH tasks are dispatched once they become `pending` (after their CPU parent succeeds).
- [ ] Barrier check counts `artifacts` rows joined to `tasks.kind='ssh'` for the job.
- [ ] When count == `jobs.pipelines_count` AND no training task exists → INSERT one training task (`status='pending'`).
- [ ] Concurrent SSH finishers: only one training task ever exists per job (verify with race test).

**Verification:**
- [ ] Submit job with `PIPELINES_PER_JOB=3`. Wait. SELECT: 3 SSH artifacts, 1 training task pending, 0 duplicate trainings.
- [ ] Race test: lower `SSH_SLEEP_MS=10`, `PIPELINES_PER_JOB=10` → repeat 5×, assert always exactly 1 training task per job.

**Dependencies:** Task 6

**Files likely touched:**
- `worker/ssh.ts`
- `lib/barrier.ts`
- `lib/scheduler.ts` (add SSH dispatch)

**Estimated scope:** M

---

#### Task 8: Training worker + job completion

> Amended by ADR-0001 (2026-05-04): inherits the lease helper changes from T6 (release nulls lease columns rather than UPDATEing `leases.released_at`). Re-verify under T22.

**Description:** Implement `worker/training.ts`: claim → sleep `TRAINING_SLEEP_MS` → write `artifacts/train-${jobId}.txt` → in tx, mark task succeeded AND null out lease columns, `UPDATE jobs SET status='completed' WHERE id=$1 AND status NOT IN ('completed','failed')`. Extend scheduler to dispatch training tasks (third slot pool).

**Acceptance criteria:**
- [ ] Training task transitions `pending → queued → running → succeeded`.
- [ ] `jobs.status` becomes `'completed'` exactly once.
- [ ] Re-running a training task (manual reset to pending) does not regress `jobs.status` from completed (idempotent UPDATE guard).

**Verification:**
- [ ] Full happy-path run with `PIPELINES_PER_JOB=10`: job ends in `completed`. One training artifact file on disk. Total artifact files: 10 + 10 + 1 = 21.
- [ ] Manual: after completion, `UPDATE tasks SET status='pending' WHERE kind='training' AND job_id=…` then watch worker re-run it. Job stays completed.

**Dependencies:** Task 7

**Files likely touched:**
- `worker/training.ts`
- `worker/index.ts`
- `lib/scheduler.ts` (training dispatch)

**Estimated scope:** S

---

#### Task 9: Minimal dashboard

**Description:** Build the home page (`app/page.tsx`) with: a "Create user" form, a "Submit job" form (user dropdown), and a live job list polling `GET /api/jobs` every 1s with progress bars (CPU done/total, SSH done/total, training 0/1 or 1/1). No fairness panel yet — that lands in Task 15. Tailwind only, no component library.

**Acceptance criteria:**
- [ ] Can create a user via UI; appears in dropdown.
- [ ] Can submit a job; appears in job list with progress 0/N → … → N/N.
- [ ] Polling refreshes once per second; React state updates without page reload.
- [ ] Empty states (no users, no jobs) render readable placeholders.

**Verification:**
- [ ] Manual: create user, submit job, watch progress bars fill, end at completed.
- [ ] No console errors. No accessibility regressions (basic: keyboard tab order works for forms).

**Dependencies:** Task 8

**Files likely touched:**
- `app/page.tsx`
- `app/components/SubmitForm.tsx`
- `app/components/JobList.tsx`
- `app/components/UserPicker.tsx`

**Estimated scope:** M

---

### Checkpoint B: Happy path complete

- [ ] Tasks 4–9 complete.
- [ ] **SPEC §9.1 happy path passes**: 1 user, 1 job, `PIPELINES_PER_JOB=200`, all chaos = 0 → job completes with 1 training artifact.
- [ ] `pnpm typecheck` green.
- [ ] **Human review** before Phase 3.

---

### Phase 3: Resilience layer

Goal: the system survives worker crashes, hangs, and bursts of pending SSH work. No chaos knobs yet — we test by killing processes manually and tightening config.

#### Task 10: Lease heartbeat + scheduler reaper + job-failure propagation

> Amended by ADR-0001 (2026-05-04): heartbeat updates `tasks.lease_heartbeat_at` and `tasks.lease_expires_at` (gated by `lease_token = $token`, which replaces today's `released_at IS NULL` guard — a released lease has `lease_token=NULL` so the UPDATE no-ops). Reaper selects from `tasks` directly using the new partial `tasks_lease_expires_idx`. Reset-to-pending NULLs the lease columns; terminal failure leaves them set or NULLs them along with status — implementation choice in T22, but state must be self-consistent. Re-verify under T22.

**Description:** Add `setInterval`-driven heartbeat that bumps `tasks.lease_heartbeat_at` and `tasks.lease_expires_at` while a task runs (kept in `lib/worker.ts`). In the scheduler tick (before dispatching), reap rows where `lease_expires_at < now() AND status IN ('queued','running')`: for each, mark the task `pending` (if `attempts < max_attempts`) or `failed`, and null out the lease columns. On permanent failure, propagate `jobs.status='failed'`.

**Acceptance criteria:**
- [ ] Heartbeat fires every `LEASE_HEARTBEAT_MS` while a task is running; stops on success, failure, or process death.
- [ ] Heartbeat UPDATE is gated by `lease_token = $token`, so it cannot resurrect a lease the finalize tx already released.
- [ ] Reaper runs every tick, before fairness dispatch, and uses the partial `tasks_lease_expires_idx`.
- [ ] A task whose worker `kill -9`'d during sleep: `lease_expires_at` slips past `now()` within `LEASE_TTL_MS`; reaper resets to pending (NULLing lease columns); next tick re-dispatches; eventually succeeds (fresh attempt).
- [ ] A task that fails `MAX_ATTEMPTS` times: marked `failed`, the job becomes `failed`, no further dispatch, training never created.

**Verification:**
- [ ] Set `LEASE_TTL_MS=10000`, submit job, `kill -9` the worker mid-flight, restart it within 5s — `tasks.attempts` increments, job still completes.
- [ ] Set `MAX_ATTEMPTS=1` and `CHAOS_CPU_CRASH_RATE` (anticipating T14) won't be available yet, so manually `UPDATE tasks SET attempts=1 WHERE id=...` to simulate exhaustion. Reaper should mark the task `failed` and the job `failed`.

**Dependencies:** Task 8 (full pipeline working) — happy path must be solid before adding reaper.

**Files likely touched:**
- `lib/scheduler.ts` (reaper logic)
- `lib/worker.ts` (heartbeat + integrate into runTask wrapper)
- `lib/jobs.ts` (job-failure propagation helper)

**Estimated scope:** M

---

#### Task 11: Per-kind timeouts via Promise.race

**Description:** Wrap every worker `doWork` in `Promise.race(work, timeoutAfter(TIMEOUT_MS[kind]))`. On timeout, throw a typed `TimeoutError` so the catch branch sets `failure_reason='timeout'` and triggers retry-or-fail.

**Acceptance criteria:**
- [ ] Lowering `SSH_TIMEOUT_MS=200` while `SSH_SLEEP_MS=1000` deterministically produces timeouts.
- [ ] Timed-out task transitions to `pending` (retry) until `MAX_ATTEMPTS` is exhausted, then `failed`.
- [ ] Worker is **not** stuck — it returns to BullMQ ready state immediately on timeout.

**Verification:**
- [ ] With `SSH_TIMEOUT_MS=200`, `SSH_SLEEP_MS=1000`, `MAX_ATTEMPTS=2`: every SSH task hits `failed`; every job hits `failed`. No wedged worker.

**Dependencies:** Task 10

**Files likely touched:**
- `lib/worker.ts`
- `lib/timeout.ts` (small helper)

**Estimated scope:** S

---

#### Task 12: Backpressure (CPU paused on SSH backlog)

**Description:** Before dispatching CPU each tick, count SSH tasks in `('pending','queued','running')`. If ≥ `SSH_BACKPRESSURE_THRESHOLD`, skip CPU dispatch this tick. SSH and training dispatch unaffected.

**Acceptance criteria:**
- [ ] With `GLOBAL_SSH_SLOTS=5`, `SSH_BACKPRESSURE_THRESHOLD=15`: CPU dispatch pauses once SSH backlog hits 15; resumes when it drops below.
- [ ] No unbounded growth of SSH `pending` over a long run.

**Verification:**
- [ ] `psql` query in a loop logs `ssh_backlog` and `cpu running`. Manual observation: CPU `running` plateaus while SSH backlog ≈ 15.

**Dependencies:** Task 10

**Files likely touched:**
- `lib/scheduler.ts`

**Estimated scope:** XS

---

#### Task 13: BullMQ lock-duration alignment + lock extension

**Description:** Configure each BullMQ Worker with `lockDuration: BULLMQ_LOCK_DURATION_MS` (default 70s). Use the worker's `lockExtender` (BullMQ built-in) or call `job.extendLock()` on the same cadence as the DB heartbeat. Validate at boot that `BULLMQ_LOCK_DURATION_MS >= max(*_TIMEOUT_MS) + 5000`.

**Acceptance criteria:**
- [ ] Boot fails fast with a clear error when the config invariant is violated.
- [ ] A long-running training task (e.g. `TRAINING_SLEEP_MS=40000`, `BULLMQ_LOCK_DURATION_MS=70000`) is **not** double-delivered.

**Verification:**
- [ ] Set `TRAINING_SLEEP_MS=40000`. Submit job. Inspect `attempts` for the training task: stays at 1.
- [ ] Set `BULLMQ_LOCK_DURATION_MS=20000` (intentionally too low) → boot exits with config error.

**Dependencies:** Task 10

**Files likely touched:**
- `lib/queues.ts` / `worker/index.ts`
- `lib/config.ts` (cross-field validation)

**Estimated scope:** S

---

#### Task 13b: Per-kind BullMQ worker concurrency (config-driven)

**Description:** Each `Worker` in `worker/index.ts` currently omits `concurrency`, so BullMQ defaults to 1 in-flight job per queue — a single slow CPU/SSH/training task serializes the whole pool. Add three env-driven settings (`CPU_WORKER_CONCURRENCY`, `SSH_WORKER_CONCURRENCY`, `TRAINING_WORKER_CONCURRENCY`) wired through `lib/config.ts`, and pass them into the corresponding `Worker` constructors. Defaults should match the existing slot pools so behavior in a fresh checkout doesn't change qualitatively (the scheduler still throttles via `GLOBAL_*_SLOTS`).

**Acceptance criteria:**
- [ ] `lib/config.ts` adds `CPU_WORKER_CONCURRENCY`, `SSH_WORKER_CONCURRENCY`, `TRAINING_WORKER_CONCURRENCY` (positive ints) with sensible defaults (suggest: same as `GLOBAL_*_SLOTS` for cpu/ssh, and `GLOBAL_TRAINING_SLOTS` for training).
- [ ] `worker/index.ts` passes each value as the `concurrency` option to its `Worker`.
- [ ] `.env.example` documents the three new vars.
- [ ] Boot still validates the existing `BULLMQ_LOCK_DURATION_MS` invariant — concurrency does not interact with lock duration.
- [ ] No change to scheduler dispatch logic, lease semantics, or atomic-claim/optimistic-lock paths.

**Verification:**
- [ ] `pnpm typecheck` clean.
- [ ] With defaults unset, `parseConfig` succeeds and `cpuWorker.opts.concurrency` matches the documented default.
- [ ] Set `CPU_WORKER_CONCURRENCY=4`, submit a job with `PIPELINES_PER_JOB=10` and `GLOBAL_CPU_SLOTS=10`: observe up to 4 CPU jobs running concurrently in BullMQ (still gated by scheduler dispatch slots).
- [ ] Set any of the three to `0` or non-numeric → boot exits with a clear zod error.

**Dependencies:** Task 13

**Files likely touched:**
- `lib/config.ts`
- `worker/index.ts`
- `.env.example`

**Estimated scope:** XS

---

### Checkpoint C: Resilience verified

- [ ] Tasks 10–13b complete.
- [ ] Manual `kill -9` of worker mid-flight → job still completes.
- [ ] Forced timeouts → tasks fail cleanly; no wedged worker.
- [ ] Backpressure observed in dashboard / `psql`.
- [ ] **Human review** before Phase 4.

---

### Phase 4: Chaos & multi-user verification

#### Task 14: Chaos knobs

**Description:** Implement `lib/chaos.ts` with three injection points: `maybeCrash()` in CPU worker (calls `process.exit(1)` mid-sleep at `CHAOS_CPU_CRASH_RATE`), `maybeOversleep()` in SSH worker (extends sleep past `SSH_TIMEOUT_MS` at `CHAOS_SSH_TIMEOUT_RATE`), and `maybeSkipArtifact()` in SSH worker (returns without writing the file at `CHAOS_SSH_MISSING_ARTIFACT_RATE`). All default 0; chaos is opt-in. Add a `pnpm worker:watch` script using `tsx watch` so `process.exit` auto-restarts the process for scenario 1.

**Acceptance criteria:**
- [ ] Each chaos knob is read once per task invocation.
- [ ] With all three knobs at 0, behavior is identical to T13.
- [ ] `pnpm worker:watch` restarts on `process.exit(1)`.

**Verification:**
- [ ] Run with all knobs = 0 → 200-pipeline job completes (Checkpoint B re-verification).
- [ ] `CHAOS_CPU_CRASH_RATE=1.0` → every CPU task crashes the worker → `pnpm worker:watch` keeps restarting → eventually job completes (very slowly) thanks to reaper. (Sanity check that the chaos knob actually fires.)

**Dependencies:** Tasks 11, 13

**Files likely touched:**
- `lib/chaos.ts`
- `worker/cpu.ts`, `worker/ssh.ts`
- `package.json` (worker:watch script)

**Estimated scope:** S

---

#### Task 15: Fairness panel in dashboard

> Amended by ADR-0001 (2026-05-04): "active leases" data source moves from `leases WHERE released_at IS NULL` to `tasks WHERE lease_token IS NOT NULL AND lease_expires_at > now()`. Build this task only after T22 lands, so the API reads the new shape from day one.

**Description:** Add a "Fairness" panel to `app/page.tsx`: shows `running CPU: X/GLOBAL_CPU_SLOTS` globally, plus a per-user breakdown of running CPU/SSH/training counts. Backed by `GET /api/users` extended to include `runningCpu`, `runningSsh`, `runningTraining` derived from `tasks` rows with an active lease (`lease_token IS NOT NULL AND lease_expires_at > now()`), grouped by `kind` and `user_id`.

**Acceptance criteria:**
- [ ] Panel updates via the same 1s poll as the job list.
- [ ] Numbers reconcile with raw `psql` counts of `tasks WHERE lease_token IS NOT NULL AND lease_expires_at > now()`, grouped by kind and user_id.
- [ ] When 3 users submit jobs simultaneously, panel visibly shows running counts converging toward equal split.

**Verification:**
- [ ] Submit jobs as alice/bob/carol within ~2s. Watch panel: each user's runningCpu approaches `GLOBAL_CPU_SLOTS / 3`.

**Dependencies:** Task 14

**Files likely touched:**
- `app/api/users/route.ts`
- `app/components/FairnessPanel.tsx`
- `app/page.tsx`

**Estimated scope:** S

---

#### Task 16: Run all 5 SPEC §9 chaos scenarios

**Description:** Execute the five acceptance scenarios from SPEC §9.2–9.6 in sequence. For each: configure env, run, observe expected behavior, capture any deviations. This is verification, not new code — but if a scenario fails, we triage and patch under this task.

**Acceptance criteria:**
- [ ] §9.1 happy path (all chaos 0): green.
- [ ] §9.2 worker crash: tasks reaped, attempts increment, job completes.
- [ ] §9.3 SSH timeout: timeouts retried, eventually fail or succeed cleanly; no hang.
- [ ] §9.4 missing artifact: barrier never advances on tasks without artifact rows; training only fires after every SSH has an artifact.
- [ ] §9.5 multi-user fairness: dashboard shows convergence (≈ equal split).
- [ ] §9.6 backpressure: CPU dispatch pauses; no unbounded SSH backlog.
- [ ] `tasks/verification.md` records each scenario's env, observation, and pass/fail.

**Verification:** Self-verifying — the task IS verification. The acceptance criteria above are the verification.

**Dependencies:** Task 15

**Files likely touched:**
- `tasks/verification.md` (new file)
- (any patches uncovered during runs)

**Estimated scope:** S (assuming no major bugs surface; otherwise unbounded)

---

### Checkpoint D: Complete

- [ ] All 16 tasks complete.
- [ ] All 5 SPEC §9 scenarios green and documented in `tasks/verification.md`.
- [ ] `pnpm typecheck` clean.
- [ ] `tasks/todo.md` is fully checked off.
- [ ] Final review with human.

---

### Phase 4.5: Lease consolidation (ADR-0001)

Goal: collapse the independent `leases` table into ownership columns on `tasks` (per ADR-0001). Must land before T15 (fairness panel) and T16 (verification scenarios) so those read the new shape from day one. T2 / T5 / T6 / T7 / T8 / T10 acceptance criteria have been amended in place; this phase is where the migration work actually executes and re-verifies them.

#### Task 22: Lease-into-tasks migration + helper rename

**Description:** Execute ADR-0001. Rewrite `db/schema.sql` to drop the `leases` table and its indexes; add `lease_token uuid`, `lease_expires_at timestamptz`, `lease_heartbeat_at timestamptz` columns to `tasks`; create the partial `tasks_lease_expires_idx ON tasks (lease_expires_at) WHERE lease_expires_at IS NOT NULL`. Rewrite all SQL paths in `lib/scheduler.ts` (reserveOneTask single-UPDATE, count subqueries, reaper) and `lib/worker.ts` (claim by `lease_token`, heartbeat gated by `lease_token`, finalize-* paths NULL the lease columns). Rename `DispatchMessage.leaseId` to `leaseToken` across `lib/queues.ts`, `lib/scheduler.ts`, `lib/worker.ts`, `worker/cpu.ts`, `worker/ssh.ts`, `worker/training.ts`. Update every test that asserts on `leases` table state to assert on `tasks.lease_*` instead. Apply via `pnpm db:reset` (lab convention — no online migration needed).

**Acceptance criteria:**
- [ ] `db/schema.sql` no longer contains `CREATE TABLE leases` or any `leases_*` index.
- [ ] `tasks` has the three new columns, all nullable, default NULL.
- [ ] Partial index `tasks_lease_expires_idx` exists.
- [ ] `pnpm typecheck` clean.
- [ ] All previously-passing tests in `lib/scheduler.test.ts`, `lib/worker.test.ts`, `db/schema.test.ts`, `worker/cpu.test.ts`, `worker/ssh.test.ts`, `worker/training.test.ts`, `lib/advisory-lock.test.ts` updated to the new schema and still passing.
- [ ] BullMQ payload field is `leaseToken: string`; no remaining reference to `leaseId` in `lib/`, `worker/`, or tests.
- [ ] T2, T5, T6, T7, T8, T10 acceptance criteria (already amended in place) all re-verify against the new code.

**Verification:**
- [ ] `grep -rn "leases\|leaseId" lib/ worker/ db/ scripts/ app/` returns no matches except inside ADR/replan-log references.
- [ ] Manual happy-path run (Checkpoint B re-verification): 1 user, `PIPELINES_PER_JOB=200`, all chaos = 0 → job completes; `psql` shows no row in `tasks` with `lease_token IS NOT NULL` once the job is done.
- [ ] Manual `kill -9` of worker mid-flight (Checkpoint C re-verification): job still completes; reaper picks up the orphaned `lease_expires_at`.

**Dependencies:** T14 (chaos knobs are independent of the lease shape, but landing T22 after T14 keeps Phase 4 contiguous).

**Files likely touched:**
- `db/schema.sql`
- `lib/scheduler.ts`, `lib/worker.ts`, `lib/queues.ts`
- `worker/cpu.ts`, `worker/ssh.ts`, `worker/training.ts`, `worker/index.ts`
- `lib/scheduler.test.ts`, `lib/worker.test.ts`, `db/schema.test.ts`
- `worker/cpu.test.ts`, `worker/ssh.test.ts`, `worker/training.test.ts`
- `lib/advisory-lock.test.ts`, `scripts/test-lock.ts` (if either touches lease shape)

**Estimated scope:** L (touches every lease-aware module; mostly mechanical rewrites with one careful claim/heartbeat invariant change).

---

#### Task 23: Race test — `lease_token` fencing under reap-and-redispatch

**Description:** Add a focused integration test (likely in `lib/scheduler.test.ts` or a new `lib/lease-fencing.test.ts`) that exercises the exact race the EXISTS-on-`leases` subquery used to close: dispatch a task → message captured but not yet claimed → force the lease to expire → reap (resets to pending, NULLs `lease_token`) → dispatch again (new `lease_token`) → both BullMQ messages now in flight. Two concurrent `claimTask` calls — one with the old token, one with the new — must result in exactly one successful claim. The other must return null silently.

**Acceptance criteria:**
- [ ] Test deterministically reproduces the dispatch → expire → re-dispatch sequence (no `setTimeout` — drive lease expiry by `UPDATE tasks SET lease_expires_at = now() - interval '1s'`).
- [ ] Two `claimTask` calls run concurrently (`Promise.all`).
- [ ] Exactly one returns a `ClaimedTask`; the other returns `null`.
- [ ] After the dust settles: `tasks.attempts` incremented exactly once; `tasks.lease_token` matches the winning message; `tasks.status='running'`.
- [ ] Repeating the test 10× is stable (no flaky pass/fail).

**Verification:**
- [ ] Run the test 10× via `pnpm test --run -t "<test name>"` — all green.
- [ ] Mutation check: temporarily remove the `lease_token = $token` predicate from `claimTask`; the test must fail. Confirms the test actually exercises the fencing, not coincidence. Revert before commit.

**Dependencies:** T22

**Files likely touched:**
- `lib/scheduler.test.ts` OR new `lib/lease-fencing.test.ts`
- `lib/test-helpers.ts` (if a helper for forcing lease expiry is added)

**Estimated scope:** S

---

### Checkpoint D.1: Lease consolidation verified

- [ ] T22 + T23 complete.
- [ ] All previously-passing tests green under the new schema.
- [ ] Checkpoint B happy path re-verified.
- [ ] Checkpoint C `kill -9` resilience re-verified.
- [ ] **Human review** before resuming T15 / T16.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Postgres advisory lock released early due to pool churn | High — second scheduler could spawn | Hold the lock on a **dedicated** `pg.Client`, not a pooled connection. Verified explicitly in Task 3. |
| BullMQ lock duration < task timeout → double delivery | High — duplicate work, possibly duplicate children | Atomic-claim + optimistic-lock catch it; alignment validation in Task 13 prevents it pre-flight. |
| `process.exit(1)` chaos kills worker — annoying dev loop | Medium | `pnpm worker:watch` via `tsx watch` (Task 14). |
| Reaper false-positive under GC pause / event-loop stall | Medium — healthy task reset to pending → optimistic-lock kicks in, no corruption | TTL = 6× heartbeat interval gives generous margin. Optimistic-lock is the safety net. |
| Race between barrier finishers creating duplicate training tasks | High — would cause `jobs.status` confusion | `SELECT … FOR UPDATE` on `jobs` row + `NOT EXISTS` guard (SPEC §3.5). Verified in Task 7 race test. |
| Postgres `FOR UPDATE SKIP LOCKED` semantics differ from expectation | Medium | Validated in Task 5 with a 2-process race (concurrent insert simulators). |
| Fairness SQL uses correlated subquery → slow at large scale | Low (this is a lab) | Acceptable. If profiled slow, switch to `LEFT JOIN ... GROUP BY`. |
| Chaos rates produce streaks (not uniformly distributed) | Low — visible noise, not correctness | Documented as "out of scope" in SPEC §12. |

---

## Open Questions

(None blocking — all decisions made in SPEC. Listed here as future-improvements:)

- Add a `scripts/load-test.ts` that submits N jobs across M users for headless load characterization? Not in scope; would be Task 17.
- Per-user backpressure (instead of global)? Discussed and explicitly deferred (SPEC §3.8 trade-off paragraph).

---

## Parallelization opportunities

- Tasks 1–3 are sequential.
- Tasks 4 and 5 can be parallelized (4 = HTTP, 5 = scheduler) once Task 3 is done — they only meet at Task 6.
- Tasks 11, 12, 13 (timeouts, backpressure, BullMQ alignment) are independent of each other once Task 10 is done.
- Task 9 (dashboard happy path) can start in parallel with Task 8 if Task 7's API contract is stable.

For a single-developer flow, sequential execution is simplest and matches the dependency graph.
