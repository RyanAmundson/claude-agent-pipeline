#!/usr/bin/env bash
# queue-claim.sh — atomically claim a ticket by moving it from one state to another.
#
# Usage:
#   queue-claim.sh <id> <from-state> <to-state> [--queue-dir <dir>]
#
# Example:
#   queue-claim.sh CER-123 needs-work in-progress
#
# Exit codes:
#   0 — claim succeeded
#   1 — claim failed (already claimed, or file missing)
#   2 — usage error
#
# This is the atomic primitive for state transitions in the filesystem backend.
# `mv` within the same filesystem is atomic — first caller wins, others get ENOENT.

set -euo pipefail

ID="${1:-}"
FROM="${2:-}"
TO="${3:-}"
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

if [[ -z "$ID" || -z "$FROM" || -z "$TO" ]]; then
    echo "usage: $0 <id> <from-state> <to-state> [--queue-dir <dir>]" >&2
    exit 2
fi

SRC="$QUEUE_DIR/$FROM/$ID.json"
DST_DIR="$QUEUE_DIR/$TO"
DST="$DST_DIR/$ID.json"

mkdir -p "$DST_DIR"

# Atomic mv. If SRC doesn't exist, mv exits non-zero — we exit 1.
mv "$SRC" "$DST" 2>/dev/null || { echo "claim failed: $ID not in $FROM" >&2; exit 1; }

echo "claimed: $ID → $TO"
