#!/usr/bin/env bash
# queue-relevance-eligible.sh — list queue items the relevance-checker should judge.
#
# Usage:
#   queue-relevance-eligible.sh [--ticket-stale-hours N] [--pr-stale-hours N]
#                               [--queue-dir <dir>] [--json]
#
# The inverse-detector intake: it scans the EXISTING queue (un-worked needs-work
# tickets, parked ready-for-human items) rather than src/ for new work, and emits
# the stale, not-yet-judged items so the orchestrator can dispatch one
# relevance-checker run per item.
#
# An item is eligible iff ALL hold:
#   1. its mtime is older than the per-state threshold
#   2. it has no `relevance_checked_at`, or that timestamp is itself older than
#      the threshold (a just-judged item is skipped; a long-parked one re-ages in)
#   3. `relevance_review` is not already true (already flagged for a human)
#   4. no commit references its id within the threshold window (git-guarded;
#      mirrors queue-stale.sh — skipped cleanly when not in a git repo)
#
# Output (default): one `<id>\t<state>` line per eligible item.
# Output (--json):  a JSON array of {"id","state"} objects ("[]" when none).

set -euo pipefail

TICKET_STALE_HOURS=24
PR_STALE_HOURS=48
QUEUE_DIR=".pipeline/queue"
JSON=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ticket-stale-hours) TICKET_STALE_HOURS="$2"; shift 2 ;;
        --pr-stale-hours)     PR_STALE_HOURS="$2"; shift 2 ;;
        --queue-dir)          QUEUE_DIR="$2"; shift 2 ;;
        --json)               JSON=1; shift ;;
        *)                    shift ;;
    esac
done

NOW=$(date +%s)

_in_git_repo() { git rev-parse --is-inside-work-tree >/dev/null 2>&1; }

# seconds since a file's mtime (GNU stat -c, BSD stat -f)
_age() {
    local mtime
    mtime=$(stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null)
    echo $((NOW - mtime))
}

# epoch of an ISO-8601 Z timestamp (GNU date -d, then BSD date -j -f); 0 on failure
_iso_epoch() {
    date -u -d "$1" +%s 2>/dev/null \
      || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
      || echo 0   # unparseable → 0 → checked_age ≈ NOW → re-eligible (fail-open: re-judge rather than skip)
}

# Print `<id>\t<state>` for each eligible item in one state dir.
_scan_state() {
    local state="$1" threshold_hours="$2"
    local dir="$QUEUE_DIR/$state"
    [[ -d "$dir" ]] || return 0
    local threshold=$((threshold_hours * 3600))

    find "$dir" -maxdepth 1 -name '*.json' -print0 \
      | while IFS= read -r -d '' file; do
            [[ "$(_age "$file")" -ge "$threshold" ]] || continue

            local id; id=$(jq -r '.id // empty' "$file")
            [[ -n "$id" ]] || id="$(basename "$file" .json)"

            [[ "$(jq -r '.relevance_review // false' "$file")" == "true" ]] && continue

            local checked; checked=$(jq -r '.relevance_checked_at // empty' "$file")
            if [[ -n "$checked" ]]; then
                local checked_age; checked_age=$((NOW - $(_iso_epoch "$checked")))
                [[ "$checked_age" -ge "$threshold" ]] || continue
            fi

            if _in_git_repo \
               && git log --since="$threshold_hours hours ago" --grep="$id" --oneline 2>/dev/null | grep -q .; then
                continue
            fi

            printf '%s\t%s\n' "$id" "$state"
        done
}

OUT="$( { _scan_state needs-work "$TICKET_STALE_HOURS"; _scan_state ready-for-human "$PR_STALE_HOURS"; } )"

if [[ "$JSON" -eq 1 ]]; then
    if [[ -z "$OUT" ]]; then
        echo "[]"
    else
        printf '%s\n' "$OUT" \
          | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {id: .[0], state: .[1]})'
    fi
else
    [[ -n "$OUT" ]] && printf '%s\n' "$OUT" || true
fi
