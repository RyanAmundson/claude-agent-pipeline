#!/usr/bin/env bash
# 01-lifecycle-smoke.sh
#
# Verifies the CLI's runs surface end-to-end WITHOUT invoking claude:
# uses a fake supervisor (lib/fake-run.sh) that writes a real run JSON and
# blocks until killed. Cost: $0. Time: ~5 seconds.
#
# This proves the framework works before the live-claude tests are exercised.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/setup.sh"
. "$HERE/lib/assertions.sh"

echo
echo "═══ 01-lifecycle-smoke ════════════════════════════════════════════"

# ─── Stage 1: nothing running ──────────────────────────────────────────────
echo "─ stage 1: empty registry"
ACTIVE_COUNT=$(ap runs --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['active']))")
assert_eq "$ACTIVE_COUNT" "0" "no active runs at start"

# ─── Stage 2: spawn fake supervisor in background ──────────────────────────
echo "─ stage 2: spawn fake supervisor"
FAKE_LOG=$(mktemp)
AP_TARGET="$AP_TARGET" bash "$HERE/lib/fake-run.sh" scanner > "$FAKE_LOG" &
FAKE_PID=$!
# wait for the supervisor to write its first JSON
for _ in 1 2 3 4 5; do
  RUN_ID=$(cat "$FAKE_LOG" | head -1 | tr -d '\n')
  [ -n "$RUN_ID" ] && [ -e "$AP_TARGET/.pipeline/runs/active/$RUN_ID.json" ] && break
  sleep 0.5
done
[ -n "$RUN_ID" ] || { echo "FAIL: fake supervisor never wrote runId" >&2; kill $FAKE_PID 2>/dev/null; exit 1; }
echo "  spawned fake run: $RUN_ID (pid $FAKE_PID)"

# ─── Stage 3: query while running ──────────────────────────────────────────
echo "─ stage 3: CLI sees the active run"
assert_run_in_active "$RUN_ID"
assert_run_status "$RUN_ID" "running"
assert_event_log_has_type "$RUN_ID" "system"

# Plain (non-json) listing should mention the runId
LIST_OUT=$(ap runs)
assert_contains "$LIST_OUT" "$RUN_ID" "plain runs output contains runId"
assert_contains "$LIST_OUT" "scanner" "plain runs output contains agent name"

# Single-run plain output
SINGLE_OUT=$(ap runs "$RUN_ID")
assert_contains "$SINGLE_OUT" "[active]" "single-run output marks active state"

# JSON shape
SINGLE_JSON=$(ap runs "$RUN_ID" --json)
assert_contains "$SINGLE_JSON" "\"agent\": \"scanner\"" "JSON has agent field"

# ─── Stage 4: kill it ──────────────────────────────────────────────────────
echo "─ stage 4: kill via CLI"
KILL_OUT=$(ap runs kill "$RUN_ID")
assert_contains "$KILL_OUT" "sent SIGTERM" "kill prints SIGTERM confirmation"

# Wait for fake supervisor to clean up
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -e "$AP_TARGET/.pipeline/runs/completed/$RUN_ID.json" ]; then break; fi
  sleep 0.3
done
wait $FAKE_PID 2>/dev/null || true

# ─── Stage 5: state moved ──────────────────────────────────────────────────
echo "─ stage 5: lifecycle transition observed"
assert_file_exists "$AP_TARGET/.pipeline/runs/completed/$RUN_ID.json" "run JSON now in completed/"
[ ! -e "$AP_TARGET/.pipeline/runs/active/$RUN_ID.json" ] && _ok "run JSON gone from active/" \
  || _fail "active/$RUN_ID.json still present after kill"
assert_run_in_completed "$RUN_ID"
assert_run_status "$RUN_ID" "killed"

# ─── Stage 6: pipe-safety regression (EPIPE fix) ───────────────────────────
echo "─ stage 6: pipe-safe stdout"
PIPE_OUT=$(ap runs "$RUN_ID" events --json | head -1)
PIPE_EXIT=${PIPESTATUS[0]}
assert_eq "$PIPE_EXIT" "0" "CLI exits 0 when stdout closed by head"
assert_contains "$PIPE_OUT" "\"type\"" "first event line has type field"

rm -f "$FAKE_LOG"
echo
echo "${_GRN}✓ 01-lifecycle-smoke passed${_RST}"
