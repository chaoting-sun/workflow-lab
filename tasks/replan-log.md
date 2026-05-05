# Replan log

Chronological record of design changes that amended the plan. Newest first.
Each entry links to its ADR (for major changes) and lists the plan/todo deltas.
SPEC.md is intentionally not edited; this log + ADRs document its evolution.

---

## 2026-05-04 — Drop `leases` table; lease state moves onto `tasks`

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
