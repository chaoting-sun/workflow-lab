# Run modes

The scheduler tick and the BullMQ workers run as **separate processes** so CPU workers can scale independently from the lighter I/O workers. Two equivalent ways to launch them — same `.env`, same Postgres, same Redis; only the process layout differs.

| | Mode A (manual) | Mode B (pm2) |
|---|---|---|
| Processes per role | 1 each | `GLOBAL_CPU_SLOTS` CPU + `IO_WORKER_REPLICAS` IO + 1 scheduler |
| Auto-restart on crash | no | yes |
| Required for chaos scenarios 9.2 / 9.5 / 9.6 | no | **yes** |
| Good for | reading one process's logs | demoing production-shaped layout |

## Mode A · Manual (four terminals)

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

> If you intentionally crash the CPU worker (`CHAOS_CPU_CRASH_RATE>0`), use `pnpm worker:cpu:watch` instead — it loops on `process.exit(1)`.

## Mode B · Supervised (pm2)

```bash
pnpm supervisor:start            # foreground (Ctrl+C to stop)
# or
pnpm supervisor:start:bg         # detached, managed by pm2
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

Layout details: [`ecosystem.config.cjs`](../../ecosystem.config.cjs).

## Other commands

```bash
pnpm typecheck                   # tsc --noEmit
pnpm test                        # vitest run
pnpm test:watch
pnpm build                       # next build
pnpm start                       # next start (after build)
pnpm db:reset                    # reapply db/schema.sql in the running postgres container
```

`pnpm db:reset` runs `psql` *inside* the Postgres container against the schema already mounted at `/docker-entrypoint-initdb.d/01-schema.sql`, so no local `psql` install is needed — but the container must be running.
