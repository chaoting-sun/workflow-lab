#!/usr/bin/env bash
# §9.6 backpressure scenario. Configures CPU production faster than SSH drain
# so the SSH backlog grows; the scheduler should pause CPU dispatch once the
# backlog hits SSH_BACKPRESSURE_THRESHOLD.
#
# Sample shape:
#   - GLOBAL_CPU_SLOTS=10, GLOBAL_SSH_SLOTS=2 (slow drain)
#   - CPU_SLEEP=200ms, SSH_SLEEP=2000ms (CPU floods SSH)
#   - SSH_BACKPRESSURE_THRESHOLD=8

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/tasks/scenario-logs"
mkdir -p "$LOG_DIR"
WORKER_LOG="$LOG_DIR/9.6-backpressure.worker.log"
SCENARIO_LOG="$LOG_DIR/9.6-backpressure.scenario.log"

PIPELINES=40
THRESHOLD=8

ENV_OVERRIDES=(
  GLOBAL_CPU_SLOTS=10
  CPU_WORKER_CONCURRENCY=10
  GLOBAL_SSH_SLOTS=2
  SSH_WORKER_CONCURRENCY=2
  CPU_SLEEP_MIN_MS=200
  CPU_SLEEP_MAX_MS=400
  SSH_SLEEP_MS=2000
  SCHEDULER_TICK_MS=500
  SSH_BACKPRESSURE_THRESHOLD=$THRESHOLD
  LEASE_TTL_MS=30000
)

echo "=== §9.6 backpressure: pipelines=$PIPELINES SSH_BACKPRESSURE_THRESHOLD=$THRESHOLD ===" | tee "$SCENARIO_LOG"

docker compose exec -T postgres psql -U workflow -d workflow_lab \
  -c "TRUNCATE TABLE artifacts, tasks, jobs, users RESTART IDENTITY CASCADE;" >/dev/null
rm -f "$ROOT/artifacts"/*.txt 2>/dev/null || true

(
  cd "$ROOT"
  # shellcheck disable=SC2068
  env ${ENV_OVERRIDES[@]} bash -c '
    # Post-T18 layout: scheduler + workers in separate processes. See
    # run-scenario-fairness.sh for rationale.
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

JOB_ID=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -c "
  WITH u AS (INSERT INTO users (name) VALUES ('alice') RETURNING id),
       j AS (INSERT INTO jobs (user_id, pipelines_count) SELECT id, $PIPELINES FROM u RETURNING id, user_id),
       _ AS (INSERT INTO tasks (job_id, user_id, kind, status)
             SELECT j.id, j.user_id, 'cpu', 'pending'
               FROM j CROSS JOIN generate_series(1, $PIPELINES))
  SELECT id FROM j;
")
echo "job_id=$JOB_ID" | tee -a "$SCENARIO_LOG"

# Sample SSH backlog and CPU running counts every 1s. Backlog should rise toward
# the threshold then plateau as CPU dispatch pauses.
echo "--- samples (cpu_running, ssh_backlog [pending+queued+running], ssh_succeeded) ---" | tee -a "$SCENARIO_LOG"
MAX_BACKLOG=0
SAW_PAUSED=0  # 1 once we observe ssh_backlog >= threshold AND cpu dispatched=0 in that tick
for sec in $(seq 1 90); do
  ROW=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -F '|' -c "
    SELECT
      (SELECT count(*) FROM tasks WHERE job_id='$JOB_ID' AND kind='cpu' AND lease_token IS NOT NULL AND lease_expires_at > now()),
      (SELECT count(*) FROM tasks WHERE job_id='$JOB_ID' AND kind='ssh' AND status IN ('pending','queued','running')),
      (SELECT count(*) FROM tasks WHERE job_id='$JOB_ID' AND kind='ssh' AND status='succeeded'),
      (SELECT count(*) FROM tasks WHERE job_id='$JOB_ID' AND kind='cpu' AND status='pending'),
      (SELECT status FROM jobs WHERE id='$JOB_ID')
  ")
  CPU_R=$(echo "$ROW" | cut -d'|' -f1)
  SSH_BACK=$(echo "$ROW" | cut -d'|' -f2)
  SSH_OK=$(echo "$ROW" | cut -d'|' -f3)
  CPU_PEND=$(echo "$ROW" | cut -d'|' -f4)
  JSTAT=$(echo "$ROW" | cut -d'|' -f5)
  if (( SSH_BACK > MAX_BACKLOG )); then MAX_BACKLOG=$SSH_BACK; fi
  if (( SSH_BACK >= THRESHOLD )) && (( CPU_R == 0 )) && (( CPU_PEND > 0 )); then
    SAW_PAUSED=1
    PAUSED_NOTE="  <-- CPU paused (backlog>=$THRESHOLD AND CPU running=0 with pending CPU left)"
  else
    PAUSED_NOTE=""
  fi
  printf '[%3ds] status=%s cpu_running=%s ssh_backlog=%s ssh_done=%s cpu_pending=%s%s\n' \
    "$sec" "$JSTAT" "$CPU_R" "$SSH_BACK" "$SSH_OK" "$CPU_PEND" "$PAUSED_NOTE" | tee -a "$SCENARIO_LOG"
  if [[ "$JSTAT" == "completed" || "$JSTAT" == "failed" ]]; then
    break
  fi
  sleep 1
done

echo "max_observed_ssh_backlog=$MAX_BACKLOG  saw_cpu_paused=$SAW_PAUSED  threshold=$THRESHOLD" | tee -a "$SCENARIO_LOG"
docker compose exec -T postgres psql -U workflow -d workflow_lab -c "
SELECT kind, status, count(*) FROM tasks WHERE job_id='$JOB_ID' GROUP BY kind, status ORDER BY kind, status;
" | tee -a "$SCENARIO_LOG"
