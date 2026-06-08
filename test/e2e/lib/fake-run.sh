# Writes a fake "active" run JSON and blocks until SIGTERM, simulating a
# supervisor without invoking claude. Used by the smoke test so the framework
# can be verified without burning model budget.
#
# Usage (sourced or executed standalone):
#   AP_TARGET=/tmp/xxx ./lib/fake-run.sh <agent-name>
#   → prints the runId on stdout, blocks until killed
#
# When this script is killed it moves its run JSON from active/ to completed/
# with status: 'killed' so the CLI's lifecycle behavior matches reality.

set -uo pipefail

AGENT="${1:-scanner}"
[ -n "${AP_TARGET:-}" ] || { echo "AP_TARGET required" >&2; exit 1; }

TS=$(date -u +%Y%m%d%H%M%S)
RAND=$(python3 -c "import secrets; print(secrets.token_hex(4))")
RUN_ID="${TS}-${RAND}"
RUNS_DIR="$AP_TARGET/.pipeline/runs"
mkdir -p "$RUNS_DIR/active" "$RUNS_DIR/completed" "$RUNS_DIR/logs"

ACTIVE_PATH="$RUNS_DIR/active/$RUN_ID.json"
COMPLETED_PATH="$RUNS_DIR/completed/$RUN_ID.json"
EVENTS_PATH="$RUNS_DIR/logs/$RUN_ID.events.jsonl"

write_run_json() {
  local state="$1" status="$2" extra="${3:-}"
  python3 -c "
import json,sys
r = {
  'runId': sys.argv[1],
  'agent': sys.argv[2],
  'prompt': 'fake smoke prompt',
  'target': sys.argv[3],
  'status': sys.argv[4],
  'startedAt': sys.argv[5],
  'pid': int(sys.argv[6]),
  'lastEventAt': sys.argv[7],
  'lastActivity': 'simulated',
  'cost': None,
}
extra = sys.argv[8]
if extra:
    r.update(json.loads(extra))
print(json.dumps(r, indent=2))
" "$RUN_ID" "$AGENT" "$AP_TARGET" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$extra"
}

# Initial active record
write_run_json active running > "$ACTIVE_PATH"

# Seed events log with one system event so assert_event_log_has_type works
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"type\":\"system\",\"subtype\":\"init\"}" > "$EVENTS_PATH"

_FINALIZED=0
finalize() {
  [ "$_FINALIZED" = "1" ] && return
  _FINALIZED=1
  local status="$1"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  write_run_json completed "$status" "{\"completedAt\":\"$completed_at\",\"exitCode\":0,\"durationMs\":1000,\"signal\":\"SIGTERM\"}" > "$COMPLETED_PATH"
  rm -f "$ACTIVE_PATH"
}
trap 'finalize killed; exit 0' TERM INT
trap 'finalize completed' EXIT

# Print runId so the test can capture it
echo "$RUN_ID"

# Block forever (or until killed). Reasonable cap so a runaway test isn't
# permanent: 5 minutes.
sleep 300 &
wait $!
