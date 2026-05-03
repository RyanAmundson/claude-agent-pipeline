#!/usr/bin/env bash
# queue-update.sh — read-modify-write a ticket file under flock.
#
# Usage:
#   queue-update.sh <state> <id> <jq-expression> [--queue-dir <dir>]
#
# Example:
#   queue-update.sh in-progress CER-123 '.pr_url = "https://github.com/owner/repo/pull/42"'
#
# Wraps the read-modify-write in flock(1) so concurrent updates serialize.
# Within a single state, claiming + updating + transitioning compose safely:
# - claim is `mv` (atomic)
# - update is flock + jq (serialized)
# - transition is `mv` (atomic)

set -euo pipefail

STATE="${1:-}"
ID="${2:-}"
EXPR="${3:-}"
QUEUE_DIR=".pipeline/queue"

shift 3 2>/dev/null || true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --queue-dir)
            QUEUE_DIR="$2"
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

(
    flock -x 200
    TMP="$FILE.tmp.$$"
    jq "$EXPR" "$FILE" > "$TMP"
    mv "$TMP" "$FILE"
) 200>"$LOCK"

echo "updated: $ID"
