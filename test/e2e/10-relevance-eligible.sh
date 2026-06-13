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
