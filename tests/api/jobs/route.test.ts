import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { ensureSchema } from "@/lib/test-helpers";
import { createUser } from "@/lib/users";
import { POST, GET } from "@/app/api/jobs/route";

const PREFIX = `t4-route-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let userId: string;

async function cleanup(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await cleanup();
  userId = (await createUser(`${PREFIX}-user`)).id;
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

function jsonReq(body: unknown): Request {
  return new Request("http://test/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function listReq(query = ""): Request {
  return new Request(`http://test/api/jobs${query}`, { method: "GET" });
}

describe("POST /api/jobs", () => {
  it("creates a job and returns 201 with {jobId,status,pipelinesCount}", async () => {
    const res = await POST(jsonReq({ userId }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      jobId: string;
      status: string;
      pipelinesCount: number;
    };
    expect(body.status).toBe("pending");
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    // From .env.example default: PIPELINES_PER_JOB=200
    expect(body.pipelinesCount).toBe(200);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1`,
      [body.jobId],
    );
    expect(rows[0].count).toBe("200");
  });

  it("returns 404 for unknown userId, no job inserted", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs`,
    );
    const res = await POST(jsonReq({ userId: fake }));
    expect(res.status).toBe(404);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs`,
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("returns 400 on invalid body (missing userId)", async () => {
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-uuid userId", async () => {
    const res = await POST(jsonReq({ userId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs", () => {
  it("returns 200 with a list filtered by userId", async () => {
    const res = await GET(listReq(`?userId=${userId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; userId: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((j) => j.userId === userId)).toBe(true);
  });

  it("returns 400 on invalid userId in query", async () => {
    const res = await GET(listReq("?userId=bogus"));
    expect(res.status).toBe(400);
  });
});
