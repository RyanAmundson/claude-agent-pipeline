#!/usr/bin/env bash
# queue-stale.sh — find stale tickets in `in-progress/` and re-queue them.
#
# Usage:
#   queue-stale.sh [--max-age-hours N] [--queue-dir <dir>] [--dry-run]
#
# A ticket in `in-progress/` is stale if its mtime is older than --max-age-hours
# AND no commit in the repo references its ID in the same window.
#
# Stale tickets are moved back to `needs-work/` with a `stale_count` field
# incremented. After 3 stale cycles, a ticket gets `needs-info` instead.

set -euo pipefail

MAX_AGE_HOURS=2
QUEUE_DIR=".pipeline/queue"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
        --queue-dir)     QUEUE_DIR="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=1; shift ;;
        *)               shift ;;
    esac
done

IN_PROGRESS="$QUEUE_DIR/in-progress"
[[ ! -d "$IN_PROGRESS" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NOW=$(date +%s)
THRESHOLD=$((MAX_AGE_HOURS * 3600))

find "$IN_PROGRESS" -maxdepth 1 -name '*.json' -print0 \
    | while IFS= read -r -d '' file; do
        mtime=$(stat -f '%m' "$file" 2>/dev/null || stat -c '%Y' "$file")
        age=$((NOW - mtime))

        if [[ "$age" -lt "$THRESHOLD" ]]; then
            continue
        fi

        id=$(jq -r '.id' "$file")

        # Has any commit referenced this id in the time window?
        if git log --since="$MAX_AGE_HOURS hours ago" --grep="$id" --oneline | grep -q .; then
            continue
        fi

        stale_count=$(jq -r '.stale_count // 0' "$file")
        new_stale=$((stale_count + 1))

        if [[ "$new_stale" -ge 3 ]]; then
            target_state="needs-info"
            echo "stale (3x) → needs-info: $id"
        else
            target_state="needs-work"
            echo "stale → needs-work: $id (count=$new_stale)"
        fi

        if [[ "$DRY_RUN" -eq 0 ]]; then
            mkdir -p "$QUEUE_DIR/$target_state"
            jq ".stale_count = $new_stale" "$file" > "$file.tmp"
            mv "$file.tmp" "$QUEUE_DIR/$target_state/$(basename "$file")"
            rm -f "$file"

            # Best-effort audit of the stale re-queue.
            bash "$SCRIPT_DIR/queue-event.sh" "$id" transition --queue-dir "$QUEUE_DIR" \
                --by stale-sweep "from=in-progress" "to=$target_state" \
                "reason=stale(${new_stale}x)" 2>/dev/null || true
        fi
    done
