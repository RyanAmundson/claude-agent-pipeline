# Orchestrator Cycle Reports + Watch TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator a deterministic, machine-readable per-cycle status report (`agent-pipeline cycle report` → `.pipeline/runs/cycles.jsonl` → `cycle.report` watcher events) plus a live terminal dashboard (`agent-pipeline watch`).

**Architecture:** A new leaf module `api/cycles.js` owns the cycle data layer (path, validation, cycle-number/delta computation, append, block rendering). `bin/cli.js` gains two verbs that lazily import it; `api/index.js`'s `createWatcher` tails `cycles.jsonl` and emits `cycle.report` events; `bin/watch.js` is a zero-dependency ANSI TUI whose frame builder is a pure function. The orchestrator prompt (`agents/orchestrator.md`) is rewritten to call the verb and paste its stdout verbatim instead of hand-formatting a table.

**Tech Stack:** Node ≥ 18, no runtime dependencies (repo rule). Tests are bash e2e scripts under `test/e2e/` using `lib/assertions.sh` + `jq` (pattern: `test/e2e/07-queue-audit.sh`).

**Spec:** `docs/superpowers/specs/2026-06-12-orchestrator-cycle-reports-design.md` (approved). Work happens on branch `spec/orchestrator-cycle-reports` in the worktree `.claude/worktrees/orchestrator-cycle-reports`.

**File map:**

| File | Action | Responsibility |
|---|---|---|
| `api/cycles.js` | Create | Cycle data layer + block renderer (leaf module, imports nothing from `api/index.js`) |
| `bin/cli.js` | Modify | `--data` flag; `cycle` + `watch` dispatch cases; HELP lines; `renderEvent` gains `cycle.report` |
| `api/index.js` | Modify | `createWatcher` tails `cycles.jsonl`, emits `cycle.report` |
| `bin/watch.js` | Create | TUI: pure `buildFrame()` + `formatEventLine()` + `runWatch()` loop |
| `agents/orchestrator.md` | Modify | §3.5 output, §4 Report rewrite, Issue Log, filesystem-backend section |
| `docs/API.md`, `README.md` | Modify | Doc parity for both verbs + event type + file schema |
| `test/e2e/08-cycle-report.sh` | Create | Verb + JSONL + watcher-event tests |
| `test/e2e/09-watch-tui.sh` | Create | Frame-builder + non-TTY guard tests |

---

### Task 1: `cycle report` verb — failing test

**Files:**
- Create: `test/e2e/08-cycle-report.sh`

- [ ] **Step 1: Write the test file**

Create `test/e2e/08-cycle-report.sh` with exactly this content (mode 755):

