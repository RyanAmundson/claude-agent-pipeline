#!/usr/bin/env bash
# queue-history.sh — print a ticket's audit timeline from the queue event log.
#
# Usage:
#   queue-history.sh <ticket-id> [--queue-dir <dir>] [--json]
#
# Examples:
#   queue-history.sh TKT-001
#   queue-history.sh TKT-001 --json
#
# Reads <queue-dir>/events.jsonl (written by queue-event.sh) and emits the events
# for <ticket-id> in log order. Default output is one human-readable line per
# event; --json emits the raw matching JSONL lines.
#
# Exit codes:
#   0 — printed (including the empty case: no log / no matching events)
#   2 — usage error

set -euo pipefail

ID="${1:-}"
QUEUE_DIR=".pipeline/queue"
AS_JSON=0

shift 1 2>/dev/null || true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        --json)      AS_JSON=1; shift ;;
        *)           shift ;;
    esac
done

if [[ -z "$ID" ]]; then
    echo "usage: $0 <ticket-id> [--queue-dir <dir>] [--json]" >&2
    exit 2
fi

LOG="$QUEUE_DIR/events.jsonl"
[[ -f "$LOG" ]] || exit 0

if [[ "$AS_JSON" -eq 1 ]]; then
    jq -c --arg id "$ID" 'select(.ticket == $id)' "$LOG"
    exit 0
fi

# Human-readable timeline. One line per event, formatted by event type.
jq -r --arg id "$ID" '
    select(.ticket == $id)
    | . as $e
    | (.by // "") as $by
    | (if $by == "" then "" else "  (" + $by + ")" end) as $bytag
    | .ts + "  "
      + (
          if .event == "transition" then
            "transition   " + (.from // "?") + " → " + (.to // "?")
            + (if .reason then "   [" + .reason + "]" else "" end)
          elif .event == "field" then
            "field        " + (.expr // "?")
          elif .event == "comment" then
            "comment      "
            + (if .verdict and .verdict != "null" then "[" + .verdict + "] " else "" end)
            + (.author // "?") + ": " + (.body // "")
          else
            .event + "   " + ($e | del(.ts, .ticket, .event, .by) | tostring)
          end
        )
      + $bytag
' "$LOG"
