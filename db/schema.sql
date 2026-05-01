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

CREATE TABLE IF NOT EXISTS tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id)  ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('cpu','ssh','training')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','queued','running','succeeded','failed')),
  parent_task_id  uuid REFERENCES tasks(id) ON DELETE SET NULL,
  attempts        int  NOT NULL DEFAULT 0  CHECK (attempts >= 0),
  max_attempts    int  NOT NULL DEFAULT 3  CHECK (max_attempts >= 1),
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS tasks_kind_status_user_idx
  ON tasks (kind, status, user_id);

CREATE INDEX IF NOT EXISTS tasks_job_kind_idx
  ON tasks (job_id, kind);

-- At most one SSH child per CPU parent
CREATE UNIQUE INDEX IF NOT EXISTS tasks_ssh_parent_unique_idx
  ON tasks (parent_task_id)
  WHERE kind = 'ssh';

CREATE TABLE IF NOT EXISTS artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_task_unique UNIQUE (task_id)
);

CREATE TABLE IF NOT EXISTS leases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource      text NOT NULL CHECK (resource IN ('cpu','ssh','training')),
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  released_at   timestamptz
);

CREATE INDEX IF NOT EXISTS leases_resource_released_idx
  ON leases (resource, released_at);

CREATE INDEX IF NOT EXISTS leases_user_resource_released_idx
  ON leases (user_id, resource, released_at);

CREATE INDEX IF NOT EXISTS leases_task_idx ON leases (task_id);
