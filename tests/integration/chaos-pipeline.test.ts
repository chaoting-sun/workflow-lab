import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock lib/config so getConfig() re-parses process.env on every call.
// Production caches the config to keep the hot path branch-free, but the
// integration tests need to flip CHAOS_*_RATE per scenario without forking
// a child process. Other config fields fall through to the live env.
vi.mock("../../lib/config", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/config")>();
  return {
    ...orig,
    getConfig: (): import("../../lib/config").Config =>
      orig.parseConfig(process.env),
  };
});

const { db, closeDb } = await import("../../lib/db");
const { reapExpiredLeases } = await import("../../lib/scheduler");
const {
  ensureSchema,
  makeQueuedSshTaskWithLease,
} = await import("../../lib/test-helpers");
const { createUser } = await import("../../lib/users");
const { createJob } = await import("../../lib/jobs");
const { runSshTask, defaultSshWork } = await import("../../worker/ssh");
const { runCpuWork } = await import("../../worker/cpu-thread");

// T31 — Chaos injection end-to-end.
//
// Pairs with lib/chaos.test.ts (which only proves the dice-rolling helpers
// fire). This file sets each CHAOS_*_RATE > 0 via process.env and asserts
// the resulting failure mode surfaces in `tasks.failure_reason` and
// `jobs.status` through the real production code path — defaultSshWork,
// runSshTask, runCpuWork — not synthetic test doubles.

const PREFIX = `t31-chaos-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_KEYS = [
  "CHAOS_CPU_CRASH_RATE",
  "CHAOS_SSH_TIMEOUT_RATE",
  "CHAOS_SSH_MISSING_ARTIFACT_RATE",
  "SSH_SLEEP_MS",
  "SSH_TIMEOUT_MS",
  "CPU_SLEEP_MIN_MS",
  "CPU_SLEEP_MAX_MS",
] as const;

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  for (const k of TRACKED_KEYS) SAVED_ENV[k] = process.env[k];
  await reset();
});

beforeEach(async () => {
  for (const k of TRACKED_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  // Force-off every chaos rate by default — each test opts in to exactly one.
  process.env.CHAOS_CPU_CRASH_RATE = "0";
  process.env.CHAOS_SSH_TIMEOUT_RATE = "0";
  process.env.CHAOS_SSH_MISSING_ARTIFACT_RATE = "0";
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const k of TRACKED_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  await reset();
  await closeDb();
});

describe("T31 — chaos injection surfaces in jobs rows", () => {
  it("CHAOS_SSH_TIMEOUT_RATE=1 with attempts exhausted: task fails with reason='timeout' and the job is failed", async () => {
    // Keep the oversleep short so withTimeout fires fast. The oversleep
    // duration in defaultSshWork is SSH_TIMEOUT_MS + 1000ms buffer; we override
    // SSH_TIMEOUT_MS to a tiny value so the oversleep is still well bounded
    // and the test runs in <100ms.
    process.env.SSH_TIMEOUT_MS = "30";
    process.env.SSH_SLEEP_MS = "1";
    process.env.CHAOS_SSH_TIMEOUT_RATE = "1";

    const user = await createUser(`${PREFIX}-ssh-timeout`);
    const fx = await makeQueuedSshTaskWithLease(user.id, 1);
    // max_attempts=1 so this single failure is terminal — no retry loop needed.
    await db.query(`UPDATE tasks SET max_attempts=1 WHERE id=$1`, [fx.taskId]);

    await runSshTask(
      { taskId: fx.taskId, leaseToken: fx.leaseToken, attempts: fx.attempts },
      defaultSshWork,
      { timeoutMs: 30 },
    );

    const task = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("failed");
    expect(task.rows[0].failure_reason).toBe("timeout");

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("failed");
  });

  it("CHAOS_SSH_MISSING_ARTIFACT_RATE=1 with attempts exhausted: task fails with reason='error' (ENOENT from fs.access) and the job is failed", async () => {
    process.env.SSH_SLEEP_MS = "1";
    process.env.CHAOS_SSH_MISSING_ARTIFACT_RATE = "1";

    const user = await createUser(`${PREFIX}-ssh-missing`);
    const fx = await makeQueuedSshTaskWithLease(user.id, 1);
    await db.query(`UPDATE tasks SET max_attempts=1 WHERE id=$1`, [fx.taskId]);

    await runSshTask(
      { taskId: fx.taskId, leaseToken: fx.leaseToken, attempts: fx.attempts },
      defaultSshWork,
    );

    const task = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("failed");
    // failureReason() in worker.ts maps any non-TimeoutError to "error".
    // fs.access on a missing path throws ENOENT, which is neither a
    // TimeoutError nor a StaleAttemptError — so it lands in the "error" bucket.
    expect(task.rows[0].failure_reason).toBe("error");

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("failed");
  });

  it("CHAOS_CPU_CRASH_RATE=1: runCpuWork invokes process.exit(1); given an expired lease post-crash, the reaper marks task & job failed", async () => {
    // Shorten the work duration so the post-crash code path (which continues
    // when process.exit is mocked) finishes quickly.
    process.env.CPU_SLEEP_MIN_MS = "1";
    process.env.CPU_SLEEP_MAX_MS = "1";
    process.env.CHAOS_CPU_CRASH_RATE = "1";

    // Synthesize the in-flight worker state: task running with attempts at
    // max_attempts (this is the next-claim-bumps state, so the next failure
    // is terminal) and a still-active lease (the heartbeat would have been
    // running right up until the crash).
    const user = await createUser(`${PREFIX}-cpu-crash`);
    const job = await createJob({ userId: user.id, pipelinesCount: 1 });
    const taskRow = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' LIMIT 1`,
      [job.jobId],
    );
    const taskId = taskRow.rows[0].id;
    await db.query(
      `UPDATE tasks
          SET status='running',
              attempts=1,
              max_attempts=1,
              started_at=now(),
              lease_token=gen_random_uuid(),
              lease_expires_at=now() + interval '1 minute',
              lease_heartbeat_at=now()
        WHERE id=$1`,
      [taskId],
    );

    // Mock process.exit so the test runner survives. maybeCrash defaults
    // to the real process.exit; in production this terminates the worker
    // and the reaper does the rest. Here we just verify it was called.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);

    await runCpuWork(taskId);

    expect(exitSpy).toHaveBeenCalledWith(1);

    // Lock the invariant the reaper branch depends on: runCpuWork is a pure
    // compute helper, so even with process.exit mocked to no-op the post-crash
    // continuation must not touch the tasks row. If that ever changes (a
    // future refactor adds a DB write to runCpuWork), this assertion fails
    // fast instead of silently letting the synthetic UPDATE below paper over
    // the regression.
    const inFlight = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [taskId],
    );
    expect(inFlight.rows[0].status).toBe("running");
    expect(inFlight.rows[0].attempts).toBe(1);

    // Crash aftermath: the worker is dead, the heartbeat is no longer
    // pushing lease_expires_at forward. Simulate that by expiring the lease
    // in one query (in production this happens by the wall clock catching
    // up to lease_expires_at).
    await db.query(
      `UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [taskId],
    );

    const reaped = await reapExpiredLeases();
    expect(reaped).toBe(1);

    const task = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM tasks WHERE id=$1`,
      [taskId],
    );
    expect(task.rows[0].status).toBe("failed");
    expect(task.rows[0].failure_reason).toBe("lease_expired");

    const jobRow = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [job.jobId],
    );
    expect(jobRow.rows[0].status).toBe("failed");
  });
});
