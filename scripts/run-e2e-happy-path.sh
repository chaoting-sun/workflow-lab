#!/usr/bin/env bash
# Happy-path E2E. Implements the decision recorded in
# docs/adr/0002-e2e-posture.md: drive the whole stack from outside —
# HTTP → Next.js route handler → Postgres → BullMQ → out-of-process
# scheduler + workers → Postgres — and assert on the polled
# /api/jobs/:id JSON.
#
# Prereqs:
#   - docker compose up -d  (postgres + redis healthy)
#   - pnpm install
#   - Nothing already bound to $E2E_PORT (default 3000); the script will
#     bail if Next.js fails to come up.
#
# Tunables (env vars):
#   E2E_PIPELINES     pipelines per job        default 4
#   E2E_PORT          Next.js dev server port  default 3000
#   E2E_MAX_WAIT_SEC  poll timeout             default 180
#
# Exit codes:
#   0  — all assertions passed.
#   1  — assertion failed, timed out, or a spawned process never reported ready.
#   64 — missing local prereq (jq, curl).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="e2e-happy-path"
LOG_DIR="$ROOT/tasks/scenario-logs"
mkdir -p "$LOG_DIR"
WORKER_LOG="$LOG_DIR/${LABEL}.worker.log"
NEXT_LOG="$LOG_DIR/${LABEL}.nextjs.log"
SCENARIO_LOG="$LOG_DIR/${LABEL}.scenario.log"

PIPELINES="${E2E_PIPELINES:-4}"
PORT="${E2E_PORT:-3000}"
MAX_WAIT_SEC="${E2E_MAX_WAIT_SEC:-180}"
BASE_URL="http://localhost:${PORT}"

# Env applied to BOTH the Next.js process (so POST /api/jobs snapshots
# the small pipelinesCount we want) and the worker processes (so slot
# math stays consistent). Node's --env-file and Next.js's .env loader
# both prefer already-set process.env values over .env file contents,
# so this override wins.
ENV_OVERRIDES=(
  PIPELINES_PER_JOB="$PIPELINES"
  PORT="$PORT"
)

echo "=== $LABEL: pipelines=$PIPELINES port=$PORT max_wait=${MAX_WAIT_SEC}s ===" | tee "$SCENARIO_LOG"

# --- prereqs ------------------------------------------------------------------
for bin in jq curl; do
  if ! command -v "$bin" >/dev/null; then
    echo "ERROR: '$bin' is required" | tee -a "$SCENARIO_LOG"
    exit 64
  fi
done

# Refuse to clobber an already-running dev server on the target port.
if curl -fsS "$BASE_URL/api/users" >/dev/null 2>&1; then
  echo "ERROR: $BASE_URL is already serving; stop it before running E2E" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# --- reset state --------------------------------------------------------------
docker compose exec -T postgres psql -U workflow -d workflow_lab \
  -c "TRUNCATE TABLE artifacts, tasks, jobs, users RESTART IDENTITY CASCADE;" >/dev/null
