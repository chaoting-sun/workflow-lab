# ADR-0002: End-to-end testing posture

Date: 2026-05-11
Status: Accepted

## Context

`tasks/plan.md` Phase 6 (test coverage uplift) splits coverage by layer:

- **Unit** — pure modules under `lib/`. Vitest, no Postgres/Redis. T24–T29.
- **Integration** — multi-module flows against real Postgres and (for T30+)
  real Redis-backed BullMQ. Vitest. `tests/integration/*.test.ts` (T30, T31)
  and `tests/api/**/*.test.ts` (route handlers invoked directly via
  `import { POST, GET }`).
- **E2E** — the whole stack: HTTP entry → Next.js route handler → Postgres →
  BullMQ → out-of-process scheduler + workers → Postgres → HTTP poll →
  terminal job state.

The integration layer covers a lot of ground. `tests/api/**/*` already
proves each route handler reads/writes the DB correctly when called as a
function. `tests/integration/cpu-dispatch-pipeline.test.ts` (T30) proves
the dispatch ↔ claim ↔ release wire works against a real BullMQ on a
dedicated Redis db index. `tests/integration/chaos-pipeline.test.ts` (T31)
proves chaos knobs propagate failures through to `jobs` rows.

What none of those cover:

- The **whole flow as observed from outside the process**. A change to
  `worker/index.ts`'s `WORKER_ROLE` switch, to `ecosystem.config.cjs`, to
  the `worker:*:watch` restart loop, or to the scheduler advisory-lock
  startup sequence can break the system end-to-end without breaking any
  Vitest test. The unit test for `worker/index.ts` (T28) verifies the
  signal handler, not that the process actually drains a job under pm2 +
  Docker Compose.
- The **HTTP path** as exercised by an external client (curl, fetch from
  the browser). `tests/api/**/*` invokes route handlers as functions; it
  doesn't run them inside a Next.js server.

So the gap is real, but narrow. The plan flags three candidates:

- **(a) Supertest + spawned worker/scheduler.** Boot Next.js (or its
  request handler) inside Vitest, run scheduler + workers as child
  processes, drive the test via HTTP. Familiar shape, but introduces a
  second harness layer alongside the bash scripts that already do most of
  the same thing.
- **(b) Playwright.** Browser-level. Verifies what a user sees in
  `app/page.tsx` (form submit, job-list progress bar fill, fairness
  panel). Brings a heavy dependency and a new runtime for a UI that is
  three components polling REST endpoints.
