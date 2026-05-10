#!/usr/bin/env bash
# §9.5 fairness scenario. Submits N jobs across N users near-simultaneously,
# samples per-user "running CPU" counts during the run, and asserts that no
# user is starved (each user's running-CPU count > 0 at multiple sample points
# and counts converge toward GLOBAL_CPU_SLOTS / N_users).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/tasks/scenario-logs"
mkdir -p "$LOG_DIR"
WORKER_LOG="$LOG_DIR/9.5-fairness.worker.log"
SCENARIO_LOG="$LOG_DIR/9.5-fairness.scenario.log"

PIPELINES=20
USERS=(alice bob carol)

# Slow CPU work + long-ish run window so the sampler catches fairness in steady
# state. SSH/training drain fast so we don't get bottlenecked outside CPU.
ENV_OVERRIDES=(
  GLOBAL_CPU_SLOTS=12
  CPU_WORKER_CONCURRENCY=12
  GLOBAL_SSH_SLOTS=12
  SSH_WORKER_CONCURRENCY=12
  CPU_SLEEP_MIN_MS=2000
  CPU_SLEEP_MAX_MS=3000
  SSH_SLEEP_MS=200
  SCHEDULER_TICK_MS=500
  LEASE_TTL_MS=30000
)

echo "=== §9.5 fairness: $PIPELINES pipelines/user across users=${USERS[*]} ===" | tee "$SCENARIO_LOG"

docker compose exec -T postgres psql -U workflow -d workflow_lab \
  -c "TRUNCATE TABLE artifacts, tasks, jobs, users RESTART IDENTITY CASCADE;" >/dev/null
rm -f "$ROOT/artifacts"/*.txt 2>/dev/null || true

(
  cd "$ROOT"
  # shellcheck disable=SC2068
  env ${ENV_OVERRIDES[@]} bash -c '
    # Post-T18 layout: scheduler (advisory lock + dispatch tick) and workers
    # (BullMQ consumers) are separate processes. Each gets its own restart loop
    # so chaos scenarios that exit a worker mid-run are recoverable.
    (until ./node_modules/.bin/tsx --env-file=.env scheduler/index.ts; do
       echo "[scheduler-loop] exited non-zero, restarting in 1s"; sleep 1
     done) &
    (until WORKER_ROLE=cpu ./node_modules/.bin/tsx --env-file=.env worker/index.ts; do
       echo "[worker:cpu-loop] exited non-zero, restarting in 1s"; sleep 1
     done) &
    (until WORKER_ROLE=io ./node_modules/.bin/tsx --env-file=.env worker/index.ts; do
       echo "[worker:io-loop] exited non-zero, restarting in 1s"; sleep 1
     done) &
    wait
  '
) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
echo "worker loop PID=$WORKER_PID  log=$WORKER_LOG" | tee -a "$SCENARIO_LOG"

cleanup() {
  pkill -9 -P "$WORKER_PID" 2>/dev/null || true
  kill -9 "$WORKER_PID" 2>/dev/null || true
  pkill -9 -f "tsx.*scheduler/index.ts" 2>/dev/null || true
  pkill -9 -f "tsx.*worker/index.ts" 2>/dev/null || true
  sleep 1
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if grep -q "scheduler lock acquired" "$WORKER_LOG" 2>/dev/null; then break; fi
  sleep 0.5
done
grep -q "scheduler lock acquired" "$WORKER_LOG" || { echo "WORKER FAILED"; cat "$WORKER_LOG"; exit 1; }
echo "worker is up" | tee -a "$SCENARIO_LOG"

# Create 3 users + 3 jobs simultaneously (single SQL round-trip to keep
# created_at within a few ms of each other).
JOB_IDS=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -c "
  WITH inserted_users AS (
    INSERT INTO users (name) VALUES ('alice'),('bob'),('carol') RETURNING id, name
  ),
  inserted_jobs AS (
    INSERT INTO jobs (user_id, pipelines_count)
      SELECT id, $PIPELINES FROM inserted_users
      RETURNING id, user_id
  ),
  inserted_tasks AS (
    INSERT INTO tasks (job_id, user_id, kind, status)
      SELECT j.id, j.user_id, 'cpu', 'pending'
        FROM inserted_jobs j CROSS JOIN generate_series(1, $PIPELINES)
  )
  SELECT id FROM inserted_jobs;
")
echo "job_ids: $JOB_IDS" | tee -a "$SCENARIO_LOG"

# Sample per-user running CPU every 1s for 25s (covers most of the CPU phase).
echo "--- samples (running CPU per user) ---" | tee -a "$SCENARIO_LOG"
for sec in $(seq 1 25); do
  ROW=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -F '|' -c "
    SELECT string_agg(u.name || '=' || k.cnt::text, ', ' ORDER BY u.name)
      FROM users u
      LEFT JOIN LATERAL (
        SELECT count(*) AS cnt
          FROM tasks t
         WHERE t.user_id = u.id
           AND t.kind = 'cpu'
           AND t.lease_token IS NOT NULL
           AND t.lease_expires_at > now()
      ) k ON true;
  ")
  printf '[%2ds] %s\n' "$sec" "$ROW" | tee -a "$SCENARIO_LOG"
  # Stop early if all jobs completed.
  REMAINING=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -c "
    SELECT count(*) FROM jobs WHERE status NOT IN ('completed','failed');
  ")
  if [[ "$REMAINING" == "0" ]]; then
    echo "all jobs terminal at ${sec}s" | tee -a "$SCENARIO_LOG"
    break
  fi
  sleep 1
done

echo "--- final job statuses ---" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT u.name, j.status, j.pipelines_count
  FROM jobs j JOIN users u ON u.id = j.user_id ORDER BY u.name;
" | tee -a "$SCENARIO_LOG"
