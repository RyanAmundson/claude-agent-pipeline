#!/usr/bin/env bash
# 06-assertions-failpath.sh
#
# Regression test for the test harness itself.
#
# Bug: assertions.sh:_fail referenced ${BASH_SOURCE[2]}/${BASH_LINENO[1]}
# unconditionally. When _fail is called directly from a test body (call depth 1)
# under `set -u` — as the live tests do — those array slots are unbound, so the
# shell aborted with "unbound variable" BEFORE printing the failure site. That
# masked the real failure (e.g. the budget-cap failure in 02/03) behind a
# confusing harness crash.
#
# This test exercises the failure path directly (deterministic, no model spend)
# and asserts _fail reports cleanly under `set -u`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/assertions.sh"

echo
echo "═══ 06-assertions-failpath ════════════════════════════════════════"

# Call _fail directly from a body (depth 1) under `set -u`, in a subshell so its
# `exit 1` doesn't end this test. Capture combined output and exit code.
out="$(set -uo pipefail; . "$HERE/lib/assertions.sh"; _fail "synthetic failure" 2>&1)"
rc=$?

assert_eq "$rc" "1" "_fail exits non-zero on the failure path"
assert_contains "$out" "FAIL: synthetic failure" "_fail prints the failure message"
assert_contains "$out" " at " "_fail prints a call-site line"

# The regression itself: no 'unbound variable' crash under set -u.
if echo "$out" | grep -q "unbound variable"; then
  _fail "_fail emitted 'unbound variable' under set -u (regression returned)"
else
  _ok "no 'unbound variable' crash under set -u"
fi

echo
echo "${_GRN}✓ 06-assertions-failpath passed${_RST}"
