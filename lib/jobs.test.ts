import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
import { createUser } from "./users";
import {
  createJob,
  failJob,
  getJob,
  listJobs,
  UserNotFoundError,
  InvalidPipelinesCountError,
} from "./jobs";

const PREFIX = `t4-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let userA: string;
let userB: string;

async function cleanup(): Promise<void> {
  // tasks/jobs cascade from users; deleting users is enough.
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await cleanup();
  userA = (await createUser(`${PREFIX}-alice`)).id;
  userB = (await createUser(`${PREFIX}-bob`)).id;
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe("createJob", () => {
  it("inserts a job in 'pending' state with the given pipelinesCount", async () => {
    const res = await createJob({ userId: userA, pipelinesCount: 5 });
    expect(res.status).toBe("pending");
    expect(res.pipelinesCount).toBe(5);
    expect(res.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await db.query<{
      user_id: string;
      status: string;
      pipelines_count: number;
    }>(`SELECT user_id, status, pipelines_count FROM jobs WHERE id = $1`, [
      res.jobId,
    ]);
    expect(rows[0]).toMatchObject({
      user_id: userA,
      status: "pending",
      pipelines_count: 5,
    });
  });

  it("inserts exactly N pending CPU tasks atomically", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 7 });

    const { rows } = await db.query<{
      kind: string;
      status: string;
      count: string;
    }>(
      `SELECT kind, status, count(*)::text AS count
         FROM tasks WHERE job_id = $1 GROUP BY kind, status`,
      [jobId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "cpu",
      status: "pending",
      count: "7",
    });
  });

  it("rolls back when userId does not exist (no orphan job/tasks)", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs`,
    );

    await expect(
      createJob({ userId: fakeUuid, pipelinesCount: 3 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs`,
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);

    const orphans = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks
         WHERE job_id NOT IN (SELECT id FROM jobs)`,
    );
    expect(orphans.rows[0].count).toBe("0");
  });

  it("rejects pipelinesCount = 0 with InvalidPipelinesCountError", async () => {
    await expect(
      createJob({ userId: userA, pipelinesCount: 0 }),
    ).rejects.toBeInstanceOf(InvalidPipelinesCountError);
  });

  it("rejects pipelinesCount = 1001", async () => {
    await expect(
      createJob({ userId: userA, pipelinesCount: 1001 }),
    ).rejects.toBeInstanceOf(InvalidPipelinesCountError);
  });

  it("accepts pipelinesCount at 1 and 1000 boundaries", async () => {
    await expect(
      createJob({ userId: userA, pipelinesCount: 1 }),
    ).resolves.toMatchObject({ pipelinesCount: 1 });
    await expect(
      createJob({ userId: userA, pipelinesCount: 1000 }),
    ).resolves.toMatchObject({ pipelinesCount: 1000 });
  });
});

describe("getJob", () => {
  it("returns null for an unknown job id", async () => {
    expect(await getJob("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns progress with totals derived from pipelines_count", async () => {
    const { jobId } = await createJob({ userId: userB, pipelinesCount: 4 });
    const job = await getJob(jobId);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.userId).toBe(userB);
    expect(job!.status).toBe("pending");
    expect(job!.pipelinesCount).toBe(4);
    expect(job!.progress).toEqual({
      cpu: { done: 0, total: 4, failed: 0 },
      ssh: { done: 0, total: 4, failed: 0 },
      training: { done: 0, total: 1, failed: 0 },
    });
  });

  it("counts succeeded and failed tasks per kind", async () => {
    const { jobId } = await createJob({ userId: userB, pipelinesCount: 3 });

    // Mark 2 CPU succeeded, 1 CPU failed.
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE id IN (
           SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' LIMIT 2
         )`,
      [jobId],
    );
    await db.query(
      `UPDATE tasks SET status='failed'
         WHERE id IN (
           SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' AND status='pending' LIMIT 1
         )`,
      [jobId],
    );
    // Insert an SSH task in 'succeeded' so ssh.done > 0.
    await db.query(
      `INSERT INTO tasks (job_id, user_id, kind, status)
         VALUES ($1, $2, 'ssh', 'succeeded')`,
      [jobId, userB],
    );

    const job = await getJob(jobId);
    expect(job!.progress).toEqual({
      cpu: { done: 2, total: 3, failed: 1 },
      ssh: { done: 1, total: 3, failed: 0 },
      training: { done: 0, total: 1, failed: 0 },
    });
  });
});

describe("failJob", () => {
  it("marks a 'pending' job as 'failed' with completed_at set", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 1 });
    await failJob(db, jobId);

    const { rows } = await db.query<{
      status: string;
      completed_at: Date | null;
    }>(`SELECT status, completed_at FROM jobs WHERE id=$1`, [jobId]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].completed_at).not.toBeNull();
  });

  it("marks a 'running' job as 'failed'", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 1 });
    await db.query(`UPDATE jobs SET status='running' WHERE id=$1`, [jobId]);
    await failJob(db, jobId);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [jobId],
    );
    expect(rows[0].status).toBe("failed");
  });

  it("does not overwrite 'completed' status", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 1 });
    await db.query(
      `UPDATE jobs SET status='completed', completed_at=now() WHERE id=$1`,
      [jobId],
    );
    await failJob(db, jobId);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id=$1`,
      [jobId],
    );
    expect(rows[0].status).toBe("completed");
  });

  it("is idempotent on an already-failed job (no completed_at clobber)", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 1 });
    await failJob(db, jobId);
    const first = await db.query<{ completed_at: Date }>(
      `SELECT completed_at FROM jobs WHERE id=$1`,
      [jobId],
    );

    await failJob(db, jobId);
    const second = await db.query<{ completed_at: Date }>(
      `SELECT completed_at FROM jobs WHERE id=$1`,
      [jobId],
    );
    expect(second.rows[0].completed_at.getTime()).toBe(
      first.rows[0].completed_at.getTime(),
    );
  });
});

describe("listJobs", () => {
  it("filters by userId when provided", async () => {
    const a = await createJob({ userId: userA, pipelinesCount: 2 });
    const b = await createJob({ userId: userB, pipelinesCount: 2 });

    const onlyA = await listJobs({ userId: userA });
    const ids = onlyA.map((j) => j.id);
    expect(ids).toContain(a.jobId);
    expect(ids).not.toContain(b.jobId);
  });

  it("returns progress on each job in the list", async () => {
    const { jobId } = await createJob({ userId: userA, pipelinesCount: 6 });
    const list = await listJobs({ userId: userA });
    const found = list.find((j) => j.id === jobId);
    expect(found).toBeDefined();
    expect(found!.progress.cpu.total).toBe(6);
    expect(found!.progress.ssh.total).toBe(6);
    expect(found!.progress.training.total).toBe(1);
  });
});
