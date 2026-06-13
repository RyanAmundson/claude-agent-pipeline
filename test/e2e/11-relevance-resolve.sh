#!/usr/bin/env bash
# 11-relevance-resolve.sh — unit test for queue/queue-relevance-resolve.sh.
# No claude, ~1s. Verifies verdict routing: relevant=keep, obsolete+high=move,
# obsolete+medium=flag, configurable threshold, idempotence stamp, audit events,
# and usage errors.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QR="$REPO_ROOT/queue/queue-relevance-resolve.sh"
QE="$REPO_ROOT/queue/queue-relevance-eligible.sh"

echo
echo "═══ 11-relevance-resolve ═════════════════════════════════════════"

WORK="$(mktemp -d -t ap-rel-res)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"

reset() {  # fresh queue holding one needs-work ticket <id>
  rm -rf "$QDIR"
  mkdir -p "$QDIR/needs-work" "$QDIR/ready-for-human"
  printf '{ "id": "%s", "title": "t" }\n' "$1" > "$QDIR/needs-work/$1.json"
}

# 1) relevant → keep (no move, no flag, but stamped)
reset T1
OUT="$(bash "$QR" T1 --verdict relevant --confidence high --queue-dir "$QDIR")"
assert_contains "$OUT" "keep: T1" "relevant verdict → keep"
assert_file_exists "$QDIR/needs-work/T1.json" "kept ticket stays in needs-work"
assert_eq "$(jq -r '.relevance_review // "unset"' "$QDIR/needs-work/T1.json")" "unset" "relevant: no relevance_review flag"
assert_contains "$(jq -r '.relevance_checked_at' "$QDIR/needs-work/T1.json")" "T" "relevant: relevance_checked_at stamped"

# 2) obsolete + high → moved to obsolete/
reset T2
OUT="$(bash "$QR" T2 --verdict obsolete --confidence high --queue-dir "$QDIR")"
assert_contains "$OUT" "obsoleted: T2" "obsolete+high → obsoleted"
assert_file_exists "$QDIR/obsolete/T2.json" "obsoleted ticket moved to obsolete/"
[[ -f "$QDIR/needs-work/T2.json" ]] && _fail "ticket must leave needs-work" || _ok "ticket gone from needs-work"

# 3) obsolete + medium (default threshold high) → flagged, no move
reset T3
OUT="$(bash "$QR" T3 --verdict obsolete --confidence medium --queue-dir "$QDIR")"
assert_contains "$OUT" "flagged: T3" "obsolete+medium (thresh high) → flagged"
assert_file_exists "$QDIR/needs-work/T3.json" "flagged ticket stays in place"
assert_eq "$(jq -r '.relevance_review' "$QDIR/needs-work/T3.json")" "true" "flagged: relevance_review=true"
[[ -f "$QDIR/obsolete/T3.json" ]] && _fail "flagged ticket must NOT move" || _ok "flagged ticket not moved"

# 4) configurable threshold: medium auto-resolves when threshold=medium
reset T4
OUT="$(bash "$QR" T4 --verdict obsolete --confidence medium --auto-resolve-confidence medium --queue-dir "$QDIR")"
assert_contains "$OUT" "obsoleted: T4" "obsolete+medium (thresh medium) → obsoleted"
assert_file_exists "$QDIR/obsolete/T4.json" "moved under medium threshold"

# 5) idempotence: a judged ticket is no longer eligible
reset T5
touch -t 202601010000 "$QDIR/needs-work/T5.json"   # make it stale first
assert_contains "$(bash "$QE" --ticket-stale-hours 1 --queue-dir "$QDIR")" "T5" "stale ticket eligible before judging"
bash "$QR" T5 --verdict relevant --confidence high --queue-dir "$QDIR" >/dev/null
echo "$(bash "$QE" --ticket-stale-hours 1 --queue-dir "$QDIR")" | grep -q "T5" \
  && _fail "judged ticket must not re-list" || _ok "judged ticket excluded next pass (idempotence)"

# 6) audit events recorded
reset T6
bash "$QR" T6 --verdict obsolete --confidence high --queue-dir "$QDIR" >/dev/null
assert_contains "$(cat "$QDIR/events.jsonl")" '"event":"relevance"' "relevance verdict event recorded"
assert_contains "$(cat "$QDIR/events.jsonl")" '"to":"obsolete"' "transition-to-obsolete event recorded"

# 7) dry-run reports the action without writing
reset T7
OUT="$(bash "$QR" T7 --verdict obsolete --confidence high --queue-dir "$QDIR" --dry-run)"
assert_contains "$OUT" "obsoleted: T7 (dry-run)" "dry-run reports the action"
assert_file_exists "$QDIR/needs-work/T7.json" "dry-run does not move the ticket"

# 8) usage errors
reset T8
set +e; bash "$QR" T8 --verdict bogus --confidence high --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "invalid verdict exits 2"
set +e; bash "$QR" NOPE --verdict relevant --confidence high --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "missing ticket exits 1"

echo
echo "${_GRN}✓ 11-relevance-resolve passed${_RST}"
