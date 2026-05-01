import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
import { createUser } from "./users";
import { createJob } from "./jobs";
import { runBarrierCheck } from "./barrier";

const PREFIX = `t7-barrier-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

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

// Forges a job whose first `succeededSshCount` CPU pipelines have already
// produced succeeded SSH tasks with on-row artifacts. The remaining pipelines
// are CPU-only so the barrier sees a job_id with a known artifact count.
async function makeJobWithSshArtifacts(
  userId: string,
  pipelinesCount: number,
  succeededSshCount: number,
): Promise<{ jobId: string }> {
  const { jobId } = await createJob({ userId, pipelinesCount });
  const cpus = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' ORDER BY created_at`,
    [jobId],
  );
  for (let i = 0; i < succeededSshCount; i++) {
    const ssh = await db.query<{ id: string }>(
      `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
         VALUES ($1, $2, 'ssh', 'succeeded', $3)
         RETURNING id`,
      [jobId, userId, cpus.rows[i].id],
    );
    await db.query(
      `INSERT INTO artifacts (task_id, path) VALUES ($1, $2)`,
      [ssh.rows[0].id, `/tmp/ssh-${ssh.rows[0].id}.txt`],
    );
  }
  return { jobId };
}

describe("runBarrierCheck", () => {
  it("does not insert training task when artifact count < pipelines_count", async () => {
    const u = await createUser(`${PREFIX}-partial`);
    const { jobId } = await makeJobWithSshArtifacts(u.id, 3, 2);

    await db.tx(async (tx) => {
      await runBarrierCheck(tx, jobId);
    });

    const t = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [jobId],
    );
    expect(t.rows[0].count).toBe("0");
  });

  it("inserts exactly one pending training task when artifact count == pipelines_count", async () => {
    const u = await createUser(`${PREFIX}-full`);
    const { jobId } = await makeJobWithSshArtifacts(u.id, 3, 3);

    await db.tx(async (tx) => {
      await runBarrierCheck(tx, jobId);
    });

    const t = await db.query<{ id: string; status: string; user_id: string }>(
      `SELECT id, status, user_id FROM tasks WHERE job_id=$1 AND kind='training'`,
      [jobId],
    );
    expect(t.rowCount).toBe(1);
    expect(t.rows[0].status).toBe("pending");
    expect(t.rows[0].user_id).toBe(u.id);
  });

  it("does not duplicate training task when called repeatedly after the barrier opens", async () => {
    const u = await createUser(`${PREFIX}-idem`);
    const { jobId } = await makeJobWithSshArtifacts(u.id, 2, 2);

    await db.tx(async (tx) => {
      await runBarrierCheck(tx, jobId);
    });
    await db.tx(async (tx) => {
      await runBarrierCheck(tx, jobId);
    });

    const t = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [jobId],
    );
    expect(t.rows[0].count).toBe("1");
  });

  it("under concurrent finishers, only one training task is created", async () => {
    const u = await createUser(`${PREFIX}-race`);
    const { jobId } = await makeJobWithSshArtifacts(u.id, 5, 5);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.tx(async (tx) => {
          await runBarrierCheck(tx, jobId);
        }),
      ),
    );

    const t = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [jobId],
    );
    expect(t.rows[0].count).toBe("1");
  });
});
