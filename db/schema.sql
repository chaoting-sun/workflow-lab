CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','completed','failed')),
  pipelines_count  int  NOT NULL CHECK (pipelines_count BETWEEN 1 AND 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs (user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status_idx       ON jobs (status);

-- At most one active lease per task — represented by `lease_token IS NOT
-- NULL`. NULL means no current owner (pending / succeeded / failed, or
-- just-reaped).
CREATE TABLE IF NOT EXISTS tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES jobs(id)  ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('cpu','ssh','training')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','queued','running','succeeded','failed')),
  parent_task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
  attempts            int  NOT NULL DEFAULT 0  CHECK (attempts >= 0),
  max_attempts        int  NOT NULL DEFAULT 3  CHECK (max_attempts >= 1),
  failure_reason      text,
  lease_token         uuid,
  lease_expires_at    timestamptz,
  lease_heartbeat_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);

CREATE INDEX IF NOT EXISTS tasks_kind_status_user_idx
  ON tasks (kind, status, user_id);

CREATE INDEX IF NOT EXISTS tasks_job_kind_idx
  ON tasks (job_id, kind);

-- At most one SSH child per CPU parent
CREATE UNIQUE INDEX IF NOT EXISTS tasks_ssh_parent_unique_idx
  ON tasks (parent_task_id)
  WHERE kind = 'ssh';

-- Reaper scans expired leases via this partial index (sparse: only tasks
-- with an active lease appear).
CREATE INDEX IF NOT EXISTS tasks_lease_expires_idx
  ON tasks (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

-- Fairness ordering does two correlated count(*) subqueries per candidate,
-- one keyed by user_id and one by job_id, both filtering
-- `lease_token IS NOT NULL`. These partial indexes are sparse (only active
-- leases) and let the planner answer the subqueries from the index alone.
-- They also cover countActiveLeases.
CREATE INDEX IF NOT EXISTS tasks_kind_user_active_lease_idx
  ON tasks (kind, user_id)
  WHERE lease_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_kind_job_active_lease_idx
  ON tasks (kind, job_id)
  WHERE lease_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_task_unique UNIQUE (task_id)
);
