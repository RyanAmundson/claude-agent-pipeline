# Relevance-Checker Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `relevance-checker` agent that judges whether stale queue items (un-worked `needs-work/` tickets and parked `ready-for-human/` items) are still relevant against current `main`, records a confidence-scored verdict, and lets the orchestrator auto-retire high-confidence-obsolete work and flag ambiguous cases for a human.

**Architecture:** The judgment is a read-only Claude agent prompt (`agents/relevance-checker.md`), structured like the detectors — it never edits code or moves tickets. The two mechanical, testable seams are extracted into shell helpers that compose the existing queue primitives: `queue/queue-relevance-eligible.sh` (the staleness gate) and `queue/queue-relevance-resolve.sh` (verdict routing → `obsolete/` move or `relevance_review` flag). The orchestrator wires them in (eligibility → dispatch → routing). A new terminal `obsolete/` state is added; the UI pipeline graph already has the `obsolete → relevance-checker` node, so only the API `STATES` list and docs need updating.

**Tech Stack:** Bash + `jq` (queue helpers, mirroring `queue-stale.sh`/`queue-comment.sh`), Node stdlib (`api/index.js`), Markdown (agent prompts/docs), JSON Schema (`config.schema.json`). Tests are POSIX-shell E2E scripts under `test/e2e/` using `lib/assertions.sh` (no Claude, ~seconds each), auto-discovered by `run-all.sh`.

---

## Spec

Source spec: `docs/superpowers/specs/2026-06-12-relevance-agent-design.md` (already on this branch). Read it once for context; this plan implements it. Where the plan narrows scope from the spec, it is called out explicitly:

- **PR auto-close (`gh pr close`) and Linear transitions are prompt-driven**, living in `agents/orchestrator.md` + `agents/relevance-checker.md` (the GitHub/Linear backends have no shell queue to test against — consistent with how the rest of those backends are prompt-only). The **filesystem** ticket path is the tested core.
- The agent's relevance *judgment* is validated by example in the agent file, **not** unit-tested (matching every other agent). The two **mechanical** seams (eligibility, routing) are unit-tested.

## Data model additions

Two new optional ticket fields (filesystem backend), set only by the resolve helper:

- `relevance_checked_at` — ISO-8601 timestamp of the last verdict. Drives **idempotence**: the eligibility gate skips a ticket judged within the staleness window, re-eligible only after it ages again.
- `relevance_review` — `true` when a medium/low-confidence obsolescence was flagged for a human. The eligibility gate skips flagged tickets until a human clears the field.

New terminal queue state `obsolete/` — *retired as no longer relevant*, kept distinct from `done/` (*merged & shipped*).

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `config.schema.json` | `relevance` tuning object (absent ⇒ feature off) | Modified |
| `api/index.js` | add `obsolete` to canonical `STATES` (UI count) | Modified |
| `queue/queue-relevance-eligible.sh` | staleness gate — list items to judge | **New** |
| `queue/queue-relevance-resolve.sh` | verdict routing — move/flag/keep | **New** |
| `test/e2e/10-relevance-eligible.sh` | unit test for the gate | **New** |
| `test/e2e/11-relevance-resolve.sh` | unit test for routing | **New** |
| `agents/relevance-checker.md` | the agent (judgment) prompt | **New** |
| `manifest.json` | register the agent | Modified |
| `agents/orchestrator.md` | eligibility + dispatch + routing + anomaly | Modified |
| `agents/PIPELINE.md` | state table, provenance label, flow | Modified |
| `queue/README.md` | document `obsolete/` + the two helpers | Modified |
| `README.md`, `docs/API.md` | short mention of the agent + config block | Modified |

Task order is dependency-first: config/state foundation → tested shell seams → agent+registration → orchestrator wiring → docs.

---

### Task 1: Config schema `relevance` object + `obsolete` state

**Files:**
- Modify: `config.schema.json` (append a `relevance` property)
- Modify: `api/index.js:24-36` (add `obsolete` to `STATES`)

- [ ] **Step 1: Add the `relevance` object to the config schema**

In `config.schema.json`, find the last property (`humanReviewer`) and add a comma + the `relevance` object after it. Replace:

```json
    "humanReviewer": {
      "type": "string",
      "description": "GitHub handle of the human who reviews and merges PRs. The pipeline routes 'ready-for-human' PRs to this reviewer."
    }
  }
}
```

with:

