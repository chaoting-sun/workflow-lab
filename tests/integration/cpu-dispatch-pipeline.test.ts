import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "../../lib/db";
import { createJob } from "../../lib/jobs";
import {
  dispatchCpu,
  type DispatchMessage,
  type DispatchQueue,
} from "../../lib/scheduler";
import { ensureSchema } from "../../lib/test-helpers";
import { createUser } from "../../lib/users";
import {
  claimTask,
  finalizeCpuSuccess,
  type WorkerTaskMessage,
} from "../../lib/worker";

// T30 — Real-Redis dispatch pipeline integration test.
//
// Proves the BullMQ wire end-to-end: scheduler.dispatchCpu enqueues into a
// real Redis-backed Queue; a real BullMQ Worker drains the message, calls
// worker.claimTask, runs the work, and calls finalizeCpuSuccess. Complements
// lib/lease-fencing.test.ts, which uses an in-memory CapturingQueue and so
// does not exercise serialisation, queue naming, or worker plumbing.
//
// Redis isolation: a dedicated db index (TEST_REDIS_DB, default 15) is used
// so the test cannot clobber dev/prod data sharing the same Redis instance.
// db 0 is rejected explicitly. The test skips at runtime if Redis is not
// reachable, matching the convention in scheduler/index.test.ts.

