import { z } from "zod";
import { db } from "./db";
import type { User, UserView } from "./types";

export type { User };

const nameSchema = z.string().trim().min(1).max(120);

export async function createUser(name: string): Promise<User> {
  const parsed = nameSchema.parse(name);
  const { rows } = await db.query<User>(
    `INSERT INTO users (name) VALUES ($1) RETURNING id, name`,
    [parsed],
  );
  return rows[0];
}

interface UserViewRow {
  id: string;
  name: string;
  running_cpu: string;
  running_ssh: string;
  running_training: string;
}

// "Active lease" = lease_token IS NOT NULL AND lease_expires_at > now() —
// matches the SPEC §3.3 fairness predicate and is covered by the partial
// index `tasks_kind_user_active_lease_idx`.
export async function listUsers(): Promise<UserView[]> {
  const { rows } = await db.query<UserViewRow>(
    `SELECT u.id,
            u.name,
            COALESCE(SUM(CASE WHEN t.kind='cpu'      THEN 1 ELSE 0 END), 0)::text AS running_cpu,
            COALESCE(SUM(CASE WHEN t.kind='ssh'      THEN 1 ELSE 0 END), 0)::text AS running_ssh,
            COALESCE(SUM(CASE WHEN t.kind='training' THEN 1 ELSE 0 END), 0)::text AS running_training
       FROM users u
       LEFT JOIN tasks t
         ON t.user_id = u.id
        AND t.lease_token IS NOT NULL
        AND t.lease_expires_at > now()
      GROUP BY u.id, u.name, u.created_at
      ORDER BY u.created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    runningCpu: Number(r.running_cpu),
    runningSsh: Number(r.running_ssh),
    runningTraining: Number(r.running_training),
  }));
}
