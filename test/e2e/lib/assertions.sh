# Shared assertions for E2E tests. Source this with `. lib/assertions.sh`.
#
# Conventions:
#   - All assertions exit non-zero on failure (set -e in the parent kills the run)
#   - Failure messages are prefixed "FAIL:" and include the assertion site
#   - Successes print "  ok: <description>" for visible progress

# Color codes if stdout is a tty
if [ -t 1 ]; then
  _RED=$'\033[31m'; _GRN=$'\033[32m'; _DIM=$'\033[2m'; _RST=$'\033[0m'
else
  _RED=''; _GRN=''; _DIM=''; _RST=''
fi

_fail() {
  echo "${_RED}FAIL:${_RST} $1" >&2
  echo "${_DIM}  at ${BASH_SOURCE[2]}:${BASH_LINENO[1]}${_RST}" >&2
  exit 1
}

_ok() {
  echo "  ${_GRN}ok:${_RST} $1"
}

assert_eq() {
  # assert_eq <actual> <expected> [<description>]
  local actual=$1 expected=$2 desc=${3:-"$actual == $expected"}
  if [ "$actual" = "$expected" ]; then _ok "$desc"
  else _fail "$desc — expected '$expected', got '$actual'"; fi
}

assert_contains() {
  # assert_contains <haystack> <needle> [<description>]
  local haystack=$1 needle=$2 desc=${3:-"contains '$needle'"}
  if echo "$haystack" | grep -qF "$needle"; then _ok "$desc"
  else _fail "$desc — '$needle' not found in: $haystack"; fi
}

assert_file_exists() {
  local path=$1 desc=${2:-"file exists: $path"}
  if [ -e "$path" ]; then _ok "$desc"
  else _fail "$desc — does not exist"; fi
}

assert_dir_has_files() {
  # assert_dir_has_files <dir> <glob> <min-count> [<description>]
  local dir=$1 glob=$2 min=$3 desc=${4:-"$dir has ≥ $min file(s) matching $glob"}
  local count
  count=$(find "$dir" -maxdepth 1 -name "$glob" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -ge "$min" ]; then _ok "$desc (found $count)"
  else _fail "$desc — found $count"; fi
}

# ─── CLI-aware assertions ──────────────────────────────────────────────────
# These assume AP_BIN and AP_TARGET are set by the test driver.

ap() { $AP_BIN "$@" --target "$AP_TARGET"; }

assert_run_status() {
  # assert_run_status <runId> <expected-status>  (running|completed|failed|killed)
  local runId=$1 expected=$2
  local actual
  actual=$(ap runs "$runId" --json | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")
  assert_eq "$actual" "$expected" "run $runId status is $expected"
}

assert_run_in_active() {
  local runId=$1
  local found
  found=$(ap runs --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(any(r.get('runId')==sys.argv[1] for r in d.get('active',[])))
" "$runId")
  assert_eq "$found" "True" "run $runId is in active list"
}

assert_run_in_completed() {
  local runId=$1
  local found
  found=$(ap runs --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(any(r.get('runId')==sys.argv[1] for r in d.get('completed',[])))
" "$runId")
  assert_eq "$found" "True" "run $runId is in completed list"
}

assert_event_log_has_type() {
  # assert_event_log_has_type <runId> <event-type>  e.g. 'system' or 'result'
  local runId=$1 type=$2
  local found
  found=$(ap runs "$runId" events --json | python3 -c "
import json,sys
want=sys.argv[1]
for line in sys.stdin:
    try:
        if json.loads(line).get('type')==want: print('yes'); sys.exit(0)
    except Exception: pass
print('no')
" "$type")
  assert_eq "$found" "yes" "events log for $runId has type=$type"
}

assert_ticket_count_in_state() {
  # assert_ticket_count_in_state <state> <min-count>
  local state=$1 min=$2
  assert_dir_has_files "$AP_TARGET/.pipeline/queue/$state" "*.json" "$min" \
    "≥ $min ticket(s) in $state"
}