rm -f "$ROOT/artifacts"/*.txt 2>/dev/null || true

# --- spawn Next.js dev --------------------------------------------------------
(
  cd "$ROOT"
  env "${ENV_OVERRIDES[@]}" ./node_modules/.bin/next dev -p "$PORT"
) >"$NEXT_LOG" 2>&1 &
NEXT_PID=$!
echo "nextjs PID=$NEXT_PID log=$NEXT_LOG" | tee -a "$SCENARIO_LOG"

# --- spawn scheduler + cpu worker + io worker ---------------------------------
# Lifted from scripts/run-scenario.sh: each loop restarts on non-zero exit so
# CHAOS_CPU_CRASH_RATE>0 future variants can reuse this shape. For the happy
# path with chaos=0 the loops should not fire.
(
  cd "$ROOT"
  env "${ENV_OVERRIDES[@]}" bash -c '
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
echo "supervisor PID=$WORKER_PID log=$WORKER_LOG" | tee -a "$SCENARIO_LOG"

cleanup() {
  # `next dev` forks a `next-server` child whose argv does not include the port,
  # and the tsx supervisor forks the actual node-tsx processes. Both can survive
  # `kill $PARENT` and get reparented to init. Strategy:
  #   1. kill the supervisor wrapper + direct children
  #   2. kill anything still LISTENING on $PORT (catches reparented next-server)
  #   3. fall back to pkill -f for the scheduler/worker procs by argv
  pkill -9 -P "$WORKER_PID" 2>/dev/null || true
  kill -9 "$WORKER_PID" 2>/dev/null || true
  pkill -9 -P "$NEXT_PID" 2>/dev/null || true
  kill -9 "$NEXT_PID" 2>/dev/null || true
  local port_holders
  port_holders=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "${port_holders:-}" ]]; then
    # shellcheck disable=SC2086
    kill -9 $port_holders 2>/dev/null || true
  fi
  pkill -9 -f "tsx.*scheduler/index.ts" 2>/dev/null || true
  pkill -9 -f "tsx.*worker/index.ts" 2>/dev/null || true
  sleep 1
}
trap cleanup EXIT

# --- wait for scheduler ready -------------------------------------------------
for _ in $(seq 1 60); do
  if grep -q "scheduler lock acquired" "$WORKER_LOG" 2>/dev/null; then
    echo "scheduler is up" | tee -a "$SCENARIO_LOG"
    break
  fi
  sleep 0.5
done
if ! grep -q "scheduler lock acquired" "$WORKER_LOG" 2>/dev/null; then
  echo "SCHEDULER FAILED TO START — last 50 lines of $WORKER_LOG:" | tee -a "$SCENARIO_LOG"
  tail -50 "$WORKER_LOG" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# --- wait for Next.js ready ---------------------------------------------------
for _ in $(seq 1 120); do
  if curl -fsS "$BASE_URL/api/users" >/dev/null 2>&1; then
    echo "nextjs is up at $BASE_URL" | tee -a "$SCENARIO_LOG"
    break
  fi
  sleep 1
done
if ! curl -fsS "$BASE_URL/api/users" >/dev/null 2>&1; then
  echo "NEXTJS FAILED TO START — last 50 lines of $NEXT_LOG:" | tee -a "$SCENARIO_LOG"
  tail -50 "$NEXT_LOG" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# --- drive: POST /api/users ---------------------------------------------------
USER_NAME="e2e-alice-$(date +%s%N)"
USER_JSON=$(curl -fsS -X POST "$BASE_URL/api/users" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg name "$USER_NAME" '{name: $name}')")
USER_ID=$(echo "$USER_JSON" | jq -r '.id')
echo "user created: id=$USER_ID name=$USER_NAME" | tee -a "$SCENARIO_LOG"
if [[ -z "$USER_ID" || "$USER_ID" == "null" ]]; then
  echo "FAIL: POST /api/users did not return an id" | tee -a "$SCENARIO_LOG"
  echo "response: $USER_JSON" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# --- drive: POST /api/jobs ----------------------------------------------------
JOB_JSON=$(curl -fsS -X POST "$BASE_URL/api/jobs" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg userId "$USER_ID" '{userId: $userId}')")
JOB_ID=$(echo "$JOB_JSON" | jq -r '.jobId')
# Trust the server's snapshot — the override is best-effort, and downstream
# assertions need to compare against whatever was actually persisted.
SNAPSHOTTED=$(echo "$JOB_JSON" | jq -r '.pipelinesCount')
echo "job created: id=$JOB_ID pipelines=$SNAPSHOTTED (requested=$PIPELINES)" | tee -a "$SCENARIO_LOG"
if [[ -z "$JOB_ID" || "$JOB_ID" == "null" ]]; then
  echo "FAIL: POST /api/jobs did not return a jobId" | tee -a "$SCENARIO_LOG"
  echo "response: $JOB_JSON" | tee -a "$SCENARIO_LOG"
  exit 1
fi

# --- poll /api/jobs/:id until terminal ----------------------------------------
START=$(date +%s)
STATUS=""
LAST=""
while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if (( ELAPSED >= MAX_WAIT_SEC )); then
    echo "TIMEOUT after ${ELAPSED}s; last_response: $LAST" | tee -a "$SCENARIO_LOG"
    exit 1
  fi
  LAST=$(curl -fsS "$BASE_URL/api/jobs/$JOB_ID")
  STATUS=$(echo "$LAST"      | jq -r '.status')
  CPU_DONE=$(echo "$LAST"    | jq -r '.progress.cpu.done')
  SSH_DONE=$(echo "$LAST"    | jq -r '.progress.ssh.done')
  TR_DONE=$(echo "$LAST"     | jq -r '.progress.training.done')
  printf '[%4ds] status=%s cpu=%s/%s ssh=%s/%s tr=%s/1\n' \
    "$ELAPSED" "$STATUS" "$CPU_DONE" "$SNAPSHOTTED" "$SSH_DONE" "$SNAPSHOTTED" "$TR_DONE" \
    | tee -a "$SCENARIO_LOG"
  if [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]]; then
    break
  fi
  sleep 2
done

# --- assertions ---------------------------------------------------------------
fail=0
assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: $label got=$got want=$want" | tee -a "$SCENARIO_LOG"
    fail=1
  fi
}

CPU_DONE=$(echo   "$LAST" | jq -r '.progress.cpu.done')
SSH_DONE=$(echo   "$LAST" | jq -r '.progress.ssh.done')
TR_DONE=$(echo    "$LAST" | jq -r '.progress.training.done')
CPU_FAILED=$(echo "$LAST" | jq -r '.progress.cpu.failed')
SSH_FAILED=$(echo "$LAST" | jq -r '.progress.ssh.failed')
TR_FAILED=$(echo  "$LAST" | jq -r '.progress.training.failed')

assert_eq "$STATUS"     "completed"    "status"
assert_eq "$CPU_DONE"   "$SNAPSHOTTED" "progress.cpu.done"
assert_eq "$SSH_DONE"   "$SNAPSHOTTED" "progress.ssh.done"
assert_eq "$TR_DONE"    "1"            "progress.training.done"
assert_eq "$CPU_FAILED" "0"            "progress.cpu.failed"
assert_eq "$SSH_FAILED" "0"            "progress.ssh.failed"
assert_eq "$TR_FAILED"  "0"            "progress.training.failed"

# Lease columns aren't exposed by the HTTP API, so fall back to psql for the
# "no orphaned ownership" invariant — same shape as run-scenario.sh.
LEFTOVER=$(docker compose exec -T postgres psql -U workflow -d workflow_lab -t -A -c "
  SELECT count(*) FROM tasks WHERE job_id='$JOB_ID' AND lease_token IS NOT NULL;
" | tr -d '[:space:]')
echo "leftover_leases=$LEFTOVER" | tee -a "$SCENARIO_LOG"
assert_eq "$LEFTOVER" "0" "leftover_leases"

if (( fail == 1 )); then
  echo "=== $LABEL: FAILED ===" | tee -a "$SCENARIO_LOG"
  exit 1
fi

echo "=== $LABEL: PASSED (elapsed=${ELAPSED}s) ===" | tee -a "$SCENARIO_LOG"
