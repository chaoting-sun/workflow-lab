# Workflow Lab

A learning lab that simulates fair multi-user job scheduling on top of a bounded global resource pool. See [`SPEC.md`](./SPEC.md) for the full design.

Stack: Next.js 15 (App Router) + Postgres + Redis/BullMQ + a separate worker process.

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) 9 (the project pins `pnpm@9.15.3` via `packageManager`)
- Docker + Docker Compose (for local Postgres and Redis)

## 1. Install dependencies

```bash
pnpm install
```

## 2. Configure environment

Copy the example file and adjust values if needed. The defaults match the bundled `docker-compose.yml`, so for local development you usually don't have to edit anything.

```bash
cp .env.example .env
```

Key variables (full list in `.env.example`):

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- `ARTIFACTS_DIR` — where simulated task output files are written (defaults to `./artifacts`)
- `PIPELINES_PER_JOB` — pipelines created per submitted job (1..1000, default 200)

## 3. Start Postgres and Redis

The compose file mounts `db/schema.sql` as an init script, so the schema is loaded automatically the first time the Postgres volume is created.

```bash
docker compose up -d
```

If you ever need to reapply the schema against an existing database:

```bash
pnpm db:reset
```

This runs `psql` **inside the Postgres container**, against the schema file already mounted at `/docker-entrypoint-initdb.d/01-schema.sql`. As a result:

- No local `psql` install required.
- No environment variables required (`pnpm` doesn't auto-load `.env`, so anything that depends on `$DATABASE_URL` from `.env` would not work via `pnpm` scripts).
- The container must be running (`docker compose up -d`) before you call this.

> The script hardcodes `-U workflow -d workflow_lab` to match `POSTGRES_USER` / `POSTGRES_DB` in `docker-compose.yml`. If you change those, update `db:reset` in `package.json` too.

## 4. Run the app, scheduler, and workers

The scheduler tick and the BullMQ workers run as **separate processes** so CPU
workers can scale independently from the lighter IO workers (see SPEC §13).
You need four terminals for local development:

```bash
# Terminal 1 — Next.js dev server (API routes + dashboard UI)
pnpm dev

# Terminal 2 — scheduler tick (single instance, holds the advisory lock)
pnpm scheduler

# Terminal 3 — CPU worker (handles the cpu BullMQ queue)
pnpm worker:cpu

# Terminal 4 — IO worker (handles ssh + training BullMQ queues)
pnpm worker:io
```

Then open <http://localhost:3000> to use the dashboard and submit a job.

For chaos scenarios that crash the CPU worker (`CHAOS_CPU_CRASH_RATE>0`),
use `pnpm worker:cpu:watch` instead — it auto-restarts on `process.exit(1)`.
Without the scheduler running, jobs will be created in Postgres but no tasks
will ever be dispatched.

## Other commands

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run (one-shot)
pnpm test:watch    # vitest in watch mode
pnpm build         # next build
pnpm start         # next start (after build)
```

## Shutting down

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # also drop the Postgres volume (wipes all data)
```
