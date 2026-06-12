#!/usr/bin/env bash
# queue-molecule.sh — durable workflow (molecule) instances for the filesystem backend.
#
# A molecule is a per-ticket workflow instance: an ordered list of agent steps
# plus a cursor, derived from a named template in workflows.json. It makes the
# advisory `chain:` handoff crash-safe — the plan lives on disk, so a crashed
# step resumes from the cursor instead of being lost.
#
# Subcommands:
#   create  <id> <template>   instantiate molecules/<id>.json from a workflow template
#   next    <id>              print the current step's agent (empty line if complete)
#   advance <id>              mark the current step done and move the cursor;
#                             --status failed marks it failed and HOLDS the cursor
#                             (retry); --status skipped advances past a step whose
#                             `when` condition was not met
#   status  <id>              print the molecule (human table, or --json)
#   list                      list incomplete molecules + their next step (human
#                             table, or --json) — the orchestrator's dispatch source
#
# Options:
#   --molecules-dir <dir>   default .pipeline/molecules
#   --queue-dir <dir>       default .pipeline/queue        (shared audit log)
#   --workflows <file>      default .pipeline/workflows.json  (create only)
#   --status done|failed|skipped    advance only (default: done)
#   --run <runId>           advance only — record which run executed the step
#   --by <agent>            attribute the audit event to an agent
#   --json                  status only — emit the raw molecule JSON
#
# Step transitions are mirrored into the Phase 0 audit log
# (<queue-dir>/events.jsonl) as `molecule` events, best-effort — a failed append
# never fails the molecule write. Per-ticket single-writer in practice (one ticket
# has one active step), so writes use atomic tmp+rename without a lock.
#
# Exit codes: 0 ok · 1 not-found / already-exists / complete · 2 usage error

set -euo pipefail

SUB="${1:-}"
shift 1 2>/dev/null || true

MOLECULES_DIR=".pipeline/molecules"
QUEUE_DIR=".pipeline/queue"
WORKFLOWS=".pipeline/workflows.json"
STATUS="done"
RUN=""
BY=""
AS_JSON=0
POS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --molecules-dir) MOLECULES_DIR="$2"; shift 2 ;;
        --queue-dir)     QUEUE_DIR="$2"; shift 2 ;;
        --workflows)     WORKFLOWS="$2"; shift 2 ;;
        --status)        STATUS="$2"; shift 2 ;;
        --run)           RUN="$2"; shift 2 ;;
        --by)            BY="$2"; shift 2 ;;
        --json)          AS_JSON=1; shift ;;
        *)               POS+=("$1"); shift ;;
    esac
done

ID="${POS[0]:-}"
TEMPLATE="${POS[1]:-}"

if [[ -z "$SUB" ]]; then
    echo "usage: $0 <create|next|advance|status|list> <id> [...]" >&2
    exit 2
fi
# Every subcommand except `list` operates on a specific ticket.
if [[ "$SUB" != "list" && -z "$ID" ]]; then
    echo "usage: $0 <create|next|advance|status> <id> [...]" >&2
    exit 2
fi

MOL="$MOLECULES_DIR/$ID.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Best-effort molecule audit event into the shared Phase 0 log.
_emit() {
    bash "$SCRIPT_DIR/queue-event.sh" "$ID" molecule --queue-dir "$QUEUE_DIR" \
        ${BY:+--by "$BY"} "$@" 2>/dev/null || true
}

# Atomic JSON write: jq into a temp, then rename. Fails the script (set -e) if jq
# errors, leaving the original file untouched.
_write() {
    local tmp="$MOL.tmp.$$"
    if ! jq "$@" "$MOL" > "$tmp"; then rm -f "$tmp"; echo "molecule write failed: $ID" >&2; exit 1; fi
    mv "$tmp" "$MOL"
}

