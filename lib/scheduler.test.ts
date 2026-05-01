import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
import { createUser } from "./users";
import { createJob } from "./jobs";
import {
  dispatchCpu,
  dispatchSsh,
  dispatchTraining,
  type DispatchMessage,
  type DispatchQueue,
} from "./scheduler";

const PREFIX = `t5-sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

class FakeQueue implements DispatchQueue {
  messages: DispatchMessage[] = [];
  shouldThrow = false;
  async add(payload: DispatchMessage): Promise<void> {
    if (this.shouldThrow) throw new Error("simulated redis failure");
    this.messages.push(payload);
  }
}

async function reset(): Promise<void> {
  // Cascades wipe jobs/tasks/artifacts/leases.
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

// Helpers: forge "running with active lease" rows so tests don't depend on
// a real worker pipeline existing yet.
async function fillActiveCpuLeases(userId: string, count: number): Promise<void> {
  const { jobId } = await createJob({ userId, pipelinesCount: count });
  await db.query(`UPDATE tasks SET status='running' WHERE job_id=$1`, [jobId]);
  await db.query(
    `INSERT INTO leases (task_id, user_id, resource, expires_at)
       SELECT id, user_id, 'cpu', now() + interval '1 minute'
         FROM tasks WHERE job_id=$1`,
    [jobId],
  );
}

describe("dispatchCpu", () => {
  it("returns 0 and enqueues nothing when no CPU tasks are pending", async () => {
    const queue = new FakeQueue();
    const n = await dispatchCpu(queue);
    expect(n).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("dispatches at most (GLOBAL_CPU_SLOTS - used) tasks per call", async () => {
    // GLOBAL_CPU_SLOTS=20 (.env.example). Pre-fill 18 active leases under one
    // user so only 2 free slots remain. Then submit a job with 5 pending
    // tasks under a different user — we expect exactly 2 to be dispatched.
    const filler = await createUser(`${PREFIX}-filler`);
    await fillActiveCpuLeases(filler.id, 18);

    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 5 });

    const queue = new FakeQueue();
    const n = await dispatchCpu(queue);

    expect(n).toBe(2);
    expect(queue.messages).toHaveLength(2);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tasks WHERE user_id=$1 AND status='queued'`,
      [u.id],
    );
    expect(rows[0].count).toBe("2");
  });

  it("dispatches nothing when there are no free slots", async () => {
    const filler = await createUser(`${PREFIX}-filler`);
    await fillActiveCpuLeases(filler.id, 20);

    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 5 });

    const queue = new FakeQueue();
    const n = await dispatchCpu(queue);
    expect(n).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("creates exactly one active lease per dispatched task and sets status='queued'", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);

    expect(queue.messages).toHaveLength(3);
    for (const msg of queue.messages) {
      const lease = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM leases
           WHERE task_id=$1 AND resource='cpu' AND released_at IS NULL`,
        [msg.taskId],
      );
      expect(lease.rows[0].count).toBe("1");

      const task = await db.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id=$1`,
        [msg.taskId],
      );
      expect(task.rows[0].status).toBe("queued");
    }
  });

  it("enqueues {taskId, leaseId, attempts} matching the DB rows", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 1 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);

    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0];

    const task = await db.query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM tasks WHERE id=$1`,
      [msg.taskId],
    );
    expect(task.rows[0].attempts).toBe(msg.attempts);

    const lease = await db.query<{ id: string }>(
      `SELECT id FROM leases
         WHERE id=$1 AND task_id=$2 AND released_at IS NULL`,
      [msg.leaseId, msg.taskId],
    );
    expect(lease.rowCount).toBe(1);
  });

  it("orders dispatch by (running_cpu_count ASC, jobs.created_at ASC, tasks.created_at ASC)", async () => {
    // Alice has 1 active CPU lease (running_cpu_count = 1).
    // Bob has 0 active CPU leases (running_cpu_count = 0).
    // Both have 1 pending CPU task. Bob's must be dispatched first.
    const alice = await createUser(`${PREFIX}-alice`);
    const aliceJob = await createJob({ userId: alice.id, pipelinesCount: 2 });
    await db.query(
      `UPDATE tasks SET status='running'
         WHERE id = (SELECT id FROM tasks WHERE job_id=$1 LIMIT 1)`,
      [aliceJob.jobId],
    );
    await db.query(
      `INSERT INTO leases (task_id, user_id, resource, expires_at)
         SELECT id, user_id, 'cpu', now() + interval '1 minute'
           FROM tasks WHERE job_id=$1 AND status='running'`,
      [aliceJob.jobId],
    );

    const bob = await createUser(`${PREFIX}-bob`);
    await createJob({ userId: bob.id, pipelinesCount: 1 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);

    expect(queue.messages.length).toBeGreaterThanOrEqual(1);
    const firstUserId = (
      await db.query<{ user_id: string }>(
        `SELECT user_id FROM tasks WHERE id=$1`,
        [queue.messages[0].taskId],
      )
    ).rows[0].user_id;
    expect(firstUserId).toBe(bob.id);
  });

  it("preserves lease + queued status if queue.add throws (reaper recovers later)", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 1 });

    const queue = new FakeQueue();
    queue.shouldThrow = true;
    await expect(dispatchCpu(queue)).rejects.toThrow(/simulated redis/);

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE user_id=$1`,
      [u.id],
    );
    expect(task.rows[0].status).toBe("queued");

    const lease = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM leases WHERE user_id=$1 AND released_at IS NULL`,
      [u.id],
    );
    expect(lease.rows[0].count).toBe("1");
  });

  it("dispatches each pending task at most once across consecutive calls", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);
    await dispatchCpu(queue);
    await dispatchCpu(queue);

    expect(queue.messages).toHaveLength(3);
    const ids = new Set(queue.messages.map((m) => m.taskId));
    expect(ids.size).toBe(3);
  });
});

// Forge `count` pending SSH tasks under one user (sharing a job) without
// running the CPU stage. Returns the job id.
async function makePendingSshTasks(
  userId: string,
  count: number,
): Promise<string> {
  const job = await createJob({ userId, pipelinesCount: count });
  const cpus = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' ORDER BY created_at`,
    [job.jobId],
  );
  for (const c of cpus.rows) {
    await db.query(
      `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
         VALUES ($1, $2, 'ssh', 'pending', $3)`,
      [job.jobId, userId, c.id],
    );
  }
  return job.jobId;
}

