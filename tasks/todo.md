# Workflow Lab — TODO

Source of truth: `tasks/plan.md` (full task descriptions, acceptance criteria, verification).
Spec: `SPEC.md`.

Tick a box only when **acceptance criteria + verification steps** for that task pass.

(no active change in flight — last completed: 4×4 rescale on 2026-05-10, see `tasks/replan-log.md`)

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

- [x] All 16 tasks ticked
- [x] All 5 SPEC §9 scenarios green and documented
- [x] `pnpm typecheck` clean
- [x] Final review

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
- [x] **T19** — Process supervisor (pm2 / Docker Compose / systemd template) running 1× scheduler, ~18× `worker:cpu` (`concurrency=1`), 1–2× `worker:io` (high `concurrency`). — S
- [x] **T20** — Re-tune `GLOBAL_CPU_SLOTS` to match deployed `worker:cpu` replicas; re-evaluate `SSH_BACKPRESSURE_THRESHOLD` against new CPU throughput. — XS — amended (2026-05-10): broadened to also re-tune `GLOBAL_SSH_SLOTS`, `CPU_WORKER_CONCURRENCY`, `SSH_WORKER_CONCURRENCY`, `IO_WORKER_REPLICAS` to a 4×4 layout
- [x] **T21** — Re-run SPEC §9.5 (fairness) and §9.6 (backpressure) under the multi-process layout; document results in `tasks/verification.md`. — S — amended (2026-05-10): scenario scripts repaired for post-T18 split (spawn scheduler + WORKER_ROLE=cpu + WORKER_ROLE=io); re-run confirms algorithm holds; "1/1/2" in earlier amendment was wrong since script env-overrides dominate

### ✅ Checkpoint E — Multi-core scaling

- [x] CPU-bound `defaultCpuWork` no longer triggers spurious lease reaps under load
- [x] `htop` shows N CPU worker processes spread across cores during a job run
- [x] SPEC §9.5 fairness still holds with N CPU worker replicas (verified 2026-05-10, see `tasks/verification.md` §9.5 post-rescale subsection)
- [x] SPEC §9.6 backpressure still gates CPU dispatch correctly (verified 2026-05-10, see `tasks/verification.md` §9.6 post-rescale subsection)
- [x] Human review

---

## Phase 6: Test coverage uplift (planned)

Audit performed 2026-05-11. Source files without a `.test.ts` sibling and missing test layers identified below. Vitest is the only test runner installed; no Playwright/Cypress/component-testing library. `tests/api/*` are route-level integration tests against a real DB; `lib/lease-fencing.test.ts` is the only cross-module integration test, and it uses an in-memory `CapturingQueue` (no real BullMQ wire).

### Unit-layer gaps

- [x] **T24** — `lib/api-errors.test.ts`: cover every error-class → HTTP-status mapping, including the catch-all branch. Pure, no DB. — XS
- [x] **T25** — `lib/queues.test.ts`: assert BullMQ queue names, prefixes, and connection options match `lib/config.ts`. Guard against silent drift when config keys change. — S
- [x] **T26** — `lib/artifacts.test.ts`: filesystem write/read round-trip in a tmp dir; assert path conventions match what the SSH worker writes. — XS
- [x] **T27** — Audit `tests/api/jobs/[id]/route.test.ts` for coverage of cancel/DELETE and not-found paths; fill any gaps. Route is GET-only (no DELETE exists); added tests for progress accuracy under succeeded/failed task states and for job-status field after transition. — XS
- [x] **T28** — Entry-point test for `worker/index.ts`: `WORKER_ROLE=cpu|io` selects the right loop, SIGTERM exits cleanly with code 0 (so `worker:*:watch` does not restart on intended shutdown). — S
- [x] **T29** — Entry-point test for `scheduler/index.ts`: advisory-lock acquisition gates `runSchedulerLoop`; second instance backs off. Happy-path SIGTERM test runtime-skips when an external supervisor already holds the lock (e.g. pm2). — S

### Integration-layer gaps

- [x] **T30** — Real-Redis dispatch pipeline test: enqueue via `scheduler.dispatchCpu` against a real BullMQ instance (test Redis db index), drain via `worker.claimTask`, assert lease acquisition + task completion. Highest-value missing test; the in-memory queue in `lease-fencing.test.ts` does not prove the wire works. — M — `tests/integration/cpu-dispatch-pipeline.test.ts`; isolates Redis on `TEST_REDIS_DB` (default 15, refuses db 0); skips at runtime if Redis is unreachable
- [x] **T31** — Chaos injection end-to-end: with `CHAOS_CPU_CRASH_RATE`/`CHAOS_SSH_TIMEOUT_RATE`/`CHAOS_SSH_MISSING_ARTIFACT_RATE` > 0, assert the corresponding failure modes surface in `jobs` rows (not just that the unit-level chaos helpers fire). — S — `tests/integration/chaos-pipeline.test.ts`; mocks `getConfig` to re-parse `process.env` per call so each test can flip exactly one rate; uses real `runSshTask`/`defaultSshWork` and real `runCpuWork` (spying `process.exit`) plus the lease reaper

### E2E gaps (none today)

- [x] **T32** — Decide and document E2E posture in an ADR. Options: (a) lightweight HTTP E2E via `supertest` + a spawned worker/scheduler; (b) browser E2E via Playwright; (c) keep `scripts/run-scenario-*.sh` and add assertions (parse `/api/jobs` JSON, exit non-zero on mismatch). — XS — decision: option (c), see `docs/adr/0002-e2e-posture.md`
- [x] **T33** — Implement one happy-path E2E per the T32 decision: submit job → observe completion via the chosen surface. — M (size depends on T32) — `scripts/run-e2e-happy-path.sh` + `pnpm e2e`; drives `POST /api/users` → `POST /api/jobs` → poll `GET /api/jobs/:id`; asserts `status=completed`, all counters match, `leftover_leases=0`; smoke-run 2026-05-11 passed in 18s with `E2E_PORT=3100 E2E_PIPELINES=4`

### Frontend (untested entirely)

- [x] **T34** — Decide and document frontend component-test posture. `app/components/*` and `app/page.tsx` have zero coverage and no testing library is installed. Either add `@testing-library/react` + vitest jsdom and start with `SubmitForm`/`JobList`, or explicitly defer and rely on E2E. Record decision. — XS — decision: defer (option b), see `docs/adr/0003-frontend-test-posture.md`; re-open triggers documented there

### ✅ Checkpoint F — Test coverage

- [ ] All untested `lib/` source files have a sibling `.test.ts` (or an explicit deferral note)
- [ ] At least one integration test exercises the real BullMQ wire
- [ ] E2E posture decided and either implemented or explicitly deferred with rationale
- [x] Frontend test posture decided and either implemented or explicitly deferred with rationale — ADR-0003 (deferred)
- [ ] `pnpm test` green
- [ ] `pnpm typecheck` green
- [ ] Human review
