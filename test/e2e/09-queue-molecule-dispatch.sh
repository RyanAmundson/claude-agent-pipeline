#!/usr/bin/env bash
# 09-queue-molecule-dispatch.sh — Phase 2 additions to queue/queue-molecule.sh:
# the `list` subcommand (the orchestrator's dispatch source) and the `skipped`
# advance status (for `when` conditions the orchestrator evaluated as false).
# No claude, $0, ~2s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
Q="$REPO_ROOT/queue"
QM="$Q/queue-molecule.sh"

echo
echo "═══ 09-queue-molecule-dispatch ════════════════════════════════════"

WORK="$(mktemp -d -t ap-qmd)"
trap 'rm -rf "$WORK"' EXIT
PIPE="$WORK/.pipeline"
QDIR="$PIPE/queue"; MDIR="$PIPE/molecules"; WF="$PIPE/workflows.json"
mkdir -p "$PIPE"
cat > "$WF" <<'JSON'
{ "default": "bugfix", "workflows": {
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

# 0) list on an empty store prints nothing and exits 0
assert_eq "$(m list; echo rc=$?)" "rc=0" "list on empty store: no output, exit 0"

# 1) list surfaces each incomplete molecule's NEXT step
m create TKT-001 bugfix >/dev/null
m create TKT-002 docs   >/dev/null
JSON_OUT="$(m list --json)"
assert_eq "$(printf '%s' "$JSON_OUT" | jq 'length')" "2" "list --json returns both molecules"
assert_eq "$(printf '%s' "$JSON_OUT" | jq -r '.[] | select(.ticket=="TKT-001") | .next.agent')" "worker" "TKT-001 next = worker"
assert_eq "$(printf '%s' "$JSON_OUT" | jq -r '.[] | select(.ticket=="TKT-002") | .next.agent')" "technical-docs-manager" "TKT-002 next = technical-docs-manager"

# 2) list human output is tab-separated: ticket, template, cursor/total, agent, status
ROW="$(m list | grep '^TKT-001')"
assert_eq "$(printf '%s' "$ROW" | cut -f2)" "bugfix" "list row carries the template"
assert_eq "$(printf '%s' "$ROW" | cut -f3)" "0/4" "list row carries cursor/total"
assert_eq "$(printf '%s' "$ROW" | cut -f4)" "worker" "list row carries the next agent"

# 3) next.when is exposed so the orchestrator can evaluate the condition
m advance TKT-001 --by worker >/dev/null   # → cursor at tester (when: hasCodeChanges)
assert_eq "$(m list --json | jq -r '.[] | select(.ticket=="TKT-001") | .next.when')" "hasCodeChanges" "list exposes next.when for the cursor step"

# 4) --status skipped advances past the step, marking it skipped (not done)
m advance TKT-001 --status skipped --by orchestrator >/dev/null
MF="$MDIR/TKT-001.json"
assert_eq "$(jq -r '.steps[1].status' "$MF")" "skipped" "skipped step recorded as skipped"
assert_eq "$(jq '.cursor' "$MF")" "2" "cursor advanced past the skipped step"
assert_eq "$(m next TKT-001)" "code-reviewer" "next = code-reviewer after skip"
assert_contains "$(m status TKT-001)" "⊘ tester (skipped)" "status renders the skipped marker"

# 5) skipped emits an advance event with status=skipped
assert_eq "$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR" --json | jq -s '[.[] | select(.event=="molecule" and .status=="skipped")] | length')" "1" "skip logged as a molecule advance(status=skipped)"

# 6) next.loop is exposed for the orchestrator's loop handling
m advance TKT-001 --by code-reviewer >/dev/null   # → cursor at feedback-responder (loop)
assert_eq "$(m list --json | jq -r '.[] | select(.ticket=="TKT-001") | .next.loop')" "until-approved" "list exposes next.loop for the cursor step"

# 7) completed molecules drop out of list
m advance TKT-001 --by feedback-responder >/dev/null   # completes TKT-001
assert_eq "$(m list --json | jq 'length')" "1" "completed molecule no longer listed"
assert_eq "$(m list --json | jq -r '.[0].ticket')" "TKT-002" "only the still-active molecule remains"

# 8) invalid status still rejected (now includes skipped in the allowed set)
set +e; m advance TKT-002 --status frob >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "invalid --status exits 2"

echo
echo "${_GRN}✓ 09-queue-molecule-dispatch passed${_RST}"
