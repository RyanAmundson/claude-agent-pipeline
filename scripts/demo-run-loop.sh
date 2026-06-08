#!/usr/bin/env bash
# demo-run-loop.sh — End-to-end test of the agent-pipeline run/runs CLI.
#
# What it does:
#   1. Creates a throwaway target directory in a tmp dir
#   2. Installs the agent-pipeline agents into it
#   3. Seeds a sample source file for the agent to look at
#   4. Dispatches a real scanner run in --detach mode
#   5. Queries the run via every CLI surface (list, single, JSON, follow, events)
#   6. Tears the whole thing down on exit (including any orphaned processes)
#
# Cost: caps at $0.30 of OAuth-tracked token spend (counts against your Claude
# Code plan quota, not API billing).
#
# Usage:
#   ./scripts/demo-run-loop.sh
#   AP_BIN=agent-pipeline ./scripts/demo-run-loop.sh   # if globally linked
#   AP_BUDGET=0.50 ./scripts/demo-run-loop.sh          # raise the budget cap

set -u   # `set -e` would mask intentional exit codes from CLI commands

# ─── config ────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
AP_BIN="${AP_BIN:-node $REPO_ROOT/bin/cli.js}"
AP_BUDGET="${AP_BUDGET:-0.30}"
TARGET="$(mktemp -d -t cap-demo)"

# ─── cleanup on any exit ───────────────────────────────────────────────────
cleanup() {
  echo
  echo "─── cleanup ──────────────────────────────────────────────────────"
  if [ -d "$TARGET/.pipeline/runs/active" ]; then
    for f in "$TARGET"/.pipeline/runs/active/*.json; do
      [ -e "$f" ] || continue
      pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid') or '')" "$f" 2>/dev/null)
      [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "killed supervisor $pid"
    done
  fi
  rm -rf "$TARGET"
  echo "removed fixture: $TARGET"
}
trap cleanup EXIT INT TERM

section() { echo; echo "═══ $1 ═══════════════════════════════════════════"; }
cmd()     { echo "\$ $*"; }

# ─── 1) setup ──────────────────────────────────────────────────────────────
section "1) Setup"
echo "fixture: $TARGET"
echo "budget:  \$$AP_BUDGET"

cmd "agent-pipeline install $TARGET --quiet"
$AP_BIN install "$TARGET" --quiet >/dev/null

mkdir -p "$TARGET/.pipeline/queue"/{needs-triage,needs-review,needs-work,in-progress,needs-test-review,needs-code-review,needs-feedback,ready-for-human,done,needs-info}
mkdir -p "$TARGET/src"
cat > "$TARGET/src/sample.js" <<'JS'
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    return await res.json();
  } catch (err) {
    // silent — caller has no way to know the fetch failed
    console.error(err);
    return null;
  }
}
JS
echo "seeded: $TARGET/src/sample.js"

# ─── 2) dispatch ───────────────────────────────────────────────────────────
section "2) Dispatch (--detach returns immediately)"
cmd "agent-pipeline run scanner --prompt '...' --target \$TARGET --max-budget-usd $AP_BUDGET --detach --json"
RES=$($AP_BIN run scanner \
  --prompt "Read src/sample.js and reply in one sentence about any silent error handling. Then stop." \
  --target "$TARGET" \
  --max-budget-usd "$AP_BUDGET" \
  --detach --json)
echo "$RES"

RUN_ID=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
SUP_PID=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('supervisorPid',''))")
echo
echo "runId:         $RUN_ID"
echo "supervisorPid: $SUP_PID"

# brief settle so the supervisor's first writeRun() has happened
sleep 1

# ─── 3) query while running ────────────────────────────────────────────────
section "3) Query while running"

cmd "agent-pipeline runs --target \$TARGET"
$AP_BIN runs --target "$TARGET"

echo
cmd "agent-pipeline runs $RUN_ID --target \$TARGET"
$AP_BIN runs "$RUN_ID" --target "$TARGET"

echo
cmd "agent-pipeline runs $RUN_ID --target \$TARGET --json"
$AP_BIN runs "$RUN_ID" --target "$TARGET" --json

# ─── 4) follow until done ──────────────────────────────────────────────────
section "4) Follow until completion (live tail)"
cmd "agent-pipeline runs $RUN_ID --follow --target \$TARGET"
$AP_BIN runs "$RUN_ID" --follow --target "$TARGET"

# ─── 5) query after completion ─────────────────────────────────────────────
section "5) Query after completion"

cmd "agent-pipeline runs --target \$TARGET"
$AP_BIN runs --target "$TARGET"

echo
cmd "agent-pipeline runs $RUN_ID --target \$TARGET"
$AP_BIN runs "$RUN_ID" --target "$TARGET"

# ─── 6) post-mortem events ─────────────────────────────────────────────────
section "6) Captured event log (text)"
cmd "agent-pipeline runs $RUN_ID events --target \$TARGET"
$AP_BIN runs "$RUN_ID" events --target "$TARGET"

section "7) Captured event log (JSON, first 2 lines)"
cmd "agent-pipeline runs $RUN_ID events --target \$TARGET --json | head -2"
$AP_BIN runs "$RUN_ID" events --target "$TARGET" --json | head -2

echo
echo "demo complete."