```bash
#!/usr/bin/env bash
# 08-cycle-report.sh — unit test for orchestrator cycle reports:
# `agent-pipeline cycle report`, .pipeline/runs/cycles.jsonl, and the
# watcher's cycle.report events. No claude, $0, ~5s. Runs on every platform.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 08-cycle-report ═══════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-cycle)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pipeline/queue/needs-work" "$WORK/.pipeline/queue/ready-for-human"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem" }
JSON
CY="$WORK/.pipeline/runs/cycles.jsonl"

cat > "$WORK/.pipeline/queue/needs-work/fs-001.json" <<'JSON'
{ "id": "fs-001", "title": "first ticket", "priority": 2 }
JSON
cat > "$WORK/.pipeline/queue/ready-for-human/fs-002.json" <<'JSON'
{ "id": "fs-002", "title": "review me", "priority": 2 }
JSON

# ── 1) first cycle: FS auto-counts, cycle=1, no deltas, file created ───────
OUT=$($AP cycle report --target "$WORK" \
  --data '{"dispatched":[{"agent":"worker","item":"fs-001"}],"awaiting":["fs-002"],"nextCheckSeconds":270}')
assert_file_exists "$CY" "cycles.jsonl created"
assert_eq "$(jq -s 'length' "$CY")" "1" "one line after first report"
assert_eq "$(jq -r '.cycle' "$CY")" "1" "first cycle is 1"
assert_eq "$(jq -r '.v' "$CY")" "1" "schema version stamped"
assert_eq "$(jq -r '.counts["needs-work"]' "$CY")" "1" "needs-work auto-counted from queue"
assert_eq "$(jq -r '.counts["ready-for-human"]' "$CY")" "1" "ready-for-human auto-counted"
assert_eq "$(jq -r '.backend' "$CY")" "filesystem" "backend stamped from config"
assert_contains "$OUT" "[orchestrator] cycle 1" "block header present"
assert_contains "$OUT" "backend: filesystem" "header names backend"
assert_contains "$OUT" "dispatched 1 worker" "dispatch annotation on stage line"
assert_contains "$OUT" "awaiting you: fs-002" "awaiting-you line"
assert_contains "$OUT" "next check in 270s" "footer countdown"
if echo "$OUT" | grep -qF '(='; then _fail "first cycle must not render deltas"
else _ok "no delta column on first cycle"; fi

# ── 2) second cycle: deltas vs cycle 1, zero-count state with delta shows ──
mv "$WORK/.pipeline/queue/needs-work/fs-001.json" "$WORK/.pipeline/queue/ready-for-human/"
OUT2=$($AP cycle report --target "$WORK" --data '{"nextCheckSeconds":600}')
assert_contains "$OUT2" "cycle 2" "cycle number increments"
assert_eq "$(jq -s '.[1].cycle' "$CY")" "2" "second line is cycle 2"
assert_contains "$OUT2" "needs-work" "zero-count state renders when delta != 0"
assert_contains "$OUT2" "(-1)" "negative delta rendered"
assert_contains "$OUT2" "(+1)" "positive delta rendered"
if echo "$OUT2" | grep -qF "needs-triage"; then _fail "zero/zero state must be omitted"
else _ok "zero-count zero-delta state omitted"; fi

# ── 3) validation errors ───────────────────────────────────────────────────
if $AP cycle report --target "$WORK" --data '{nope' >/dev/null 2>"$WORK/err1.txt"; then
  _fail "malformed --data must exit non-zero"
else _ok "malformed --data exits non-zero"; fi
assert_contains "$(cat "$WORK/err1.txt")" "not valid JSON" "error names the problem"

if $AP cycle report --target "$WORK" --data '{"counts":{"bogus":1}}' >/dev/null 2>"$WORK/err2.txt"; then
  _fail "unknown state must exit non-zero"
else _ok "unknown count state exits non-zero"; fi
assert_contains "$(cat "$WORK/err2.txt")" "unknown state 'bogus'" "error names the bad state"

if $AP cycle report --target "$WORK" >/dev/null 2>"$WORK/err3.txt"; then
  _fail "missing --data must exit non-zero"
else _ok "missing --data exits non-zero"; fi
assert_contains "$(cat "$WORK/err3.txt")" "--data is required" "usage error names the flag"

# ── 4) linear backend requires counts ──────────────────────────────────────
LWORK="$(mktemp -d -t ap-cycle-linear)"
mkdir -p "$LWORK/.pipeline"
cat > "$LWORK/.pipeline/config.json" <<'JSON'
{ "backend": "linear" }
JSON
if $AP cycle report --target "$LWORK" --data '{}' >/dev/null 2>"$LWORK/err.txt"; then
  _fail "linear backend without counts must exit non-zero"
else _ok "linear backend without counts exits non-zero"; fi
assert_contains "$(cat "$LWORK/err.txt")" "required when backend is 'linear'" "error explains why + names the fix"
LOUT=$($AP cycle report --target "$LWORK" --data '{"counts":{"needs-work":3},"nextCheckSeconds":600}')
assert_contains "$LOUT" "backend: linear" "linear mode works with explicit counts"
assert_eq "$(jq -r '.counts["needs-work"]' "$LWORK/.pipeline/runs/cycles.jsonl")" "3" "explicit counts stored"
rm -rf "$LWORK"

# ── 5) corrupt tail: fail-open, warn, numbering restarts ───────────────────
echo 'GARBAGE NOT JSON' >> "$CY"
OUT3=$($AP cycle report --target "$WORK" --data '{}' 2>"$WORK/warn.txt")
assert_contains "$(cat "$WORK/warn.txt")" "not valid JSON" "corrupt tail warns on stderr"
assert_contains "$OUT3" "cycle 1" "fail-open: treated as first cycle"
assert_eq "$(tail -1 "$CY" | jq -r '.cycle')" "1" "appended line is cycle 1"

# ── 6) idle cycle still renders a block ────────────────────────────────────
OUT4=$($AP cycle report --target "$WORK" --data '{"nextCheckSeconds":1800}')
assert_contains "$OUT4" "[orchestrator] cycle 2" "idle cycle still reports"
assert_contains "$OUT4" "0 dispatched" "idle footer shows zero dispatches"

# ── 7) notes render ────────────────────────────────────────────────────────
OUT5=$($AP cycle report --target "$WORK" \
  --data '{"notes":["self-healing: re-queued stale fs-098"],"nextCheckSeconds":600}')
assert_contains "$OUT5" "✓ self-healing: re-queued stale fs-098" "notes render with check mark"

# ── 8) watcher emits cycle.report exactly once per append ─────────────────
$AP events --target "$WORK" --json > "$WORK/events.out" 2>/dev/null &
EV_PID=$!
sleep 1
$AP cycle report --target "$WORK" --data '{"nextCheckSeconds":600}' >/dev/null
sleep 1
kill "$EV_PID" 2>/dev/null
wait "$EV_PID" 2>/dev/null
assert_contains "$(cat "$WORK/events.out")" '"type":"cycle.report"' "watcher emitted cycle.report"
assert_eq "$(grep -c '"type":"cycle.report"' "$WORK/events.out")" "1" "emitted exactly once (no history replay, no double-emit)"

echo
echo "08-cycle-report: all assertions passed"
```

- [ ] **Step 2: Make it executable and run it to verify it fails**

Run: `chmod +x test/e2e/08-cycle-report.sh && bash test/e2e/08-cycle-report.sh`
Expected: FAIL — the first `$AP cycle report` invocation dies with `Unknown command: cycle` (the CLI's `default:` case), leaving `OUT` empty and no file written, so the very first assertion (`assert_file_exists "cycles.jsonl created"`) prints `FAIL:` and exits 1. (The suite uses `set -uo pipefail` without `-e`, so the failed substitution itself doesn't stop the script — the assertion does.)

- [ ] **Step 3: Commit the failing test**

```bash
git add test/e2e/08-cycle-report.sh
git commit -m "test: failing e2e for agent-pipeline cycle report"
```

---

### Task 2: `api/cycles.js` + CLI wiring

**Files:**
- Create: `api/cycles.js`
- Modify: `bin/cli.js` (flag defaults ~line 85, flag case ~line 120, HELP ~line 56, dispatch switch ~line 347, new function near `runEvents`)

- [ ] **Step 1: Create `api/cycles.js`**

Full content:

