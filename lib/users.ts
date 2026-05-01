import { z } from "zod";
import { db } from "./db";

export interface User {
  id: string;
  name: string;
}

const nameSchema = z.string().trim().min(1).max(120);

export async function createUser(name: string): Promise<User> {
  const parsed = nameSchema.parse(name);
  const { rows } = await db.query<User>(
    `INSERT INTO users (name) VALUES ($1) RETURNING id, name`,
    [parsed],
  );
  return rows[0];
}

export async function listUsers(): Promise<User[]> {
  const { rows } = await db.query<User>(
    `SELECT id, name FROM users ORDER BY created_at ASC`,
  );
  return rows;
}