- **(c) Extend existing scripts.** `scripts/run-scenario.sh` and the two
  scenario-specific siblings already (1) spawn scheduler + `WORKER_ROLE=cpu`
  + `WORKER_ROLE=io` with restart loops, (2) drive a job, (3) poll DB state
  to terminal, (4) emit a structured report under `tasks/scenario-logs/`.
  They were already used to verify SPEC §9.1 against the running web app
  (see `tasks/verification.md` §9.1 — "submitted via `POST /api/jobs`
  against the running web app"). What they lack is (i) HTTP as the
  job-creation entry point (today they use `psql` to INSERT directly), and
  (ii) exit-non-zero-on-assertion-failure so they're CI-runnable.

The shell scripts also already encode the parts of E2E that are most
likely to regress in this codebase: scheduler/worker process spawning,
supervisor restart-on-exit, and lease/heartbeat behavior across process
death. Reimplementing that orchestration inside Vitest would duplicate
work without adding coverage.

## Decision

**Adopt option (c).** Promote the existing bash scenario scripts to
assertion-bearing E2E tests by:

1. Driving job creation through `POST /api/jobs` (via `curl` against the
   running Next.js dev server) instead of direct `psql` INSERT, so the
   route handler, zod validation, and `jobs.pipelines_count` snapshot
   are all exercised on the entry path.
2. Adding final-state assertions on the polled `GET /api/jobs/:id` JSON
   response — at minimum: `status === 'completed'`, progress counters
   match `pipelines_count`, no leftover active leases.
3. Exiting non-zero on any assertion failure so the script is suitable
   for a `pnpm test:e2e` runner and (later) CI invocation.

Reject (a) and (b) for now:

- **(a)** would duplicate the scheduler/worker spawn-and-supervise logic
  that already exists in `scripts/run-scenario.sh`. The marginal benefit
  over (c) is a familiar TypeScript test shape; the cost is a parallel
  E2E harness whose drift from the bash scripts will erode trust in
  both.
- **(b)** is rejected as overkill for this lab. The dashboard is three
  Tailwind components polling REST endpoints (`SubmitForm`, `JobList`,
  `FairnessPanel`). The DOM is a thin projection of `GET /api/jobs` and
  `GET /api/users`; the API contract is what actually matters. If
  frontend regressions become a concern in practice, ADR-0003 can
  reopen the question for Playwright at that point — but T34 is the
  proper forum for that decision, not this one.

## Consequences

- **Positive:**
  - One E2E harness, not two. The bash scripts that already pass
    `tasks/verification.md` §9.2–§9.6 become CI-runnable with minor
    assertion additions.
  - The HTTP layer (route handlers behind a real Next.js server) gets
    actual coverage for the first time — currently only invoked as
    functions in `tests/api/**/*`.
  - No new dependencies. `curl`, `jq`, and `psql` are already on the
    expected dev path (Docker Compose, scenario logs).
  - Aligns with how SPEC §9.1 was already verified ("submitted via
    `POST /api/jobs` against the running web app") — closes a small
    drift between Phase 4 manual verification and Phase 6 automated
    coverage.

- **Negative:**
  - Bash is a worse language than TypeScript for non-trivial
    assertion logic. The discipline this decision relies on is keeping
    the assertions narrow: terminal `status`, counter equality, leftover
    leases. If T33 (or future T-N) grows the assertion surface enough
    that bash + `jq` becomes painful, that's the trigger to revisit
    option (a).
  - The scripts depend on a running Next.js dev server. T33 must pick
    one of: (i) the harness boots `pnpm dev` itself and waits for
    `:3000` to become ready, or (ii) the runner documents "start
    `pnpm dev` first" as a precondition. Choice deferred to T33; (i)
    is the obvious CI-friendly form.
  - No browser-level regression coverage. Accepted — see rejection of
    (b) above and the explicit T34 carve-out.

- **Neutral:**
  - The existing bash scripts continue to serve their dual purpose:
    SPEC §9 acceptance verification *and* automated E2E coverage. No
    new file lives in two places.
  - `tasks/scenario-logs/` already exists as the canonical place for
    E2E artifacts; T33 plugs into it directly.

## Alternatives considered

- **Supertest + spawned worker/scheduler (option a).** Discussed above
  under Decision. The deciding factor: this codebase's E2E risk surface
  is the scheduler/worker *process* layout, not the HTTP request shape.
  The bash scripts already address the former; supertest would re-solve
  it.

- **Playwright (option b).** Discussed above under Decision. The
  deciding factor: the UI is a thin REST projection, and frontend
  testing posture has a dedicated decision point at T34.

- **Hybrid — keep bash scripts as system tests AND add one supertest
  HTTP smoke test.** Briefly considered. Rejected for now because the
  bash scripts driven through `curl` (rather than `psql`) already
  exercise the HTTP path, so a supertest smoke test would be net
  redundant. Worth reconsidering only if (a) the supertest variant
  can prove something the bash variant can't, or (b) a future
  contributor finds bash assertions too brittle to maintain.

## Notes for replan

- **T33 scope** (the implementation half): one happy-path E2E that
  - spawns Postgres + Redis (assume Docker Compose already up — the lab
    convention) and Next.js dev server,
  - spawns scheduler + `WORKER_ROLE=cpu` + `WORKER_ROLE=io` (reuse the
    spawn block from `scripts/run-scenario.sh`),
  - creates a user via `POST /api/users`,
  - creates a job via `POST /api/jobs` with a small `pipelinesCount`
    (suggest 4–8 — fast feedback; the long-running variants live under
    the SPEC §9 scenario scripts),
  - polls `GET /api/jobs/:id` until terminal,
  - asserts `status === 'completed'`, CPU/SSH/training counters match,
    `leftover_leases === 0`,
  - exits non-zero on assertion failure or timeout,
  - emits a log to `tasks/scenario-logs/e2e-happy-path.*.log`.
- **T34 (frontend test posture)** is untouched by this ADR. The decision
  to skip Playwright here applies only to E2E posture; T34 may still
  conclude that `@testing-library/react` + jsdom is worth adding for
  component-level tests of `SubmitForm` / `JobList` / `FairnessPanel`.
- **Checkpoint F**: "E2E posture decided and either implemented or
  explicitly deferred with rationale" — this ADR satisfies the
  "decided" half; T33 satisfies the "implemented" half.