```js
// claude-agent-pipeline — orchestrator cycle reports (data layer + renderer).
//
// One JSON line per orchestrator cycle, appended to
//   <target>/.pipeline/runs/cycles.jsonl
// The CLI (`agent-pipeline cycle report`) stamps cycle number + timestamp and
// computes per-state deltas against the previous line; the rendered block is
// what the orchestrator pastes into its session. The watcher (api/index.js)
// tails the same file into `cycle.report` events.
//
// Deliberately separate from the queue audit log (queue/events.jsonl): that is
// filesystem-backend ticket-mutation audit; this is backend-neutral
// orchestrator telemetry. Leaf module — must not import from api/index.js
// (index.js imports from here; keep the graph acyclic).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function cyclesPath(target) {
  return join(resolve(target), '.pipeline', 'runs', 'cycles.jsonl');
}

// Reads config.backend; absent/unreadable config means filesystem (local-only default).
export function getBackend(target) {
  const cfgPath = join(resolve(target), '.pipeline', 'config.json');
  if (!existsSync(cfgPath)) return 'filesystem';
  try { return JSON.parse(readFileSync(cfgPath, 'utf8')).backend || 'filesystem'; }
  catch { return 'filesystem'; }
}

// Agent role → the queue state its dispatch annotation attaches to in the block.
// Roles not listed here (detectors, cleanup, scanner, ...) render in the footer.
export const DISPATCH_STATE = Object.freeze({
  'ticket-creator': 'needs-triage',
  'ticket-reviewer': 'needs-review',
  'worker': 'needs-work',
  'tester': 'needs-test-review',
  'code-reviewer': 'needs-code-review',
  'feedback-responder': 'needs-feedback',
  'branch-updater': 'ready-for-human',
});

// → array of human-readable problems (empty = valid). `states` is api STATES.
export function validatePayload(payload, { backend, states }) {
  const errs = [];
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(payload)) return ['payload must be a JSON object'];
  const known = ['counts', 'dispatched', 'running', 'awaiting', 'notes', 'nextCheckSeconds'];
  for (const k of Object.keys(payload)) {
    if (!known.includes(k)) errs.push(`unknown field '${k}' (known: ${known.join(', ')})`);
  }
  if (payload.counts != null) {
    if (!isObj(payload.counts)) errs.push(`'counts' must be an object of <state>: <integer>`);
    else for (const [k, v] of Object.entries(payload.counts)) {
      if (!states.includes(k)) errs.push(`counts: unknown state '${k}' (valid: ${states.join(', ')})`);
      else if (!Number.isInteger(v) || v < 0) errs.push(`counts.${k}: must be a non-negative integer, got ${JSON.stringify(v)}`);
    }
  } else if (backend !== 'filesystem') {
    errs.push(`'counts' is required when backend is '${backend}' — only the orchestrator can see label state. Pass them in --data, e.g. {"counts":{"needs-work":3}}`);
  }
  for (const field of ['dispatched', 'running']) {
    const arr = payload[field];
    if (arr == null) continue;
    if (!Array.isArray(arr)) { errs.push(`'${field}' must be an array`); continue; }
    arr.forEach((d, i) => {
      if (!isObj(d) || typeof d.agent !== 'string') {
        errs.push(`${field}[${i}]: must be an object with a string 'agent' (and optional 'item'${field === 'running' ? ", 'minutes'" : ''})`);
      }
    });
  }
  for (const field of ['awaiting', 'notes']) {
    const arr = payload[field];
    if (arr == null) continue;
    if (!Array.isArray(arr) || arr.some(s => typeof s !== 'string')) {
      errs.push(`'${field}' must be an array of strings`);
    }
  }
  if (payload.nextCheckSeconds != null && (!Number.isInteger(payload.nextCheckSeconds) || payload.nextCheckSeconds <= 0)) {
    errs.push(`'nextCheckSeconds' must be a positive integer (seconds until the next orchestrator check)`);
  }
  return errs;
}

// Last n entries. corruptTail is true iff the FINAL line exists but is not JSON
// (earlier bad lines are skipped silently — only the tail drives numbering).
export function readCycleTail(target, n = 1) {
  let content;
  try { content = readFileSync(cyclesPath(target), 'utf8'); } catch { return { entries: [], corruptTail: false }; }
  const lines = content.split('\n').filter(l => l.trim());
  const tail = lines.slice(-n);
  const entries = [];
  let corruptTail = false;
  tail.forEach((line, i) => {
    try { entries.push(JSON.parse(line)); }
    catch { if (i === tail.length - 1) corruptTail = true; }
  });
  return { entries, corruptTail };
}

// All parseable entries + raw line count (watcher uses lineCount as its cursor).
export function readCycleLines(target) {
  let content;
  try { content = readFileSync(cyclesPath(target), 'utf8'); } catch { return { lineCount: 0, entries: [] }; }
  const lines = content.split('\n').filter(l => l.trim());
  return { lineCount: lines.length, entries: lines.map(l => { try { return JSON.parse(l); } catch { return null; } }) };
}

export function cyclesFileSize(target) {
  try { return statSync(cyclesPath(target)).size; } catch { return 0; }
}

export function computeDeltas(prevCounts, counts) {
  const keys = new Set([...Object.keys(prevCounts || {}), ...Object.keys(counts || {})]);
  const out = {};
  for (const k of keys) out[k] = (counts?.[k] || 0) - (prevCounts?.[k] || 0);
  return out;
}

export function buildCycleEntry(payload, prev, { backend, now = new Date() } = {}) {
  const counts = {};
  for (const [k, v] of Object.entries(payload.counts || {})) if (v !== 0) counts[k] = v;
  return {
    v: 1,
    cycle: (prev?.cycle ?? 0) + 1,
    at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    backend,
    counts,
    dispatched: payload.dispatched || [],
    running: payload.running || [],
    awaiting: payload.awaiting || [],
    notes: payload.notes || [],
    ...(payload.nextCheckSeconds != null ? { nextCheckSeconds: payload.nextCheckSeconds } : {}),
  };
}

export function appendCycle(target, entry) {
  mkdirSync(join(resolve(target), '.pipeline', 'runs'), { recursive: true });
  const path = cyclesPath(target);
  appendFileSync(path, JSON.stringify(entry) + '\n');
  return path;
}

function fmtDelta(d) { return d > 0 ? `(+${d})` : d < 0 ? `(${d})` : '(=)'; }

// The canonical block. `prev` null → first cycle → no delta column.
export function renderBlock(entry, prev, states) {
  const lines = [];
  const when = entry.at.slice(0, 16).replace('T', ' ');
  lines.push(`[orchestrator] cycle ${entry.cycle} · ${when} · backend: ${entry.backend}`);
  lines.push('');

  const deltas = prev ? computeDeltas(prev.counts, entry.counts) : null;

  // Aggregate dispatch annotations per state ("dispatched 2 workers").
  const byState = {};
  const footerDispatch = [];
  const tally = {};
  for (const d of entry.dispatched) tally[d.agent] = (tally[d.agent] || 0) + 1;
  for (const [agent, n] of Object.entries(tally)) {
    const text = `dispatched ${n} ${n > 1 ? `${agent}s` : agent}`;
    const st = DISPATCH_STATE[agent];
    if (st) (byState[st] ||= []).push(text);
    else footerDispatch.push(text);
  }

  const shown = states.filter(s => (entry.counts[s] || 0) !== 0 || (deltas?.[s] || 0) !== 0);
  const nameW = shown.reduce((m, s) => Math.max(m, s.length), 0);
  for (const s of shown) {
    const count = entry.counts[s] || 0;
    let line = `  ${s.padEnd(nameW)} ${String(count).padEnd(3)}`;
    if (deltas) line += ` ${fmtDelta(deltas[s] || 0).padEnd(5)}`;
    const ann = [];
    if (byState[s]) ann.push(`→ ${byState[s].join(', ')}`);
    if (s === 'ready-for-human' && entry.awaiting.length) {
      const ids = entry.awaiting.slice(0, 6).join(', ');
      const more = entry.awaiting.length > 6 ? ` +${entry.awaiting.length - 6} more` : '';
      ann.push(`⚠ awaiting you: ${ids}${more}`);
    }
    if (ann.length) line += `  ${ann.join('  ')}`;
    lines.push(line);
  }

  lines.push('');
  const parts = [`${entry.dispatched.length} dispatched`];
  if (entry.running.length) {
    const r = entry.running
      .map(x => `${x.agent} on ${x.item ?? '?'}${x.minutes != null ? `, ${x.minutes}m` : ''}`)
      .join(' · ');
    parts.push(`${entry.running.length} running (${r})`);
  }
  lines.push(`  agents: ${parts.join(', ')}`);
  if (footerDispatch.length) lines.push(`  also: ${footerDispatch.join(', ')}`);
  if (entry.nextCheckSeconds != null) lines.push(`  next check in ${entry.nextCheckSeconds}s`);
  for (const n of entry.notes) lines.push(`  ✓ ${n}`);
  return lines.join('\n');
}
```