const PREFIX = `t30-pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const TEST_DB_INDEX = Number(process.env.TEST_REDIS_DB ?? 15);
const QUEUE_NAME = "cpu";

function testRedisUrl(): string {
  const u = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  u.pathname = `/${TEST_DB_INDEX}`;
  return u.toString();
}

let connection: IORedis | null = null;
let queue: Queue<DispatchMessage> | null = null;
let scratchDir: string;
let redisAvailable = false;

async function resetDb(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

async function resetRedis(): Promise<void> {
  if (queue) await queue.obliterate({ force: true });
}

beforeAll(async () => {
  if (TEST_DB_INDEX === 0) {
    throw new Error(
      "refusing to run T30 against Redis db 0; set TEST_REDIS_DB to an isolated index",
    );
  }

  await ensureSchema();
  scratchDir = await mkdtemp(join(tmpdir(), "workflow-lab-t30-"));

  connection = new IORedis(testRedisUrl(), {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  try {
    await connection.connect();
    await connection.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
    return;
  }

  await connection.flushdb();
  queue = new Queue<DispatchMessage>(QUEUE_NAME, { connection });
  await resetDb();
});

beforeEach(async () => {
  if (!redisAvailable) return;
  await resetDb();
  await resetRedis();
});

afterAll(async () => {
  if (redisAvailable) {
    try {
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    } catch {
      // Swallow — afterAll must not mask a test failure.
    }
    if (connection) connection.disconnect();
  }
  try {
    await resetDb();
  } catch {
    // DB already closed in some failure paths.
  }
  await rm(scratchDir, { recursive: true, force: true });
  await closeDb();
});

// Wrap a real BullMQ Queue in the DispatchQueue shape that scheduler.dispatchCpu
// consumes. Mirrors the production adapter in lib/queues.ts (job name "task").
function adapt(q: Queue<DispatchMessage>): DispatchQueue {
  return {
    async add(payload: DispatchMessage): Promise<void> {
      await q.add("task", payload);
    },
  };
}

// Fast doWork that writes a real file (so the on-disk fs.access check in the
// production CPU worker would pass). Mirrors the helper in worker/cpu.test.ts.
async function fastWork(taskId: string, content = "ok"): Promise<string> {
  const path = join(scratchDir, `cpu-${taskId}.txt`);
  await writeFile(path, content);
  return path;
}

interface PendingTaskRow {
  status: string;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
}

describe("T30 — real-Redis CPU dispatch pipeline", () => {
  it("dispatch enqueues into real BullMQ and a real worker drains via claimTask + finalizeCpuSuccess", async () => {
    if (!redisAvailable || !queue) return; // Redis unavailable — skip.

    const user = await createUser(`${PREFIX}-happy`);
    const job = await createJob({ userId: user.id, pipelinesCount: 1 });

    const dispatched = await dispatchCpu(adapt(queue));
    expect(dispatched).toBe(1);

    // Postgres side-effect of dispatch: the lone CPU task is queued with an
    // active lease (token + expiry set). attempts is NOT bumped — claimTask
    // bumps it.
    const taskAfterDispatch = await db.query<PendingTaskRow>(
      `SELECT status, attempts, lease_token, lease_expires_at
         FROM tasks
        WHERE job_id = $1 AND kind = 'cpu'`,
      [job.jobId],
    );
    expect(taskAfterDispatch.rowCount).toBe(1);
    const before = taskAfterDispatch.rows[0];
    expect(before.status).toBe("queued");
    expect(before.attempts).toBe(0);
    expect(before.lease_token).not.toBeNull();
    expect(before.lease_expires_at).not.toBeNull();
    expect(before.lease_expires_at!.getTime()).toBeGreaterThan(Date.now());

    // BullMQ side-effect: exactly one waiting message on the cpu queue.
    const counts = await queue.getJobCounts("waiting", "active", "completed", "failed");
    expect(counts.waiting).toBe(1);
    expect(counts.active).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);

    // Capture the claimed payload so we can assert lease acquisition.
    const claimedTasks: { msg: WorkerTaskMessage; bumpedAttempts: number | null }[] = [];

    const processed = new Promise<void>((resolve, reject) => {
      const worker = new Worker<WorkerTaskMessage>(
        QUEUE_NAME,
        async (bullJob: Job<WorkerTaskMessage>) => {
          // Spec-prescribed drain: worker.claimTask is the atomic claim. A
          // null return is the lease-fencing reject path; on a real
          // single-dispatch test it must succeed.
          const claimed = await claimTask(bullJob.data);
          if (!claimed) {
            claimedTasks.push({ msg: bullJob.data, bumpedAttempts: null });
            return;
          }
          const artifactPath = await fastWork(claimed.taskId, "t30");
          await finalizeCpuSuccess(claimed, artifactPath);
          claimedTasks.push({ msg: bullJob.data, bumpedAttempts: claimed.myAttempts });
        },
        { connection: connection!, concurrency: 1 },
      );

      const timer = setTimeout(() => {
        worker.close().finally(() =>
          reject(
            new Error(
              `T30: worker did not complete the job within timeout; counts=${JSON.stringify(counts)}`,
            ),
          ),
        );
      }, 15000);

      worker.on("completed", () => {
        clearTimeout(timer);
        worker.close().then(() => resolve(), reject);
      });
      worker.on("failed", (_job, err) => {
        clearTimeout(timer);
        worker.close().finally(() => reject(err));
      });
    });

    await processed;

    // Drain side-effects on Postgres: task succeeded, lease released,
    // attempts bumped once by claimTask, artifact row inserted, and the
    // child SSH task was forged by finalizeCpuSuccess.
    expect(claimedTasks).toHaveLength(1);
    expect(claimedTasks[0].bumpedAttempts).toBe(1);
    expect(claimedTasks[0].msg.leaseToken).toBe(before.lease_token);

    const taskAfter = await db.query<{
      status: string;
      attempts: number;
      lease_token: string | null;
      lease_expires_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT status, attempts, lease_token, lease_expires_at, finished_at
         FROM tasks
        WHERE job_id = $1 AND kind = 'cpu'`,
      [job.jobId],
    );
    expect(taskAfter.rows[0].status).toBe("succeeded");
    expect(taskAfter.rows[0].attempts).toBe(1);
    expect(taskAfter.rows[0].lease_token).toBeNull();
    expect(taskAfter.rows[0].lease_expires_at).toBeNull();
    expect(taskAfter.rows[0].finished_at).not.toBeNull();

    const artifact = await db.query<{ path: string }>(
      `SELECT path FROM artifacts WHERE task_id = (
         SELECT id FROM tasks WHERE job_id = $1 AND kind = 'cpu'
       )`,
      [job.jobId],
    );
    expect(artifact.rowCount).toBe(1);
    expect(await readFile(artifact.rows[0].path, "utf-8")).toBe("t30");

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id = $1 AND kind = 'ssh'`,
      [job.jobId],
    );
    expect(Number(child.rows[0].count)).toBe(1);

    // Job is promoted to running (claimTask flips pending→running atomically
    // with the task claim). Completion waits for the SSH+training stages.
    const jobRow = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`,
      [job.jobId],
    );
    expect(jobRow.rows[0].status).toBe("running");

    // BullMQ should be drained.
    const finalCounts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
    );
    expect(finalCounts.waiting).toBe(0);
    expect(finalCounts.active).toBe(0);
    expect(finalCounts.failed).toBe(0);
    expect(finalCounts.completed).toBeGreaterThanOrEqual(1);
  }, 30000);
});