```json
    "humanReviewer": {
      "type": "string",
      "description": "GitHub handle of the human who reviews and merges PRs. The pipeline routes 'ready-for-human' PRs to this reviewer."
    },
    "relevance": {
      "type": "object",
      "description": "Tuning for the relevance-checker agent. Absent ⇒ feature off; existing installs are unaffected.",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": false,
          "description": "Master switch. When false (or the whole object is absent), the orchestrator never dispatches relevance-checker."
        },
        "ticketStaleHours": {
          "type": "integer",
          "default": 24,
          "minimum": 1,
          "description": "A needs-work ticket older than this (by mtime) becomes eligible for a relevance check."
        },
        "prStaleHours": {
          "type": "integer",
          "default": 48,
          "minimum": 1,
          "description": "A ready-for-human item older than this becomes eligible for a relevance check."
        },
        "autoResolveConfidence": {
          "type": "string",
          "enum": ["high", "medium", "low"],
          "default": "high",
          "description": "Minimum verdict confidence at which an 'obsolete' item is auto-resolved (moved to obsolete/ / PR closed) rather than flagged for a human."
        },
        "autoClosePRs": {
          "type": "boolean",
          "default": true,
          "description": "GitHub backend: run `gh pr close` on a high-confidence-obsolete PR (reversible). When false, only label/flag it."
        }
      }
    }
  }
}
```

- [ ] **Step 2: Verify the schema is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log('schema ok')"`
Expected: `schema ok`

- [ ] **Step 3: Add `obsolete` to the canonical STATES list**

In `api/index.js`, replace:

```js
// The 10 queue states, in pipeline order. Anything in `in-progress` is "active".
export const STATES = Object.freeze([
  'needs-triage',
  'needs-review',
  'needs-work',
  'in-progress',
  'needs-test-review',
  'needs-code-review',
  'needs-feedback',
  'ready-for-human',
  'done',
  'needs-info',
]);
```

with:

```js
// The 11 queue states, in pipeline order. Anything in `in-progress` is "active".
// `obsolete` is terminal (retired as no-longer-relevant) — distinct from `done`.
export const STATES = Object.freeze([
  'needs-triage',
  'needs-review',
  'needs-work',
  'in-progress',
  'needs-test-review',
  'needs-code-review',
  'needs-feedback',
  'ready-for-human',
  'done',
  'needs-info',
  'obsolete',
]);
```

- [ ] **Step 4: Verify STATES includes obsolete and the UI tests still pass**

Run: `node -e "import('./api/index.js').then(m => console.log('obsolete in STATES:', m.STATES.includes('obsolete'), '| count:', m.STATES.length))"`
Expected: `obsolete in STATES: true | count: 11`

Run: `npm run test:ui 2>&1 | grep -E "pass [0-9]+|fail [0-9]+"`
Expected: `pass 29` and `fail 0` (the graph already models `obsolete`; this change only adds the API count).

- [ ] **Step 5: Commit**

```bash
git add config.schema.json api/index.js
git commit -m "feat(relevance): add relevance config schema + obsolete queue state"
```

---

### Task 2: Staleness gate — `queue/queue-relevance-eligible.sh`

**Files:**
- Test: `test/e2e/10-relevance-eligible.sh`
- Create: `queue/queue-relevance-eligible.sh`

- [ ] **Step 1: Write the failing test**

Create `test/e2e/10-relevance-eligible.sh`:

