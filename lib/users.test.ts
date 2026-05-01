import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
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
});
