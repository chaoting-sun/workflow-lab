import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { ensureSchema } from "@/lib/test-helpers";
import { POST, GET } from "@/app/api/users/route";
import type { UserView } from "@/lib/types";

const PREFIX = `t4-route-users-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function cleanup(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await closeDb();
});

function jsonReq(body: unknown): Request {
  return new Request("http://test/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/users", () => {
  it("returns 201 with {id, name} on success", async () => {
    const res = await POST(jsonReq({ name: `${PREFIX}-alice` }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe(`${PREFIX}-alice`);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 400 on invalid body (missing name)", async () => {
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty name", async () => {
    const res = await POST(jsonReq({ name: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate name", async () => {
    await POST(jsonReq({ name: `${PREFIX}-dup` }));
    const res = await POST(jsonReq({ name: `${PREFIX}-dup` }));
    expect(res.status).toBe(409);
  });
});

describe("GET /api/users", () => {
  it("returns 200 with an array including created users", async () => {
    await POST(jsonReq({ name: `${PREFIX}-bob` }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(body.map((u) => u.name)).toEqual(
      expect.arrayContaining([`${PREFIX}-bob`]),
    );
  });

  it("returns numeric runningCpu/runningSsh/runningTraining for each user", async () => {
    await POST(jsonReq({ name: `${PREFIX}-eve` }));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserView[];
    const eve = body.find((u) => u.name === `${PREFIX}-eve`);
    expect(eve).toBeDefined();
    expect(eve!.runningCpu).toBe(0);
    expect(eve!.runningSsh).toBe(0);
    expect(eve!.runningTraining).toBe(0);
  });
});
