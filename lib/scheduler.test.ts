import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
import { getConfig } from "./config";
import { createUser } from "./users";
import { createJob } from "./jobs";
import {
  dispatchCpu,
  dispatchSsh,
  dispatchTraining,
  reapExpiredLeases,
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

  it("interleaves dispatch between two jobs of the same user (per-job fairness)", async () => {
    // Single user submits jobs A then B, each with 3 pending CPU tasks. Without
    // per-job fairness, j.created_at would drain A entirely before touching B.
    const u = await createUser(`${PREFIX}-multi-job`);
    const a = await createJob({ userId: u.id, pipelinesCount: 3 });
    const b = await createJob({ userId: u.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    const n = await dispatchCpu(queue);
    expect(n).toBe(6);

    const order: string[] = [];
    for (const m of queue.messages) {
      const { rows } = await db.query<{ job_id: string }>(
        `SELECT job_id FROM tasks WHERE id=$1`,
        [m.taskId],
      );
      order.push(rows[0].job_id === a.jobId ? "A" : "B");
    }
    expect(order).toEqual(["A", "B", "A", "B", "A", "B"]);
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

describe("dispatchCpu — SSH backpressure (T12)", () => {
  // .env.example sets SSH_BACKPRESSURE_THRESHOLD=80. We forge exactly that
  // many SSH rows in active states so the backlog gate trips, then assert
  // CPU dispatch is paused for the tick.
  it("skips CPU dispatch when SSH backlog >= SSH_BACKPRESSURE_THRESHOLD", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-filler`);
    await makeSshTasksWithStatus(
      filler.id,
      cfg.SSH_BACKPRESSURE_THRESHOLD,
      "pending",
    );

    const u = await createUser(`${PREFIX}-bp-cpu`);
    await createJob({ userId: u.id, pipelinesCount: 5 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);
    expect(queue.messages).toEqual([]);

    // No CPU lease was created and no task was flipped to 'queued'.
    const queued = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tasks WHERE user_id=$1 AND status='queued'`,
      [u.id],
    );
    expect(queued.rows[0].count).toBe("0");
    const leases = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM leases WHERE user_id=$1 AND released_at IS NULL`,
      [u.id],
    );
    expect(leases.rows[0].count).toBe("0");
  });

  it("counts pending, queued, and running SSH tasks toward the backlog", async () => {
    const cfg = getConfig();
    const t = cfg.SSH_BACKPRESSURE_THRESHOLD;
    // Split the threshold across all three counted statuses to confirm the
    // SQL filter mirrors SPEC §3.8.
    const a = Math.floor(t / 3);
    const b = Math.floor(t / 3);
    const c = t - a - b;

    const u1 = await createUser(`${PREFIX}-bp-pending`);
    await makeSshTasksWithStatus(u1.id, a, "pending");
    const u2 = await createUser(`${PREFIX}-bp-queued`);
    await makeSshTasksWithStatus(u2.id, b, "queued");
    const u3 = await createUser(`${PREFIX}-bp-running`);
    await makeSshTasksWithStatus(u3.id, c, "running");

    const target = await createUser(`${PREFIX}-bp-target`);
    await createJob({ userId: target.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);
  });

  it("does not count succeeded or failed SSH tasks toward the backlog", async () => {
    const cfg = getConfig();
    // Forge threshold-many SSH rows in *terminal* states; backlog must still
    // read 0 and CPU dispatch must proceed.
    const filler = await createUser(`${PREFIX}-bp-terminal`);
    await makeSshTasksWithStatus(
      filler.id,
      cfg.SSH_BACKPRESSURE_THRESHOLD,
      "pending",
    );
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE user_id=$1 AND kind='ssh'`,
      [filler.id],
    );

    const u = await createUser(`${PREFIX}-bp-after-terminal`);
    await createJob({ userId: u.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(3);
  });

  it("resumes CPU dispatch once SSH backlog drops below the threshold", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-resume-filler`);
    await makeSshTasksWithStatus(
      filler.id,
      cfg.SSH_BACKPRESSURE_THRESHOLD,
      "pending",
    );

    const u = await createUser(`${PREFIX}-bp-resume`);
    await createJob({ userId: u.id, pipelinesCount: 4 });

    // Tick 1: gate trips → 0 dispatched.
    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);

    // Drain one SSH task so backlog == threshold - 1. Postgres rejects LIMIT
    // directly on UPDATE; subquery is the standard idiom.
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE id = (
           SELECT id FROM tasks
            WHERE user_id=$1 AND kind='ssh' AND status='pending'
            LIMIT 1
         )`,
      [filler.id],
    );

    // Tick 2: gate clears → CPU dispatch proceeds normally.
    expect(await dispatchCpu(queue)).toBe(4);
  });

  it("does not gate dispatchSsh on SSH backpressure", async () => {
    const cfg = getConfig();
    // Forge threshold-many *running* SSH rows — those count toward the
    // backlog but do NOT consume SSH-lease slots (no lease rows). dispatchSsh
    // must still drain pending SSH work up to GLOBAL_SSH_SLOTS.
    const filler = await createUser(`${PREFIX}-bp-ssh-filler`);
    await makeSshTasksWithStatus(
      filler.id,
      cfg.SSH_BACKPRESSURE_THRESHOLD,
      "running",
    );

    const u = await createUser(`${PREFIX}-bp-ssh-target`);
    await makePendingSshTasks(u.id, 3);

    const queue = new FakeQueue();
    expect(await dispatchSsh(queue)).toBe(3);
  });

  it("does not gate dispatchTraining on SSH backpressure", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-train-filler`);
    await makeSshTasksWithStatus(
      filler.id,
      cfg.SSH_BACKPRESSURE_THRESHOLD,
      "pending",
    );

    const u = await createUser(`${PREFIX}-bp-train-target`);
    const job = await createJob({ userId: u.id, pipelinesCount: 1 });
    await db.query(
      `INSERT INTO tasks (job_id, user_id, kind, status)
         VALUES ($1, $2, 'training', 'pending')`,
      [job.jobId, u.id],
    );

    const queue = new FakeQueue();
    expect(await dispatchTraining(queue)).toBe(1);
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

// Bulk-forge `count` SSH tasks with an arbitrary status. Used by the
// backpressure tests to push the SSH backlog past the threshold cheaply
// (one INSERT per call instead of N). The parent CPU tasks are marked
// succeeded so they don't pollute concurrent dispatchCpu assertions.
async function makeSshTasksWithStatus(
  userId: string,
  count: number,
  status: "pending" | "queued" | "running",
): Promise<void> {
  const job = await createJob({ userId, pipelinesCount: count });
  await db.query(
    `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
       SELECT $1, $2, 'ssh', $3, t.id
         FROM tasks t
        WHERE t.job_id = $1 AND t.kind = 'cpu'`,
    [job.jobId, userId, status],
  );
  await db.query(
    `UPDATE tasks SET status='succeeded'
       WHERE job_id=$1 AND kind='cpu'`,
    [job.jobId],
  );
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

// Forge a queued CPU task with an expired (or about-to-expire) lease, simulating
// a worker that died mid-flight without releasing.
async function makeQueuedCpuWithExpiredLease(
  userId: string,
  opts: { attempts?: number; maxAttempts?: number } = {},
): Promise<{ jobId: string; taskId: string; leaseId: string }> {
  const job = await createJob({ userId, pipelinesCount: 1 });
  const t = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE job_id=$1 LIMIT 1`,
    [job.jobId],
  );
  const taskId = t.rows[0].id;
  await db.query(
    `UPDATE tasks
        SET status='queued', attempts=$2, max_attempts=$3
      WHERE id=$1`,
    [taskId, opts.attempts ?? 0, opts.maxAttempts ?? 3],
  );
  const lease = await db.query<{ id: string }>(
    `INSERT INTO leases (task_id, user_id, resource, expires_at)
       VALUES ($1, $2, 'cpu', now() - interval '1 second')
       RETURNING id`,
    [taskId, userId],
  );
  return { jobId: job.jobId, taskId, leaseId: lease.rows[0].id };
}

describe("reapExpiredLeases", () => {
  it("returns 0 and does nothing when no leases are expired", async () => {
    const u = await createUser(`${PREFIX}-reap-noop`);
    const job = await createJob({ userId: u.id, pipelinesCount: 1 });
    const t = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE job_id=$1 LIMIT 1`,
      [job.jobId],
    );
    await db.query(`UPDATE tasks SET status='queued' WHERE id=$1`, [t.rows[0].id]);
    await db.query(
      `INSERT INTO leases (task_id, user_id, resource, expires_at)
         VALUES ($1, $2, 'cpu', now() + interval '1 minute')`,
      [t.rows[0].id, u.id],
    );

    expect(await reapExpiredLeases()).toBe(0);

    const row = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [t.rows[0].id],
    );
    expect(row.rows[0].status).toBe("queued");
  });

  it("resets a retryable expired task to 'pending' and releases the lease", async () => {
    const u = await createUser(`${PREFIX}-reap-retry`);
    const fx = await makeQueuedCpuWithExpiredLease(u.id, {
      attempts: 1,
      maxAttempts: 3,
    });

    const reaped = await reapExpiredLeases();
    expect(reaped).toBe(1);

    const task = await db.query<{
      status: string;
      attempts: number;
      started_at: Date | null;
    }>(`SELECT status, attempts, started_at FROM tasks WHERE id=$1`, [
      fx.taskId,
    ]);
    expect(task.rows[0].status).toBe("pending");
    // attempts is NOT bumped by the reaper — the next worker's claimTask bumps
    // it. Bumping here would double-count attempts.
    expect(task.rows[0].attempts).toBe(1);
    expect(task.rows[0].started_at).toBeNull();

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).not.toBeNull();
  });

  it("marks a task 'failed' when attempts >= max_attempts and propagates job failure", async () => {
    const u = await createUser(`${PREFIX}-reap-perm-fail`);
    const fx = await makeQueuedCpuWithExpiredLease(u.id, {
      attempts: 3,
      maxAttempts: 3,
    });

    expect(await reapExpiredLeases()).toBe(1);

    const task = await db.query<{
      status: string;
      failure_reason: string | null;
      finished_at: Date | null;
    }>(
      `SELECT status, failure_reason, finished_at FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("failed");
    expect(task.rows[0].failure_reason).toBe("lease_expired");
    expect(task.rows[0].finished_at).not.toBeNull();

    const job = await db.query<{ status: string; completed_at: Date | null }>(
      `SELECT status, completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("failed");
    expect(job.rows[0].completed_at).not.toBeNull();

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).not.toBeNull();
  });

  it("does not touch leases that are already released", async () => {
    const u = await createUser(`${PREFIX}-reap-released`);
    const fx = await makeQueuedCpuWithExpiredLease(u.id);
    await db.query(`UPDATE leases SET released_at=now() WHERE id=$1`, [
      fx.leaseId,
    ]);
    // Task is left in 'queued' on purpose; reaper must not touch it.
    expect(await reapExpiredLeases()).toBe(0);

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("queued");
  });

  it("frees CPU slots — after reap, dispatchCpu can use the freed slot", async () => {
    // Saturate CPU pool with 20 expired leases on permanently-failed tasks.
    // attempts==max_attempts ensures the reaper marks them 'failed' (not
    // 'pending'), so the dispatch count below tests slot recovery cleanly.
    const filler = await createUser(`${PREFIX}-reap-slot`);
    for (let i = 0; i < 20; i++) {
      await makeQueuedCpuWithExpiredLease(filler.id, {
        attempts: 3,
        maxAttempts: 3,
      });
    }

    const u = await createUser(`${PREFIX}-reap-slot-user`);
    await createJob({ userId: u.id, pipelinesCount: 1 });

    // Before reap: no free slots.
    const queueBefore = new FakeQueue();
    expect(await dispatchCpu(queueBefore)).toBe(0);

    await reapExpiredLeases();

    const queueAfter = new FakeQueue();
    expect(await dispatchCpu(queueAfter)).toBe(1);
  });
});
