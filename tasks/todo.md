# Workflow Lab — TODO

Source of truth: `tasks/plan.md` (full task descriptions, acceptance criteria, verification).
Spec: `SPEC.md`.

Tick a box only when **acceptance criteria + verification steps** for that task pass.

> **Active change:** ADR-0001 — drop `leases` table; lease state moves onto `tasks`. See `tasks/replan-log.md`.

---

## Phase 1: Foundation

- [x] **T1** — Project scaffold (Next.js + TS strict + Tailwind + pnpm + docker-compose + zod env config) — M
- [x] **T2** — DB schema (`db/schema.sql`, all tables/indexes/unique constraints from SPEC §3.4) — S — needs reverification (ADR-0001)
- [x] **T3** — DB client + advisory-lock helper (`lib/db.ts`, `lib/advisory-lock.ts`) — S

### ✅ Checkpoint A — Foundation

- [x] `pnpm dev` + `docker compose up -d` + `pnpm db:reset` work on a fresh clone
- [x] `pnpm typecheck` green
- [x] Human review

---

## Phase 2: Happy-path vertical slice

- [x] **T4** — Users & jobs API (POST/GET, zod validation, `pipelines_count` snapshot) — M
- [x] **T5** — Scheduler tick (CPU only) with single-instance advisory lock — M — needs reverification (ADR-0001)
- [x] **T6** — CPU worker with atomic-claim + optimistic-lock — M — needs reverification (ADR-0001)
- [x] **T7** — SSH worker + barrier check (counts `artifacts` table) — M — needs reverification (ADR-0001)
- [x] **T8** — Training worker + job completion — S — needs reverification (ADR-0001)
- [x] **T9** — Minimal dashboard (form + job list with progress) — M

### ✅ Checkpoint B — Happy path

- [x] SPEC §9.1 happy path: 1 user, `PIPELINES_PER_JOB=200`, all chaos = 0 → job completes
- [x] `pnpm typecheck` green
- [x] Human review

---

## Phase 3: Resilience layer

- [x] **T10** — Lease heartbeat + scheduler reaper + job-failure propagation — M — needs reverification (ADR-0001)
- [x] **T11** — Per-kind timeouts via `Promise.race` — S
- [x] **T12** — Backpressure (CPU paused on SSH backlog) — XS
- [x] **T13** — BullMQ `lockDuration` alignment + lock extension + boot-time validation — S
- [x] **T13b** — Per-kind BullMQ worker concurrency (config-driven `CPU_WORKER_CONCURRENCY` / `SSH_WORKER_CONCURRENCY` / `TRAINING_WORKER_CONCURRENCY`) — XS

### ✅ Checkpoint C — Resilience

- [x] `kill -9` worker mid-flight → job still completes
- [x] Forced timeouts → tasks fail cleanly, no wedged worker
- [x] Backpressure observed
- [x] Human review

---

## Phase 4: Chaos & multi-user verification

- [x] **T14** — Chaos knobs (`CHAOS_CPU_CRASH_RATE`, `CHAOS_SSH_TIMEOUT_RATE`, `CHAOS_SSH_MISSING_ARTIFACT_RATE`) + `pnpm worker:watch` — S
- [x] **T15** — Fairness panel in dashboard (per-user running counts) — S — amended by ADR-0001 (build after T22)
- [x] **T16** — Run SPEC §9.2–9.6, document in `tasks/verification.md` — S

### ✅ Checkpoint D — Complete

- [ ] All 16 tasks ticked
- [ ] All 5 SPEC §9 scenarios green and documented
- [ ] `pnpm typecheck` clean
- [ ] Final review

---

## Phase 4.5: Lease consolidation (ADR-0001)

- [x] **T22** — Lease-into-tasks migration + helper rename (drop `leases`, add `tasks.lease_*`, rename `leaseId`→`leaseToken`, update all tests) — L
- [x] **T23** — Race test: `lease_token` fencing under reap-and-redispatch — S

### ✅ Checkpoint D.1 — Lease consolidation verified

- [x] T22 + T23 complete
- [x] All previously-passing tests green under the new schema
- [x] Checkpoint B happy path re-verified
- [x] Checkpoint C `kill -9` resilience re-verified
- [x] Human review before resuming T15 / T16

---

## Open / blocked

(none right now — surface here as work proceeds)

---

## Phase 5: Multi-process / multi-core scaling (planned, deferred)

Spec reference: SPEC §13. Motivation: once `defaultCpuWork` becomes real CPU-bound compute, a single Node process saturates one core AND blocks the lease heartbeat / BullMQ lock renewal, causing duplicate execution. Short term we keep the existing single-process `worker/index.ts`; this phase records the planned shape.

- [x] **T17** — Move `defaultCpuWork` into `worker_threads` (`worker/cpu-thread.ts`); main thread keeps heartbeat + BullMQ lock renewal + `withTimeout` alive; `terminate()` the thread on timeout. Prerequisite for T18 to be useful, but valuable on its own. — M
- [x] **T18** — Extract `scheduler/index.ts` (advisory lock + `runSchedulerLoop` only); strip lock + scheduler loop out of `worker/index.ts`; add `WORKER_ROLE=cpu|io` switch; add `pnpm scheduler` / `pnpm worker:cpu` / `pnpm worker:io` scripts. — M
- [ ] **T19** — Process supervisor (pm2 / Docker Compose / systemd template) running 1× scheduler, ~18× `worker:cpu` (`concurrency=1`), 1–2× `worker:io` (high `concurrency`). — S
- [ ] **T20** — Re-tune `GLOBAL_CPU_SLOTS` to match deployed `worker:cpu` replicas; re-evaluate `SSH_BACKPRESSURE_THRESHOLD` against new CPU throughput. — XS
- [ ] **T21** — Re-run SPEC §9.5 (fairness) and §9.6 (backpressure) under the multi-process layout; document results in `tasks/verification.md`. — S

### ✅ Checkpoint E — Multi-core scaling

- [ ] CPU-bound `defaultCpuWork` no longer triggers spurious lease reaps under load
- [ ] `htop` shows N CPU worker processes spread across cores during a job run
- [ ] SPEC §9.5 fairness still holds with N CPU worker replicas
- [ ] SPEC §9.6 backpressure still gates CPU dispatch correctly
- [ ] Human review