describe("dispatchSsh", () => {
  it("returns 0 and enqueues nothing when no SSH tasks are pending", async () => {
    const queue = new FakeQueue();
    expect(await dispatchSsh(queue)).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("dispatches all pending SSH tasks under the GLOBAL_SSH_SLOTS cap, marks them queued, creates SSH leases", async () => {
    const u = await createUser(`${PREFIX}-ssh-u`);
    const jobId = await makePendingSshTasks(u.id, 3);

    const queue = new FakeQueue();
    const n = await dispatchSsh(queue);
    expect(n).toBe(3);
    expect(queue.messages).toHaveLength(3);

    const queuedSsh = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
         WHERE job_id=$1 AND kind='ssh' AND status='queued'`,
      [jobId],
    );
    expect(queuedSsh.rows[0].count).toBe("3");

    for (const m of queue.messages) {
      const lease = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM leases
           WHERE task_id=$1 AND resource='ssh' AND released_at IS NULL`,
        [m.taskId],
      );
      expect(lease.rows[0].count).toBe("1");
    }
  });

  it("uses SSH-resource leases when computing free slots, not CPU leases", async () => {
    // Saturate CPU resource pool: with 20 CPU leases active, dispatchCpu would
    // refuse, but dispatchSsh must be unaffected.
    const filler = await createUser(`${PREFIX}-ssh-cpu-filler`);
    await fillActiveCpuLeases(filler.id, 20);

    const u = await createUser(`${PREFIX}-ssh-u2`);
    await makePendingSshTasks(u.id, 2);

    const queue = new FakeQueue();
    const n = await dispatchSsh(queue);
    expect(n).toBe(2);
  });
});

// Forge a pending training task (one per job) without running CPU/SSH stages.
async function makePendingTrainingTask(userId: string): Promise<string> {
  const job = await createJob({ userId, pipelinesCount: 1 });
  await db.query(
    `INSERT INTO tasks (job_id, user_id, kind, status)
       VALUES ($1, $2, 'training', 'pending')`,
    [job.jobId, userId],
  );
  return job.jobId;
}

describe("dispatchTraining", () => {
  it("returns 0 and enqueues nothing when no training tasks are pending", async () => {
    const queue = new FakeQueue();
    expect(await dispatchTraining(queue)).toBe(0);
    expect(queue.messages).toEqual([]);
  });

  it("dispatches pending training tasks, marks them queued, creates training-resource leases", async () => {
    const u = await createUser(`${PREFIX}-train-u`);
    const jobA = await makePendingTrainingTask(u.id);
    const jobB = await makePendingTrainingTask(u.id);

    const queue = new FakeQueue();
    const n = await dispatchTraining(queue);
    expect(n).toBe(2);
    expect(queue.messages).toHaveLength(2);

    const queuedRows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
         WHERE job_id = ANY($1::uuid[]) AND kind='training' AND status='queued'`,
      [[jobA, jobB]],
    );
    expect(queuedRows.rows[0].count).toBe("2");

    for (const m of queue.messages) {
      const lease = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM leases
           WHERE task_id=$1 AND resource='training' AND released_at IS NULL`,
        [m.taskId],
      );
      expect(lease.rows[0].count).toBe("1");
    }
  });

  it("uses TRAINING-resource leases when computing free slots, not CPU leases", async () => {
    const filler = await createUser(`${PREFIX}-train-cpu-filler`);
    await fillActiveCpuLeases(filler.id, 20);

    const u = await createUser(`${PREFIX}-train-u2`);
    await makePendingTrainingTask(u.id);

    const queue = new FakeQueue();
    const n = await dispatchTraining(queue);
    expect(n).toBe(1);
  });
});
