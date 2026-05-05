import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema, makeQueuedCpuTaskWithExpiredLease } from "./test-helpers";
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
  // Cascades wipe jobs/tasks/artifacts.
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
  await db.query(
    `UPDATE tasks
        SET status='running',
            lease_token=gen_random_uuid(),
            lease_expires_at=now() + interval '1 minute',
            lease_heartbeat_at=now()
      WHERE job_id=$1`,
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

  it("sets lease_token, lease_expires_at, and status='queued' on each dispatched task", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);

    expect(queue.messages).toHaveLength(3);
    for (const msg of queue.messages) {
      const task = await db.query<{
        status: string;
        lease_token: string | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, lease_token, lease_expires_at FROM tasks WHERE id=$1`,
        [msg.taskId],
      );
      expect(task.rows[0].status).toBe("queued");
      expect(task.rows[0].lease_token).toBe(msg.leaseToken);
      expect(task.rows[0].lease_expires_at).not.toBeNull();
      expect(task.rows[0].lease_expires_at!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("enqueues {taskId, leaseToken, attempts} matching the DB rows", async () => {
    const u = await createUser(`${PREFIX}-u`);
    await createJob({ userId: u.id, pipelinesCount: 1 });

    const queue = new FakeQueue();
    await dispatchCpu(queue);

    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0];

    const task = await db.query<{
      attempts: number;
      lease_token: string;
    }>(
      `SELECT attempts, lease_token FROM tasks WHERE id=$1`,
      [msg.taskId],
    );
    expect(task.rows[0].attempts).toBe(msg.attempts);
    expect(task.rows[0].lease_token).toBe(msg.leaseToken);
  });

  it("orders dispatch by (running_cpu_count ASC, jobs.created_at ASC, tasks.created_at ASC)", async () => {
    // Alice has 1 active CPU lease (running_cpu_count = 1).
    // Bob has 0 active CPU leases (running_cpu_count = 0).
    // Both have 1 pending CPU task. Bob's must be dispatched first.
    const alice = await createUser(`${PREFIX}-alice`);
    const aliceJob = await createJob({ userId: alice.id, pipelinesCount: 2 });
    await db.query(
      `UPDATE tasks
          SET status='running',
              lease_token=gen_random_uuid(),
              lease_expires_at=now() + interval '1 minute',
              lease_heartbeat_at=now()
        WHERE id = (SELECT id FROM tasks WHERE job_id=$1 LIMIT 1)`,
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

    const task = await db.query<{
      status: string;
      lease_token: string | null;
    }>(
      `SELECT status, lease_token FROM tasks WHERE user_id=$1`,
      [u.id],
    );
    expect(task.rows[0].status).toBe("queued");
    expect(task.rows[0].lease_token).not.toBeNull();
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

describe("dispatchCpu — SSH backpressure", () => {
  it("skips CPU dispatch when SSH backlog >= SSH_BACKPRESSURE_THRESHOLD", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-filler`);
    await makeSshTasks(filler.id, cfg.SSH_BACKPRESSURE_THRESHOLD, {
      succeedParents: true,
    });

    const u = await createUser(`${PREFIX}-bp-cpu`);
    await createJob({ userId: u.id, pipelinesCount: 5 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);
    expect(queue.messages).toEqual([]);

    const queued = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tasks WHERE user_id=$1 AND status='queued'`,
      [u.id],
    );
    expect(queued.rows[0].count).toBe("0");
    const leased = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tasks WHERE user_id=$1 AND lease_token IS NOT NULL`,
      [u.id],
    );
    expect(leased.rows[0].count).toBe("0");
  });

  it("counts pending, queued, and running SSH tasks toward the backlog", async () => {
    const cfg = getConfig();
    const t = cfg.SSH_BACKPRESSURE_THRESHOLD;
    const a = Math.floor(t / 3);
    const b = Math.floor(t / 3);
    const c = t - a - b;

    const u1 = await createUser(`${PREFIX}-bp-pending`);
    await makeSshTasks(u1.id, a, { status: "pending", succeedParents: true });
    const u2 = await createUser(`${PREFIX}-bp-queued`);
    await makeSshTasks(u2.id, b, { status: "queued", succeedParents: true });
    const u3 = await createUser(`${PREFIX}-bp-running`);
    await makeSshTasks(u3.id, c, { status: "running", succeedParents: true });

    const target = await createUser(`${PREFIX}-bp-target`);
    await createJob({ userId: target.id, pipelinesCount: 3 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);
  });

  it("does not count succeeded or failed SSH tasks toward the backlog", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-terminal`);
    await makeSshTasks(filler.id, cfg.SSH_BACKPRESSURE_THRESHOLD, {
      succeedParents: true,
    });
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
    await makeSshTasks(filler.id, cfg.SSH_BACKPRESSURE_THRESHOLD, {
      succeedParents: true,
    });

    const u = await createUser(`${PREFIX}-bp-resume`);
    await createJob({ userId: u.id, pipelinesCount: 4 });

    const queue = new FakeQueue();
    expect(await dispatchCpu(queue)).toBe(0);

    // Postgres rejects LIMIT directly on UPDATE; subquery is the standard idiom.
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE id = (
           SELECT id FROM tasks
            WHERE user_id=$1 AND kind='ssh' AND status='pending'
            LIMIT 1
         )`,
      [filler.id],
    );

    expect(await dispatchCpu(queue)).toBe(4);
  });

  it("does not gate dispatchSsh on SSH backpressure", async () => {
    // SSH rows in 'running' status without an active lease (lease_token NULL)
    // count toward the backlog but consume no SSH-lease slots, so dispatchSsh
    // can still drain pending SSH work.
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-ssh-filler`);
    await makeSshTasks(filler.id, cfg.SSH_BACKPRESSURE_THRESHOLD, {
      status: "running",
      succeedParents: true,
    });

    const u = await createUser(`${PREFIX}-bp-ssh-target`);
    await makeSshTasks(u.id, 3);

    const queue = new FakeQueue();
    expect(await dispatchSsh(queue)).toBe(3);
  });

  it("does not gate dispatchTraining on SSH backpressure", async () => {
    const cfg = getConfig();
    const filler = await createUser(`${PREFIX}-bp-train-filler`);
    await makeSshTasks(filler.id, cfg.SSH_BACKPRESSURE_THRESHOLD, {
      succeedParents: true,
    });

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

// Forge `count` SSH tasks under one user (sharing a job), each parented to a
// CPU sibling. Parents stay pending by default so dispatchSsh tests can
// assert on CPU state; succeedParents=true clears them out for tests that
// run dispatchCpu against an isolated target user.
async function makeSshTasks(
  userId: string,
  count: number,
  opts: {
    status?: "pending" | "queued" | "running";
    succeedParents?: boolean;
  } = {},
): Promise<string> {
  const status = opts.status ?? "pending";
  const job = await createJob({ userId, pipelinesCount: count });
  await db.query(
    `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
       SELECT $1, $2, 'ssh', $3, t.id
         FROM tasks t
        WHERE t.job_id = $1 AND t.kind = 'cpu'`,
    [job.jobId, userId, status],
  );
  if (opts.succeedParents) {
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE job_id=$1 AND kind='cpu'`,
      [job.jobId],
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

  it("dispatches all pending SSH tasks under the GLOBAL_SSH_SLOTS cap, marks them queued with a lease_token", async () => {
    const u = await createUser(`${PREFIX}-ssh-u`);
    const jobId = await makeSshTasks(u.id, 3);

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
      const t = await db.query<{ lease_token: string | null }>(
        `SELECT lease_token FROM tasks WHERE id=$1`,
        [m.taskId],
      );
      expect(t.rows[0].lease_token).toBe(m.leaseToken);
    }
  });

  it("uses SSH-kind active leases when computing free slots, not CPU leases", async () => {
    // Saturate CPU resource pool: with 20 CPU leases active, dispatchCpu would
    // refuse, but dispatchSsh must be unaffected.
    const filler = await createUser(`${PREFIX}-ssh-cpu-filler`);
    await fillActiveCpuLeases(filler.id, 20);

    const u = await createUser(`${PREFIX}-ssh-u2`);
    await makeSshTasks(u.id, 2);

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

  it("dispatches pending training tasks, marks them queued with a lease_token", async () => {
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
      const t = await db.query<{ lease_token: string | null }>(
        `SELECT lease_token FROM tasks WHERE id=$1`,
        [m.taskId],
      );
      expect(t.rows[0].lease_token).toBe(m.leaseToken);
    }
  });

  it("uses TRAINING-kind active leases when computing free slots, not CPU leases", async () => {
    const filler = await createUser(`${PREFIX}-train-cpu-filler`);
    await fillActiveCpuLeases(filler.id, 20);

    const u = await createUser(`${PREFIX}-train-u2`);
    await makePendingTrainingTask(u.id);

    const queue = new FakeQueue();
    const n = await dispatchTraining(queue);
    expect(n).toBe(1);
  });
});

