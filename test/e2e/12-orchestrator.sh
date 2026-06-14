#!/usr/bin/env bash
# 12-orchestrator.sh — orchestrator lifecycle verbs. No claude (claude-free via
# a fake-cycle seam in later steps); runs on every platform.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 12-orchestrator ═══════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-orch)"
SPID=""
CYCLE_PID=""
trap 'kill "$SPID" "${CYCLE_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pipeline/runs"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem" }
JSON
STATE="$WORK/.pipeline/runs/orchestrator.state.json"

# status with no state file → stopped
OUT=$($AP orchestrator status --target "$WORK" --json)
assert_eq "$(echo "$OUT" | jq -r '.state')" "stopped" "status defaults to stopped"

# pause writes paused
$AP orchestrator pause --target "$WORK" >/dev/null
assert_eq "$(jq -r '.state' "$STATE")" "paused" "pause sets state=paused"
assert_eq "$(jq -r '.nextFireAt' "$STATE")" "null" "pause clears nextFireAt"

# resume writes running
$AP orchestrator resume --target "$WORK" >/dev/null
assert_eq "$(jq -r '.state' "$STATE")" "running" "resume sets state=running"

# stop writes stopped
$AP orchestrator stop --target "$WORK" >/dev/null
assert_eq "$(jq -r '.state' "$STATE")" "stopped" "stop sets state=stopped"

# status --json reflects the file
OUT=$($AP orchestrator status --target "$WORK" --json)
assert_eq "$(echo "$OUT" | jq -r '.state')" "stopped" "status reads state=stopped"

# --- real detached supervisor lifecycle, claude-free via the fake-cycle seam ---
export AP_ORCHESTRATOR_CYCLE_FAKE=1   # nextCheckSeconds=1 so a cycle is recorded fast
START=$($AP orchestrator start --target "$WORK" --json)
assert_eq "$(echo "$START" | jq -r '.started')" "true" "start reports started"
SPID=$(echo "$START" | jq -r '.supervisorPid')
assert_neq "$SPID" "null" "start records a supervisor pid"

# start fires a cycle immediately; wait for the supervisor to record it
for _ in $(seq 1 30); do
  [ "$(jq -r '.lastCycleNumber // "null"' "$STATE")" != "null" ] && break
  sleep 0.2
done
assert_neq "$(jq -r '.lastCycleNumber' "$STATE")" "null" "supervisor recorded a cycle"
assert_eq "$(jq -r '.state' "$STATE")" "running" "supervisor state is running"

# starting again refuses while a live supervisor exists
if $AP orchestrator start --target "$WORK" --json >/dev/null 2>&1; then
  _fail "second start should refuse while running"
fi

# stop tears down the supervisor
$AP orchestrator stop --target "$WORK" >/dev/null
# fake cadence => ~1s ticks, so SIGTERM is honored within the 6s poll budget
for _ in $(seq 1 30); do
  kill -0 "$SPID" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$SPID" 2>/dev/null; then _fail "supervisor pid $SPID still alive after stop"; fi
assert_eq "$(jq -r '.state' "$STATE")" "stopped" "state is stopped after stop"
unset AP_ORCHESTRATOR_CYCLE_FAKE

# --- restart kills the in-flight orchestrator cycle run and resets cadence ---
mkdir -p "$WORK/.pipeline/runs/active"
sleep 120 &                                   # stand-in for an in-flight cycle's claude pid
CYCLE_PID=$!
cat > "$WORK/.pipeline/runs/active/fakecycle.json" <<JSON
{ "runId": "fakecycle", "agent": "orchestrator", "status": "running", "pid": $CYCLE_PID, "startedAt": "2026-06-13T20:00:00Z" }
JSON

export AP_ORCHESTRATOR_CYCLE_FAKE=1
$AP orchestrator restart --target "$WORK" --json >/dev/null
SPID=$(jq -r '.supervisorPid' "$STATE")        # let the EXIT trap reap the restarted supervisor too
# the in-flight orchestrator cycle run (CYCLE_PID) must be killed by restart
for _ in $(seq 1 30); do kill -0 "$CYCLE_PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$CYCLE_PID" 2>/dev/null; then kill "$CYCLE_PID" 2>/dev/null; _fail "restart did not kill the in-flight orchestrator run"; fi
_ok "restart killed the in-flight orchestrator cycle run"
assert_eq "$(jq -r '.state' "$STATE")" "running" "restart leaves state running"
assert_neq "$SPID" "null" "restart ensured a live supervisor"
$AP orchestrator stop --target "$WORK" >/dev/null
unset AP_ORCHESTRATOR_CYCLE_FAKE

echo
echo "12-orchestrator: all assertions passed"
