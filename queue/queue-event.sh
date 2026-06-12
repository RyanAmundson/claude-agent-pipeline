#!/usr/bin/env bash
# queue-event.sh — append one audit event to the queue event log.
#
# Usage:
#   queue-event.sh <ticket-id> <event-type> [--by <agent>] [--queue-dir <dir>] [key=value ...]
#
# Examples:
#   queue-event.sh TKT-001 transition --by worker from=needs-work to=in-progress
#   queue-event.sh TKT-001 field --by worker 'expr=.pr_url="https://…/42"' state=in-progress
#   queue-event.sh TKT-001 comment author=code-reviewer verdict=fail body="layer violation"
#
# Appends a single compact JSON line to <queue-dir>/events.jsonl. Always includes
# ts/ticket/event; --by adds `by`; trailing key=value tokens become string fields
# (value may itself contain '=', e.g. a jq expression).
#
# This is the append-only audit layer for the filesystem backend. A single-line
# `>>` append is atomic under PIPE_BUF (4 KB) with O_APPEND, so concurrent emits
# from multiple agents do not interleave — no lock is needed for the log itself.
#
# Exit codes:
#   0 — event appended
#   2 — usage error

set -euo pipefail

ID="${1:-}"
EVENT="${2:-}"
shift 2 2>/dev/null || true

BY=""
QUEUE_DIR=".pipeline/queue"
EXTRA=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --by)        BY="$2"; shift 2 ;;
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        *)           EXTRA+=("$1"); shift ;;
    esac
done

# ID and EVENT are positional; a leading `--` means a flag landed where a
# positional was expected (e.g. the event-type was omitted) — treat as usage error.
if [[ -z "$ID" || -z "$EVENT" || "$ID" == --* || "$EVENT" == --* ]]; then
    echo "usage: $0 <ticket-id> <event-type> [--by <agent>] [--queue-dir <dir>] [key=value ...]" >&2
    exit 2
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="$QUEUE_DIR/events.jsonl"
mkdir -p "$QUEUE_DIR"

# Build the event object in a single jq pass. $ARGS.positional holds the k=v
# tokens; each becomes a string field (split on the FIRST '=' so values may
# contain '='). --by, when set, is added as `by`.
jq -cn \
   --arg ts "$NOW" \
   --arg ticket "$ID" \
   --arg event "$EVENT" \
   --arg by "$BY" \
   --args '
     ({ ts: $ts, ticket: $ticket, event: $event }
      + (if $by == "" then {} else { by: $by } end))
     + reduce ($ARGS.positional[]) as $kv ({};
         ($kv | index("=")) as $i
         | if $i == null then .
           else . + { ($kv[0:$i]): ($kv[($i+1):]) } end)
   ' "${EXTRA[@]+"${EXTRA[@]}"}" >> "$LOG"
