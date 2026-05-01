import { db } from "./db";
import type {
  JobProgress,
  JobStatus,
  JobView,
  TaskKind,
  TaskStatus,
} from "./types";

const MIN_PIPELINES = 1;
const MAX_PIPELINES = 1000;

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`user not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class InvalidPipelinesCountError extends Error {
  constructor(value: unknown) {
    super(
      `pipelinesCount must be an integer in [${MIN_PIPELINES}, ${MAX_PIPELINES}] (got ${String(value)})`,
    );
    this.name = "InvalidPipelinesCountError";
  }
}

export interface CreateJobInput {
  userId: string;
  pipelinesCount: number;
}

export interface CreateJobResult {
  jobId: string;
  status: "pending";
  pipelinesCount: number;
}

interface JobRow {
  id: string;
  user_id: string;
  status: JobStatus;
  pipelines_count: number;
  created_at: Date;
  completed_at: Date | null;
}

interface TaskCountRow {
  job_id: string;
  kind: TaskKind;
  status: TaskStatus;
  count: string;
}

function validatePipelinesCount(n: number): void {
  if (
    !Number.isInteger(n) ||
    n < MIN_PIPELINES ||
    n > MAX_PIPELINES
  ) {
    throw new InvalidPipelinesCountError(n);
  }
}

export async function createJob(input: CreateJobInput): Promise<CreateJobResult> {
  validatePipelinesCount(input.pipelinesCount);

  return db.tx(async (tx) => {
    // Pre-check inside the tx so we surface a typed error rather than a raw
    // FK violation, and so a non-existent user produces zero side effects.
    const userCheck = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [input.userId],
    );
    if (userCheck.rowCount === 0) {
      throw new UserNotFoundError(input.userId);
    }

    const jobIns = await tx.query<{ id: string }>(
      `INSERT INTO jobs (user_id, pipelines_count)
         VALUES ($1, $2)
         RETURNING id`,
      [input.userId, input.pipelinesCount],
    );
    const jobId = jobIns.rows[0].id;

    // SPEC §3.2: insert all N CPU tasks as 'pending' at job-creation time.
    // The scheduler — not the API — decides when they enter Redis.
    await tx.query(
      `INSERT INTO tasks (job_id, user_id, kind, status)
         SELECT $1, $2, 'cpu', 'pending'
           FROM generate_series(1, $3::int)`,
      [jobId, input.userId, input.pipelinesCount],
    );

    return {
      jobId,
      status: "pending",
      pipelinesCount: input.pipelinesCount,
    };
  });
}

function emptyProgress(pipelinesCount: number): JobProgress {
  return {
    cpu: { done: 0, total: pipelinesCount, failed: 0 },
    ssh: { done: 0, total: pipelinesCount, failed: 0 },
    training: { done: 0, total: 1, failed: 0 },
  };
}

function applyTaskCount(
  progress: JobProgress,
  kind: TaskKind,
  status: TaskStatus,
  count: number,
): void {
  const bucket = progress[kind];
  if (status === "succeeded") bucket.done += count;
  else if (status === "failed") bucket.failed += count;
}

function rowToView(row: JobRow, progress: JobProgress): JobView {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    pipelinesCount: row.pipelines_count,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    progress,
  };
}

type JobsFilter =
  | { kind: "all" }
  | { kind: "byId"; jobId: string }
  | { kind: "byUser"; userId: string };

function buildJobsQuery(filter: JobsFilter): { sql: string; params: unknown[] } {
  const base = `SELECT id, user_id, status, pipelines_count, created_at, completed_at
                  FROM jobs`;
  const tail = `ORDER BY created_at DESC`;
  switch (filter.kind) {
    case "byId":
      return { sql: `${base} WHERE id = $1 ${tail}`, params: [filter.jobId] };
    case "byUser":
      return { sql: `${base} WHERE user_id = $1 ${tail}`, params: [filter.userId] };
    case "all":
      return { sql: `${base} ${tail}`, params: [] };
  }
}

async function fetchJobs(filter: JobsFilter): Promise<JobView[]> {
  const { sql, params } = buildJobsQuery(filter);
  const jobs = await db.query<JobRow>(sql, params);
  if (jobs.rowCount === 0) return [];

  const ids = jobs.rows.map((r) => r.id);
  const counts = await db.query<TaskCountRow>(
    `SELECT job_id, kind, status, count(*)::text AS count
       FROM tasks
       WHERE job_id = ANY($1::uuid[])
       GROUP BY job_id, kind, status`,
    [ids],
  );

  const progressByJob = new Map<string, JobProgress>();
  for (const j of jobs.rows) progressByJob.set(j.id, emptyProgress(j.pipelines_count));
  for (const c of counts.rows) {
    const p = progressByJob.get(c.job_id);
    if (!p) continue;
    applyTaskCount(p, c.kind, c.status, Number(c.count));
  }

  return jobs.rows.map((r) => rowToView(r, progressByJob.get(r.id)!));
}

export async function getJob(jobId: string): Promise<JobView | null> {
  const list = await fetchJobs({ kind: "byId", jobId });
  return list[0] ?? null;
}

export interface ListJobsFilter {
  userId?: string;
}

export async function listJobs(filter: ListJobsFilter = {}): Promise<JobView[]> {
  if (filter.userId) return fetchJobs({ kind: "byUser", userId: filter.userId });
  return fetchJobs({ kind: "all" });
}
