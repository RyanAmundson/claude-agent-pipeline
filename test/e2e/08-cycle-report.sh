#!/usr/bin/env bash
# 08-cycle-report.sh — unit test for orchestrator cycle reports:
# `agent-pipeline cycle report`, .pipeline/runs/cycles.jsonl, and the
# watcher's cycle.report events. No claude, $0, ~5s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 08-cycle-report ═══════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-cycle)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pipeline/queue/needs-work" "$WORK/.pipeline/queue/ready-for-human"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem" }
JSON
CY="$WORK/.pipeline/runs/cycles.jsonl"

cat > "$WORK/.pipeline/queue/needs-work/fs-001.json" <<'JSON'
{ "id": "fs-001", "title": "first ticket", "priority": 2 }
JSON
cat > "$WORK/.pipeline/queue/ready-for-human/fs-002.json" <<'JSON'
{ "id": "fs-002", "title": "review me", "priority": 2 }
JSON

# ── 1) first cycle: FS auto-counts, cycle=1, no deltas, file created ───────
OUT=$($AP cycle report --target "$WORK" \
  --data '{"dispatched":[{"agent":"worker","item":"fs-001"}],"awaiting":["fs-002"],"nextCheckSeconds":270}')
assert_file_exists "$CY" "cycles.jsonl created"
assert_eq "$(jq -s 'length' "$CY")" "1" "one line after first report"
assert_eq "$(jq -r '.cycle' "$CY")" "1" "first cycle is 1"
assert_eq "$(jq -r '.v' "$CY")" "1" "schema version stamped"
assert_eq "$(jq -r '.counts["needs-work"]' "$CY")" "1" "needs-work auto-counted from queue"
assert_eq "$(jq -r '.counts["ready-for-human"]' "$CY")" "1" "ready-for-human auto-counted"
assert_eq "$(jq -r '.backend' "$CY")" "filesystem" "backend stamped from config"
assert_contains "$OUT" "[orchestrator] cycle 1" "block header present"
assert_contains "$OUT" "backend: filesystem" "header names backend"
assert_contains "$OUT" "dispatched 1 worker" "dispatch annotation on stage line"
assert_contains "$OUT" "awaiting you: fs-002" "awaiting-you line"
assert_contains "$OUT" "next check in 270s" "footer countdown"
if echo "$OUT" | grep -qF '(='; then _fail "first cycle must not render deltas"
else _ok "no delta column on first cycle"; fi

# ── 2) second cycle: deltas vs cycle 1, zero-count state with delta shows ──
mv "$WORK/.pipeline/queue/needs-work/fs-001.json" "$WORK/.pipeline/queue/ready-for-human/"
OUT2=$($AP cycle report --target "$WORK" --data '{"nextCheckSeconds":600}')
assert_contains "$OUT2" "cycle 2" "cycle number increments"
assert_eq "$(jq -s '.[1].cycle' "$CY")" "2" "second line is cycle 2"
assert_contains "$OUT2" "needs-work" "zero-count state renders when delta != 0"
assert_contains "$OUT2" "(-1)" "negative delta rendered"
assert_contains "$OUT2" "(+1)" "positive delta rendered"
if echo "$OUT2" | grep -qF "needs-triage"; then _fail "zero/zero state must be omitted"
else _ok "zero-count zero-delta state omitted"; fi

# ── 3) validation errors ───────────────────────────────────────────────────
if $AP cycle report --target "$WORK" --data '{nope' >/dev/null 2>"$WORK/err1.txt"; then
  _fail "malformed --data must exit non-zero"
else _ok "malformed --data exits non-zero"; fi
assert_contains "$(cat "$WORK/err1.txt")" "not valid JSON" "error names the problem"

if $AP cycle report --target "$WORK" --data '{"counts":{"bogus":1}}' >/dev/null 2>"$WORK/err2.txt"; then
  _fail "unknown state must exit non-zero"
else _ok "unknown count state exits non-zero"; fi
assert_contains "$(cat "$WORK/err2.txt")" "unknown state 'bogus'" "error names the bad state"

if $AP cycle report --target "$WORK" >/dev/null 2>"$WORK/err3.txt"; then
  _fail "missing --data must exit non-zero"
