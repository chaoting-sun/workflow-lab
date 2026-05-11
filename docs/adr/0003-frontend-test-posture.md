# ADR-0003: Frontend component-test posture

Date: 2026-05-11
Status: Accepted

## Context

The dashboard under `app/` has zero automated test coverage:

- `app/page.tsx` — top-level layout; fetches `/api/users` once and renders
  four child components.
- `app/components/UserPicker.tsx` — `CreateUserForm`. Controlled input;
  `POST /api/users`; bubbles a `User` up via `onCreated`.
- `app/components/SubmitForm.tsx` — `SubmitJobForm`. Reads `userId` from a
  `<select>`; `POST /api/jobs`; renders inline error.
- `app/components/JobList.tsx` — polls `GET /api/jobs` every 3s; renders a
  list of jobs with three progress bars (CPU / SSH / training); contains
  a `sameJobs` short-circuit to skip `setState` when the payload is
  unchanged.
- `app/components/FairnessPanel.tsx` — one-shot `GET /api/config`, plus
  3s polling of `GET /api/users`; renders aggregate slot usage and a
  per-user table; contains a `sameUsers` short-circuit symmetric to
  `sameJobs`.

No testing library is installed. `package.json` carries vitest only; there
is no `jsdom`, no `@testing-library/react`, no `@testing-library/dom`,
and no `@testing-library/jest-dom`. The vitest config does not register a
DOM environment.

ADR-0002 (E2E posture) explicitly carved this question out: the E2E
scripts drive HTTP via `curl` and assert on JSON; they do not exercise
React rendering. So any frontend regression has to be caught either by
type-checking, by manual smoke, or by some new test layer added here.

The plan (T34, `tasks/todo.md`) lists two options:

- **(a)** add `@testing-library/react` + `jsdom` to vitest and start with
  unit-style component tests for `SubmitForm` / `JobList`.
- **(b)** explicitly defer and rely on E2E + type-checking.

### What the components actually do

The reading is that the components are thin. There are exactly three
shapes of logic on the frontend:

1. **Form-submit-then-`apiFetch`** (`UserPicker`, `SubmitForm`). The
   non-trivial behavior is `disabled`-during-submit and error rendering.
   `lib/api-client.ts` is independently unit-tested (`lib/api-client.test.ts`)
   for HTTP error → message extraction; the components are wiring around
   it.
2. **Poll-and-render** (`JobList`, `FairnessPanel`). The non-trivial
   behavior is (i) the 3s polling loop with `AbortController` cleanup
   on unmount and (ii) the `sameJobs` / `sameUsers` equality
   short-circuit that prevents the list from reconciling every tick when
   nothing changed.
3. **Status / progress rendering** (`StatusBadge`, `ProgressBar` inside
   `JobList`; `GlobalStat` inside `FairnessPanel`). Pure projection from
   props to JSX with one arithmetic step (`Math.round((done / total) *
   100)` in `ProgressBar`, guarded against `total === 0`).

Shape 3 is pure and could be unit-tested without a DOM if the helpers
were exported from `lib/`. They are currently private to the component
file. Shape 1 is shallow enough that the regression risk concentrates in
either (a) `apiFetch` itself (already tested) or (b) form-field wiring
that type-checking catches. Shape 2 is where automated coverage would
add the most signal — specifically, the equality short-circuits and the
cleanup-on-unmount paths. These are non-obvious and silent-failure-prone
(a busted `sameJobs` causes a re-render every 3s but the app still
"works"; a missing `ctrl.abort()` leaks fetches after unmount but the
page rarely unmounts in normal use).

### Cost of option (a)

Adding the component-test stack means:

- `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` as
  devDeps (three more packages, plus their transitive trees).
- A vitest config split: the `lib/*`, `tests/api/*`, `tests/integration/*`
  suites need `environment: "node"`; only the component suites want
  `jsdom`. Either a per-file `// @vitest-environment jsdom` directive or
  a project-config workspace. Both work; both add config surface.
- A `vi.mock("@/lib/api-client", ...)` (or `fetch`-level mock) helper for
  every component test to avoid hitting the real network — components
  call `apiFetch` directly, so the mocking boundary lives at the
  module-import level.
- Familiar mileage with React-Testing-Library: `render`, `screen`,
  `userEvent`, `waitFor` patterns; the existing test suite (vitest with
  Node-only modules) gives no template for this.