describe("reapExpiredLeases", () => {
  it("returns 0 and does nothing when no leases are expired", async () => {
    const u = await createUser(`${PREFIX}-reap-noop`);
    const job = await createJob({ userId: u.id, pipelinesCount: 1 });
    const t = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE job_id=$1 LIMIT 1`,
      [job.jobId],
    );
    await db.query(
      `UPDATE tasks
          SET status='queued',
              lease_token=gen_random_uuid(),
              lease_expires_at=now() + interval '1 minute',
              lease_heartbeat_at=now()
        WHERE id=$1`,
      [t.rows[0].id],
    );

    expect(await reapExpiredLeases()).toBe(0);

    const row = await db.query<{ status: string; lease_token: string | null }>(
      `SELECT status, lease_token FROM tasks WHERE id=$1`,
      [t.rows[0].id],
    );
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].lease_token).not.toBeNull();
  });

  it("resets a retryable expired task to 'pending' and clears the lease columns", async () => {
    const u = await createUser(`${PREFIX}-reap-retry`);
    const fx = await makeQueuedCpuTaskWithExpiredLease(u.id, {
      attempts: 1,
      maxAttempts: 3,
    });

    const reaped = await reapExpiredLeases();
    expect(reaped).toBe(1);

    const task = await db.query<{
      status: string;
      attempts: number;
      started_at: Date | null;
      lease_token: string | null;
      lease_expires_at: Date | null;
      lease_heartbeat_at: Date | null;
    }>(
      `SELECT status, attempts, started_at, lease_token, lease_expires_at, lease_heartbeat_at
         FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("pending");
    // attempts is NOT bumped by the reaper — the next worker's claimTask bumps
    // it. Bumping here would double-count attempts.
    expect(task.rows[0].attempts).toBe(1);
    expect(task.rows[0].started_at).toBeNull();
    expect(task.rows[0].lease_token).toBeNull();
    expect(task.rows[0].lease_expires_at).toBeNull();
    expect(task.rows[0].lease_heartbeat_at).toBeNull();
  });

  it("marks a task 'failed' when attempts >= max_attempts and propagates job failure", async () => {
    const u = await createUser(`${PREFIX}-reap-perm-fail`);
    const fx = await makeQueuedCpuTaskWithExpiredLease(u.id, {
      attempts: 3,
      maxAttempts: 3,
    });

    expect(await reapExpiredLeases()).toBe(1);

    const task = await db.query<{
      status: string;
      failure_reason: string | null;
      finished_at: Date | null;
      lease_token: string | null;
    }>(
      `SELECT status, failure_reason, finished_at, lease_token FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("failed");
    expect(task.rows[0].failure_reason).toBe("lease_expired");
    expect(task.rows[0].finished_at).not.toBeNull();
    expect(task.rows[0].lease_token).toBeNull();

    const job = await db.query<{ status: string; completed_at: Date | null }>(
      `SELECT status, completed_at FROM jobs WHERE id=$1`,
      [fx.jobId],
    );
    expect(job.rows[0].status).toBe("failed");
    expect(job.rows[0].completed_at).not.toBeNull();
  });

  it("does not touch tasks whose lease has already been released", async () => {
    const u = await createUser(`${PREFIX}-reap-released`);
    const fx = await makeQueuedCpuTaskWithExpiredLease(u.id);
    // Simulate finalize having released the lease (lease columns cleared).
    // Status is left in 'queued' on purpose; reaper must not touch it because
    // there is no expired lease_expires_at to detect.
    await db.query(
      `UPDATE tasks
          SET lease_token=NULL, lease_expires_at=NULL, lease_heartbeat_at=NULL
        WHERE id=$1`,
      [fx.taskId],
    );
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
      await makeQueuedCpuTaskWithExpiredLease(filler.id, {
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
