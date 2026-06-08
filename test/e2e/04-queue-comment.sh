#!/usr/bin/env bash
# 04-queue-comment.sh — unit test for queue/queue-comment.sh + the `comment`
# CLI verb. No claude, $0, ~2s. The concurrency sub-test runs on every platform:
# queue-comment.sh serializes with flock when present and a portable mkdir lock
# otherwise, so concurrent appends must not clobber regardless of flock.

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

# 7) concurrency: 8 parallel appends all land (flock OR portable mkdir lock)
before="$(jq '.comments | length' "$F")"
for i in 1 2 3 4 5 6 7 8; do bash "$QC" TKT-001 --author "w$i" --body "c$i" --queue-dir "$QDIR" >/dev/null & done
wait
assert_eq "$(jq '.comments | length' "$F")" "$((before + 8))" "all 8 concurrent appends landed"
NEW_AUTHORS="$(jq -r '[.comments[].author | select(startswith("w"))] | unique | length' "$F")"
assert_eq "$NEW_AUTHORS" "8" "no concurrent append clobbered another (8 distinct authors)"
if ! command -v flock >/dev/null 2>&1; then _ok "concurrency held via portable mkdir lock (no flock)"; fi

# 7b) fail-safe: a malformed ticket makes jq fail; the write must NOT reach mv
#     (no truncation) and must exit non-zero. Guards the regression where
#     `_apply || rc=$?` suppressed set -e and overwrote the file with empty tmp.
BADC="$QDIR/needs-code-review/BAD.json"
printf 'not { valid json' > "$BADC"
BADC_ORIG="$(cat "$BADC")"
set +e; bash "$QC" BAD --author x --body y --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "malformed ticket (jq fails) exits non-zero"
assert_eq "$(cat "$BADC")" "$BADC_ORIG" "malformed ticket left intact — not truncated by failed write"

# 8) CLI verb: `agent-pipeline comment` resolves a NON-DEFAULT queueDir from config and appends author=human
CUSTOM="$WORK/custom-queue"
mkdir -p "$CUSTOM/needs-code-review"
cat > "$CUSTOM/needs-code-review/TKT-CLI.json" <<'JSON'
{ "id": "TKT-CLI", "title": "cli", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "repo": "x/y", "ghUser": "z", "backend": "filesystem",
  "filesystem": { "queueDir": "custom-queue" } }
JSON
node "$REPO_ROOT/bin/cli.js" comment TKT-CLI --body "via cli" --target "$WORK" >/dev/null
CF="$CUSTOM/needs-code-review/TKT-CLI.json"
assert_eq "$(jq -r '.comments[-1].author' "$CF")" "human" "CLI defaults author to human"
assert_eq "$(jq -r '.comments[-1].body' "$CF")" "via cli" "CLI body recorded (resolved non-default queueDir)"

echo
echo "${_GRN}✓ 04-queue-comment passed${_RST}"
