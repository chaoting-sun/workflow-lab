import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "../lib/db";
import {
  ensureSchema,
  makeQueuedSshTaskWithLease,
  type QueuedTaskFixture,
} from "../lib/test-helpers";
import { createUser } from "../lib/users";
import { runSshTask } from "./ssh";
import type { WorkerTaskMessage } from "../lib/worker";

const PREFIX = `t7-ssh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let scratchDir: string;

function msg(fx: QueuedTaskFixture): WorkerTaskMessage {
  return { taskId: fx.taskId, leaseId: fx.leaseId, attempts: fx.attempts };
}

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  scratchDir = await mkdtemp(join(tmpdir(), "workflow-lab-ssh-"));
  await reset();
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await rm(scratchDir, { recursive: true, force: true });
  await closeDb();
});

// fastWork writes a real file (so fs.access verification passes) without
// the production sleep.
function fastWork(content: string = "ok") {
  return async (taskId: string): Promise<string> => {
    const path = join(scratchDir, `ssh-${taskId}.txt`);
    await writeFile(path, content);
    return path;
  };
}

describe("runSshTask", () => {
  it("happy path (single-pipeline job): succeeded, artifact, lease released, training task created by barrier", async () => {
    const u = await createUser(`${PREFIX}-happy`);
    const fx = await makeQueuedSshTaskWithLease(u.id, 1);

    await runSshTask(msg(fx), fastWork("hello"));

    const task = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(task.rows[0].status).toBe("succeeded");

    const artifact = await db.query<{ path: string }>(
      `SELECT path FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(artifact.rowCount).toBe(1);
    await access(artifact.rows[0].path);
    expect(await readFile(artifact.rows[0].path, "utf-8")).toBe("hello");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).not.toBeNull();

    const training = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE job_id=$1 AND kind='training'`,
      [fx.jobId],
    );
    expect(training.rowCount).toBe(1);
    expect(training.rows[0].status).toBe("pending");
  });

  it("does not create training task when other SSH artifacts in the job are still missing", async () => {
    const u = await createUser(`${PREFIX}-partial`);
    const fx = await makeQueuedSshTaskWithLease(u.id, 3); // 3-pipeline job, this is 1 of 3

    await runSshTask(msg(fx), fastWork());

    const training = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [fx.jobId],
    );
    expect(training.rows[0].count).toBe("0");
  });

  it("silently aborts when message is stale (attempts mismatch)", async () => {
    const u = await createUser(`${PREFIX}-stale`);
    const fx = await makeQueuedSshTaskWithLease(u.id, 1);

    await runSshTask(
      { taskId: fx.taskId, leaseId: fx.leaseId, attempts: fx.attempts + 5 },
      fastWork(),
    );

    const t = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).toBe("queued");
    expect(t.rows[0].attempts).toBe(fx.attempts);

    const a = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(a.rows[0].count).toBe("0");

    const train = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [fx.jobId],
    );
    expect(train.rows[0].count).toBe("0");
  });

  it("optimistic-lock: attempts bumped mid-flight → no artifact, lease still active, no training task", async () => {
    const u = await createUser(`${PREFIX}-opt-lock`);
    const fx = await makeQueuedSshTaskWithLease(u.id, 1);

    const racingWork = async (taskId: string): Promise<string> => {
      await db.query(`UPDATE tasks SET attempts=attempts+1 WHERE id=$1`, [taskId]);
      const path = join(scratchDir, `ssh-${taskId}.txt`);
      await writeFile(path, "raced");
      return path;
    };

    await runSshTask(msg(fx), racingWork);

    const t = await db.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1`,
      [fx.taskId],
    );
    expect(t.rows[0].status).not.toBe("succeeded");

    const a = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(a.rows[0].count).toBe("0");

    const lease = await db.query<{ released_at: Date | null }>(
      `SELECT released_at FROM leases WHERE id=$1`,
      [fx.leaseId],
    );
    expect(lease.rows[0].released_at).toBeNull();

    const train = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [fx.jobId],
    );
    expect(train.rows[0].count).toBe("0");
  });

  it("duplicate delivery is a no-op the second time and barrier fires once", async () => {
    const u = await createUser(`${PREFIX}-dup`);
    const fx = await makeQueuedSshTaskWithLease(u.id, 1);

    await runSshTask(msg(fx), fastWork());
    await runSshTask(msg(fx), fastWork());

    const a = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1`,
      [fx.taskId],
    );
    expect(a.rows[0].count).toBe("1");

    const train = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tasks WHERE job_id=$1 AND kind='training'`,
      [fx.jobId],
    );
    expect(train.rows[0].count).toBe("1");
  });
});