- [ ] **Step 2: Wire the verb into `bin/cli.js`**

Four edits:

(a) In `parseFlags` defaults (the object at ~line 79–86), extend the last line:

```js
    body: null, verdict: null, author: null, data: null,
```

(b) In the flag `switch` (after `case '--author': ...` ~line 120):

```js
      case '--data': flags.data = args[++i]; break;
```

(c) In HELP, after the `runs kill` line (~line 55):

```
  agent-pipeline cycle report --data '<json>' [--target <p>]
                                              Record an orchestrator cycle + print the formatted status block
  agent-pipeline watch [--target <p>]         Live terminal dashboard (TUI) of queue, runs, and cycles
```

(The `watch` HELP line lands now; the verb itself is Task 4 — `agent-pipeline watch` keeps dying with `Unknown command` until then, which only test 09 exercises.)

(d) In the dispatch `switch` (after `case 'runs': ...` ~line 347):

```js
  case 'cycle':  runCycle(positional, flags); break;
```

(e) Add the function after `runEvents` (~line 505):

```js
async function runCycle(positional, flags) {
  const usage = `Usage: agent-pipeline cycle report --data '<json>' [--target <p>]   (--data - reads the payload from stdin)`;
  if (positional.length !== 1 || positional[0] !== 'report') die(usage);
  if (!flags.data) {
    die(`cycle report: --data is required — the cycle payload JSON (or '-' to read it from stdin).\n${usage}\nExample: agent-pipeline cycle report --data '{"dispatched":[{"agent":"worker","item":"fs-103"}],"nextCheckSeconds":600}'`);
  }
  const target = targetOf(flags);
  const { STATES, readSnapshot } = await import('../api/index.js');
  const { getBackend, validatePayload, readCycleTail, buildCycleEntry, appendCycle, renderBlock } =
    await import('../api/cycles.js');

  const raw = flags.data === '-' ? readFileSync(0, 'utf8') : flags.data;
  let payload;
  try { payload = JSON.parse(raw); }
  catch (err) {
    die(`cycle report: --data is not valid JSON (${err.message}).\nExample: --data '{"dispatched":[],"nextCheckSeconds":600}'`);
  }

  const backend = getBackend(target);
  const errs = validatePayload(payload, { backend, states: STATES });
  if (errs.length) die(`cycle report: invalid payload:\n  - ${errs.join('\n  - ')}`);

  // Filesystem mode: counts are optional — snapshot the queue ourselves.
  if (!payload.counts && backend === 'filesystem') {
    const snap = readSnapshot({ target, pluginRoot: PLUGIN_ROOT });
    payload.counts = {};
    for (const st of STATES) {
      const n = (snap.tickets.byState[st] || []).length;
      if (n) payload.counts[st] = n;
    }
  }

  const { entries, corruptTail } = readCycleTail(target, 1);
  if (corruptTail) {
    console.warn(`warning: last line of .pipeline/runs/cycles.jsonl is not valid JSON — treating this as the first cycle (numbering and deltas reset). Inspect the file if cycle history matters.`);
  }
  const prev = corruptTail ? null : (entries[entries.length - 1] ?? null);
  const entry = buildCycleEntry(payload, prev, { backend });
  appendCycle(target, entry);
  console.log(renderBlock(entry, prev, STATES));
}
```

- [ ] **Step 3: Run the test — sections 1–7 pass, section 8 fails**

Run: `bash test/e2e/08-cycle-report.sh`
Expected: all assertions through "notes render with check mark" pass; the final watcher section FAILS (`emitted exactly once` or the `"type":"cycle.report"` contains-check) because the watcher doesn't know about `cycles.jsonl` yet.

