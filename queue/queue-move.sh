#!/usr/bin/env bash
# queue-move.sh — atomically move a ticket to a different state dir under a lock.
#
# Usage:
#   queue-move.sh <id> --to <state> [--queue-dir <dir>]
#
# Locates <id>.json across state subdirs, stamps updated_at, and moves it into
# <queue-dir>/<state>/. A move to the same state is a no-op (still stamps).
# Serialized with flock(1) when available, else a portable mkdir(2) lock.
set -euo pipefail

ID="${1:-}"
shift 1 2>/dev/null || true
TO=""
QUEUE_DIR=".pipeline/queue"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to) TO="$2"; shift 2 ;;
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$ID" || -z "$TO" ]]; then
    echo "usage: $0 <id> --to <state> [--queue-dir <dir>]" >&2
    exit 2
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOCK="$QUEUE_DIR/.lock"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$QUEUE_DIR"
touch "$LOCK"

_apply() {
    local file="" from=""
    for d in "$QUEUE_DIR"/*/; do
        if [[ -f "$d$ID.json" ]]; then file="$d$ID.json"; from="$(basename "$d")"; break; fi
    done
    if [[ -z "$file" ]]; then echo "no such ticket: $ID" >&2; return 1; fi
    local tmp="$file.tmp.$$"
    jq --arg at "$NOW" '.updated_at = $at' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$file"
    if [[ "$from" != "$TO" ]]; then
        mkdir -p "$QUEUE_DIR/$TO"
        mv "$file" "$QUEUE_DIR/$TO/$ID.json"
    fi
    # Best-effort audit: mirror the move into the event log (matches
    # queue-create.sh / queue-comment.sh / queue-update.sh). Placed inside the
    # lock — unlike the siblings' after-lock placement — because `from` is only
    # in scope here, and an under-lock append reflects the committed state. A
    # failed append must never fail the (already-committed) move.
    bash "$SCRIPT_DIR/queue-event.sh" "$ID" move --queue-dir "$QUEUE_DIR" \
        "from=$from" "to=$TO" 2>/dev/null || true
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

echo "moved: $ID -> $TO"
