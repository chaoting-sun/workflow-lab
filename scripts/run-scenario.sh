#!/usr/bin/env bash
# Verification harness for SPEC §9.2-§9.6 scenarios.
#
# Usage:
#   ./scripts/run-scenario.sh <scenario_label> <pipelines> <max_wait_sec> [ENV_OVERRIDES...]
#
# Example:
#   ./scripts/run-scenario.sh 9.2-cpu-crash 5 180 \
#       CHAOS_CPU_CRASH_RATE=0.10 LEASE_TTL_MS=10000
#
# Each invocation:
#   1. Truncates DB and clears artifacts/.
#   2. Spawns a worker subprocess with the supplied env overrides + a
#      restart-on-exit loop (so CHAOS_CPU_CRASH_RATE>0 doesn't permanently kill us).
#   3. Creates user 'alice' and one job with N pipelines (direct SQL — bypasses
#      the running next dev's cached PIPELINES_PER_JOB).
#   4. Polls task state every 2s until the job is terminal or max_wait_sec elapses.
#   5. Captures a final-state report (counts, attempts histogram, leftover leases).
#   6. Tears down the worker subprocess.

set -euo pipefail

LABEL="${1:-}"
PIPELINES="${2:-}"
MAX_WAIT="${3:-}"
shift 3 || true

if [[ -z "$LABEL" || -z "$PIPELINES" || -z "$MAX_WAIT" ]]; then
  echo "usage: $0 <label> <pipelines> <max_wait_sec> [ENV=val ...]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS_DIR="$ROOT/artifacts"
LOG_DIR="$ROOT/tasks/scenario-logs"
mkdir -p "$LOG_DIR"
WORKER_LOG="$LOG_DIR/${LABEL}.worker.log"
SCENARIO_LOG="$LOG_DIR/${LABEL}.scenario.log"

echo "=== scenario $LABEL: pipelines=$PIPELINES max_wait=${MAX_WAIT}s overrides=$* ===" | tee "$SCENARIO_LOG"

# 1. Truncate DB + clear artifacts.
docker compose exec -T postgres psql -U workflow -d workflow_lab \
  -c "TRUNCATE TABLE artifacts, tasks, jobs, users RESTART IDENTITY CASCADE;" >/dev/null
rm -f "$ARTIFACTS_DIR"/*.txt 2>/dev/null || true

# 2. Spawn scheduler + cpu + io workers, each with its own restart-on-exit loop.
# Post-T18 layout: scheduler (advisory lock + dispatch tick) and workers (BullMQ
# consumers) are separate processes. The cpu worker loop is what makes
# CHAOS_CPU_CRASH_RATE>0 recoverable; scheduler and io worker rarely exit.
(
  cd "$ROOT"
  # shellcheck disable=SC2068
  env $@ bash -c '
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
echo "supervisor loop PID=$WORKER_PID  log=$WORKER_LOG" | tee -a "$SCENARIO_LOG"

cleanup() {
  # Kill the supervisor subshell and any straggling tsx processes.
  pkill -9 -P "$WORKER_PID" 2>/dev/null || true
  kill -9 "$WORKER_PID" 2>/dev/null || true
  pkill -9 -f "tsx.*scheduler/index.ts" 2>/dev/null || true
  pkill -9 -f "tsx.*worker/index.ts" 2>/dev/null || true
  sleep 1
}
trap cleanup EXIT

# Wait for "scheduler lock acquired" so we know the worker is actually running.
for _ in $(seq 1 30); do
  if grep -q "scheduler lock acquired" "$WORKER_LOG" 2>/dev/null; then
    echo "worker is up" | tee -a "$SCENARIO_LOG"
    break
  fi
  sleep 0.5
done
if ! grep -q "scheduler lock acquired" "$WORKER_LOG" 2>/dev/null; then
  echo "WORKER FAILED TO START — log:" | tee -a "$SCENARIO_LOG"
  cat "$WORKER_LOG" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# 3. Create user alice + one job + N pending CPU tasks (direct SQL).
JOB_ID=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -c "
  WITH u AS (INSERT INTO users (name) VALUES ('alice') RETURNING id),
       j AS (INSERT INTO jobs (user_id, pipelines_count) SELECT id, $PIPELINES FROM u RETURNING id, user_id),
       _ AS (INSERT INTO tasks (job_id, user_id, kind, status)
             SELECT j.id, j.user_id, 'cpu', 'pending'
               FROM j CROSS JOIN generate_series(1, $PIPELINES))
  SELECT id FROM j;
")
echo "job_id=$JOB_ID" | tee -a "$SCENARIO_LOG"

# 4. Poll until terminal status or max_wait_sec.
START=$(date +%s)
STATUS=""
while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if (( ELAPSED >= MAX_WAIT )); then
    echo "TIMEOUT after ${ELAPSED}s" | tee -a "$SCENARIO_LOG"
    break
  fi
  ROW=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -F '|' -c "
    SELECT j.status,
           COALESCE(SUM(CASE WHEN t.kind='cpu'      AND t.status='succeeded' THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.kind='cpu'      AND t.status='failed'    THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.kind='ssh'      AND t.status='succeeded' THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.kind='ssh'      AND t.status='failed'    THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.kind='training' AND t.status='succeeded' THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.kind='training' AND t.status='failed'    THEN 1 END), 0),
           COALESCE(SUM(CASE WHEN t.lease_token IS NOT NULL THEN 1 END), 0)
      FROM jobs j LEFT JOIN tasks t ON t.job_id=j.id
     WHERE j.id='$JOB_ID' GROUP BY j.status
  ")
  STATUS=$(echo "$ROW" | cut -d'|' -f1)
  printf '[%4ds] status=%s cpu=%s/%s(f=%s) ssh=%s/%s(f=%s) tr=%s/1(f=%s) leases=%s\n' \
    "$ELAPSED" "$STATUS" \
    "$(echo "$ROW" | cut -d'|' -f2)" "$PIPELINES" "$(echo "$ROW" | cut -d'|' -f3)" \
    "$(echo "$ROW" | cut -d'|' -f4)" "$PIPELINES" "$(echo "$ROW" | cut -d'|' -f5)" \
    "$(echo "$ROW" | cut -d'|' -f6)" "$(echo "$ROW" | cut -d'|' -f7)" \
    "$(echo "$ROW" | cut -d'|' -f8)" | tee -a "$SCENARIO_LOG"
  if [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]]; then
    break
  fi
  sleep 2
done

# 5. Final-state report.
echo "--- final state ---" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT kind, status, count(*) FROM tasks WHERE job_id='$JOB_ID' GROUP BY kind, status ORDER BY kind, status;
" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT kind, attempts, count(*) FROM tasks WHERE job_id='$JOB_ID' GROUP BY kind, attempts ORDER BY kind, attempts;
" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT count(*) AS leftover_leases FROM tasks WHERE job_id='$JOB_ID' AND lease_token IS NOT NULL;
" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT failure_reason, count(*) FROM tasks WHERE job_id='$JOB_ID' AND failure_reason IS NOT NULL GROUP BY failure_reason ORDER BY 2 DESC;
" | tee -a "$SCENARIO_LOG"

echo "scenario $LABEL terminal_status=$STATUS" | tee -a "$SCENARIO_LOG"
