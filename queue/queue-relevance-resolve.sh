#!/usr/bin/env bash
# queue-relevance-resolve.sh — route a relevance verdict to a state change.
#
# Usage:
#   queue-relevance-resolve.sh <id> --verdict relevant|obsolete \
#       --confidence high|medium|low \
#       [--auto-resolve-confidence high|medium|low] \
#       [--state <state>] [--queue-dir <dir>] [--dry-run]
#
# The relevance-checker agent RECORDS a verdict (a fenced JSON block in a comment);
# it never moves the item. This is the orchestrator's mechanical router for that
# verdict — the tested seam. It composes the existing queue primitives so locking
# and audit events come for free.
#
# Routing (confidence rank high > medium > low):
#   relevant                            → keep      (stamp relevance_checked_at)
#   obsolete, rank ≥ auto-resolve-conf  → obsoleted (move to obsolete/)
#   obsolete, rank <  auto-resolve-conf → flagged   (set relevance_review=true)
# Every outcome stamps relevance_checked_at so the eligibility gate is idempotent.
#
# Prints the action: `keep|obsoleted|flagged: <id>` (suffixed ` (dry-run)`).
# Exit: 0 ok · 1 no such ticket · 2 usage error.

set -euo pipefail

ID="${1:-}"; shift 1 2>/dev/null || true
VERDICT=""
CONFIDENCE=""
AUTO="high"
STATE=""
QUEUE_DIR=".pipeline/queue"
DRY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --verdict)                 VERDICT="$2"; shift 2 ;;
        --confidence)              CONFIDENCE="$2"; shift 2 ;;
        --auto-resolve-confidence) AUTO="$2"; shift 2 ;;
        --state)                   STATE="$2"; shift 2 ;;
        --queue-dir)               QUEUE_DIR="$2"; shift 2 ;;
        --dry-run)                 DRY=1; shift ;;
        *)                         shift ;;
    esac
done

_rank() { case "$1" in high) echo 3 ;; medium) echo 2 ;; low) echo 1 ;; *) echo 0 ;; esac; }

if [[ -z "$ID" || -z "$VERDICT" || -z "$CONFIDENCE" ]]; then
    echo "usage: $0 <id> --verdict relevant|obsolete --confidence high|medium|low [--auto-resolve-confidence high|medium|low] [--state <s>] [--queue-dir <d>] [--dry-run]" >&2
    exit 2
fi
case "$VERDICT" in relevant|obsolete) ;; *) echo "invalid --verdict: $VERDICT (want relevant|obsolete)" >&2; exit 2 ;; esac
case "$CONFIDENCE" in high|medium|low) ;; *) echo "invalid --confidence: $CONFIDENCE (want high|medium|low)" >&2; exit 2 ;; esac
case "$AUTO" in high|medium|low) ;; *) echo "invalid --auto-resolve-confidence: $AUTO" >&2; exit 2 ;; esac

# Locate the ticket's current state if not given.
if [[ -z "$STATE" ]]; then
    if [[ -d "$QUEUE_DIR" ]]; then
        for d in "$QUEUE_DIR"/*/; do
            if [[ -f "$d$ID.json" ]]; then STATE="$(basename "$d")"; break; fi
        done
    fi
fi
if [[ -z "$STATE" || ! -f "$QUEUE_DIR/$STATE/$ID.json" ]]; then
    echo "no such ticket: $ID" >&2
    exit 1
fi

# Decide the action.
ACTION="keep"
if [[ "$VERDICT" == "obsolete" ]]; then
    if [[ "$(_rank "$CONFIDENCE")" -ge "$(_rank "$AUTO")" ]]; then ACTION="obsoleted"; else ACTION="flagged"; fi
fi

if [[ "$DRY" -eq 1 ]]; then
    echo "$ACTION: $ID (dry-run)"
    exit 0
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$ACTION" in
  keep)
    bash "$SCRIPT_DIR/queue-update.sh" "$STATE" "$ID" ".relevance_checked_at = \"$NOW\"" \
        --queue-dir "$QUEUE_DIR" --by relevance-checker >/dev/null
    ;;
  flagged)
    bash "$SCRIPT_DIR/queue-update.sh" "$STATE" "$ID" \
        ".relevance_checked_at = \"$NOW\" | .relevance_review = true" \
        --queue-dir "$QUEUE_DIR" --by relevance-checker >/dev/null
    ;;
  obsoleted)
    bash "$SCRIPT_DIR/queue-update.sh" "$STATE" "$ID" ".relevance_checked_at = \"$NOW\"" \
        --queue-dir "$QUEUE_DIR" --by relevance-checker >/dev/null
    bash "$SCRIPT_DIR/queue-claim.sh" "$ID" "$STATE" obsolete \
        --queue-dir "$QUEUE_DIR" --by relevance-checker >/dev/null
    ;;
esac

# Record the relevance verdict itself (the field/transition events were emitted by
# the helpers above). Best-effort: a failed append never fails the resolution.
bash "$SCRIPT_DIR/queue-event.sh" "$ID" relevance --queue-dir "$QUEUE_DIR" \
    --by relevance-checker "verdict=$VERDICT" "confidence=$CONFIDENCE" "routed=$ACTION" 2>/dev/null || true

echo "$ACTION: $ID"
