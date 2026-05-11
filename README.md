# Workflow Lab

A simulated job-orchestration system that demonstrates **fair multi-user scheduling on a bounded resource pool**. Built as a learning lab for the patterns that make production schedulers correct under load and failure: lease-based execution, single-instance dispatch with atomic claims, barrier synchronization, and graceful recovery from worker crashes.

The work itself is fake (`sleep` + a touched file). The point is the machinery around it.

## What's interesting

- **Fairness under skew.** When user A submits 200 tasks before user B submits 1, naïve FIFO leaves B waiting behind all 200. The scheduler picks the next task with a 4-level tie-break (per-user active count → per-job active count → job age → task age) so B's task interleaves immediately. Two concurrent jobs from the same user also interleave instead of draining oldest-first.
- **Correctness under failure.** Tasks are owned via DB-backed leases (`lease_token`, `lease_expires_at`, `lease_heartbeat_at`). Workers heartbeat while running; the scheduler's reaper reclaims any task whose heartbeat stops. Every worker write is gated on a fencing token (atomic claim + optimistic lock on `attempts`), so a slow worker that finishes after re-dispatch becomes a silent no-op instead of corrupting state.
- **Multi-process scaling.** Real CPU-bound work would block the event loop, freezing both the lease heartbeat and the BullMQ lock-renewal callback — causing the same task to be re-dispatched and executed twice. The fix is two-layered: pm2 runs one CPU-bound process per slot (`GLOBAL_CPU_SLOTS` replicas), and inside each, `doWork` runs in a `worker_threads.Worker` so the main thread stays free for heartbeats.
- **Operational thinking.** Six chaos scenarios (happy path, worker crash, SSH timeout, missing artifact, multi-user fairness, backpressure) double as acceptance tests. Flip one env var, watch the dashboard.

Full design and rationale: [`SPEC.md`](./SPEC.md).

## Architecture (process-level)

```mermaid
flowchart TB
    UI["Next.js API + Dashboard"]
    DB[("Postgres<br/>source of truth<br/>jobs · tasks · leases · artifacts")]
    Scheduler[["Scheduler 1×<br/>advisory lock · fairness<br/>reaper · backpressure"]]
    Queue[("Redis + BullMQ<br/>cpu · ssh · training")]
    CPU["worker:cpu N×<br/>one process per slot<br/>doWork in worker_threads"]
    IO["worker:io M×<br/>ssh + training,<br/>high in-process concurrency"]

    UI <--> DB
    Scheduler <--> DB
    Scheduler -->|enqueue {taskId, leaseToken, attempts}| Queue
    Queue --> CPU
    Queue --> IO
    CPU -->|claim · heartbeat · finalize| DB
    IO -->|claim · heartbeat · finalize| DB
```

**Key separation:** Postgres holds policy state (pending tasks, leases). Redis only delivers already-decided work. The scheduler is the single point where fairness is enforced — guaranteed by a Postgres advisory lock that exits any second scheduler at startup.

