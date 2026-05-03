#!/usr/bin/env bash
# queue-list.sh — list tickets in a given pipeline state.
#
# Usage:
#   queue-list.sh <state> [--queue-dir <dir>]
#
# Example:
#   queue-list.sh needs-work
#   queue-list.sh in-progress --queue-dir .pipeline/queue
#
# Output: one line per ticket in the form: <id>\t<priority>\t<title>
# Sorted by priority (highest first), then by oldest mtime.

set -euo pipefail

STATE="${1:-}"
QUEUE_DIR=".pipeline/queue"

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

if [[ -z "$STATE" ]]; then
    echo "usage: $0 <state> [--queue-dir <dir>]" >&2
    exit 2
fi

DIR="$QUEUE_DIR/$STATE"

if [[ ! -d "$DIR" ]]; then
    exit 0
fi

# List JSON files in the state dir, extract id/priority/title, sort.
find "$DIR" -maxdepth 1 -name '*.json' -print0 \
    | while IFS= read -r -d '' file; do
        id=$(jq -r '.id // ""' "$file")
        prio=$(jq -r '.priority // 99' "$file")
        title=$(jq -r '.title // ""' "$file")
        mtime=$(stat -f '%m' "$file" 2>/dev/null || stat -c '%Y' "$file")
        printf '%s\t%s\t%s\t%s\n' "$prio" "$mtime" "$id" "$title"
    done \
    | sort -k1,1n -k2,2n \
    | awk -F'\t' '{ printf "%s\t%s\t%s\n", $3, $1, $4 }'
