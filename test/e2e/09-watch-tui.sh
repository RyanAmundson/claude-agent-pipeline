#!/usr/bin/env bash
# 09-watch-tui.sh — unit test for the `agent-pipeline watch` TUI:
# pure frame builder (no TTY needed) + the non-TTY guard.
# No claude, $0, ~3s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 09-watch-tui ══════════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-watch)"
trap 'rm -rf "$WORK"' EXIT

# ── 1) non-TTY guard: piped stdout refuses with a pointer to events --json ─
if $AP watch --target "$WORK" >"$WORK/out.txt" 2>"$WORK/err.txt"; then
  _fail "watch must refuse when stdout is not a TTY"
else _ok "watch exits non-zero on non-TTY stdout"; fi
assert_contains "$(cat "$WORK/err.txt")" "not a TTY" "guard names the cause"
assert_contains "$(cat "$WORK/err.txt")" "events --json" "guard names the pipeable alternative"

# ── 2) frame builder is a pure function — exercise it headlessly ──────────
FRAME=$(node --input-type=module -e "
import { buildFrame } from '$REPO_ROOT/bin/watch.js';
const now = new Date('2026-06-12T10:42:10Z');
console.log(buildFrame({
  targetName: 'demo-app', backend: 'filesystem',
  states: ['needs-triage','needs-work','needs-test-review','ready-for-human','done','needs-info'],
  counts: { 'needs-work': 3, 'ready-for-human': 4 },
  deltas: { 'needs-work': 1, 'ready-for-human': 2 },
  cycle: { cycle: 14, at: '2026-06-12T10:42:00Z', nextCheckSeconds: 270 },
  runs: [{ agent: 'worker', startedAt: '2026-06-12T10:35:58Z' }],
  awaiting: [{ id: 'fs-101', title: 'fix: queue race in claim' }],
  events: ['10:42:01 MOVE  fs-101 needs-code-review → ready-for-human'],
  now, columns: 80, rows: 30,
}));
")
assert_contains "$FRAME" "demo-app" "title shows target"
assert_contains "$FRAME" "cycle 14" "title shows cycle number"
assert_contains "$FRAME" "next check 260s" "countdown derived from cycle.at + nextCheckSeconds"
assert_contains "$FRAME" "STAGES" "stages section present"
assert_contains "$FRAME" "needs-work" "non-zero stage rendered"
assert_contains "$FRAME" "(+1)" "stage delta rendered"
assert_contains "$FRAME" "⚠" "ready-for-human warning marker"
assert_contains "$FRAME" "RUNS" "runs section present"
assert_contains "$FRAME" "6m12s" "run elapsed time"
assert_contains "$FRAME" "AWAITING YOU" "awaiting section present"
assert_contains "$FRAME" "fs-101" "awaiting ticket id"
assert_contains "$FRAME" "EVENTS" "events section present"
assert_contains "$FRAME" "q quit" "quit hint in footer"
if echo "$FRAME" | grep -qF "needs-info"; then _fail "zero/zero state must not render"
else _ok "zero/zero state omitted"; fi

# every line exactly the same width (border integrity), and ≤ 80 cols
WIDTHS=$(node --input-type=module -e "
import { buildFrame } from '$REPO_ROOT/bin/watch.js';
const f = buildFrame({ targetName: 'x', backend: 'filesystem', states: ['needs-work'],
  counts: { 'needs-work': 1 }, deltas: null, cycle: null, runs: [], awaiting: [],
  events: [], now: new Date('2026-06-12T10:00:00Z'), columns: 72, rows: 20 });
const ws = new Set(f.split('\n').map(l => [...l].length));
console.log(ws.size === 1 && [...ws][0] <= 72 ? 'UNIFORM' : 'RAGGED ' + [...ws].join(','));
")
assert_eq "$WIDTHS" "UNIFORM" "all frame lines same code-point width (wide-char rendering not pinned)"

# expired countdown → 'check due'
DUE=$(node --input-type=module -e "
import { buildFrame } from '$REPO_ROOT/bin/watch.js';
const f = buildFrame({ targetName: 'x', backend: 'filesystem', states: [], counts: {},
  deltas: null, cycle: { cycle: 3, at: '2026-06-12T09:00:00Z', nextCheckSeconds: 60 },
  runs: [], awaiting: [], events: [], now: new Date('2026-06-12T10:00:00Z'), columns: 80, rows: 20 });
console.log(f.includes('check due') ? 'DUE' : 'MISSING');
")
assert_eq "$DUE" "DUE" "expired countdown renders 'check due'"

# degraded (non-FS) mode: no live queue — stages come from the cycle entry
DEG=$(node --input-type=module -e "
import { buildFrame } from '$REPO_ROOT/bin/watch.js';
const f = buildFrame({ targetName: 'x', backend: 'linear', states: ['needs-work'],
  counts: { 'needs-work': 5 }, deltas: null,
  cycle: { cycle: 2, at: '2026-06-12T10:00:00Z', nextCheckSeconds: 600 },
  runs: [], awaiting: [], events: [], now: new Date('2026-06-12T10:01:00Z'), columns: 80, rows: 20 });
console.log(f.includes('linear') && f.includes('needs-work') ? 'OK' : 'MISSING');
")
assert_eq "$DEG" "OK" "non-FS mode renders backend + cycle-sourced counts"

# ── 3) quit keys: q and Ctrl-C (ETX) — raw mode suppresses SIGINT ──────────
QUIT=$(node --input-type=module -e "
import { isQuitKey } from '$REPO_ROOT/bin/watch.js';
console.log([isQuitKey('q'), isQuitKey(String.fromCharCode(3)), isQuitKey('x'), isQuitKey('')].join(','));
")
assert_eq "$QUIT" "true,true,false,false" "q and ETX quit; x and empty string do not"

echo
echo "09-watch-tui: all assertions passed"