For a single-developer learning lab where the dashboard is intentionally
thin (SPEC §1; CLAUDE.md "values correctness, maintainability, and small
reviewable changes over clever or overly compact code"), the cost-vs-
risk balance is unfavorable today. The non-trivial frontend bits are
narrow and the components compose mostly-pure helpers.

### Cost of pure deferral

The risk that deferral accepts:

- A regression in `sameJobs` / `sameUsers` (e.g. a new field added to
  `JobView` but not added to the equality check) silently re-renders
  every 3s. No automated test catches it. Verification is "the page
  looks janky during manual smoke."
- A regression in `ProgressBar` math (e.g. `total === 0` guard removed)
  produces `NaN%` width. Type-checking catches `undefined` but not
  arithmetic edge cases.
- A regression in the abort-on-unmount cleanup leaks fetches. Not user-
  visible; observable only in DevTools.
- Form-submit happy/error paths: a regression that, say, leaves
  `submitting` permanently `true` after an error would be missed. The
  finally-block currently guards this, but a refactor could break it.

All four of these are real, but none of them silently produce wrong
backend state. The data plane (BullMQ, scheduler, workers, Postgres)
has integration coverage; the worst frontend regression is a janky-but-
correct dashboard.

## Decision

**Defer (option b).** Do not add `@testing-library/react` + `jsdom` at
this time. Rely on:

1. **Type-checking** (`pnpm typecheck`) for prop wiring, field-shape
   drift between `lib/types.ts` and component usage, and React-specific
   misuse the TS plugin catches.
2. **The existing E2E happy path** (T33, `scripts/run-e2e-happy-path.sh`)
   for proof that `POST /api/users` → `POST /api/jobs` → poll-to-
   completion works end-to-end through the same HTTP surface the dashboard
   uses. The browser DOM is not rendered, but the API contract the DOM
   depends on is exercised.
3. **Manual smoke** before merge for changes that touch
   `app/components/*` or `app/page.tsx`. This is already implicit in
   CLAUDE.md's "After Implementing" workflow and the post-task `/simplify`
   → `/code-review` flow.

### Re-open triggers

This decision is cheap to revisit. Add `@testing-library/react` + jsdom
when any of the following becomes true:

- A second or third UI bug ships that a component test would plausibly
  have caught (specifically: a `sameJobs`/`sameUsers` drift, a progress-
  bar math regression, or a form-submit state stuck after an error).
  Two manual-smoke catches is a noise event; three is a signal.
- `app/components/*` grows beyond the current four files, or any single
  component grows beyond the current ~180 lines (JobList).
- The dashboard gains conditional logic that is hard to reason about
  statically — e.g. role-gated views, optimistic-update flows, or local
  state that diverges from server state in interesting ways.
- A contributor other than the original author starts modifying the
  frontend regularly. Component tests pay off most when the safety net
  benefits a reader who didn't write the code.

### Cheap intermediate step (not committed by this ADR)

If a `sameJobs` / `sameUsers` / `ProgressBar` regression bites before any
re-open trigger fires, the lighter-weight remediation — taken in
preference to installing jsdom — is to extract the pure helpers into
`lib/` (e.g. `lib/job-view-equality.ts`) and unit-test them under the
existing Node-only vitest config. This costs three new files and zero
new dependencies, and addresses the highest-signal sliver of the gap
without committing to a full component-test harness.

This intermediate step is recorded here for visibility only; it is not
scheduled as a task. If it becomes useful, it gets its own todo entry
and is implemented at that time.

## Consequences

- **Positive:**
  - No new devDeps; no vitest config split; the existing `pnpm test`
    profile stays one-shape (Node-only).
  - Aligns with ADR-0002's posture: the integration / E2E layers carry
    the contract surface, and the UI is a thin projection of it. Adding
    component tests now would duplicate the API-contract guarantees the
    integration tests already provide.
  - Keeps the `pnpm test` runtime small. The current suite runs in
    seconds; jsdom + DOM testing adds non-trivial fixed cost per file
    that switches environments.

- **Negative:**
  - No automated coverage of `sameJobs` / `sameUsers` equality short-
    circuits, polling cleanup on unmount, or `ProgressBar` math.
    Acknowledged in the "Cost of pure deferral" section above; the
    re-open triggers are the safety valve.
  - Checkpoint F asks "Frontend test posture decided **and either
    implemented or explicitly deferred with rationale**." This ADR
    satisfies "decided + explicitly deferred with rationale." It does
    not satisfy "implemented." That is the intentional outcome.

- **Neutral:**
  - The dashboard remains testable manually via `pnpm dev` + browser;
    nothing about this decision reduces that path.
  - If future work needs `jsdom` for one specific helper (e.g. a hook
    extracted from `JobList`), it can be added as a single
    `// @vitest-environment jsdom` file without committing to the full
    component-testing pattern across the codebase.

## Alternatives considered

- **(a) Install `@testing-library/react` + `jsdom` now and write
  component tests for `SubmitForm` and `JobList`.** Discussed under
  Context. Rejected on cost-vs-risk grounds for the current dashboard
  shape, not on principle. The re-open triggers describe when (a)
  becomes the right call.

- **Playwright for component-level coverage.** Rejected for the same
  reasons ADR-0002 rejected Playwright for E2E: a heavy dependency for a
  dashboard that is three polling components. If browser-level
  regression coverage becomes necessary, the right framing is "one
  Playwright happy path covering the UI rendering of the existing E2E
  scenario," not "Playwright as a component-test runner."

- **Extract pure helpers and unit-test them under existing Node vitest.**
  Discussed under "Cheap intermediate step." Not adopted by this ADR
  because no regression has bitten yet; documented as the preferred
  first step if one does.

## Notes for replan

- **Checkpoint F** (Phase 6, `tasks/todo.md`) — the line "Frontend test
  posture decided and either implemented or explicitly deferred with
  rationale" is satisfied by this ADR (the "explicitly deferred"
  branch).
- **T34** is the decision task; it has no implementation half. There is
  no follow-up T-N scheduled by this ADR. The re-open triggers above
  are explicit pre-conditions for any future task in this area.
