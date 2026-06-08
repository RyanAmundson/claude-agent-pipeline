#!/usr/bin/env bash
# demo-live-ui.sh — One-command live demo of the agent-pipeline UI.
#
# Spins up a throwaway target, boots the live-log dashboard, opens it in your
# browser, and dispatches a few real scanner runs so you immediately see
# interleaved agent activity scrolling in the log.
#
# Cost: ~$0.30 total (3 concurrent scanner runs, each capped at $0.10 of OAuth
# quota; counts against your Claude Code subscription, not API billing).
#
# Tear-down: Ctrl+C kills the UI, kills any in-flight supervisors, removes the
# tmp fixture.
#
# Usage:
#   ./scripts/demo-live-ui.sh
#   AP_PORT=8080 AP_RUNS=5 AP_BUDGET=0.20 ./scripts/demo-live-ui.sh

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
AP_BIN="${AP_BIN:-node $REPO_ROOT/bin/cli.js}"
AP_PORT="${AP_PORT:-7733}"
AP_RUNS="${AP_RUNS:-3}"
AP_BUDGET="${AP_BUDGET:-0.10}"
TARGET="$(mktemp -d -t cap-live-ui)"

UI_PID=""

cleanup() {
  echo
  echo "─── shutting down ────────────────────────────────────────────────"
  # Kill any active supervisors first so they don't outlive the UI
  if [ -d "$TARGET/.pipeline/runs/active" ]; then
    for f in "$TARGET"/.pipeline/runs/active/*.json; do
      [ -e "$f" ] || continue
      pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid') or '')" "$f" 2>/dev/null)
      [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "  killed supervisor $pid"
    done
  fi
  [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null && echo "  stopped UI (pid $UI_PID)"
  rm -rf "$TARGET"
  echo "  removed fixture"
  exit 0
}
trap cleanup INT TERM EXIT

# ─── 1) Fixture ────────────────────────────────────────────────────────────
echo "═══ setup ════════════════════════════════════════════════════════"
echo "fixture: $TARGET"
$AP_BIN install "$TARGET" --quiet >/dev/null
mkdir -p "$TARGET/src"
cat > "$TARGET/src/sample.ts" <<'TS'
export async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}
TS
echo "seeded: src/sample.ts (silent-catch pattern)"

# ─── 2) Boot UI ────────────────────────────────────────────────────────────
echo
echo "═══ boot UI ══════════════════════════════════════════════════════"
$AP_BIN ui --target "$TARGET" --port "$AP_PORT" --open >/tmp/ap-demo-ui.log 2>&1 &
UI_PID=$!
# Wait for port to listen
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs "http://127.0.0.1:$AP_PORT/api/v1/snapshot" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
if ! curl -fs "http://127.0.0.1:$AP_PORT/api/v1/snapshot" >/dev/null 2>&1; then
  echo "FAIL: UI did not start on port $AP_PORT. Log:"
  cat /tmp/ap-demo-ui.log
  exit 1
fi
echo "UI → http://127.0.0.1:$AP_PORT/    (pid $UI_PID)"
echo "    (browser should have opened; if not, click that URL)"

# ─── 3) Dispatch runs ──────────────────────────────────────────────────────
echo
echo "═══ dispatch $AP_RUNS run(s) ═════════════════════════════════════"
PROMPTS=(
  "Read src/sample.ts. In one short sentence, say whether the catch is silent. Stop."
  "Read src/sample.ts and tell me one thing that could be improved in a single sentence. Stop."
  "Read src/sample.ts. List one specific issue you'd fix. Keep it brief. Stop."
  "Skim src/sample.ts and report one observation in 10 words or fewer. Stop."
  "Read src/sample.ts. One sentence: is error feedback reaching the user? Stop."
)
for i in $(seq 1 "$AP_RUNS"); do
  idx=$(( (i - 1) % ${#PROMPTS[@]} ))
  prompt="${PROMPTS[$idx]}"
  res=$($AP_BIN run scanner \
    --prompt "$prompt" \
    --target "$TARGET" \
    --max-budget-usd "$AP_BUDGET" \
    --detach --json)
  runId=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
  echo "  → $runId"
done

# ─── 4) Hold ───────────────────────────────────────────────────────────────
echo
echo "═══ watching ═════════════════════════════════════════════════════"
echo "Live events streaming in browser at http://127.0.0.1:$AP_PORT/"
echo "Press Ctrl+C to stop everything and clean up."
echo

# Tail the active-runs count so the terminal has something to show
while true; do
  if [ -d "$TARGET/.pipeline/runs/active" ]; then
    active=$(find "$TARGET/.pipeline/runs/active" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    completed=$(find "$TARGET/.pipeline/runs/completed" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    printf "\r  active: %s   completed: %s   (Ctrl+C to quit)   " "$active" "$completed"
  fi
  sleep 1
done
