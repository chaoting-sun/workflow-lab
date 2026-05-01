# Workflow Lab — TODO

Source of truth: `tasks/plan.md` (full task descriptions, acceptance criteria, verification).
Spec: `SPEC.md`.

Tick a box only when **acceptance criteria + verification steps** for that task pass.

---

## Phase 1: Foundation

- [x] **T1** — Project scaffold (Next.js + TS strict + Tailwind + pnpm + docker-compose + zod env config) — M
- [x] **T2** — DB schema (`db/schema.sql`, all tables/indexes/unique constraints from SPEC §3.4) — S
- [x] **T3** — DB client + advisory-lock helper (`lib/db.ts`, `lib/advisory-lock.ts`) — S

### ✅ Checkpoint A — Foundation
- [ ] `pnpm dev` + `docker compose up -d` + `pnpm db:reset` work on a fresh clone
- [ ] `pnpm typecheck` green
- [ ] Human review

---

## Phase 2: Happy-path vertical slice

- [x] **T4** — Users & jobs API (POST/GET, zod validation, `pipelines_count` snapshot) — M
- [x] **T5** — Scheduler tick (CPU only) with single-instance advisory lock — M
- [x] **T6** — CPU worker with atomic-claim + optimistic-lock — M
- [x] **T7** — SSH worker + barrier check (counts `artifacts` table) — M
- [x] **T8** — Training worker + job completion — S
- [ ] **T9** — Minimal dashboard (form + job list with progress) — M

### ✅ Checkpoint B — Happy path
- [ ] SPEC §9.1 happy path: 1 user, `PIPELINES_PER_JOB=200`, all chaos = 0 → job completes
- [ ] `pnpm typecheck` green
- [ ] Human review

---

## Phase 3: Resilience layer

- [ ] **T10** — Lease heartbeat + scheduler reaper + job-failure propagation — M
- [ ] **T11** — Per-kind timeouts via `Promise.race` — S
- [ ] **T12** — Backpressure (CPU paused on SSH backlog) — XS
- [ ] **T13** — BullMQ `lockDuration` alignment + lock extension + boot-time validation — S

### ✅ Checkpoint C — Resilience
- [ ] `kill -9` worker mid-flight → job still completes
- [ ] Forced timeouts → tasks fail cleanly, no wedged worker
- [ ] Backpressure observed
- [ ] Human review

---

## Phase 4: Chaos & multi-user verification

- [ ] **T14** — Chaos knobs (`CHAOS_CPU_CRASH_RATE`, `CHAOS_SSH_TIMEOUT_RATE`, `CHAOS_SSH_MISSING_ARTIFACT_RATE`) + `pnpm worker:watch` — S
- [ ] **T15** — Fairness panel in dashboard (per-user running counts) — S
- [ ] **T16** — Run SPEC §9.2–9.6, document in `tasks/verification.md` — S

### ✅ Checkpoint D — Complete
- [ ] All 16 tasks ticked
- [ ] All 5 SPEC §9 scenarios green and documented
- [ ] `pnpm typecheck` clean
- [ ] Final review

---

## Open / blocked

(none right now — surface here as work proceeds)
