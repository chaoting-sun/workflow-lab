# Quickstart

Get the happy path running in ~5 minutes.

## Prerequisites

- Node 20+
- [pnpm](https://pnpm.io/) 9
- Docker (for Postgres + Redis)

## Five commands

```bash
pnpm install
cp .env.example .env             # defaults match docker-compose.yml
docker compose up -d             # postgres + redis; schema auto-loaded on first run
pnpm dev                         # Terminal 1 — Next.js UI + API
```

In a second terminal, start the rest of the system using either run mode:

```bash
pnpm supervisor:start            # Mode B (pm2) — recommended
```

Open <http://localhost:3000>, create a user, submit a job. You should see 200 tasks fan out through CPU → SSH and then a single training task complete.

> **Without the scheduler, jobs are inserted into Postgres but no tasks are ever dispatched.** If `pnpm dev` is the only thing running, the dashboard will sit at `pending` forever.

## Two run modes

Mode B (pm2) is one command and gives the production-shaped layout. Mode A (four terminals) is better for reading one process's logs in isolation.

See [`run-modes.md`](./run-modes.md) for the details and when to use each.

## Shutting down

```bash
docker compose down              # stop containers, keep data
docker compose down -v           # also drop the Postgres volume (wipes all data)
pnpm supervisor:stop             # if Mode B was used
```
