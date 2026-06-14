#!/usr/bin/env bash
# 13-ticket-actions.sh — human-facing ticket action verbs: ticket create/move/
# update + comment --json. No claude; pure queue ops; runs on every platform.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 13-ticket-actions ═════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-tkt)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
mkdir -p "$QDIR/needs-triage" "$QDIR/needs-code-review" "$QDIR/done"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem" }
JSON

# ── ticket create ──────────────────────────────────────────────────────
OUT=$($AP ticket create --title "Fix the thing" --priority 2 --id TKT-100 --json --target "$WORK")
assert_eq "$(echo "$OUT" | jq -r '.ok')" "true" "create reports ok"
assert_eq "$(echo "$OUT" | jq -r '.ticket.id')" "TKT-100" "create returns the ticket id"
assert_eq "$(echo "$OUT" | jq -r '.ticket.title')" "Fix the thing" "create stores the title"
assert_eq "$(echo "$OUT" | jq -r '.ticket.priority')" "2" "create stores the priority"
assert_file_exists "$QDIR/needs-triage/TKT-100.json" "create writes into the default state dir"
assert_contains "$(jq -r '.created_at' "$QDIR/needs-triage/TKT-100.json")" "T" "create stamps created_at"

# create appends a best-effort audit event to events.jsonl (matches 07-queue-audit style)
CREATE_EVT="$(jq -c 'select(.ticket=="TKT-100" and .event=="create")' "$QDIR/events.jsonl")"
assert_eq "$(printf '%s' "$CREATE_EVT" | jq -r '.state')" "needs-triage" "create writes an audit event (state=needs-triage)"

# create refuses to clobber an existing id
if $AP ticket create --title dup --id TKT-100 --json --target "$WORK" >/dev/null 2>&1; then
  echo "FAIL: create should reject a duplicate id"; exit 1
fi
echo "  ok: create rejects duplicate id"
