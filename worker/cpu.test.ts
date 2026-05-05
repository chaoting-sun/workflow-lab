import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "../lib/db";
import {
  ensureSchema,
  makeQueuedCpuTaskWithLease,
  type QueuedTaskFixture,
} from "../lib/test-helpers";
import { createUser } from "../lib/users";
import { sleep } from "../lib/sleep";
import { runCpuTask } from "./cpu";
import type { WorkerTaskMessage } from "../lib/worker";

const PREFIX = `t6-cpu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let scratchDir: string;

function msg(fx: QueuedTaskFixture): WorkerTaskMessage {
  return { taskId: fx.taskId, leaseToken: fx.leaseToken, attempts: fx.attempts };
}

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  scratchDir = await mkdtemp(join(tmpdir(), "workflow-lab-cpu-"));
  await reset();
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await rm(scratchDir, { recursive: true, force: true });
  await closeDb();
});

// Fast doWork that writes a real file (so the on-disk fs.access check passes)
// without sleeping for seconds.
function fastWork(content: string = "ok") {
  return async (taskId: string): Promise<string> => {
    const path = join(scratchDir, `cpu-${taskId}.txt`);
    await writeFile(path, content);
    return path;
  };
}

describe("runCpuTask", () => {
  it("happy path: task succeeded, artifact row, lease released, SSH child created, file on disk", async () => {
    const u = await createUser(`${PREFIX}-happy`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    await runCpuTask(msg(fx), fastWork("hello"));

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("succeeded");

    const artifact = await db.query<{ path: string }>(
      `SELECT path FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rowCount).toBe(1);
    await access(artifact.rows[0].path);
    expect(await readFile(artifact.rows[0].path, "utf-8")).toBe("hello");

    const lease = await db.query<{ lease_token: string | null }>(
      `SELECT lease_token FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(lease.rows[0].lease_token).toBeNull();

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1 AND kind='ssh'`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("1");
  });

  it("silently aborts when the BullMQ message is stale (attempts mismatch)", async () => {
    const u = await createUser(`${PREFIX}-stale-msg`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    await runCpuTask(
      { taskId: fx.taskId, leaseToken: fx.leaseToken, attempts: fx.attempts + 5 },
      fastWork(),
    );

    const task = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("queued");
    expect(task.rows[0].attempts).toBe(fx.attempts);

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("0");

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("0");
  });

  it("optimistic-lock branch: attempts bumped mid-flight → no artifact, no SSH child, lease still active", async () => {
    const u = await createUser(`${PREFIX}-opt-lock`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const racingWork = async (taskId: string): Promise<string> => {
      // Reaper-style mutation between claim and finalize.
      await db.query(`UPDATE tasks SET attempts=attempts+1 WHERE id=$1`, [taskId]);
      const path = join(scratchDir, `cpu-${taskId}.txt`);
      await writeFile(path, "raced");
      return path;
    };

    await runCpuTask(msg(fx), racingWork);

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).not.toBe("succeeded");

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("0");

    const lease = await db.query<{ lease_token: string | null }>(
      `SELECT lease_token FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(lease.rows[0].lease_token).not.toBeNull();

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("0");
  });

  it("timeout (retryable): doWork outlasts the timeout → task reset to pending with failure_reason='timeout', lease cleared, no artifact, no SSH child", async () => {
    const u = await createUser(`${PREFIX}-timeout-retry`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const slowWork = async (taskId: string): Promise<string> => {
      await sleep(500);
      return join(scratchDir, `cpu-${taskId}.txt`);
    };

    await runCpuTask(msg(fx), slowWork, { timeoutMs: 30 });

    const task = await db.query<{
      status: string;
      failure_reason: string | null;
    }>(
      `SELECT status, failure_reason FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("pending");
    expect(task.rows[0].failure_reason).toBe("timeout");

    const lease = await db.query<{ lease_token: string | null }>(
      `SELECT lease_token FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(lease.rows[0].lease_token).toBeNull();

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("0");

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("0");

    const job = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).not.toBe("failed");
  });

  it("timeout (terminal): task on its last attempt → status='failed', job propagates to 'failed'", async () => {
    const u = await createUser(`${PREFIX}-timeout-final`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    await db.query(`UPDATE tasks SET max_attempts=1 WHERE id=$1`, [fx.taskId]);

    const slowWork = async (taskId: string): Promise<string> => {
      await sleep(500);
      return join(scratchDir, `cpu-${taskId}.txt`);
    };

    await runCpuTask(msg(fx), slowWork, { timeoutMs: 30 });

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

  it("a duplicate delivery of the same message is a no-op the second time", async () => {
    const u = await createUser(`${PREFIX}-dup`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    await runCpuTask(msg(fx), fastWork());
    // Second delivery uses the original (now stale) message; should silently abort.
    await runCpuTask(msg(fx), fastWork());

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1 AND kind='ssh'`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("1");

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("1");
  });
});
