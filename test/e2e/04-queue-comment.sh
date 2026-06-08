#!/usr/bin/env bash
# 04-queue-comment.sh — unit test for queue/queue-comment.sh + the `comment`
# CLI verb. No claude, $0, ~2s. Portable: the concurrency sub-test is skipped
# where flock(1) is unavailable.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QC="$REPO_ROOT/queue/queue-comment.sh"

echo
echo "═══ 04-queue-comment ══════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-qc)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
mkdir -p "$QDIR/needs-code-review" "$QDIR/needs-feedback"
cat > "$QDIR/needs-code-review/TKT-001.json" <<'JSON'
{ "id": "TKT-001", "title": "demo", "priority": 2,
  "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON

# 1) append a comment with a verdict
bash "$QC" TKT-001 --author tester --verdict pass --body "regression test present" --queue-dir "$QDIR" >/dev/null
F="$QDIR/needs-code-review/TKT-001.json"
assert_eq "$(jq '.comments | length' "$F")" "1" "one comment appended"
assert_eq "$(jq -r '.comments[0].author' "$F")" "tester" "author recorded"
assert_eq "$(jq -r '.comments[0].verdict' "$F")" "pass" "verdict recorded"
assert_eq "$(jq -r '.comments[0].body' "$F")" "regression test present" "body recorded"
AT="$(jq -r '.comments[0].at' "$F")"
assert_contains "$AT" "T" "timestamp is ISO-8601"

# 2) omitted verdict -> JSON null
bash "$QC" TKT-001 --author human --body "rename to fooBar" --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq -r '.comments[1].verdict' "$F")" "null" "omitted verdict is JSON null"
assert_eq "$(jq -r '.comments[1].author' "$F")" "human" "second author recorded"

# 3) finds ticket across states without --state
mv "$F" "$QDIR/needs-feedback/TKT-001.json"
F="$QDIR/needs-feedback/TKT-001.json"
bash "$QC" TKT-001 --author code-reviewer --verdict fail --body "layer violation" --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq '.comments | length' "$F")" "3" "found across states; third comment appended"

# 4) missing ticket exits 1
set +e; bash "$QC" NOPE --author x --body y --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "missing ticket exits 1"

# 5) missing --body exits 2
set +e; bash "$QC" TKT-001 --author x --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "missing --body exits 2"

# 6) invalid verdict exits 2
set +e; bash "$QC" TKT-001 --author x --body y --verdict maybe --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "invalid --verdict exits 2"

# 7) concurrency: 5 parallel appends all land (requires flock)
if command -v flock >/dev/null 2>&1; then
  before="$(jq '.comments | length' "$F")"
  for i in 1 2 3 4 5; do bash "$QC" TKT-001 --author "w$i" --body "c$i" --queue-dir "$QDIR" >/dev/null & done
  wait
  assert_eq "$(jq '.comments | length' "$F")" "$((before + 5))" "all 5 concurrent appends landed"
else
  echo "  (skip concurrency: flock unavailable)"
fi

# TODO(Task 2): restore section #8 once 'agent-pipeline comment' exists
# # 8) CLI verb: `agent-pipeline comment` resolves queueDir from config and appends author=human
# cat > "$WORK/.pipeline/config.json" <<'JSON'
# { "repo": "x/y", "ghUser": "z", "backend": "filesystem",
#   "filesystem": { "queueDir": ".pipeline/queue" } }
# JSON
# node "$REPO_ROOT/bin/cli.js" comment TKT-001 --body "via cli" --target "$WORK" >/dev/null
# LAST_AUTHOR=$(jq -r '.comments[-1].author' "$F")
# LAST_BODY=$(jq -r '.comments[-1].body' "$F")
# assert_eq "$LAST_AUTHOR" "human" "CLI defaults author to human"
# assert_eq "$LAST_BODY" "via cli" "CLI body recorded"

echo
echo "${_GRN}✓ 04-queue-comment passed${_RST}"