else _ok "missing --data exits non-zero"; fi
assert_contains "$(cat "$WORK/err3.txt")" "--data is required" "usage error names the flag"

# ── 4) linear backend requires counts ──────────────────────────────────────
LWORK="$(mktemp -d -t ap-cycle-linear)"
mkdir -p "$LWORK/.pipeline"
cat > "$LWORK/.pipeline/config.json" <<'JSON'
{ "backend": "linear" }
JSON
if $AP cycle report --target "$LWORK" --data '{}' >/dev/null 2>"$LWORK/err.txt"; then
  _fail "linear backend without counts must exit non-zero"
else _ok "linear backend without counts exits non-zero"; fi
assert_contains "$(cat "$LWORK/err.txt")" "required when backend is 'linear'" "error explains why + names the fix"
LOUT=$($AP cycle report --target "$LWORK" --data '{"counts":{"needs-work":3},"nextCheckSeconds":600}')
assert_contains "$LOUT" "backend: linear" "linear mode works with explicit counts"
assert_eq "$(jq -r '.counts["needs-work"]' "$LWORK/.pipeline/runs/cycles.jsonl")" "3" "explicit counts stored"
rm -rf "$LWORK"

# ── 5) corrupt tail: fail-open, warn, numbering restarts ───────────────────
echo 'GARBAGE NOT JSON' >> "$CY"
OUT3=$($AP cycle report --target "$WORK" --data '{}' 2>"$WORK/warn.txt")
assert_contains "$(cat "$WORK/warn.txt")" "not valid JSON" "corrupt tail warns on stderr"
assert_contains "$OUT3" "cycle 1" "fail-open: treated as first cycle"
assert_eq "$(tail -1 "$CY" | jq -r '.cycle')" "1" "appended line is cycle 1"

# ── 6) idle cycle still renders a block ────────────────────────────────────
OUT4=$($AP cycle report --target "$WORK" --data '{"nextCheckSeconds":1800}')
assert_contains "$OUT4" "[orchestrator] cycle 2" "idle cycle still reports"
assert_contains "$OUT4" "0 dispatched" "idle footer shows zero dispatches"

# ── 7) notes render ────────────────────────────────────────────────────────
OUT5=$($AP cycle report --target "$WORK" \
  --data '{"notes":["self-healing: re-queued stale fs-098"],"nextCheckSeconds":600}')
assert_contains "$OUT5" "✓ self-healing: re-queued stale fs-098" "notes render with check mark"

# ── 8) watcher emits cycle.report exactly once per append ─────────────────
$AP events --target "$WORK" --json > "$WORK/events.out" 2>/dev/null &
EV_PID=$!
sleep 1
$AP cycle report --target "$WORK" --data '{"nextCheckSeconds":600}' >/dev/null
for _ in $(seq 1 25); do
  grep -q '"type":"cycle.report"' "$WORK/events.out" 2>/dev/null && break
  sleep 0.2
done
kill "$EV_PID" 2>/dev/null
wait "$EV_PID" 2>/dev/null
assert_contains "$(cat "$WORK/events.out")" '"type":"cycle.report"' "watcher emitted cycle.report"
assert_eq "$(grep -c '"type":"cycle.report"' "$WORK/events.out")" "1" "emitted exactly once (no history replay, no double-emit)"
# the emitted entry must be the line just appended, not a replayed earlier one
EMITTED=$(grep '"type":"cycle.report"' "$WORK/events.out" | head -1 | jq -r '.cycle.cycle')
assert_eq "$EMITTED" "$(tail -1 "$CY" | jq -r '.cycle')" "emitted entry matches the appended cycles.jsonl line"

# ── 9) --data - reads payload from stdin (special-char robustness) ────────────
STDIN_OUT=$(printf '{"notes":["self-healing: PR #570'"'"'s branch deleted"],"nextCheckSeconds":60}' \
  | $AP cycle report --target "$WORK" --data -)
assert_contains "$STDIN_OUT" "self-healing: PR #570's branch deleted" "stdin payload: note with single-quote renders"
STDIN_NOTE=$(tail -1 "$CY" | jq -r '.notes[0]')
assert_eq "$STDIN_NOTE" "self-healing: PR #570's branch deleted" "stdin payload: note persisted correctly in cycles.jsonl"

echo
echo "08-cycle-report: all assertions passed"