```bash
#!/usr/bin/env bash
# 10-relevance-eligible.sh — unit test for queue/queue-relevance-eligible.sh.
# No claude, ~1s. Verifies the staleness gate: mtime threshold, already-judged
# idempotence, already-flagged skip, the --json shape, and git-commit exclusion.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QE="$REPO_ROOT/queue/queue-relevance-eligible.sh"

echo
echo "═══ 10-relevance-eligible ════════════════════════════════════════"

WORK="$(mktemp -d -t ap-rel-elig)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
mkdir -p "$QDIR/needs-work" "$QDIR/ready-for-human"

mkt() {  # mkt <state> <id> [extra-json-fields]
  local state="$1" id="$2" extra="${3:-}"
  printf '{ "id": "%s", "title": "t"%s }\n' "$id" "$extra" > "$QDIR/$state/$id.json"
}
stale() { touch -t 202601010000 "$1"; }   # force an old mtime
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# fresh ticket (mtime now)        — NOT eligible at a 1h threshold
mkt needs-work FRESH
# stale ticket                    — eligible
mkt needs-work STALE;   stale "$QDIR/needs-work/STALE.json"
# stale but just-judged           — NOT eligible (idempotence)
mkt needs-work JUDGED ", \"relevance_checked_at\": \"$NOW_ISO\""; stale "$QDIR/needs-work/JUDGED.json"
# stale but already flagged        — NOT eligible
mkt needs-work FLAGGED ", \"relevance_review\": true";            stale "$QDIR/needs-work/FLAGGED.json"
# stale ready-for-human item       — eligible at the pr threshold
mkt ready-for-human PR1; stale "$QDIR/ready-for-human/PR1.json"

OUT="$(bash "$QE" --ticket-stale-hours 1 --pr-stale-hours 1 --queue-dir "$QDIR")"

assert_contains "$OUT" "$(printf 'STALE\tneeds-work')" "stale needs-work ticket is eligible"
assert_contains "$OUT" "$(printf 'PR1\tready-for-human')" "stale ready-for-human item is eligible"
echo "$OUT" | grep -q "FRESH"   && _fail "fresh ticket must NOT be eligible"   || _ok "fresh ticket excluded"
echo "$OUT" | grep -q "JUDGED"  && _fail "just-judged must NOT be eligible"    || _ok "just-judged excluded (idempotence)"
echo "$OUT" | grep -q "FLAGGED" && _fail "flagged must NOT be eligible"        || _ok "already-flagged excluded"

# --json shape: exactly the eligible ids
J="$(bash "$QE" --ticket-stale-hours 1 --pr-stale-hours 1 --queue-dir "$QDIR" --json)"
assert_eq "$(echo "$J" | jq -r 'map(.id) | sort | join(",")')" "PR1,STALE" "--json lists exactly the eligible ids"
assert_eq "$(echo "$J" | jq -r 'map(select(.id=="STALE"))[0].state')" "needs-work" "--json carries the state"

# empty output is valid (nothing eligible) — high threshold excludes all
EMPTY="$(bash "$QE" --ticket-stale-hours 100000 --pr-stale-hours 100000 --queue-dir "$QDIR" --json)"
assert_eq "$EMPTY" "[]" "no eligible items → []"

# git exclusion: a stale ticket referenced by a recent commit is excluded
if command -v git >/dev/null 2>&1; then
  GW="$WORK/gitrepo"
  mkdir -p "$GW/.pipeline/queue/needs-work"
  (
    cd "$GW"
    git init -q && git config user.email t@t && git config user.name t
    echo '{"id":"GIT1","title":"t"}' > .pipeline/queue/needs-work/GIT1.json
    touch -t 202601010000 .pipeline/queue/needs-work/GIT1.json
    echo x > x.txt && git add x.txt && git commit -qm "fix GIT1 thing"
  )
  OUTG="$(cd "$GW" && bash "$QE" --ticket-stale-hours 1 --queue-dir .pipeline/queue)"
  echo "$OUTG" | grep -q "GIT1" && _fail "commit-referenced ticket must be excluded" || _ok "git-referenced ticket excluded"
fi

echo
echo "${_GRN}✓ 10-relevance-eligible passed${_RST}"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/e2e/10-relevance-eligible.sh`
Expected: FAIL — the script doesn't exist yet (e.g. `bash: .../queue-relevance-eligible.sh: No such file or directory`, surfacing as a failed `assert_contains`).

- [ ] **Step 3: Write the staleness-gate script**

Create `queue/queue-relevance-eligible.sh`:

```bash
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
    mtime=$(stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1")
    echo $((NOW - mtime))
}

# epoch of an ISO-8601 Z timestamp (GNU date -d, then BSD date -j -f); 0 on failure
_iso_epoch() {
    date -u -d "$1" +%s 2>/dev/null \
      || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
      || echo 0
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
                local checked_age=$((NOW - $(_iso_epoch "$checked")))
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
```

- [ ] **Step 4: Make it executable and run the test to verify it passes**

Run: `chmod +x queue/queue-relevance-eligible.sh && bash test/e2e/10-relevance-eligible.sh`
Expected: ends with `✓ 10-relevance-eligible passed` (all `ok:` lines, no `FAIL:`).

- [ ] **Step 5: Commit**

```bash
git add queue/queue-relevance-eligible.sh test/e2e/10-relevance-eligible.sh
git commit -m "feat(relevance): staleness gate (queue-relevance-eligible.sh)"
```

---

### Task 3: Verdict routing — `queue/queue-relevance-resolve.sh`

**Files:**
- Test: `test/e2e/11-relevance-resolve.sh`
- Create: `queue/queue-relevance-resolve.sh`

