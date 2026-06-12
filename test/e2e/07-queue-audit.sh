#!/usr/bin/env bash
# 07-queue-audit.sh — unit test for the Phase 0 versioned-audit layer:
# queue/queue-event.sh, queue/queue-history.sh, and the event emission wired into
# queue-claim.sh / queue-update.sh / queue-comment.sh / queue-stale.sh.
# No claude, $0, ~2s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
Q="$REPO_ROOT/queue"

echo
echo "═══ 07-queue-audit ════════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-qa)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
LOG="$QDIR/events.jsonl"
mkdir -p "$QDIR/needs-work"
cat > "$QDIR/needs-work/TKT-001.json" <<'JSON'
{ "id": "TKT-001", "title": "demo", "priority": 2,
  "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON

# 1) claim emits a transition event (from/to/by)
bash "$Q/queue-claim.sh" TKT-001 needs-work in-progress --queue-dir "$QDIR" --by worker >/dev/null
assert_file_exists "$LOG" "event log created on first emit"
assert_eq "$(jq -s 'length' "$LOG")" "1" "one event after claim"
assert_eq "$(jq -r 'select(.event=="transition") | .from' "$LOG")" "needs-work" "transition.from recorded"
assert_eq "$(jq -r 'select(.event=="transition") | .to' "$LOG")" "in-progress" "transition.to recorded"
assert_eq "$(jq -r 'select(.event=="transition") | .by' "$LOG")" "worker" "transition.by recorded"
assert_contains "$(jq -r '.ts' "$LOG")" "T" "event ts is ISO-8601"

# 2) update emits a field event carrying the raw jq expr (replayable) + state
bash "$Q/queue-update.sh" in-progress TKT-001 '.pr_url="https://x/42"' --queue-dir "$QDIR" --by worker >/dev/null
FIELD="$(jq -c 'select(.event=="field")' "$LOG")"
assert_eq "$(printf '%s' "$FIELD" | jq -r '.expr')" '.pr_url="https://x/42"' "field.expr preserved verbatim (value contains '=')"
assert_eq "$(printf '%s' "$FIELD" | jq -r '.state')" "in-progress" "field.state recorded"
assert_eq "$(printf '%s' "$FIELD" | jq -r '.by')" "worker" "field.by recorded"

# 3) comment emits a comment event (author/verdict/body)
bash "$Q/queue-comment.sh" TKT-001 --author code-reviewer --verdict fail --body "layer violation" --queue-dir "$QDIR" >/dev/null
CMT="$(jq -c 'select(.event=="comment")' "$LOG")"
assert_eq "$(printf '%s' "$CMT" | jq -r '.author')" "code-reviewer" "comment.author recorded"
assert_eq "$(printf '%s' "$CMT" | jq -r '.verdict')" "fail" "comment.verdict recorded"
assert_eq "$(printf '%s' "$CMT" | jq -r '.body')" "layer violation" "comment.body recorded"
assert_eq "$(jq -s 'length' "$LOG")" "3" "three events total (transition+field+comment)"

# 4) every line is valid, single-line JSON (compact append, no interleave)
assert_eq "$(grep -c '' "$LOG")" "3" "log has exactly 3 physical lines"
jq -e -s 'all(.[]; type=="object")' "$LOG" >/dev/null && _ok "all log lines parse as JSON objects"

# 5) queue-history.sh --json returns this ticket's events in log order
H="$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR" --json)"
assert_eq "$(printf '%s\n' "$H" | jq -s 'length')" "3" "history --json returns 3 events"
assert_eq "$(printf '%s\n' "$H" | jq -rs '.[0].event + "," + .[1].event + "," + .[2].event')" \
  "transition,field,comment" "history preserves log order"

# 6) queue-history.sh human output is readable per type
HUMAN="$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR")"
assert_contains "$HUMAN" "needs-work → in-progress" "human: transition rendered with arrow"
assert_contains "$HUMAN" ".pr_url=" "human: field rendered with expr"
assert_contains "$HUMAN" "[fail] code-reviewer: layer violation" "human: comment rendered with verdict"

# 7) multi-ticket isolation: a second ticket's events don't leak into the first
mkdir -p "$QDIR/needs-work"
cat > "$QDIR/needs-work/TKT-002.json" <<'JSON'
{ "id": "TKT-002", "title": "other", "priority": 3 }
JSON
bash "$Q/queue-claim.sh" TKT-002 needs-work in-progress --queue-dir "$QDIR" --by worker >/dev/null
assert_eq "$(bash "$Q/queue-history.sh" TKT-001 --queue-dir "$QDIR" --json | jq -s 'length')" "3" \
  "TKT-001 history unchanged after TKT-002 event"
assert_eq "$(bash "$Q/queue-history.sh" TKT-002 --queue-dir "$QDIR" --json | jq -s 'length')" "1" \
  "TKT-002 history isolated to its own event"

# 8) queue-stale.sh emits a transition with a stale reason
#    Make TKT-002 (in in-progress) look old, then sweep with a 0h threshold.
touch -t 202001010000 "$QDIR/in-progress/TKT-002.json"
bash "$Q/queue-stale.sh" --max-age-hours 0 --queue-dir "$QDIR" >/dev/null
STALE="$(bash "$Q/queue-history.sh" TKT-002 --queue-dir "$QDIR" --json | jq -c 'select(.by=="stale-sweep")')"
assert_eq "$(printf '%s' "$STALE" | jq -r '.from')" "in-progress" "stale event from=in-progress"
assert_contains "$(printf '%s' "$STALE" | jq -r '.reason')" "stale" "stale event carries a stale reason"

# 9) best-effort: a non-writable log must NOT fail the mutation
#    (audit is secondary — a failed append never blocks work). Skip when running
#    as root, where file-mode write restrictions don't apply.
if [ "$(id -u)" -ne 0 ]; then
  cp "$QDIR/needs-work/"*.json "$QDIR/" 2>/dev/null || true
  cat > "$QDIR/needs-work/TKT-003.json" <<'JSON'
{ "id": "TKT-003", "title": "best-effort", "priority": 2 }
JSON
  chmod 000 "$LOG"
  set +e
  bash "$Q/queue-claim.sh" TKT-003 needs-work in-progress --queue-dir "$QDIR" --by worker >/dev/null 2>&1
  RC=$?
  set -e
  chmod 644 "$LOG"
  assert_eq "$RC" "0" "claim still succeeds when the audit log is unwritable (best-effort)"
  assert_file_exists "$QDIR/in-progress/TKT-003.json" "ticket actually moved despite failed audit append"
else
  _ok "skipped unwritable-log sub-test (running as root)"
fi

# 10) queue-event.sh usage error exits 2
set +e; bash "$Q/queue-event.sh" TKT-001 --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "queue-event.sh missing event-type exits 2"

# 11) concurrency: 8 parallel emits all land as distinct valid JSON lines
CDIR="$WORK/conc/.pipeline/queue"; mkdir -p "$CDIR"
for i in 1 2 3 4 5 6 7 8; do
  bash "$Q/queue-event.sh" "TKT-$i" transition --queue-dir "$CDIR" "from=a" "to=b" >/dev/null &
done
wait
assert_eq "$(grep -c '' "$CDIR/events.jsonl")" "8" "8 concurrent emits produced 8 lines (no clobber)"
jq -e -s 'all(.[]; type=="object")' "$CDIR/events.jsonl" >/dev/null && _ok "all 8 concurrent lines are valid JSON (no interleave)"

echo
echo "${_GRN}✓ 07-queue-audit passed${_RST}"
