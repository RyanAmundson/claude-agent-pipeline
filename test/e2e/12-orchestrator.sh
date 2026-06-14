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
trap 'rm -rf "$WORK"' EXIT
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

echo
echo "12-orchestrator: all assertions passed"