This is the highest-value seam. It composes the existing primitives (`queue-update.sh` for fields, `queue-claim.sh` for the atomic move, `queue-event.sh` for the verdict event) so locking and audit come for free.

- [ ] **Step 1: Write the failing test**

Create `test/e2e/11-relevance-resolve.sh`:

```bash
#!/usr/bin/env bash
# 11-relevance-resolve.sh — unit test for queue/queue-relevance-resolve.sh.
# No claude, ~1s. Verifies verdict routing: relevant=keep, obsolete+high=move,
# obsolete+medium=flag, configurable threshold, idempotence stamp, audit events,
# and usage errors.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QR="$REPO_ROOT/queue/queue-relevance-resolve.sh"
QE="$REPO_ROOT/queue/queue-relevance-eligible.sh"

echo
echo "═══ 11-relevance-resolve ═════════════════════════════════════════"

WORK="$(mktemp -d -t ap-rel-res)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"

reset() {  # fresh queue holding one needs-work ticket <id>
  rm -rf "$QDIR"
  mkdir -p "$QDIR/needs-work" "$QDIR/ready-for-human"
  printf '{ "id": "%s", "title": "t" }\n' "$1" > "$QDIR/needs-work/$1.json"
}

# 1) relevant → keep (no move, no flag, but stamped)
reset T1
OUT="$(bash "$QR" T1 --verdict relevant --confidence high --queue-dir "$QDIR")"
assert_contains "$OUT" "keep: T1" "relevant verdict → keep"
assert_file_exists "$QDIR/needs-work/T1.json" "kept ticket stays in needs-work"
assert_eq "$(jq -r '.relevance_review // "unset"' "$QDIR/needs-work/T1.json")" "unset" "relevant: no relevance_review flag"
assert_contains "$(jq -r '.relevance_checked_at' "$QDIR/needs-work/T1.json")" "T" "relevant: relevance_checked_at stamped"

# 2) obsolete + high → moved to obsolete/
reset T2
OUT="$(bash "$QR" T2 --verdict obsolete --confidence high --queue-dir "$QDIR")"
assert_contains "$OUT" "obsoleted: T2" "obsolete+high → obsoleted"
assert_file_exists "$QDIR/obsolete/T2.json" "obsoleted ticket moved to obsolete/"
[[ -f "$QDIR/needs-work/T2.json" ]] && _fail "ticket must leave needs-work" || _ok "ticket gone from needs-work"

# 3) obsolete + medium (default threshold high) → flagged, no move
reset T3
OUT="$(bash "$QR" T3 --verdict obsolete --confidence medium --queue-dir "$QDIR")"
assert_contains "$OUT" "flagged: T3" "obsolete+medium (thresh high) → flagged"
assert_file_exists "$QDIR/needs-work/T3.json" "flagged ticket stays in place"
assert_eq "$(jq -r '.relevance_review' "$QDIR/needs-work/T3.json")" "true" "flagged: relevance_review=true"
[[ -f "$QDIR/obsolete/T3.json" ]] && _fail "flagged ticket must NOT move" || _ok "flagged ticket not moved"

# 4) configurable threshold: medium auto-resolves when threshold=medium
reset T4
OUT="$(bash "$QR" T4 --verdict obsolete --confidence medium --auto-resolve-confidence medium --queue-dir "$QDIR")"
assert_contains "$OUT" "obsoleted: T4" "obsolete+medium (thresh medium) → obsoleted"
assert_file_exists "$QDIR/obsolete/T4.json" "moved under medium threshold"

# 5) idempotence: a judged ticket is no longer eligible
reset T5
touch -t 202601010000 "$QDIR/needs-work/T5.json"   # make it stale first
assert_contains "$(bash "$QE" --ticket-stale-hours 1 --queue-dir "$QDIR")" "T5" "stale ticket eligible before judging"
bash "$QR" T5 --verdict relevant --confidence high --queue-dir "$QDIR" >/dev/null
echo "$(bash "$QE" --ticket-stale-hours 1 --queue-dir "$QDIR")" | grep -q "T5" \
  && _fail "judged ticket must not re-list" || _ok "judged ticket excluded next pass (idempotence)"

# 6) audit events recorded
reset T6
bash "$QR" T6 --verdict obsolete --confidence high --queue-dir "$QDIR" >/dev/null
assert_contains "$(cat "$QDIR/events.jsonl")" '"event":"relevance"' "relevance verdict event recorded"
assert_contains "$(cat "$QDIR/events.jsonl")" '"to":"obsolete"' "transition-to-obsolete event recorded"

# 7) dry-run reports the action without writing
reset T7
OUT="$(bash "$QR" T7 --verdict obsolete --confidence high --queue-dir "$QDIR" --dry-run)"
assert_contains "$OUT" "obsoleted: T7 (dry-run)" "dry-run reports the action"
assert_file_exists "$QDIR/needs-work/T7.json" "dry-run does not move the ticket"

# 8) usage errors
reset T8
set +e; bash "$QR" T8 --verdict bogus --confidence high --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "invalid verdict exits 2"
set +e; bash "$QR" NOPE --verdict relevant --confidence high --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "missing ticket exits 1"

echo
echo "${_GRN}✓ 11-relevance-resolve passed${_RST}"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/e2e/11-relevance-resolve.sh`
Expected: FAIL — `queue-relevance-resolve.sh` doesn't exist yet.

