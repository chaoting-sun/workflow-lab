import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import {
  ensureSchema,
  makeQueuedCpuTaskWithLease,
  makeQueuedSshTaskWithLease,
} from "./test-helpers";
import { createUser, listUsers } from "./users";

const NAME_PREFIX = `t4-users-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const name = (suffix: string) => `${NAME_PREFIX}-${suffix}`;

beforeAll(async () => {
  await ensureSchema();
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
});

afterAll(async () => {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
  await closeDb();
});

describe("createUser", () => {
  it("inserts a user and returns its id and name", async () => {
    const u = await createUser(name("alice"));
    expect(u.name).toBe(name("alice"));
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`,
      [u.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(name("alice"));
  });

  it("rejects an empty name", async () => {
    await expect(createUser("")).rejects.toThrow();
  });

  it("rejects a duplicate name", async () => {
    await createUser(name("dup"));
    await expect(createUser(name("dup"))).rejects.toThrow();
  });
});

describe("listUsers", () => {
  it("includes created users", async () => {
    await createUser(name("bob"));
    const users = await listUsers();
    const names = users.map((u) => u.name);
    expect(names).toEqual(expect.arrayContaining([name("bob")]));
  });

  it("returns zero running counts for a user with no tasks", async () => {
    const carol = await createUser(name("carol"));
    const users = await listUsers();
    const row = users.find((u) => u.id === carol.id);
    expect(row).toBeDefined();
    expect(row!.runningCpu).toBe(0);
    expect(row!.runningSsh).toBe(0);
    expect(row!.runningTraining).toBe(0);
  });

  it("counts only tasks with an active (unexpired) lease, grouped by kind", async () => {
    const dan = await createUser(name("dan"));
    const cpu = await makeQueuedCpuTaskWithLease(dan.id);
    await makeQueuedSshTaskWithLease(dan.id);

    await db.query(
      `INSERT INTO tasks (job_id, user_id, kind, status,
                          lease_token, lease_expires_at, lease_heartbeat_at)
       VALUES ($1, $2, 'training', 'queued',
               gen_random_uuid(), now() - interval '1 second', now() - interval '5 seconds')`,
      [cpu.jobId, dan.id],
    );

    const users = await listUsers();
    const row = users.find((u) => u.id === dan.id);
    expect(row).toBeDefined();
    expect(row!.runningCpu).toBe(1);
    expect(row!.runningSsh).toBe(1);
    expect(row!.runningTraining).toBe(0);
  });
});
