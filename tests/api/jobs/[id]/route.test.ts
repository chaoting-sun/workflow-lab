import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { ensureSchema } from "@/lib/test-helpers";
import { createUser } from "@/lib/users";
import { createJob } from "@/lib/jobs";
import { GET } from "@/app/api/jobs/[id]/route";

const PREFIX = `t4-route-jobid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let userId: string;
let jobId: string;

async function cleanup(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await cleanup();
  userId = (await createUser(`${PREFIX}-user`)).id;
  jobId = (await createJob({ userId, pipelinesCount: 4 })).jobId;
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/:id", () => {
  it("returns 200 with job + progress", async () => {
    const res = await GET(new Request(`http://test/api/jobs/${jobId}`), ctx(jobId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      userId: string;
      status: string;
      pipelinesCount: number;
      progress: {
        cpu: { done: number; total: number; failed: number };
        ssh: { done: number; total: number; failed: number };
        training: { done: number; total: number; failed: number };
      };
    };
    expect(body.id).toBe(jobId);
    expect(body.userId).toBe(userId);
    expect(body.status).toBe("pending");
    expect(body.pipelinesCount).toBe(4);
    expect(body.progress.cpu).toEqual({ done: 0, total: 4, failed: 0 });
    expect(body.progress.ssh).toEqual({ done: 0, total: 4, failed: 0 });
    expect(body.progress.training).toEqual({ done: 0, total: 1, failed: 0 });
  });

  it("returns 404 for an unknown job id", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    const res = await GET(new Request(`http://test/api/jobs/${fake}`), ctx(fake));
    expect(res.status).toBe(404);
  });

  it("returns 400 on a non-uuid id", async () => {
    const res = await GET(new Request("http://test/api/jobs/bogus"), ctx("bogus"));
    expect(res.status).toBe(400);
  });

  it("reflects succeeded and failed cpu task counts in the progress buckets", async () => {
    // Set up a second job we can mutate without disturbing the happy-path test.
    // Only cpu tasks exist at creation time — ssh/training rows are inserted
    // later by the worker pipeline, so we can only exercise cpu progress here.
    const job = await createJob({ userId, pipelinesCount: 3 });
    await db.query(
      `UPDATE tasks SET status='succeeded'
         WHERE id IN (SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' LIMIT 2)`,
      [job.jobId],
    );
    await db.query(
      `UPDATE tasks SET status='failed'
         WHERE id IN (
           SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' AND status='pending' LIMIT 1
         )`,
      [job.jobId],
    );

    const res = await GET(
      new Request(`http://test/api/jobs/${job.jobId}`),
      ctx(job.jobId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      progress: {
        cpu: { done: number; total: number; failed: number };
        ssh: { done: number; total: number; failed: number };
        training: { done: number; total: number; failed: number };
      };
    };
    expect(body.progress.cpu).toEqual({ done: 2, total: 3, failed: 1 });
    // ssh / training totals are derived from pipelinesCount, not actual row
    // counts, so they remain at their initial shape even with no rows present.
    expect(body.progress.ssh).toEqual({ done: 0, total: 3, failed: 0 });
    expect(body.progress.training).toEqual({ done: 0, total: 1, failed: 0 });
  });

  it("surfaces the job status field when the job has been transitioned", async () => {
    const job = await createJob({ userId, pipelinesCount: 2 });
    await db.query(
      `UPDATE jobs SET status='failed', completed_at=now() WHERE id=$1`,
      [job.jobId],
    );

    const res = await GET(
      new Request(`http://test/api/jobs/${job.jobId}`),
      ctx(job.jobId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completedAt: string | null };
    expect(body.status).toBe("failed");
    expect(body.completedAt).not.toBeNull();
  });
});