- [ ] **Step 3: Write the routing script**

Create `queue/queue-relevance-resolve.sh`:

```bash
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
```

- [ ] **Step 4: Make it executable and run the test to verify it passes**

Run: `chmod +x queue/queue-relevance-resolve.sh && bash test/e2e/11-relevance-resolve.sh`
Expected: ends with `✓ 11-relevance-resolve passed`.

- [ ] **Step 5: Run the whole E2E suite to confirm nothing regressed**

Run: `npm run test:e2e 2>&1 | tail -5`
Expected: `SUMMARY: N passed, 0 failed, ...` (N includes the two new tests; live tests skip without `CAP_E2E_LIVE=1`).

- [ ] **Step 6: Commit**

```bash
git add queue/queue-relevance-resolve.sh test/e2e/11-relevance-resolve.sh
git commit -m "feat(relevance): verdict routing (queue-relevance-resolve.sh)"
```

---

### Task 4: The agent + manifest registration

**Files:**
- Create: `agents/relevance-checker.md`
- Modify: `manifest.json` (add the routing-stage entry)

- [ ] **Step 1: Write the agent definition**

Create `agents/relevance-checker.md`:

````markdown
# Relevance Checker Agent

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms (your project's domain terms). If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer. Never paraphrase a definition — read the glossary entry or ask.

**Role**: Judge whether ONE stale queue item is still relevant against current `main`. The inverse of a detector: detectors scan `src/` for *new* issues to file; you scan *existing* queued work for items the world has moved past. Single responsibility.

**Input**: One item id the orchestrator has staleness-gated — a ticket in `needs-work/` or an item in `ready-for-human/`. The orchestrator passes the id (and PR ref in GitHub mode) in your prompt.
**Output**: A confidence-scored verdict recorded as a comment (see Verdict Format). You do **not** move the item or close anything — the orchestrator routes on your verdict.
**Provenance**: `agent:relevance-checker`
**Scope**: `config.repo` only. **Read-only** against the codebase — no edits, no rebases, no merges, no PRs, no worktree (you read `main` and the ticket/diff; you do not build).

## What you decide (and ONLY this)

Is this change still worth doing, judged against the current state of `main`? Output one of:

- **`relevant`** — the work still applies. The common case. Always routes to "leave in place".
- **`obsolete`** — the world moved past it; doing the work would produce a no-op or a confusing diff.

Plus a **confidence** (`high` | `medium` | `low`). When evidence is mixed, pick the **lowest** matching confidence — bias toward keeping work, since auto-resolve discards it.

## Relevance signals

**For a ticket** (judge against current `main`):

- Does `source.file` still exist on `main`? (`git cat-file -e HEAD:<path>` — missing ⇒ strong obsolescence signal.)
- Is the flagged symbol / pattern / line still present? (`rg` the smell at the recorded location and codebase-wide.)
- Was the exact fix already merged? (`git log --oneline -- <path>` since the ticket's `created_at`, then read the current code.)
- Is there a duplicate ticket already in `done/` or `in-progress/` covering it?
- For a rule-based scanner finding: does the rule that generated it still exist (`config.rulesDir`)?

**For a PR / branch** (judge against current `main`):

- Does the code the diff touches still exist on `main`, or was it deleted / refactored away?
- Was the PR's goal already achieved by another merge — does the problem it solves still reproduce on `main`?
- Was the targeted feature / flag removed from `main`?
- **Mechanical conflict alone is NOT obsolescence** — that is the branch-updater's job. Relevance is about meaning, not merge-ability.

## Confidence rubric

| Confidence | Criteria (any one suffices) | Orchestrator routing |
|---|---|---|
| **high** | `source.file` deleted; flagged pattern provably gone from the exact recorded location AND the ticket was location-bound; the described fix is literally present in a merged commit; PR's target symbol no longer exists on `main` | **auto-resolve** (retire) |
| **medium** | Area was refactored/renamed but the concern *might* still apply; partial overlap with a merge; PR target moved but still present | **flag a human** |
| **low** | Conceptual / cross-cutting issue not bound to one location; weak or indirect evidence | **flag a human** |

## Verdict Format

Post exactly one comment whose body contains a single fenced ```json block the orchestrator parses. On the filesystem backend, use:

```bash
queue/queue-comment.sh <id> --author relevance-checker --body "$BODY"
```

(GitHub/Linear backends: post the same body as a PR/issue comment via `gh pr comment` / the Linear comment tool, and apply the `pipeline:relevance-*` label the orchestrator expects.) The body MUST be:

````
[agent:relevance-checker] Relevance verdict

```json
{
  "verdict": "relevant" | "obsolete",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-paragraph, human-readable justification",
  "evidence": [
    "source.file src/x/Old.tsx no longer exists on main (git cat-file -e HEAD:src/x/Old.tsx → missing)",
    "exact pattern from finding not present at any path (rg returned 0 hits)"
  ]
}
```
````

Every `obsolete` verdict MUST cite at least one concrete `evidence` line (a command and its result). A verdict without verifiable evidence is `relevant` by default.

## What NOT to do

- Do NOT edit code, rebase, merge, or open/close PRs — you only judge and record.
- Do NOT move the item between states — the orchestrator does that based on your verdict.
- Do NOT treat a mechanical merge conflict as obsolescence (branch-updater handles conflicts).
- Do NOT re-scope a still-relevant ticket whose issue merely moved — judge `relevant` and let your `reasoning` note the move (re-scoping is future work).
- Do NOT judge fresh items — if dispatched on an item that looks freshly touched, say so and verdict `relevant`.

## Report Format

Under 150 words:

```
[agent:relevance-checker] Checked <id>

Verdict: <relevant|obsolete>  (confidence: <high|medium|low>)
Reasoning: <one line>
Key evidence: <one line>

Terminology drift: <none | list>
```
````

- [ ] **Step 2: Register the agent in the manifest**

In `manifest.json`, replace:

```json
    "ticket-reviewer":                { "stage": "routing",        "requires": [], "optional": ["linear"] },
```

with:

```json
    "ticket-reviewer":                { "stage": "routing",        "requires": [], "optional": ["linear"] },
    "relevance-checker":              { "stage": "routing",        "requires": [], "optional": ["github", "linear"] },
```

- [ ] **Step 3: Verify the manifest parses and the agent is registered**

Run: `node -e "const m=require('./manifest.json'); console.log('count:', Object.keys(m.agents).length, '| relevance-checker:', JSON.stringify(m.agents['relevance-checker']))"`
Expected: `count: 34 | relevance-checker: {"stage":"routing","requires":[],"optional":["github","linear"]}`

- [ ] **Step 4: Verify list-agents and the CLI smoke test**

Run: `node bin/cli.js list-agents | grep -A1 routing | grep relevance-checker`
Expected: a line showing `relevance-checker` under the `routing` stage.

Run: `npm test`
Expected: `cli smoke ok` (list-agents + list-presets run without error).

- [ ] **Step 5: Commit**

```bash
git add agents/relevance-checker.md manifest.json
git commit -m "feat(relevance): add relevance-checker agent + register in manifest"
```

---

### Task 5: Orchestrator wiring

**Files:**
- Modify: `agents/orchestrator.md` (dispatch table row, eligibility/routing in the filesystem section, anomaly row)

No automated test (the orchestrator is a prompt). Verify by grepping for each inserted section.

- [ ] **Step 1: Add the dispatch-table row**

In `agents/orchestrator.md`, in the "Dispatch mapping" table (§3 Agent Dispatch), find the row:

```
| `pipeline:needs-feedback` | feedback-responder | `.agents/feedback-responder.md` |
```

and add immediately after it:

```
| Staleness-gated `needs-work` ticket or `ready-for-human` item (only when `relevance.enabled`) | relevance-checker | `.agents/relevance-checker.md` |
```

- [ ] **Step 2: Add eligibility + routing to the filesystem backend section**

In `agents/orchestrator.md`, in "Backend: filesystem (GitHub-free)", find the `ready-for-human/` bullet:

```
- **`ready-for-human/`** is the human's queue (merge + move to `done/` manually) — no dispatch.
```

and insert this bullet immediately **before** it:

```
- **Relevance sweep (only when `config.relevance.enabled`)**: each cycle, list staleness-gated items with
  `queue/queue-relevance-eligible.sh --ticket-stale-hours <relevance.ticketStaleHours> --pr-stale-hours <relevance.prStaleHours> --queue-dir <queueDir>`.
  Dispatch **one** `relevance-checker` per eligible item (counts toward the per-cycle agent cap), subject to the **same readyQueueSaturation backoff as detectors** — when `ready-for-human/` is saturated, skip the sweep (the human is the bottleneck; don't spend dispatches retiring work nobody is reviewing). After the agent posts its verdict comment, parse the fenced `json` block and route it:
  `queue/queue-relevance-resolve.sh <id> --verdict <v> --confidence <c> --auto-resolve-confidence <relevance.autoResolveConfidence> --queue-dir <queueDir>`.
  The helper moves high-confidence-obsolete items to `obsolete/`, flags medium/low as `relevance_review` (left in place for a human), and is a no-op for `relevant`. GitHub mode: additionally `gh pr close <ref>` with the reasoning comment when `relevance.autoClosePRs` and the verdict is high-confidence obsolete; Linear mode: transition the issue to Cancelled. The helper stamps `relevance_checked_at`, so re-listing the same item next cycle is automatically suppressed.
```

- [ ] **Step 3: Add the self-healing anomaly row**

In `agents/orchestrator.md`, in the "Pipeline State Issues" table (§ Self-Healing), add this row after the existing `**Stuck PR**` row:

```
| **Stale relevance flag** | An item carries `relevance_review` (filesystem) / `pipeline:relevance-review` (GitHub/Linear) with no human action for > 3 cycles | Surface it in the cycle report `notes` (prefix `self-healing:`) — do NOT auto-resolve; retiring flagged work is the human's call |
```

- [ ] **Step 4: Verify all four insertions are present**

Run:
```bash
grep -c "relevance-checker\|queue-relevance-eligible\|queue-relevance-resolve\|relevance_review" agents/orchestrator.md
```
Expected: `4` or more (the dispatch row, the eligible call, the resolve call, and the anomaly row all matched).

- [ ] **Step 5: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(relevance): wire relevance-checker into the orchestrator"
```

---

### Task 6: Documentation

**Files:**
- Modify: `agents/PIPELINE.md` (state table, provenance label, flow note)
- Modify: `queue/README.md` (obsolete dir + two helpers)
- Modify: `README.md`, `docs/API.md` (short mention + config block)

- [ ] **Step 1: PIPELINE.md — add the state, provenance label, and flow note**

In `agents/PIPELINE.md`, in the "Pipeline States" table, add after the `needs-info` row:

```
| `obsolete` | Retired as no longer relevant (distinct from `done` = merged) | relevance-checker (via orchestrator) |
```

In the "Provenance Labels" table, add after the `agent:code-simplifier` row:

```
| `agent:relevance-checker` | Relevance checker judged an item's continued relevance |
```

In the "On-demand (dispatched by orchestrator)" table, add after the `feedback-responder` row:

```
| relevance-checker | `relevance.enabled` and a staleness-gated `needs-work`/`ready-for-human` item exists |
```

Then under "## Pipeline Flow", add this line directly below the closing ``` of the diagram:

```
A staleness-gated relevance check can retire an un-worked ticket or a parked item to `obsolete/` (high confidence) or flag it for a human (medium/low), instead of spending a worker or review cycle on work the world moved past.
```

- [ ] **Step 2: queue/README.md — document the obsolete state and helpers**

In `queue/README.md`, in the directory-tree code block under "## Concept", change:

```
├── done/             # merged and cleaned up
└── needs-info/       # parked, missing detail
```

to:

```
├── done/             # merged and cleaned up
├── needs-info/       # parked, missing detail
└── obsolete/         # retired as no longer relevant (auto-created on first use)
```

Then, in the "## Helpers" section, add these two entries after the `queue-stale.sh` entry:

````markdown
### `queue-relevance-eligible.sh [--ticket-stale-hours N] [--pr-stale-hours N] [--json]`

List queue items the relevance-checker should judge — stale (past the per-state
mtime threshold), not yet judged (`relevance_checked_at` absent or itself stale),
not already flagged (`relevance_review`), and not referenced by a recent commit.
Output is `<id>\t<state>` lines, or a JSON array with `--json`.

```bash
queue-relevance-eligible.sh --ticket-stale-hours 24 --pr-stale-hours 48 --json
```

### `queue-relevance-resolve.sh <id> --verdict relevant|obsolete --confidence high|medium|low`

Route a recorded relevance verdict: `relevant` → keep (stamp only); `obsolete` at
or above `--auto-resolve-confidence` (default `high`) → move to `obsolete/`;
`obsolete` below it → set `relevance_review=true` and leave in place. Always stamps
`relevance_checked_at` for idempotence. Composes `queue-update.sh` + `queue-claim.sh`.

```bash
queue-relevance-resolve.sh TKT-001 --verdict obsolete --confidence high
```
````

- [ ] **Step 3: README.md + docs/API.md — short mention**

First find where agents/config are documented:

```bash
grep -n "ticket-reviewer\|relevance\|## Config\|config.json\|backend" README.md docs/API.md | head
```

In `README.md`, wherever the agent roster or feature list lives, add one bullet:

```
- **relevance-checker** — judges whether stale tickets/PRs are still relevant against `main`, auto-retiring high-confidence-obsolete work to `obsolete/` and flagging the rest for a human. Off unless `config.relevance.enabled`.
```

In `docs/API.md`, wherever config keys are listed, add:

````markdown
### `relevance` (optional — absent ⇒ off)

Tuning for the relevance-checker agent.

```jsonc
"relevance": {
  "enabled": true,
  "ticketStaleHours": 24,          // needs-work age before a ticket is eligible
  "prStaleHours": 48,              // ready-for-human age before an item is eligible
  "autoResolveConfidence": "high", // confidence at which obsolete items auto-retire
  "autoClosePRs": true             // GitHub: gh pr close on high-confidence-obsolete PRs
}
```
````

- [ ] **Step 4: Verify the docs reference the new pieces**

Run:
```bash
grep -l "obsolete" agents/PIPELINE.md queue/README.md && \
grep -c "relevance-checker\|relevance" README.md docs/API.md
```
Expected: `agents/PIPELINE.md` and `queue/README.md` both listed, and non-zero counts for README.md / docs/API.md.

- [ ] **Step 5: Final full-suite check**

Run: `npm test && npm run test:ui 2>&1 | grep -E "pass|fail" && npm run test:e2e 2>&1 | tail -3`
Expected: `cli smoke ok`; `pass 29` / `fail 0`; E2E `SUMMARY: N passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add agents/PIPELINE.md queue/README.md README.md docs/API.md
git commit -m "docs(relevance): document obsolete state, helpers, and config"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented by |
|---|---|
| Component `agents/relevance-checker.md` (read-only, verdict comment) | Task 4 |
| Verdict schema (fenced JSON block) | Task 4 (Verdict Format) |
| Relevance signals (ticket + PR) | Task 4 |
| Confidence rubric (high/medium/low + lowest-on-mixed) | Task 4 |
| Both lifecycle points (needs-work + ready-for-human) | Tasks 2, 5 (eligible scans both) |
| Confidence-tiered disposition | Task 3 (`--auto-resolve-confidence`) |
| Staleness-gated trigger | Task 2 |
| PR auto-close at high confidence | Task 5 (GitHub-mode, prompt-driven) |
| New `obsolete/` state | Tasks 1 (STATES), 3 (move), 6 (docs) |
| `relevance-review` flag | Task 3 (`relevance_review`) |
| Orchestrator wiring (gate, dispatch, routing, anomaly) | Task 5 |
| Config `relevance` object | Task 1 |
| Backends (filesystem tested; GitHub/Linear prompt) | Tasks 3, 5 |
| manifest registration | Task 4 |
| Testing (staleness gate, verdict routing, idempotence) | Tasks 2, 3 |

No gaps. Two deliberate scope narrowings (documented under "Spec"): GitHub/Linear paths are prompt-driven, not shell-tested; the agent's judgment is example-validated, not unit-tested — both consistent with existing codebase conventions.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete file content or an exact old→new replacement; every command has an expected result.

**3. Type/interface consistency:** `relevance_checked_at` and `relevance_review` field names, the `keep|obsoleted|flagged` action strings, the `<id>\t<state>` eligible output, and the `--verdict/--confidence/--auto-resolve-confidence/--queue-dir` flags are used identically across the scripts, their tests, and the orchestrator wiring. `obsolete` is the state name in `STATES`, the queue dir, the graph node, and `queue-claim.sh`'s target. `config.relevance.{enabled,ticketStaleHours,prStaleHours,autoResolveConfidence,autoClosePRs}` match between the schema (Task 1) and the orchestrator references (Task 5).
