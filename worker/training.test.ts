import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "../lib/db";
import {
  ensureSchema,
  makeQueuedTrainingTaskWithLease,
  type QueuedTaskFixture,
} from "../lib/test-helpers";
import { createUser } from "../lib/users";
import { runTrainingTask } from "./training";
import type { WorkerTaskMessage } from "../lib/worker";

const PREFIX = `t8-train-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let scratchDir: string;

function msg(fx: QueuedTaskFixture): WorkerTaskMessage {
  return { taskId: fx.taskId, leaseId: fx.leaseId, attempts: fx.attempts };
}

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  scratchDir = await mkdtemp(join(tmpdir(), "workflow-lab-train-"));
  await reset();
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await rm(scratchDir, { recursive: true, force: true });
  await closeDb();
});

// fastWork writes a deterministic file in the scratch dir without sleeping.
function fastWork(content: string = "ok") {
  return async (jobId: string): Promise<string> => {
    const path = join(scratchDir, `train-${jobId}.txt`);
    await writeFile(path, content);
    return path;
  };
}

describe("runTrainingTask", () => {
  it("happy path: task succeeded, lease released, jobs.status='completed' with completed_at set, file on disk", async () => {
    const u = await createUser(`${PREFIX}-happy`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    await runTrainingTask(msg(fx), fastWork("trained"));

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("succeeded");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).not.toBeNull();

    const job = await db.query<{ status: string; completed_at: Date | null }>(
      `SELECT status, completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("completed");
    expect(job.rows[0].completed_at).not.toBeNull();

    const path = join(scratchDir, `train-${fx.jobId}.txt`);
    await access(path);
    expect(await readFile(path, "utf-8")).toBe("trained");
  });

  it("silently aborts when message is stale (attempts mismatch)", async () => {
    const u = await createUser(`${PREFIX}-stale`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    await runTrainingTask(
      { taskId: fx.taskId, leaseId: fx.leaseId, attempts: fx.attempts + 5 },
      fastWork(),
    );

    const t = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).toBe("queued");
    expect(t.rows[0].attempts).toBe(fx.attempts);

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).not.toBe("completed");
  });

  it("optimistic-lock: attempts bumped mid-flight → no success, lease still active, job not completed", async () => {
    const u = await createUser(`${PREFIX}-opt-lock`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    const racingWork = async (jobId: string): Promise<string> => {
      // Simulate a reaper / parallel worker bumping attempts after our claim.
      await db.query(`UPDATE tasks SET attempts=attempts+1 WHERE id=$1`, [
        fx.taskId,
      ]);
      const path = join(scratchDir, `train-${jobId}.txt`);
      await writeFile(path, "raced");
      return path;
    };

    await runTrainingTask(msg(fx), racingWork);

    const t = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).not.toBe("succeeded");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).toBeNull();

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).not.toBe("completed");
  });

  it("re-running training on a completed job preserves the original completed_at (idempotent UPDATE guard)", async () => {
    const u = await createUser(`${PREFIX}-rerun-completed`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    await runTrainingTask(msg(fx), fastWork());

    const first = await db.query<{ completed_at: Date }>(
      `SELECT completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    const firstCompletedAt = first.rows[0].completed_at;
    expect(firstCompletedAt).not.toBeNull();

    // Manually reset the task and reissue a lease so we can replay the worker.
    await db.query(
      `UPDATE tasks SET status='queued', attempts=0, finished_at=NULL WHERE id=$1`,
      [fx.taskId],
    );
    const lease2 = await db.query<{ id: string }>(
      `INSERT INTO leases (task_id, user_id, resource, expires_at)
         VALUES ($1, $2, 'training', now() + interval '1 minute')
         RETURNING id`,
      [fx.taskId, u.id],
    );

    await runTrainingTask(
      { taskId: fx.taskId, leaseId: lease2.rows[0].id, attempts: 0 },
      fastWork(),
    );

    const after = await db.query<{ status: string; completed_at: Date }>(
      `SELECT status, completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(after.rows[0].status).toBe("completed");
    expect(after.rows[0].completed_at.getTime()).toBe(firstCompletedAt.getTime());
  });

  it("does not flip a 'failed' job to 'completed'", async () => {
    const u = await createUser(`${PREFIX}-failed-job`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    await db.query(
      `UPDATE jobs SET status='failed', completed_at=now() WHERE id=$1`,
      [fx.jobId],
    );
    const before = await db.query<{ completed_at: Date }>(
      `SELECT completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );

    await runTrainingTask(msg(fx), fastWork());

    const after = await db.query<{ status: string; completed_at: Date }>(
      `SELECT status, completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(after.rows[0].status).toBe("failed");
    expect(after.rows[0].completed_at.getTime()).toBe(
      before.rows[0].completed_at.getTime(),
    );

    // The training task itself still succeeded (its row was claimed and updated).
    const t = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).toBe("succeeded");
  });

  it("duplicate delivery is a no-op the second time", async () => {
    const u = await createUser(`${PREFIX}-dup`);
    const fx = await makeQueuedTrainingTaskWithLease(u.id);

    await runTrainingTask(msg(fx), fastWork());
    await runTrainingTask(msg(fx), fastWork());

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("completed");

    const t = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).toBe("succeeded");
    // The second delivery's claim must fail (status='succeeded' ≠ 'queued'),
    // so attempts stays at the value set by the first claim (1).
    expect(t.rows[0].attempts).toBe(1);
  });
});
