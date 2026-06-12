#!/usr/bin/env bash
# 08-queue-molecule.sh — unit test for the Phase 1 durable-molecule layer:
# queue/queue-molecule.sh (create/next/advance/status) and its `molecule` events
# in the shared Phase 0 audit log. No claude, $0, ~2s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
Q="$REPO_ROOT/queue"
QM="$Q/queue-molecule.sh"

echo
echo "═══ 08-queue-molecule ═════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-qm)"
trap 'rm -rf "$WORK"' EXIT
PIPE="$WORK/.pipeline"
QDIR="$PIPE/queue"
MDIR="$PIPE/molecules"
WF="$PIPE/workflows.json"
mkdir -p "$PIPE"
cat > "$WF" <<'JSON'
{ "workflows": {
  "bugfix": { "steps": [
    { "agent": "worker" },
    { "agent": "tester", "when": "hasCodeChanges" },
    { "agent": "code-reviewer" },
    { "agent": "feedback-responder", "loop": "until-approved" }
  ]},
  "docs": { "steps": [ { "agent": "technical-docs-manager" }, { "agent": "code-reviewer" } ] }
}}
JSON

m() { bash "$QM" "$@" --molecules-dir "$MDIR" --queue-dir "$QDIR" --workflows "$WF"; }

# 1) create instantiates the molecule from the template
m create TKT-001 bugfix >/dev/null
MF="$MDIR/TKT-001.json"
assert_file_exists "$MF" "molecule file created"
assert_eq "$(jq -r '.ticket' "$MF")" "TKT-001" "molecule.ticket set"
assert_eq "$(jq -r '.template' "$MF")" "bugfix" "molecule.template set"
assert_eq "$(jq '.cursor' "$MF")" "0" "cursor starts at 0"
assert_eq "$(jq '.steps | length' "$MF")" "4" "4 steps from template"
assert_eq "$(jq -r '[.steps[].status] | unique | join(",")' "$MF")" "pending" "all steps start pending"
assert_eq "$(jq -r '.steps[0].agent' "$MF")" "worker" "first step is worker"

# 2) when/loop metadata carried onto the steps (for Phase 2 to consume)
assert_eq "$(jq -r '.steps[1].when' "$MF")" "hasCodeChanges" "when carried onto tester step"
assert_eq "$(jq -r '.steps[3].loop' "$MF")" "until-approved" "loop carried onto feedback step"

# 3) next returns the current step's agent
assert_eq "$(m next TKT-001)" "worker" "next = worker at cursor 0"

# 4) advance marks the step done, stamps run/at, moves the cursor
m advance TKT-001 --by worker --run RUN-1 >/dev/null
assert_eq "$(jq -r '.steps[0].status' "$MF")" "done" "step 0 marked done"
assert_eq "$(jq -r '.steps[0].run' "$MF")" "RUN-1" "step 0 records the run id"
assert_contains "$(jq -r '.steps[0].at' "$MF")" "T" "step 0 stamped with ISO time"
assert_eq "$(jq '.cursor' "$MF")" "1" "cursor advanced to 1"
assert_eq "$(m next TKT-001)" "tester" "next = tester after advance"

# 5) advance through to completion → cursor == len, complete event
m advance TKT-001 --by tester >/dev/null
m advance TKT-001 --by code-reviewer >/dev/null
OUT="$(m advance TKT-001 --by feedback-responder)"
assert_contains "$OUT" "molecule complete" "final advance reports completion"
assert_eq "$(jq '.cursor' "$MF")" "4" "cursor == number of steps when complete"
assert_eq "$(m next TKT-001)" "" "next is empty when complete"

# 6) advancing a complete molecule exits 1
set +e; m advance TKT-001 >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "advance on a complete molecule exits 1"

# 7) the molecule events landed in the shared Phase 0 audit log
HIST="$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR" --json)"
assert_eq "$(printf '%s\n' "$HIST" | jq -s '[.[] | select(.event=="molecule" and .action=="create")] | length')" "1" "one create event logged"
assert_eq "$(printf '%s\n' "$HIST" | jq -s '[.[] | select(.event=="molecule" and .action=="advance")] | length')" "4" "four advance events logged"
assert_eq "$(printf '%s\n' "$HIST" | jq -s '[.[] | select(.event=="molecule" and .action=="complete")] | length')" "1" "one complete event logged"
assert_contains "$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR")" "molecule     create bugfix" "history renders molecule events"

# 8) --status failed marks failed and HOLDS the cursor for retry
m create TKT-002 bugfix >/dev/null
m advance TKT-002 --by worker --status failed >/dev/null
MF2="$MDIR/TKT-002.json"
assert_eq "$(jq -r '.steps[0].status' "$MF2")" "failed" "failed step marked failed"
assert_eq "$(jq '.cursor' "$MF2")" "0" "cursor HELD at the failed step (retriable)"
assert_eq "$(m next TKT-002)" "worker" "next still returns the failed step's agent (retry)"

# 9) status: human + json
assert_eq "$(m status TKT-002 --json | jq -r '.template')" "bugfix" "status --json emits the molecule"
assert_contains "$(m status TKT-002)" "✗ worker (failed)" "status human marks the failed step"

# 10) docs template → 2 steps
m create TKT-003 docs >/dev/null
assert_eq "$(jq '.steps | length' "$MDIR/TKT-003.json")" "2" "docs template yields 2 steps"

# 11) error paths
set +e; m create TKT-009 nope >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "unknown template exits 1"
set +e; m create TKT-001 bugfix >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "re-creating an existing molecule exits 1"
set +e; bash "$QM" create TKT-X bugfix --molecules-dir "$MDIR" --queue-dir "$QDIR" --workflows "$WORK/none.json" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "missing workflows file exits 1"
set +e; bash "$QM" frobnicate TKT-001 --molecules-dir "$MDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "unknown subcommand exits 2"
set +e; bash "$QM" create --molecules-dir "$MDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "missing id exits 2"

echo
echo "${_GRN}✓ 08-queue-molecule passed${_RST}"
