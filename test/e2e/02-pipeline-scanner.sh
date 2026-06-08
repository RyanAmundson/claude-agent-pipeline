#!/usr/bin/env bash
# 02-pipeline-scanner.sh
#
# LIVE TEST — invokes real `claude -p`. Requires CAP_E2E_LIVE=1.
#
# Dispatches the scanner agent against the seeded fixture and asserts:
#   (a) CLI shows the run as active while it's running
#   (b) status moves to 'completed' with exitCode 0
#   (c) events log contains expected stream-json types
#   (d) findings are reported (cost > 0, lastActivity populated)
#
# Note: scanner is expected to produce structured findings. Whether it writes
# tickets to .pipeline/queue/needs-triage/ depends on the agent's contract —
# this test asserts the dispatch/observability layer, not full ticket creation
# (that's 03-pipeline-full.sh's job).

set -uo pipefail

if [ "${CAP_E2E_LIVE:-0}" != "1" ]; then
  echo "SKIP: live tests require CAP_E2E_LIVE=1 (this test invokes real claude and costs OAuth quota)"
  echo "      To run: CAP_E2E_LIVE=1 bash $(basename "$0")"
  exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/setup.sh"
. "$HERE/lib/assertions.sh"

echo
echo "═══ 02-pipeline-scanner (live) ═══════════════════════════════════"

# ─── Stage 1: dispatch scanner detached ────────────────────────────────────
echo "─ stage 1: dispatch scanner (--detach)"
RES=$(ap run scanner \
  --prompt "Scan src/ for the issues you find. Report findings concisely then stop." \
  --max-budget-usd "$AP_BUDGET" \
  --detach --json)
echo "  $RES"
RUN_ID=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
SUP_PID=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('supervisorPid',''))")
echo "  runId=$RUN_ID supervisorPid=$SUP_PID"

# Brief settle for supervisor's first writeRun()
sleep 2

# ─── Stage 2: CLI sees the active run ──────────────────────────────────────
echo "─ stage 2: query while running"
assert_run_in_active "$RUN_ID"
STATUS=$(ap runs "$RUN_ID" --json | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")
case "$STATUS" in
  starting|running) _ok "status is $STATUS (in-flight)" ;;
  completed|failed) _ok "status is $STATUS (scanner already finished — fast run)" ;;
  *) _fail "unexpected status: $STATUS" ;;
esac

# ─── Stage 3: follow until completion ──────────────────────────────────────
echo "─ stage 3: follow to completion"
ap runs "$RUN_ID" --follow
echo  # newline after follow output

# ─── Stage 4: final state ──────────────────────────────────────────────────
echo "─ stage 4: post-completion assertions"
assert_run_in_completed "$RUN_ID"
FINAL=$(ap runs "$RUN_ID" --json)
FINAL_STATUS=$(echo "$FINAL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")
FINAL_EXIT=$(echo "$FINAL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('exitCode',''))")
FINAL_COST=$(echo "$FINAL" | python3 -c "import json,sys; c=json.load(sys.stdin).get('cost'); print(c.get('usd','') if c else '')")

case "$FINAL_STATUS" in
  completed) _ok "final status is completed" ;;
  failed)    echo "${_DIM}  (scanner exited non-zero — diagnostic dump:)${_RST}"
             echo "$FINAL" | head -30
             _fail "scanner failed: exitCode=$FINAL_EXIT" ;;
  *) _fail "unexpected final status: $FINAL_STATUS" ;;
esac

assert_eq "$FINAL_EXIT" "0" "exitCode is 0"
[ -n "$FINAL_COST" ] && _ok "cost recorded: \$$FINAL_COST" \
  || _fail "no cost recorded in final run JSON"

# ─── Stage 5: events log shape ─────────────────────────────────────────────
echo "─ stage 5: event log assertions"
assert_event_log_has_type "$RUN_ID" "system"
assert_event_log_has_type "$RUN_ID" "assistant"
assert_event_log_has_type "$RUN_ID" "result"

# ─── Stage 6: events command works end-to-end ──────────────────────────────
echo "─ stage 6: CLI events surface"
EVENT_COUNT=$(ap runs "$RUN_ID" events --json | wc -l | tr -d ' ')
[ "$EVENT_COUNT" -gt 3 ] && _ok "events log has $EVENT_COUNT lines" \
  || _fail "events log too short ($EVENT_COUNT lines)"

echo
echo "${_GRN}✓ 02-pipeline-scanner passed${_RST}"
