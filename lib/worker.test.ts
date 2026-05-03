import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import {
  ensureSchema,
  makeQueuedCpuTaskWithLease,
  type QueuedTaskFixture,
} from "./test-helpers";
import { createUser } from "./users";
import {
  claimTask,
  finalizeCpuSuccess,
  StaleAttemptError,
  startHeartbeat,
  type ClaimedTask,
  type WorkerTaskMessage,
} from "./worker";

const PREFIX = `t6-worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await reset();
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await closeDb();
});

describe("claimTask", () => {
  it("transitions queued task to running and increments attempts", async () => {
    const u = await createUser(`${PREFIX}-claim-ok`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const msg: WorkerTaskMessage = {
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    };
    const claimed = await claimTask(msg);
    expect(claimed).not.toBeNull();
    expect(claimed!.taskId).toBe(fx.taskId);
    expect(claimed!.jobId).toBe(fx.jobId);
    expect(claimed!.userId).toBe(fx.userId);
    expect(claimed!.myAttempts).toBe(fx.attempts + 1);

    const row = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].attempts).toBe(fx.attempts + 1);
  });

  it("promotes parent job from 'pending' to 'running' on first claim", async () => {
    const u = await createUser(`${PREFIX}-claim-job-running`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const before = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(before.rows[0].status).toBe("pending");

    const claimed = await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    });
    expect(claimed).not.toBeNull();

    const after = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(after.rows[0].status).toBe("running");
  });

  it("does not overwrite a terminal job status on re-claim", async () => {
    const u = await createUser(`${PREFIX}-claim-job-terminal`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    await db.query(
      `UPDATE jobs SET status='completed', completed_at=now() WHERE id=$1`,
      [fx.jobId],
    );

    await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    });

    const row = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(row.rows[0].status).toBe("completed");
  });

  it("returns null and does not mutate when status != 'queued'", async () => {
    const u = await createUser(`${PREFIX}-claim-status`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    await db.query(`UPDATE tasks SET status='succeeded' WHERE id=$1`, [fx.taskId]);

    const claimed = await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    });
    expect(claimed).toBeNull();

    const row = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(row.rows[0].status).toBe("succeeded");
    expect(row.rows[0].attempts).toBe(fx.attempts);
  });

  it("returns null when message attempts does not match DB", async () => {
    const u = await createUser(`${PREFIX}-claim-attempts`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const claimed = await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts + 99,
    });
    expect(claimed).toBeNull();

    const row = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].attempts).toBe(fx.attempts);
  });

  it("returns null when the lease has been released", async () => {
    const u = await createUser(`${PREFIX}-claim-lease-released`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    await db.query(`UPDATE leases SET released_at=now() WHERE id=$1`, [fx.leaseId]);

    const claimed = await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    });
    expect(claimed).toBeNull();
  });

  it("returns null when the leaseId does not match the task", async () => {
    const u = await createUser(`${PREFIX}-claim-wrong-lease`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const claimed = await claimTask({
      taskId: fx.taskId,
      leaseId: "00000000-0000-0000-0000-000000000000",
      attempts: fx.attempts,
    });
    expect(claimed).toBeNull();
  });
});

describe("finalizeCpuSuccess", () => {
  async function claim(fx: QueuedTaskFixture): Promise<ClaimedTask> {
    const c = await claimTask({
      taskId: fx.taskId,
      leaseId: fx.leaseId,
      attempts: fx.attempts,
    });
    if (!c) throw new Error("setup: claim failed");
    return c;
  }

  it("marks task succeeded, inserts artifact, releases lease, and creates SSH child", async () => {
    const u = await createUser(`${PREFIX}-fin-ok`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    const claimed = await claim(fx);

    await finalizeCpuSuccess(claimed, fx.leaseId, "/tmp/cpu-artifact.txt");

    const task = await db.query<{ status: string; finished_at: Date }>(
      `SELECT status, finished_at FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("succeeded");
    expect(task.rows[0].finished_at).not.toBeNull();

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("1");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).not.toBeNull();

    const child = await db.query<{
      id: string;
      kind: string;
      status: string;
      parent_task_id: string;
      job_id: string;
      user_id: string;
    }>(
      `SELECT id, kind, status, parent_task_id, job_id, user_id
         FROM tasks WHERE parent_task_id=$1`,
      [fx.taskId],
    );
    expect(child.rowCount).toBe(1);
    expect(child.rows[0]).toMatchObject({
      kind: "ssh",
      status: "pending",
      parent_task_id: fx.taskId,
      job_id: fx.jobId,
      user_id: u.id,
    });
  });

  it("aborts (StaleAttemptError) when attempts changed mid-flight; no side effects", async () => {
    const u = await createUser(`${PREFIX}-fin-stale`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    const claimed = await claim(fx);

    // Simulate the reaper bumping attempts behind us.
    await db.query(`UPDATE tasks SET attempts=attempts+1 WHERE id=$1`, [fx.taskId]);

    await expect(
      finalizeCpuSuccess(claimed, fx.leaseId, "/tmp/cpu-artifact.txt"),
    ).rejects.toBeInstanceOf(StaleAttemptError);

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    // Status should still be 'running' (or whatever the racing actor set);
    // crucially, it must NOT be 'succeeded'.
    expect(task.rows[0].status).not.toBe("succeeded");

    const artifact = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rows[0].count).toBe("0");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).toBeNull();

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE parent_task_id=$1`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("0");
  });

  it("is idempotent if SSH child already exists (ON CONFLICT DO NOTHING)", async () => {
    const u = await createUser(`${PREFIX}-fin-idem`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    const claimed = await claim(fx);

    // Pre-insert an SSH child to simulate a prior partial run.
    await db.query(
      `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
         VALUES ($1, $2, 'ssh', 'pending', $3)`,
      [fx.jobId, fx.userId, fx.taskId],
    );

    await finalizeCpuSuccess(claimed, fx.leaseId, "/tmp/cpu-artifact.txt");

    const child = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
         WHERE parent_task_id=$1 AND kind='ssh'`,
      [fx.taskId],
    );
    expect(child.rows[0].count).toBe("1");
  });
});

