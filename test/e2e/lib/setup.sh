# Shared setup for E2E tests. Source this AFTER setting test-specific env.
#
# Inputs (env):
#   FIXTURE   — fixture name under test/fixtures/  (default: full-pipeline)
#   AP_BUDGET — per-run budget cap in USD          (default: 0.30)
#
# Outputs (env exported back to the caller):
#   AP_TARGET — path to the tmp copy of the fixture
#   AP_BIN    — node bin/cli.js  (or $AP_BIN if pre-set)
#   AP_BUDGET — confirmed budget

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
FIXTURE="${FIXTURE:-full-pipeline}"
FIXTURE_DIR="$REPO_ROOT/test/fixtures/$FIXTURE"
AP_BIN="${AP_BIN:-node $REPO_ROOT/bin/cli.js}"
AP_BUDGET="${AP_BUDGET:-0.30}"

[ -d "$FIXTURE_DIR" ] || { echo "FAIL: fixture not found: $FIXTURE_DIR" >&2; exit 1; }

AP_TARGET="$(mktemp -d -t "ap-e2e-$FIXTURE")"
export AP_TARGET AP_BIN AP_BUDGET

# Copy fixture (excluding any pre-existing build artifacts) to tmp
cp -R "$FIXTURE_DIR/." "$AP_TARGET/"

# git init so agents that shell out to `git` don't fail with "not a repo"
(cd "$AP_TARGET" && git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "fixture") >/dev/null

# Install the pipeline (agents + rules + commands) into the fixture
$AP_BIN install "$AP_TARGET" --quiet >/dev/null

# Ensure the filesystem-backend queue dirs all exist (some agents assume)
for s in needs-triage needs-review needs-work in-progress needs-test-review \
         needs-code-review needs-feedback ready-for-human done needs-info; do
  mkdir -p "$AP_TARGET/.pipeline/queue/$s"
done

# Cleanup trap: kill any active-run supervisor pids, then rm -rf tmp dir.
_e2e_cleanup() {
  local exit_code=$?
  if [ -d "$AP_TARGET/.pipeline/runs/active" ]; then
    for f in "$AP_TARGET"/.pipeline/runs/active/*.json; do
      [ -e "$f" ] || continue
      pid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid') or '')" "$f" 2>/dev/null)
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done
  fi
  rm -rf "$AP_TARGET"
  exit "$exit_code"
}
trap _e2e_cleanup EXIT INT TERM

echo "── fixture ready: $AP_TARGET"
echo "── budget cap:    \$$AP_BUDGET / run"
