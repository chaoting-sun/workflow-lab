import { Client } from "pg";
import { getConfig } from "./config";

const SCHEDULER_LOCK_KEY_SQL = "hashtext('workflow-lab:scheduler')";

export interface SchedulerLockHandle {
  release: () => Promise<void>;
}

// Swallow client.end() errors on cleanup paths: the connection may already be
// torn down (server-side disconnect, prior query failure), and Postgres
// releases advisory locks on session end regardless.
async function safeEnd(client: Client): Promise<void> {
  await client.end().catch(() => {});
}

// The lock must live on a dedicated, long-lived connection — not a pooled one.
// Pool churn would close the connection and silently release the advisory lock.
export async function acquireSchedulerLock(): Promise<SchedulerLockHandle | null> {
  const client = new Client({ connectionString: getConfig().DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_KEY_SQL}) AS acquired`,
    );
    if (rows[0]?.acquired !== true) {
      await safeEnd(client);
      return null;
    }
  } catch (err) {
    await safeEnd(client);
    throw err;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query(`SELECT pg_advisory_unlock(${SCHEDULER_LOCK_KEY_SQL})`);
      } catch {
        // Closing the connection releases the lock regardless.
      } finally {
        await safeEnd(client);
      }
    },
  };
}