- [ ] **Step 4: Commit**

```bash
git add api/cycles.js bin/cli.js
git commit -m "feat(cli): agent-pipeline cycle report — cycles.jsonl + deterministic status block"
```

---

### Task 3: Watcher emits `cycle.report`

**Files:**
- Modify: `api/index.js` (imports ~line 13, `createWatcher` ~lines 223–308)
- Modify: `bin/cli.js` (`renderEvent` switch ~lines 509–522)

- [ ] **Step 1: Add the cycles tail to `createWatcher`**

(a) At the top of `api/index.js`, after the `./runs.js` import (line 13):

```js
import { cyclesPath, readCycleLines, cyclesFileSize } from './cycles.js';
```

(b) In `createWatcher`, after `let lastRuns = indexRuns(target);` (~line 233):

```js
  let lastCyclesSize = cyclesFileSize(target);
  let lastCyclesCount = readCycleLines(target).lineCount;
```

(c) In `scheduleReconcile()`, after the runs diff block (~line 261, before the closing brace):

```js
    // Cycle reports: tail .pipeline/runs/cycles.jsonl. Size-guarded so the
    // common no-change reconcile never reads the file. Shrink = truncation/
    // rotation — reset the cursor without emitting (the log is append-only;
    // anything else is manual intervention).
    const size = cyclesFileSize(target);
    if (size !== lastCyclesSize) {
      const { lineCount, entries } = readCycleLines(target);
      if (lineCount > lastCyclesCount) {
        for (const c of entries.slice(lastCyclesCount)) {
          if (c) emit({ type: 'cycle.report', cycle: c });
        }
      }
      lastCyclesSize = size;
      lastCyclesCount = lineCount;
    }
```

(d) After the runs-dir `fsWatch` loop (~line 302, after the `for (const sub of ['active', 'completed'])` block), watch the runs root itself so writes to `cycles.jsonl` (a direct child) trigger `onFsChange`:

```js
  // cycles.jsonl lives directly in the runs root; watch the dir non-recursively.
  try {
    const w = fsWatch(runsRoot(target), { persistent: true }, onFsChange);
    w.on('error', err => emitter.emit('error', err));
    watchers.push(w);
  } catch (err) {
    emitter.emit('error', err);
  }
```

(`runsRoot` is already imported from `./runs.js` at line 13; `ensureRunsDirs` at ~line 291 guarantees the dir exists before this runs.)

- [ ] **Step 2: Render the event in `bin/cli.js`**

In `renderEvent`'s switch, after the `run.remove` case (~line 521):

```js
    case 'cycle.report': {
      const c = ev.cycle;
      const ready = c.counts?.['ready-for-human'] || 0;
      console.log(`CYCLE  #${c.cycle}  dispatched=${(c.dispatched || []).length} ready-for-human=${ready}`);
      break;
    }
```

(`runsOnly` mode at the top of `renderEvent` already filters this out for `runs events` — `cycle.report` doesn't start with `run.`.)

- [ ] **Step 3: Run the full test — everything passes**

Run: `bash test/e2e/08-cycle-report.sh`
Expected: PASS — ends with `08-cycle-report: all assertions passed`. The watcher section asserts both emission and exactly-once (no replay of pre-existing lines on watcher start, since the cursor initializes to the current line count).

- [ ] **Step 4: Regression-check the existing suites**

Run: `bash test/e2e/04-queue-comment.sh && bash test/e2e/05-queue-update-noflock.sh && bash test/e2e/07-queue-audit.sh && npm test`
Expected: all pass (watcher change is additive; 01–03/06 are live-tier and skip without `CAP_E2E_LIVE=1`).

- [ ] **Step 5: Commit**

```bash
git add api/index.js bin/cli.js
git commit -m "feat(api): watcher tails cycles.jsonl into cycle.report events"
```

---

### Task 4: `agent-pipeline watch` TUI

**Files:**
- Create: `test/e2e/09-watch-tui.sh`
- Create: `bin/watch.js`
- Modify: `bin/cli.js` (dispatch switch + new `runWatchCmd`)

- [ ] **Step 1: Write the failing test**

Create `test/e2e/09-watch-tui.sh` (mode 755):

```bash
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
assert_eq "$WIDTHS" "UNIFORM" "all frame lines same width, within columns"

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

