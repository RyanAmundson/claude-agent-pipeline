#!/usr/bin/env bash
# 05-queue-update-noflock.sh — unit test for queue/queue-update.sh.
# Guards the macOS portability fix: the read-modify-write must succeed even when
# flock(1) is absent. We force the no-flock branch deterministically (on every
# platform, including Linux CI where flock exists) by running the script with a
# PATH that exposes jq/mv/etc but NOT flock. No claude, $0, ~1s.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QU="$REPO_ROOT/queue/queue-update.sh"
BASH_BIN="$(command -v bash)"

echo
echo "═══ 05-queue-update-noflock ═══════════════════════════════════════"

WORK="$(mktemp -d -t ap-qu)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
mkdir -p "$QDIR/in-progress"
cat > "$QDIR/in-progress/TKT-001.json" <<'JSON'
{ "id": "TKT-001", "title": "demo", "priority": 2,
  "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON
F="$QDIR/in-progress/TKT-001.json"

# 1) normal update in the ambient environment (flock path on Linux, fallback on macOS)
bash "$QU" in-progress TKT-001 '.branch="fix/TKT-001" | .base="main"' --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq -r '.branch' "$F")" "fix/TKT-001" "branch field set"
assert_eq "$(jq -r '.base' "$F")" "main" "base field set"
assert_eq "$(jq -r '.title' "$F")" "demo" "untouched field preserved"

# 2) deterministic no-flock path: PATH has jq/mv/mkdir/touch but NOT flock
FLOCKLESS="$WORK/flockless"
mkdir -p "$FLOCKLESS"
# include sleep + rmdir: the no-flock fallback serializes via a mkdir spin-lock
for b in jq mv mkdir rmdir touch rm cat sleep; do
  src="$(command -v "$b" || true)"
  [ -n "$src" ] && ln -sf "$src" "$FLOCKLESS/$b"
done
# guard the guard: flock must be unreachable under this PATH
if PATH="$FLOCKLESS" command -v flock >/dev/null 2>&1; then
  _fail "test setup error: flock leaked into neutered PATH"
fi
PATH="$FLOCKLESS" "$BASH_BIN" "$QU" in-progress TKT-001 '.worktree=".worktrees/TKT-001"' --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq -r '.worktree' "$F")" ".worktrees/TKT-001" "update applied without flock (fallback path)"
assert_eq "$(jq -r '.branch' "$F")" "fix/TKT-001" "earlier field still intact after fallback update"
jq -e . "$F" >/dev/null && _ok "ticket remains valid JSON after fallback write"

# 2b) concurrency on the no-flock path: 8 parallel updates each set a distinct
#     field; the portable mkdir lock must let all 8 land without clobbering.
for i in 1 2 3 4 5 6 7 8; do
  PATH="$FLOCKLESS" "$BASH_BIN" "$QU" in-progress TKT-001 ".z$i=$i" --queue-dir "$QDIR" >/dev/null &
done
wait
LANDED="$(jq '[keys[] | select(startswith("z"))] | length' "$F")"
assert_eq "$LANDED" "8" "8 concurrent no-flock updates all landed (mkdir lock, no clobber)"
jq -e . "$F" >/dev/null && _ok "ticket still valid JSON after concurrent fallback writes"

# 2c) fail-safe on the no-flock path: a malformed ticket makes jq fail; the
#     write must NOT reach mv (no truncation) and must exit non-zero. Guards the
#     regression where `_apply || rc=$?` suppressed set -e and corrupted the file.
BAD="$QDIR/in-progress/BAD.json"
printf 'this is { not valid json' > "$BAD"
BAD_ORIG="$(cat "$BAD")"
set +e
PATH="$FLOCKLESS" "$BASH_BIN" "$QU" in-progress BAD '.x=1' --queue-dir "$QDIR" >/dev/null 2>&1; rc=$?
set -e
assert_eq "$rc" "1" "malformed ticket (jq fails) exits non-zero on no-flock path"
assert_eq "$(cat "$BAD")" "$BAD_ORIG" "malformed ticket left intact — not truncated by failed write"
assert_eq "$(find "$QDIR/in-progress" -name '*.tmp.*' | wc -l | tr -d ' ')" "0" "no .tmp leak after failed write"

# 3) missing ticket -> exit 1
set +e
bash "$QU" in-progress NOPE '.x=1' --queue-dir "$QDIR" >/dev/null 2>&1; rc=$?
set -e
assert_eq "$rc" "1" "missing ticket exits 1"

# 4) missing jq-expression -> exit 2
set +e
bash "$QU" in-progress TKT-001 >/dev/null 2>&1; rc=$?
set -e
assert_eq "$rc" "2" "missing jq-expression exits 2"

echo
echo "${_GRN}✓ 05-queue-update-noflock passed${_RST}"