case "$SUB" in
    create)
        if [[ -z "$TEMPLATE" ]]; then
            echo "usage: $0 create <id> <template>" >&2; exit 2
        fi
        if [[ ! -f "$WORKFLOWS" ]]; then
            echo "no workflows file: $WORKFLOWS" >&2; exit 1
        fi
        if ! jq -e --arg t "$TEMPLATE" '.workflows[$t].steps | type == "array"' "$WORKFLOWS" >/dev/null 2>&1; then
            echo "no such workflow template (or it has no steps): $TEMPLATE" >&2; exit 1
        fi
        if [[ -e "$MOL" ]]; then
            echo "molecule already exists: $ID" >&2; exit 1
        fi
        mkdir -p "$MOLECULES_DIR"
        tmp="$MOL.tmp.$$"
        # Carry optional `when`/`loop` from the template onto each step as metadata
        # (acted on by the orchestrator in Phase 2; inert here).
        if ! jq -n --arg ticket "$ID" --arg template "$TEMPLATE" --slurpfile wf "$WORKFLOWS" '
                ($wf[0].workflows[$template].steps) as $steps
                | { ticket: $ticket, template: $template, cursor: 0,
                    steps: [ $steps[]
                             | { agent: .agent, status: "pending" }
                               + (if .when then { when: .when } else {} end)
                               + (if .loop then { loop: .loop } else {} end) ] }
             ' > "$tmp"; then
            rm -f "$tmp"; echo "molecule create failed: $ID" >&2; exit 1
        fi
        mv "$tmp" "$MOL"
        _emit action=create "template=$TEMPLATE"
        echo "created molecule: $ID ($TEMPLATE, $(jq '.steps | length' "$MOL") steps)"
        ;;

    next)
        [[ -f "$MOL" ]] || { echo "no molecule: $ID" >&2; exit 1; }
        jq -r 'if .cursor >= (.steps | length) then "" else .steps[.cursor].agent end' "$MOL"
        ;;

    advance)
        [[ -f "$MOL" ]] || { echo "no molecule: $ID" >&2; exit 1; }
        if [[ "$STATUS" != "done" && "$STATUS" != "failed" && "$STATUS" != "skipped" ]]; then
            echo "invalid --status: $STATUS (want done|failed|skipped)" >&2; exit 2
        fi
        CUR="$(jq '.cursor' "$MOL")"
        LEN="$(jq '.steps | length' "$MOL")"
        if [[ "$CUR" -ge "$LEN" ]]; then
            echo "molecule already complete: $ID" >&2; exit 1
        fi
        NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        STEP_AGENT="$(jq -r '.steps[.cursor].agent' "$MOL")"
        if [[ "$STATUS" == "failed" ]]; then
            # Mark failed but HOLD the cursor so the step can be retried.
            _write --arg at "$NOW" --arg run "$RUN" \
                '.steps[.cursor].status = "failed" | .steps[.cursor].at = $at
                 | (if $run == "" then . else .steps[.cursor].run = $run end)'
            _emit action=advance "step=$STEP_AGENT" status=failed
            echo "step failed (cursor held for retry): $ID step=$STEP_AGENT"
        else
            # done or skipped: stamp the status and advance the cursor.
            _write --arg at "$NOW" --arg run "$RUN" --arg st "$STATUS" \
                '.steps[.cursor].status = $st | .steps[.cursor].at = $at
                 | (if $run == "" then . else .steps[.cursor].run = $run end)
                 | .cursor += 1'
            _emit action=advance "step=$STEP_AGENT" "status=$STATUS"
            if [[ "$(jq '.cursor' "$MOL")" -ge "$LEN" ]]; then
                _emit action=complete
                echo "molecule complete: $ID"
            else
                echo "advanced: $ID → step $(jq -r '.steps[.cursor].agent' "$MOL")"
            fi
        fi
        ;;

    status)
        [[ -f "$MOL" ]] || { echo "no molecule: $ID" >&2; exit 1; }
        if [[ "$AS_JSON" -eq 1 ]]; then
            cat "$MOL"
        else
            jq -r '
                . as $m
                | "molecule \($m.ticket)  [\($m.template)]  cursor=\($m.cursor)/\($m.steps | length)",
                  ( $m.steps | to_entries[]
                    | "  " + (if .value.status == "done" then "✓"
                              elif .value.status == "failed" then "✗"
                              elif .value.status == "skipped" then "⊘"
                              elif .key == $m.cursor then "→"
                              else "·" end)
                           + " " + .value.agent + " (" + .value.status + ")" )
            ' "$MOL"
        fi
        ;;

    list)
        [[ -d "$MOLECULES_DIR" ]] || exit 0
        files=()
        for f in "$MOLECULES_DIR"/*.json; do [[ -e "$f" ]] && files+=("$f"); done
        [[ ${#files[@]} -eq 0 ]] && exit 0
        # Each incomplete molecule with its next runnable step, so the orchestrator
        # can dispatch next.agent (and consult next.when / next.loop).
        if [[ "$AS_JSON" -eq 1 ]]; then
            jq -s '
                [ .[] | . as $m | ($m.steps | length) as $len
                  | select($m.cursor < $len)
                  | { ticket: $m.ticket, template: $m.template,
                      cursor: $m.cursor, total: $len,
                      next: ({ agent: $m.steps[$m.cursor].agent, status: $m.steps[$m.cursor].status }
                             + (if $m.steps[$m.cursor].when then { when: $m.steps[$m.cursor].when } else {} end)
                             + (if $m.steps[$m.cursor].loop then { loop: $m.steps[$m.cursor].loop } else {} end)) } ]
            ' "${files[@]}"
        else
            jq -rs '
                .[] | . as $m | ($m.steps | length) as $len
                | select($m.cursor < $len)
                | [ $m.ticket, $m.template,
                    "\($m.cursor)/\($len)",
                    $m.steps[$m.cursor].agent,
                    $m.steps[$m.cursor].status ] | @tsv
            ' "${files[@]}"
        fi
        ;;

    *)
        echo "usage: $0 <create|next|advance|status|list> <id> [...]" >&2
        exit 2
        ;;
esac