echo
echo "09-watch-tui: all assertions passed"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `chmod +x test/e2e/09-watch-tui.sh && bash test/e2e/09-watch-tui.sh`
Expected: FAIL — `watch` is an unknown command (exits non-zero, which passes the guard's exit check, but the stderr assertion `guard names the cause` fails since the message is `Unknown command: watch`).

- [ ] **Step 3: Create `bin/watch.js`**

Full content:

```js
// claude-agent-pipeline — `agent-pipeline watch`: live terminal dashboard.
//
// Zero dependencies: raw ANSI (alternate screen, full-frame redraw). The frame
// builder is a pure function (state → string) so it is testable without a TTY.
// Data comes from one createWatcher subscription plus cycles.jsonl for cycle
// context. In non-filesystem backends the watcher sees no queue dirs, so
// STAGES/AWAITING degrade to the latest cycle report's data.

import { basename } from 'node:path';

const LABEL_W = 16;

function clip(text, w) {
  const chars = [...text];
  return chars.length > w ? chars.slice(0, Math.max(0, w - 1)).join('') + '…' : text;
}

function elapsed(startedAt, now) {
  const ms = now - new Date(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function countdown(cycle, now) {
  if (!cycle?.nextCheckSeconds || !cycle.at) return 'no cycle yet';
  const due = new Date(cycle.at).getTime() + cycle.nextCheckSeconds * 1000;
  const remain = Math.floor((due - now.getTime()) / 1000);
  return remain > 0 ? `next check ${remain}s` : 'check due';
}

function fmtDelta(d) { return d > 0 ? `(+${d})` : d < 0 ? `(${d})` : '(=)'; }

// Pure: state → frame string. state = { targetName, backend, states, counts,
// deltas, cycle, runs, awaiting, events, now, columns, rows }.
export function buildFrame(s) {
  const w = Math.min(Math.max(s.columns || 80, 60), 110);
  const inner = w - 4; // '│ ' + content + ' │'
  const lines = [];
  const row = t => '│ ' + clip(t, inner).padEnd(inner) + ' │';
  const blank = row('');
  const section = (label, body) => {
    lines.push(blank);
    const items = body.length ? body : ['—'];
    items.forEach((b, i) => lines.push(row(`${(i === 0 ? label : '').padEnd(LABEL_W)}${b}`)));
  };

  const title = ` ${s.targetName} · ${s.backend}${s.cycle ? ` · cycle ${s.cycle.cycle}` : ''} · ${countdown(s.cycle, s.now)} `;
  lines.push('┌' + clip(`─${title}`, w - 2).padEnd(w - 2, '─') + '┐');

  const counts = s.counts || {};
  const stages = (s.states || [])
    .filter(st => (counts[st] || 0) !== 0 || (s.deltas?.[st] || 0) !== 0)
    .map(st => {
      const d = s.deltas ? ` ${fmtDelta(s.deltas[st] || 0)}` : '';
      const warn = st === 'ready-for-human' && (counts[st] || 0) > 0 ? ' ⚠' : '';
      return `${st.padEnd(18)} ${String(counts[st] || 0).padEnd(3)}${d}${warn}`;
    });
  section('STAGES', stages);

  section('RUNS ▶', (s.runs || []).map(r =>
    `${(r.agent || '?').padEnd(20)} ${elapsed(r.startedAt, s.now)}`));

  section('AWAITING YOU', (s.awaiting || []).slice(0, 5).map(t =>
    `${String(t.id).padEnd(12)} ${t.title || ''}`));

  section('EVENTS', (s.events || []).slice(-8));

  lines.push(blank);
  lines.push('└' + clip('─ q quit · refreshes live ', w - 2).padEnd(w - 2, '─') + '┘');
  return lines.join('\n');
}

// One line per watcher event for the EVENTS panel. Returns null for events
// the panel doesn't show (snapshot, run.update churn).
export function formatEventLine(ev, ts) {
  const t = ts.toTimeString().slice(0, 8);
  switch (ev.type) {
    case 'ticket.move':   return `${t} MOVE  ${ev.id} ${ev.from} → ${ev.to}`;
    case 'ticket.upsert': return `${t} TKT   ${ev.ticket?.id} [${ev.state}]`;
    case 'ticket.remove': return `${t} DEL   ${ev.id} [${ev.state}]`;
    case 'run.start':     return `${t} RUN▶  ${ev.run?.agent || ev.runId}`;
    case 'run.complete':  return `${t} RUN✓  ${ev.run?.agent || ev.runId}${ev.run?.cost?.usd != null ? ` $${ev.run.cost.usd.toFixed(2)}` : ''}`;
    case 'run.fail':      return `${t} RUN✗  ${ev.run?.agent || ev.runId} exit=${ev.run?.exitCode}`;
    case 'run.kill':      return `${t} RUNK  ${ev.runId}`;
    case 'cycle.report':  return `${t} CYCLE #${ev.cycle.cycle} dispatched=${(ev.cycle.dispatched || []).length}`;
    default: return null;
  }
}

export async function runWatch({ target, pluginRoot }) {
  const { createWatcher, readSnapshot, STATES } = await import('../api/index.js');
  const { readCycleTail, computeDeltas, getBackend } = await import('../api/cycles.js');

  const state = {
    targetName: basename(target),
    backend: getBackend(target),
    states: STATES,
    cycle: null, prevCycle: null,
    counts: {}, deltas: null, awaiting: [], runs: [], events: [],
  };

  const tail = readCycleTail(target, 2);
  state.cycle = tail.entries[tail.entries.length - 1] ?? null;
  state.prevCycle = tail.entries.length > 1 ? tail.entries[tail.entries.length - 2] : null;

  const refresh = () => {
    const snap = readSnapshot({ target, pluginRoot });
    if (state.backend === 'filesystem') {
      state.counts = {};
      for (const st of STATES) {
        const n = (snap.tickets.byState[st] || []).length;
        if (n) state.counts[st] = n;
      }
      state.awaiting = (snap.tickets.byState['ready-for-human'] || [])
        .map(t => ({ id: t.id, title: t.title || '' }));
      state.deltas = state.prevCycle ? computeDeltas(state.prevCycle.counts, state.counts) : null;
    } else {
      // Degraded mode: no queue on disk — render the orchestrator's last report.
      state.counts = state.cycle?.counts || {};
      state.awaiting = (state.cycle?.awaiting || []).map(id => ({ id, title: '' }));
      state.deltas = state.prevCycle && state.cycle
        ? computeDeltas(state.prevCycle.counts, state.cycle.counts) : null;
    }
    state.runs = snap.runs.active;
  };

  const render = () => {
    const frame = buildFrame({
      ...state, now: new Date(),
      columns: process.stdout.columns, rows: process.stdout.rows,
    });
    process.stdout.write('\x1b[H\x1b[2J' + frame + '\n');
  };

  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  const w = createWatcher({ target, pluginRoot });
  const timer = setInterval(render, 1000);
  const cleanup = () => {
    clearInterval(timer);
    try { w.close(); } catch {}
    process.stdout.write('\x1b[?25h\x1b[?1049l'); // cursor back, leave alt screen
  };
  const quit = () => { cleanup(); process.exit(0); };

  w.on('event', ev => {
    if (ev.type === 'cycle.report') { state.prevCycle = state.cycle; state.cycle = ev.cycle; }
    const line = formatEventLine(ev, new Date());
    if (line) {
      state.events.push(line);
      if (state.events.length > 8) state.events.shift();
    }
    refresh();
    render();
  });
  w.on('error', () => {}); // transient fs errors — the reconcile tick recovers

  process.stdout.on('resize', render);
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', b => {
      const k = b.toString();
      if (k === 'q' || k === '\u0003') quit(); // q or Ctrl-C in raw mode
    });
  }

  refresh();
  render();
}
```

- [ ] **Step 4: Wire `watch` into `bin/cli.js`**

(a) Dispatch switch, after the `cycle` case from Task 2:

```js
  case 'watch':  runWatchCmd(flags); break;
