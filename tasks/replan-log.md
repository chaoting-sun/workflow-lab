# Replan log

Chronological record of design changes that amended the plan. Newest first.
Each entry links to its ADR (for major changes) and lists the plan/todo deltas.
SPEC.md is intentionally not edited; this log + ADRs document its evolution.

---

## 2026-05-10 — Slot / replica / concurrency rescale to 4×4 (CPU + SSH)

- **Trigger:** `/change-request` analysis on 2026-05-10 recommending `Adopt now` (路 A — keep SSH inside `worker:io`, scale via replicas; no SPEC §13.2 architecture change).
- **Level:** medium (no ADR)
- **Scope adopted:** full (路 A). 路 B — splitting SSH into a dedicated `WORKER_ROLE=ssh` — was offered and not chosen; would have required ADR-0002 and a SPEC §13.2 amendment.
- **Plan changes:**
  - Amended in place: T20 (broadened from CPU-only re-tune to symmetric 4×4 across CPU + SSH + IO replicas + worker concurrencies + backpressure threshold), T21 (expected steady-state fairness numbers updated for 4-slot config)
  - Superseded: none
  - Added: none — T20 + T21 already existed as one-line entries in `todo.md`; this replan promotes them to full task bodies in `plan.md` under a new "Phase 5" section. T17–T19 (already done) intentionally not backfilled into `plan.md`; their detail lives in commit history.
  - Rolled back: none
- **Todo state shifts:** 0 completed→reverify, 0 completed→rolled back, 0 new, 2 not-yet-done amended (T20, T21)
- **SPEC sections now stale (not edited):** §3.3 (illustrative "~6/6/7 split for 3 users at 20 slots" no longer matches the env defaults; the algorithm description itself remains correct), §7 (env defaults `GLOBAL_CPU_SLOTS=20`, `GLOBAL_SSH_SLOTS=40`, `CPU_WORKER_CONCURRENCY=20`, `SSH_WORKER_CONCURRENCY=40`, `SSH_BACKPRESSURE_THRESHOLD=80`), §9.5 (fairness narrative built around 20-slot baseline). §13.2 architecture table is intentionally **not** stale because 路 A keeps the `worker:io` role intact.
- **Verification artifacts now stale (not edited):** `tasks/verification.md` §9.1 and §9.5 results recorded against 20-slot config; T21 will re-run and append a "post-rescale" subsection.
- **Next safe build step:** T20 — pure config change (`.env`, `.env.example`, possibly `ecosystem.config.cjs`); T21 depends on T20 landing first.

- **Trigger:** ADR-0001 (`docs/adr/0001-merge-leases-into-tasks.md`, Status: Accepted) — preceded by `/change-request` analysis on 2026-05-04 recommending `Adopt now`.
- **Level:** major
- **Scope adopted:** full (no split — explicit `lease_token` retained per ADR-0001 "Alternatives considered")
- **Plan changes:**
  - Amended in place: T2 (schema shape), T5 (reserve/fairness/count SQL), T6 (claim by `lease_token`, release NULLs lease cols), T7 (inherits T6 helper changes), T8 (inherits T6 helper changes), T10 (heartbeat + reap rewrite), T15 (data source for fairness panel)
  - Superseded: none
  - Added: T22 (Lease-into-tasks migration + helper rename), T23 (race test for `lease_token` fencing under reap-and-redispatch); both placed in a new "Phase 4.5: Lease consolidation" between Checkpoint D and the Risks table in `plan.md`. (Phase 5 in `todo.md` is the multi-process planning section and was unaffected.)
  - Rolled back: none
- **Todo state shifts:** 6 completed→reverify (T2, T5, T6, T7, T8, T10), 0 completed→rolled back, 2 new (T22, T23), 1 not-yet-done amended (T15)
- **SPEC sections now stale (not edited):** §3.1 (components table lists `leases` in Postgres), §3.3 (fairness algorithm SQL example), §3.4 (data model — `leases` block + `tasks` columns), §3.6 (lease lifecycle & reaper SQL), §3.7 (failure semantics example references `leases.released_at` and the EXISTS subquery)
- **Next safe build step:** T22 — schema + helper rename is the foundation; T23 depends on it; T15/T16 wait on T22 to read the new shape from day one.