describe("startHeartbeat", () => {
  async function getLeaseTimes(leaseId: string): Promise<{
    heartbeat_at: Date;
    expires_at: Date;
    released_at: Date | null;
  }> {
    const { rows } = await db.query<{
      heartbeat_at: Date;
      expires_at: Date;
      released_at: Date | null;
    }>(
      `SELECT heartbeat_at, expires_at, released_at FROM leases WHERE id=$1`,
      [leaseId],
    );
    return rows[0];
  }

  it("bumps heartbeat_at and expires_at on each tick while running", async () => {
    const u = await createUser(`${PREFIX}-hb-bump`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    const before = await getLeaseTimes(fx.leaseId);

    const hb = startHeartbeat(fx.leaseId, { intervalMs: 30, ttlMs: 60_000 });
    await new Promise((r) => setTimeout(r, 120));
    hb.stop();

    const after = await getLeaseTimes(fx.leaseId);
    expect(after.heartbeat_at.getTime()).toBeGreaterThan(
      before.heartbeat_at.getTime(),
    );
    expect(after.expires_at.getTime()).toBeGreaterThan(
      before.expires_at.getTime(),
    );
  });

  it("stops bumping after stop()", async () => {
    const u = await createUser(`${PREFIX}-hb-stop`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);

    const hb = startHeartbeat(fx.leaseId, { intervalMs: 30, ttlMs: 60_000 });
    await new Promise((r) => setTimeout(r, 80));
    hb.stop();
    const afterStop = await getLeaseTimes(fx.leaseId);

    await new Promise((r) => setTimeout(r, 120));
    const later = await getLeaseTimes(fx.leaseId);

    expect(later.heartbeat_at.getTime()).toBe(afterStop.heartbeat_at.getTime());
    expect(later.expires_at.getTime()).toBe(afterStop.expires_at.getTime());
  });

  it("does not resurrect a released lease", async () => {
    const u = await createUser(`${PREFIX}-hb-released`);
    const fx = await makeQueuedCpuTaskWithLease(u.id);
    await db.query(`UPDATE leases SET released_at=now() WHERE id=$1`, [
      fx.leaseId,
    ]);

    const hb = startHeartbeat(fx.leaseId, { intervalMs: 20, ttlMs: 60_000 });
    await new Promise((r) => setTimeout(r, 80));
    hb.stop();

    const row = await getLeaseTimes(fx.leaseId);
    expect(row.released_at).not.toBeNull();
  });
});