```

(b) New function after `runCycle`:

```js
async function runWatchCmd(flags) {
  if (!process.stdout.isTTY) {
    die(`watch: stdout is not a TTY — the live dashboard needs an interactive terminal.\nFor pipeable output use: agent-pipeline events --json`);
  }
  const { runWatch } = await import('./watch.js');
  await runWatch({ target: targetOf(flags), pluginRoot: PLUGIN_ROOT });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash test/e2e/09-watch-tui.sh`
Expected: PASS — ends with `09-watch-tui: all assertions passed`.

- [ ] **Step 6: Manual smoke (interactive)**

In a real terminal, from the worktree root: `node bin/cli.js watch --target "$(mktemp -d)"` — expect the bordered frame with `no cycle yet`, all sections showing `—`; `q` exits and restores the screen. (Skip if no interactive TTY is available; the non-TTY path is covered by the test.)

- [ ] **Step 7: Commit**

```bash
git add test/e2e/09-watch-tui.sh bin/watch.js bin/cli.js
git commit -m "feat(cli): agent-pipeline watch — live zero-dep terminal dashboard"
```

---

### Task 5: Orchestrator prompt changes

**Files:**
- Modify: `agents/orchestrator.md` (§3.5 ~line 114, §4 ~lines 118–140, Issue Log ~lines 221–230, filesystem section ~lines 271–279)

No automated test — verify by reading the diff against the checklist in Step 5.

- [ ] **Step 1: Rewrite §4 "Report"**

Replace the entire `### 4. Report` section (lines 118–140: the heading, "Post a summary each cycle:", and the fenced example block) with:

````markdown
### 4. Report (every cycle — idle cycles included)

Do NOT hand-format a status table. After making this cycle's dispatch decisions, record the cycle and emit the canonical block:

1. Build the payload:
   - `counts` — GitHub/Linear mode: the label snapshot from step 1, keyed by queue-state names (`pipeline:needs-work` → `needs-work`), with PR refs (`#123`) as items. Filesystem mode: OMIT `counts` entirely — the CLI snapshots the queue itself.
   - `dispatched` — one `{"agent","item"}` per agent dispatched this cycle.
   - `running` — agents still running from earlier cycles: `{"agent","item","minutes"}`.
   - `awaiting` — ticket ids / PR refs currently in ready-for-human.
   - `notes` — one string per self-audit action (prefix `self-audit:`) and self-healing action (prefix `self-healing:`). Omit the field when nothing happened — don't pad.
   - `nextCheckSeconds` — the ScheduleWakeup delay you are about to use.
2. Run:

   ```
   agent-pipeline cycle report --data '<payload JSON>'
   ```

3. Paste the command's stdout VERBATIM as your cycle update. That block IS the report — do not wrap it in another table or restate it.

Example:

```
agent-pipeline cycle report --data '{"dispatched":[{"agent":"worker","item":"fs-103"},{"agent":"tester","item":"fs-102"}],"running":[{"agent":"worker","item":"fs-099","minutes":6}],"awaiting":["fs-101"],"notes":["self-healing: re-queued stale fs-098"],"nextCheckSeconds":270}'
```

This appends the cycle to `.pipeline/runs/cycles.jsonl`, which feeds `agent-pipeline events` and the `agent-pipeline watch` dashboard — skipping it makes the cycle invisible to every monitoring surface.
````

- [ ] **Step 2: Point §3.5's output at `notes`**

In §3.5, replace the paragraph starting `**Output**: If any improvements were made, note them in the cycle report under a \`Self-audit actions:\` line...` (line 114) with:

```markdown
**Output**: If any improvements were made, add one `notes` entry per improvement to the cycle-report payload (§4), prefixed `self-audit:`. If nothing needed fixing, add nothing — don't pad.
```

- [ ] **Step 3: Point the self-healing Issue Log at `notes`**

Replace the `### Issue Log` section's prose + fenced example (lines 221–230) with:

```markdown
### Issue Log

When an anomaly is detected and resolved, record it as a `notes` entry in the cycle-report payload (§4), prefixed `self-healing:` — e.g. `"self-healing: created missing label agent:tester"`, `"self-healing: PR #570 branch deleted — flagged for attention"`.
```

- [ ] **Step 4: Filesystem-backend section**

In the `## Backend: filesystem (GitHub-free)` section, add this bullet after the **Snapshot** bullet (line 275):

```markdown
- **Report (every cycle)**: same as §4 — run `agent-pipeline cycle report --data '<payload>'` and paste its stdout verbatim. Omit `counts`; the CLI auto-snapshots the queue.
```

- [ ] **Step 5: Verify by reading**

Run: `git diff agents/orchestrator.md`
Check: (1) no remaining hand-drawn report table; (2) §3.5 and Issue Log both route through `notes`; (3) FS section references §4 with the omit-`counts` rule; (4) nothing else in the file changed.

- [ ] **Step 6: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(orchestrator): report cycles via agent-pipeline cycle report, not hand-formatted tables"
```

---

### Task 6: Doc parity

**Files:**
- Modify: `docs/API.md` (CLI section after `events` ~line 99; event list ~line 91/99; filesystem-state section ~line 242)
- Modify: `README.md` (CLI block ~lines 62–68; observability section ~line 134)

- [ ] **Step 1: `docs/API.md` — two new CLI subsections**

After the `### events — live event stream (full pipeline)` subsection (ends ~line 99), insert:

````markdown
### `cycle report` — record an orchestrator cycle

```bash
agent-pipeline cycle report --data '<json>' [--target ~/Code/my-app]
agent-pipeline cycle report --data -          # payload JSON on stdin
```

Appends one line to `<target>/.pipeline/runs/cycles.jsonl` and prints the canonical formatted status block (the orchestrator pastes this verbatim each cycle). The CLI stamps `cycle` (previous + 1) and `at`, and computes per-state deltas against the previous line. Payload fields (all optional unless noted): `counts` (object of `<queue-state>: <int>` — **required** on non-filesystem backends, auto-snapshotted from the queue on filesystem), `dispatched` / `running` (arrays of `{agent, item?, minutes?}`), `awaiting` (string ids), `notes` (strings), `nextCheckSeconds` (positive int). Fail-open: a missing or corrupt-tailed file restarts numbering with a stderr warning rather than blocking the report.

Each appended line becomes a `cycle.report` watcher event. Distinct from the queue audit log (`queue/events.jsonl`): that is filesystem-backend ticket-mutation audit; `cycles.jsonl` is backend-neutral orchestrator telemetry.

### `watch` — live terminal dashboard

```bash
agent-pipeline watch [--target ~/Code/my-app]
```

Full-screen zero-dependency TUI: stage counts with deltas, active runs with elapsed time, tickets awaiting human review, and a scrolling event tail. Re-renders on every watcher event plus a 1s tick (countdown to the orchestrator's next check). `q` or Ctrl-C exits. Requires an interactive terminal — for pipeable output use `agent-pipeline events --json`. In non-filesystem backends the queue panels degrade to the latest cycle report's data (the watcher cannot see Linear/GitHub label state).
````

- [ ] **Step 2: `docs/API.md` — event union + filesystem-state entries**

(a) In the `### events` subsection (~line 99), extend the event list sentence to:

```markdown
Like `runs events`, but also includes ticket-state-machine events (`ticket.upsert | ticket.move | ticket.remove`) and orchestrator cycle summaries (`cycle.report`, one per `agent-pipeline cycle report` append).
```

(b) In the filesystem-state debugging section (~line 242, the tree showing `.pipeline/runs/`), add under the `logs/` line:

```
    cycles.jsonl                    # orchestrator cycle reports (one JSON line per cycle)
```

- [ ] **Step 3: `README.md` — CLI table + observability blurb**

(a) In the CLI block, after the `agent-pipeline events ...` line (line 67):

```
agent-pipeline cycle report --data '<json>' [--target <p>]   Record an orchestrator cycle + print status block
agent-pipeline watch [--target <p>]                           Live terminal dashboard (TUI)
```

(b) In `## Dispatch & observability`, after the `agent-pipeline events ... | jq .` example (~line 134), add:

````markdown
For a live terminal dashboard (stage counts, active runs, event tail, orchestrator cycle countdown):

```bash
agent-pipeline watch --target ~/Code/my-app
```
````

- [ ] **Step 4: Verify HELP/docs/README parity**

Run: `node bin/cli.js --help | grep -E "cycle|watch" && grep -c "cycle report" README.md docs/API.md`
Expected: both verbs in `--help`; non-zero grep counts in both docs.

- [ ] **Step 5: Commit**

```bash
git add docs/API.md README.md
git commit -m "docs: cycle report + watch verbs, cycle.report event, cycles.jsonl schema"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the whole smoke suite**

Run: `bash test/e2e/run-all.sh`
Expected: `08-cycle-report.sh` and `09-watch-tui.sh` PASS; 04/05/07 PASS; 01/02/03/06 SKIP (live tier, no `CAP_E2E_LIVE`). Summary line shows 0 failed.

- [ ] **Step 2: npm smoke**

Run: `npm test`
Expected: `cli smoke ok`.

- [ ] **Step 3: End-to-end sanity of the report → events → watch chain**

```bash
T=$(mktemp -d)
mkdir -p "$T/.pipeline/queue/needs-work"
printf '{ "backend": "filesystem" }' > "$T/.pipeline/config.json"
node bin/cli.js cycle report --target "$T" --data '{"dispatched":[],"nextCheckSeconds":600}'
node bin/cli.js cycle report --target "$T" --data '{"dispatched":[],"nextCheckSeconds":600}'
tail -2 "$T/.pipeline/runs/cycles.jsonl" | jq -c '{cycle, backend}'
rm -rf "$T"
```

Expected: two rendered blocks (`cycle 1`, then `cycle 2` with `(=)` deltas), and jq prints `{"cycle":1,...}` `{"cycle":2,...}`.

---

## Self-review (completed at plan time)

- **Spec coverage:** payload schema + stamping → Task 2; FS auto-counts + linear-requires-counts → Tasks 1/2; fail-open corrupt tail → Tasks 1/2; rendering rules (zero/zero omitted, first-cycle no deltas, awaiting cap 6, idle renders, notes) → Tasks 1/2; watcher + exactly-once + renderEvent → Task 3; TUI (frame purity, width, countdown/due, degraded non-FS, non-TTY guard, q/Ctrl-C, resize, 1s tick) → Task 4; orchestrator prompt §4/§3.5/Issue Log/FS section → Task 5; A7 doc parity + audit-log distinction → Task 6. Spec's "no `cycle last` subcommand" honored (none added).
- **Type consistency:** `readCycleTail/readCycleLines/cyclesFileSize/computeDeltas/buildCycleEntry/appendCycle/renderBlock/getBackend/validatePayload/DISPATCH_STATE` names match across Tasks 2–4; `buildFrame/formatEventLine/runWatch` match between Tasks 4 steps; event shape `{type:'cycle.report', cycle}` consistent across Tasks 3–4.
- **Placeholders:** none — every code step carries full content.
