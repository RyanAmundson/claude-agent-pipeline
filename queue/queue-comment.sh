#!/usr/bin/env bash
# queue-comment.sh — append a comment to a ticket's comments[] under flock.
#
# Usage:
#   queue-comment.sh <id> --author <name> --body <text> \
#       [--verdict pass|fail] [--state <state>] [--queue-dir <dir>]
#
# Example:
#   queue-comment.sh TKT-001 --author code-reviewer --verdict fail \
#       --body "layer violation in src/x.ts"
#
# Locates <id>.json across the queue state subdirectories (or honors --state),
# then appends { author, verdict, body, at } to .comments and bumps updated_at.
# Serialized via flock(1) when available (matching queue-update.sh); falls back
# to a portable mkdir(2)-based lock when flock is absent (e.g. macOS), which
# preserves cross-process serialization so concurrent appends do not clobber.

set -euo pipefail

ID="${1:-}"
shift 1 2>/dev/null || true

AUTHOR=""
BODY=""
VERDICT="null"
STATE=""
QUEUE_DIR=".pipeline/queue"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --author)    AUTHOR="$2"; shift 2 ;;
        --body)      BODY="$2"; shift 2 ;;
        --verdict)   VERDICT="$2"; shift 2 ;;
        --state)     STATE="$2"; shift 2 ;;
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        *)           shift ;;
    esac
done

if [[ -z "$ID" || -z "$AUTHOR" || -z "$BODY" ]]; then
    echo "usage: $0 <id> --author <name> --body <text> [--verdict pass|fail] [--state <state>] [--queue-dir <dir>]" >&2
    exit 2
fi

if [[ "$VERDICT" != "null" && "$VERDICT" != "pass" && "$VERDICT" != "fail" ]]; then
    echo "invalid --verdict: $VERDICT (want pass|fail)" >&2
    exit 2
fi

# Locate the ticket file.
FILE=""
if [[ -n "$STATE" ]]; then
    FILE="$QUEUE_DIR/$STATE/$ID.json"
else
    if [[ -d "$QUEUE_DIR" ]]; then
        for d in "$QUEUE_DIR"/*/; do
            if [[ -f "$d$ID.json" ]]; then FILE="$d$ID.json"; break; fi
        done
    fi
fi

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
    echo "no such ticket: $ID" >&2
    exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
case "$VERDICT" in
  null) VERDICT_JSON="null" ;;
  pass) VERDICT_JSON='"pass"' ;;
  fail) VERDICT_JSON='"fail"' ;;
esac

_apply() {
    local file="$1"
    local tmp="$file.tmp.$$"
    jq --arg author "$AUTHOR" \
       --arg body "$BODY" \
       --arg at "$NOW" \
       --argjson verdict "$VERDICT_JSON" \
       '.comments = ((.comments // []) + [{author: $author, verdict: $verdict, body: $body, at: $at}]) | .updated_at = $at' \
       "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$file"
}

LOCK="$QUEUE_DIR/.lock"
mkdir -p "$QUEUE_DIR"
touch "$LOCK"

if command -v flock >/dev/null 2>&1; then
    ( flock -x 200; _apply "$FILE" ) 200>"$LOCK"
else
    # flock(1) absent (e.g. macOS): serialize with a portable mkdir lock.
    # mkdir is atomic on POSIX — it fails if the dir already exists, so exactly
    # one process holds the lock at a time. Queue write volume is tiny.
    LOCKDIR="$LOCK.d"
    _waited=0
    until mkdir "$LOCKDIR" 2>/dev/null; do
        sleep 0.05
        _waited=$((_waited + 1))
        if [[ "$_waited" -ge 200 ]]; then
            echo "timeout acquiring lock: $LOCKDIR" >&2
            exit 1
        fi
    done
    _rc=0
    _apply "$FILE" || _rc=$?
    rmdir "$LOCKDIR" 2>/dev/null || true
    [[ "$_rc" -eq 0 ]] || exit "$_rc"
fi

echo "commented: $ID ($AUTHOR)"
