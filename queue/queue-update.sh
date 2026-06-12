#!/usr/bin/env bash
# queue-update.sh — read-modify-write a ticket file under flock.
#
# Usage:
#   queue-update.sh <state> <id> <jq-expression> [--queue-dir <dir>]
#
# Example:
#   queue-update.sh in-progress CER-123 '.pr_url = "https://github.com/owner/repo/pull/42"'
#
# Wraps the read-modify-write in flock(1) so concurrent updates serialize when
# flock is available; falls back to a portable mkdir(2)-based lock when it is
# absent (e.g. macOS), which preserves cross-process serialization so concurrent
# updates do not clobber. Mirrors queue-comment.sh.
# Within a single state, claiming + updating + transitioning compose safely:
# - claim is `mv` (atomic)
# - update is flock + jq when available, else mkdir-lock + jq + atomic rename
# - transition is `mv` (atomic)

set -euo pipefail

STATE="${1:-}"
ID="${2:-}"
EXPR="${3:-}"
QUEUE_DIR=".pipeline/queue"
BY=""

shift 3 2>/dev/null || true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --queue-dir)
            QUEUE_DIR="$2"
            shift 2
            ;;
        --by)
            BY="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

if [[ -z "$STATE" || -z "$ID" || -z "$EXPR" ]]; then
    echo "usage: $0 <state> <id> <jq-expression> [--queue-dir <dir>]" >&2
    exit 2
fi

FILE="$QUEUE_DIR/$STATE/$ID.json"
LOCK="$QUEUE_DIR/.lock"

if [[ ! -f "$FILE" ]]; then
    echo "no such ticket: $FILE" >&2
    exit 1
fi

mkdir -p "$QUEUE_DIR"
touch "$LOCK"

_apply() {
    local file="$1"
    local tmp="$file.tmp.$$"
    jq "$EXPR" "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$file"
}

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

# Best-effort audit: record the applied jq expression (replayable). A failed
# append must never fail the (already-committed) update.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/queue-event.sh" "$ID" field --queue-dir "$QUEUE_DIR" \
    ${BY:+--by "$BY"} "expr=$EXPR" "state=$STATE" 2>/dev/null || true

echo "updated: $ID"
