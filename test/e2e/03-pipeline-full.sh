#!/usr/bin/env bash
# 03-pipeline-full.sh
#
# LIVE TEST — requires CAP_E2E_LIVE=1. Most expensive test (~$2–3 per run).
#
# Multi-stage pipeline driven by the CLI: scanner → ticket-creator →
# ticket-reviewer → worker → tester. After each agent stage, the test queries
# the CLI to assert observability matches the agent's actual filesystem
# side-effects.
#
# This is a FORCING FUNCTION as much as a regression test — failures here
# reveal contract gaps between agents and the dispatch surface that the
# unit-of-one tests don't expose.

set -uo pipefail

if [ "${CAP_E2E_LIVE:-0}" != "1" ]; then
  echo "SKIP: live tests require CAP_E2E_LIVE=1 (this test costs \$2–3 in OAuth quota)"
  exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/setup.sh"
. "$HERE/lib/assertions.sh"

# Bump default per-run budget since each stage can be a few hundred K tokens
AP_BUDGET="${AP_BUDGET:-0.50}"

echo
echo "═══ 03-pipeline-full (live) ══════════════════════════════════════"

# Helper: dispatch + wait + assert success, return runId
run_stage() {
  local stage_name="$1"
  local agent="$2"
  local prompt="$3"
  echo
  echo "── stage: $stage_name ── ($agent)"
  local res run_id status exit_code
  res=$(ap run "$agent" --prompt "$prompt" --max-budget-usd "$AP_BUDGET" --detach --json)
  run_id=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
  echo "  dispatched: $run_id"
  sleep 2
  assert_run_in_active "$run_id"
  ap runs "$run_id" --follow
  echo
  status=$(ap runs "$run_id" --json | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")
  exit_code=$(ap runs "$run_id" --json | python3 -c "import json,sys; print(json.load(sys.stdin).get('exitCode',''))")
  if [ "$status" != "completed" ]; then
    echo "${_DIM}  stage failed — final run JSON:${_RST}"
    ap runs "$run_id" --json | head -40
    _fail "$stage_name: status=$status exitCode=$exit_code"
  fi
  _ok "$stage_name completed (exit $exit_code)"
  echo "$run_id"
}

# ─── Stage 1: scanner produces findings ────────────────────────────────────
SCAN_RUN=$(run_stage "scan" scanner \
  "Scan src/ for quality issues per your role definition. Write each finding as a JSON file under .pipeline/queue/needs-triage/ with shape {id, title, description, source:{file,line,agent}}. Use short IDs like 'silent-error-1'. Stop when done.")

assert_ticket_count_in_state "needs-triage" 1
TRIAGE_COUNT=$(ls "$AP_TARGET/.pipeline/queue/needs-triage/"*.json 2>/dev/null | wc -l | tr -d ' ')
echo "  → $TRIAGE_COUNT ticket(s) created in needs-triage/"

# ─── Stage 2: ticket-reviewer triages to needs-work ────────────────────────
REVIEW_RUN=$(run_stage "review-tickets" ticket-reviewer \
  "Read every ticket in .pipeline/queue/needs-triage/. For each one that has clear scope (file, problem, change to make), MOVE the JSON file to .pipeline/queue/needs-work/. For anything ambiguous, leave it in place. Use git mv where possible. Stop when done.")

assert_ticket_count_in_state "needs-work" 1
WORK_COUNT=$(ls "$AP_TARGET/.pipeline/queue/needs-work/"*.json 2>/dev/null | wc -l | tr -d ' ')
echo "  → $WORK_COUNT ticket(s) advanced to needs-work/"

# ─── Stage 3: worker implements one ticket ─────────────────────────────────
FIRST_TICKET=$(ls "$AP_TARGET/.pipeline/queue/needs-work/"*.json 2>/dev/null | head -1)
[ -n "$FIRST_TICKET" ] || _fail "no ticket to give worker"
TICKET_ID=$(basename "$FIRST_TICKET" .json)
echo "  picked ticket: $TICKET_ID"

WORKER_RUN=$(run_stage "implement" worker \
  "Implement the change described in .pipeline/queue/needs-work/$TICKET_ID.json. When the code change is committed locally, MOVE the ticket JSON to .pipeline/queue/needs-test-review/. Stop when done.")

assert_ticket_count_in_state "needs-test-review" 1

# Did the worker actually change files?
CHANGED=$(cd "$AP_TARGET" && git diff --name-only HEAD~0 2>/dev/null | wc -l | tr -d ' ')
[ "$CHANGED" -gt 0 ] && _ok "worker modified $CHANGED file(s)" \
  || echo "${_DIM}  note: no working-tree changes detected (worker may have committed)${_RST}"

# ─── Stage 4: tester adds coverage ─────────────────────────────────────────
TEST_RUN=$(run_stage "test" tester \
  "Read .pipeline/queue/needs-test-review/$TICKET_ID.json and the changed code. Confirm the change makes sense; you do not need to run tests. MOVE the ticket to .pipeline/queue/ready-for-human/. Stop when done.")

assert_ticket_count_in_state "ready-for-human" 1
echo "  → ticket reached ready-for-human/"

# ─── Final summary ─────────────────────────────────────────────────────────
echo
echo "── final state ───────────────────────────────────────────────────"
ap runs
echo
for s in needs-triage needs-work needs-test-review ready-for-human; do
  c=$(ls "$AP_TARGET/.pipeline/queue/$s/"*.json 2>/dev/null | wc -l | tr -d ' ')
  printf "  %-20s %s\n" "$s" "$c"
done

echo
echo "${_GRN}✓ 03-pipeline-full passed${_RST}"