The annotated full diagram lives in [SPEC §3.1](./SPEC.md#31-components).

## Stack

Next.js 15 (App Router) · Postgres · Redis + BullMQ · pm2 supervisor · TypeScript (strict) · Tailwind · raw `pg` (no ORM — the SQL is the point of this lab).

## Quick start

Prerequisites: Node 20+, [pnpm](https://pnpm.io/) 9, Docker.

```bash
pnpm install
cp .env.example .env       # defaults match docker-compose.yml
docker compose up -d       # postgres + redis; schema auto-loaded on first run
```

Then pick a run mode below.

## Run modes

The scheduler tick and the BullMQ workers run as **separate processes** so CPU workers can scale independently from the lighter I/O workers (SPEC §13). Two equivalent ways to launch them — same `.env`, same Postgres, same Redis; only the process layout differs.

### Mode A · Manual (four terminals)

Best for iterating on code or reading one process's logs in isolation.

```bash
# Terminal 1 — Next.js dev server (API + dashboard UI)
pnpm dev

# Terminal 2 — scheduler (single instance, holds the advisory lock)
pnpm scheduler

# Terminal 3 — CPU worker
pnpm worker:cpu

# Terminal 4 — I/O worker (ssh + training)
pnpm worker:io
```

Open <http://localhost:3000>, create a user, submit a job.

> Without the scheduler, jobs are inserted into Postgres but no tasks are ever dispatched.
>
> If you intentionally crash the CPU worker (`CHAOS_CPU_CRASH_RATE>0`), use `pnpm worker:cpu:watch` instead — it loops on `process.exit(1)`.

### Mode B · Supervised (pm2)

Best for demoing the production-shaped layout — N CPU replicas + M I/O replicas + 1 scheduler, all auto-restarted on crash. Required for chaos scenarios §9.2, §9.5, and §9.6 (see below): they exercise process-level death-recovery and multi-replica fairness, which Mode A's single worker per role can't show.

```bash
pnpm supervisor:start         # foreground (Ctrl+C to stop)
# or
pnpm supervisor:start:bg      # detached, managed by pm2
pnpm supervisor:logs
pnpm supervisor:status
pnpm supervisor:stop
pnpm supervisor:delete
```

Replica counts are read from `.env` at boot:

- `worker:cpu` instances = `GLOBAL_CPU_SLOTS` (one process per slot, concurrency forced to 1 inside each).
- `worker:io` instances = `IO_WORKER_REPLICAS`.
- `scheduler` instances = 1 (the advisory lock would refuse a second).

`pnpm dev` is **not** managed by pm2 — start it separately when you need the dashboard.

Layout details: [`ecosystem.config.cjs`](./ecosystem.config.cjs).

## Demo scenarios

Each scenario flips one chaos knob and observes the dashboard. Full procedures and expectations: [SPEC §9](./SPEC.md#9-testing-strategy).

| # | Scenario | Chaos knob | Mode | What to watch |
|---|---|---|---|---|
| 9.1 | Happy path | (all = 0) | A or B | All 200 pipelines complete; one training artifact; job status = completed. |
| 9.2 | CPU worker crash | `CHAOS_CPU_CRASH_RATE=0.10` | **B** | ~10% of CPU tasks call `process.exit(1)`. Leases expire after `LEASE_TTL_MS`; reaper resets them to pending; `attempts` increments; pm2 restarts the dead replica; job still completes. |
| 9.3 | SSH timeout | `CHAOS_SSH_TIMEOUT_RATE=0.05` | A or B | `Promise.race` rejects on timeout; retry up to `MAX_ATTEMPTS`, then fail. Worker is never stuck; lease released cleanly. |
| 9.4 | Missing artifact | `CHAOS_SSH_MISSING_ARTIFACT_RATE=0.05` | A or B | `verifyArtifact` throws → retry. Barrier counts only on-disk artifacts, so training never starts prematurely. |
| 9.5 | Multi-user fairness | (none — submit jobs from 3 users within ~2s) | **B** | Fairness panel's per-user CPU counts converge to within 1. With `GLOBAL_CPU_SLOTS=4` + 3 users → 2/1/1, with the extra slot rotating as tasks finish. |
| 9.6 | Backpressure | `GLOBAL_SSH_SLOTS=5`, `SSH_BACKPRESSURE_THRESHOLD=15` | **B** | When SSH backlog (pending + queued + running) hits 15, scheduler stops dispatching new CPU tasks; SSH drains; CPU resumes. No unbounded growth. |

## Configuration

`.env.example` documents the full set. Defaults target a developer laptop (4×4 slots). The knobs reviewers usually care about:

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

Lease, timeout, and BullMQ-lock defaults satisfy `LEASE_TTL_MS ≥ LEASE_HEARTBEAT_MS × ~6` and `BULLMQ_LOCK_DURATION_MS ≥ max(*_TIMEOUT_MS) + 5000` ([SPEC §3.10](./SPEC.md#310-bullmq-lock-alignment)). Don't lower them blindly — they prevent double-delivery.

## Project layout

```
workflow-lab/
  app/                    Next.js app router — API routes + dashboard
  scheduler/              scheduler entrypoint (advisory lock + tick loop)
  worker/                 BullMQ workers, role-selected via WORKER_ROLE
    cpu.ts                spawns the cpu-thread Worker
    cpu-thread.ts         synchronous compute, isolated from the main thread
    ssh.ts · training.ts
  lib/                    shared: db, queues, scheduler, leases, barrier, config
  db/schema.sql           DDL — mounted into Postgres on first boot
  ecosystem.config.cjs    pm2 supervisor template (Mode B)
  SPEC.md                 full design — start here if evaluating the project
  docs/
    adr/0001-…            ADR: leases live on tasks, not a child table
    task-lifecycle.md     state machine + reaper interactions
    dispatch-ordering-and-queue-role.md
    timeout-and-death-detection.md
    queue-architecture-tradeoffs.md
```

## Other commands

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm test:watch
pnpm build          # next build
pnpm start          # next start (after build)
pnpm db:reset       # reapply db/schema.sql in the running postgres container
```

`pnpm db:reset` runs `psql` *inside* the Postgres container against the schema already mounted at `/docker-entrypoint-initdb.d/01-schema.sql`, so no local `psql` install is needed — but the container must be running.

## Shutting down

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # also drop the Postgres volume (wipes all data)
```
