#!/usr/bin/env bash
# queue-create.sh — atomically create a new ticket file under a lock.
#
# Usage:
#   queue-create.sh <state> <id> <json> [--queue-dir <dir>]
#
# Writes <queue-dir>/<state>/<id>.json from the provided JSON object. Refuses to
# clobber an id that already exists in ANY state. Serialized with flock(1) when
# available, else a portable mkdir(2) lock (mirrors queue-comment.sh).
set -euo pipefail

STATE="${1:-}"
ID="${2:-}"
JSON="${3:-}"
QUEUE_DIR=".pipeline/queue"
shift 3 2>/dev/null || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$STATE" || -z "$ID" || -z "$JSON" ]]; then
    echo "usage: $0 <state> <id> <json> [--queue-dir <dir>]" >&2
    exit 2
fi

DIR="$QUEUE_DIR/$STATE"
FILE="$DIR/$ID.json"
LOCK="$QUEUE_DIR/.lock"
mkdir -p "$QUEUE_DIR"
touch "$LOCK"

_apply() {
    # Refuse to clobber an id present in any state (inside the lock).
    if [[ -d "$QUEUE_DIR" ]]; then
        for d in "$QUEUE_DIR"/*/; do
            if [[ -f "$d$ID.json" ]]; then echo "ticket already exists: $ID" >&2; return 1; fi
        done
    fi
    mkdir -p "$DIR"
    local tmp="$FILE.tmp.$$"
    printf '%s' "$JSON" | jq '.' > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$FILE"
}

if command -v flock >/dev/null 2>&1; then
    ( flock -x 200; _apply ) 200>"$LOCK"
else
    LOCKDIR="$LOCK.d"
    _waited=0
    until mkdir "$LOCKDIR" 2>/dev/null; do
        sleep 0.05
        _waited=$((_waited + 1))
        if [[ "$_waited" -ge 200 ]]; then echo "timeout acquiring lock: $LOCKDIR" >&2; exit 1; fi
    done
    _rc=0
    _apply || _rc=$?
    rmdir "$LOCKDIR" 2>/dev/null || true
    [[ "$_rc" -eq 0 ]] || exit "$_rc"
fi

# Best-effort audit: mirror the create into the event log (matches
# queue-comment.sh / queue-update.sh). A failed append must never fail the
# (already-committed) create.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/queue-event.sh" "$ID" create --queue-dir "$QUEUE_DIR" "state=$STATE" 2>/dev/null || true

echo "created: $ID [$STATE]"
