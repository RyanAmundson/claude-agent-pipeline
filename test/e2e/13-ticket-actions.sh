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

# ── comment --json (verdict + plain) ───────────────────────────────────
cat > "$QDIR/needs-code-review/TKT-200.json" <<'JSON'
{ "id": "TKT-200", "title": "review me", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON
OUT=$($AP comment TKT-200 --body "ship it" --verdict pass --json --target "$WORK")
assert_eq "$(echo "$OUT" | jq -r '.ok')" "true" "comment --json reports ok"
assert_eq "$(echo "$OUT" | jq -r '.id')" "TKT-200" "comment --json echoes id"
assert_eq "$(echo "$OUT" | jq -r '.verdict')" "pass" "comment --json echoes verdict"
assert_eq "$(echo "$OUT" | jq -r '.ticket.comments[-1].body')" "ship it" "comment --json returns the updated ticket"
assert_eq "$(echo "$OUT" | jq -r '.ticket.comments[-1].author')" "human" "comment defaults author=human"

OUT=$($AP comment TKT-200 --body "no verdict here" --json --target "$WORK")
assert_eq "$(echo "$OUT" | jq -r '.verdict')" "null" "comment --json verdict is null when omitted"
