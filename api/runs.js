// claude-agent-pipeline — runs registry (live agent invocations).
//
// Filesystem layout (mirrors the queue's mv-as-state-transition pattern):
//
//   <target>/.pipeline/runs/
//     active/<runId>.json       — currently running
//     completed/<runId>.json    — finished (success or failure)
//     logs/<runId>.stdout       — raw claude -p stdout (stream-json)
//     logs/<runId>.stderr       — raw claude -p stderr
//     logs/<runId>.events.jsonl — parsed/normalized events per line
//
// A Run JSON looks like:
//   {
//     "runId": "01HXYZ...",
//     "agent": "scanner",
//     "prompt": "Scan src/ for silent errors",
//     "target": "/abs/path/to/project",
//     "pid": 12345,
//     "status": "starting" | "running" | "completed" | "failed" | "killed",
//     "startedAt": "2026-05-22T01:00:00Z",
//     "completedAt": "2026-05-22T01:00:42Z",   // when not active
//     "durationMs": 42000,                      // when not active
//     "exitCode": 0,                            // when not active
//     "cost": { "usd": 0.0123, "tokens": { ... } },  // best-effort
//     "lastEventAt": "2026-05-22T01:00:40Z",
//     "lastActivity": "Edit src/foo.ts"         // free-text, last tool use
//   }

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, watch as fsWatch, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

export const RUN_STATES = Object.freeze(['active', 'completed']);

export function runsRoot(target) {
  return join(resolve(target), '.pipeline', 'runs');
}

export function ensureRunsDirs(target) {
  const root = runsRoot(target);
  for (const sub of ['active', 'completed', 'logs']) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return root;
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readRunsInState(target, state) {
  const dir = join(runsRoot(target), state);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const run = readJsonSafe(join(dir, entry));
    if (!run) continue;
    if (!run.runId) run.runId = entry.replace(/\.json$/, '');
    out.push({ ...run, _state: state });
  }
  return out;
}

export function listRuns(opts) {
  const target = resolve(opts.target);
  // Opportunistic reap so every query sees a self-healed view.
  try { reapOrphanedRuns(target); } catch {}
  const active = readRunsInState(target, 'active').map(strip);
  const completed = readRunsInState(target, 'completed').map(strip);
  // Newest first by startedAt
  const sortDesc = (a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  active.sort(sortDesc);
  completed.sort(sortDesc);
  return { active, completed };
}

export function getRun(opts, runId) {
  const target = resolve(opts.target);
  for (const state of RUN_STATES) {
    const path = join(runsRoot(target), state, `${runId}.json`);
    if (existsSync(path)) {
      const r = readJsonSafe(path);
      if (r) return { ...r, runId: r.runId || runId, state };
    }
  }
  return null;
}

export function getRunEvents(opts, runId) {
  const target = resolve(opts.target);
  const path = join(runsRoot(target), 'logs', `${runId}.events.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Atomic write: write to .tmp then rename. Prevents partial-read races by the watcher.
export function writeRun(target, run) {
  const state = run.state || (run.status === 'completed' || run.status === 'failed' || run.status === 'killed' ? 'completed' : 'active');
  const dir = join(runsRoot(target), state);
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `${run.runId}.json`);
  const tmp = `${final}.tmp`;
  const { _state, state: _s, ...body } = run;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, final);
  return final;
}

export function moveActiveToCompleted(target, runId) {
  const from = join(runsRoot(target), 'active', `${runId}.json`);
  const to = join(runsRoot(target), 'completed', `${runId}.json`);
  if (!existsSync(from)) return null;
  mkdirSync(join(runsRoot(target), 'completed'), { recursive: true });
  renameSync(from, to);
  return to;
}

export function logPath(target, runId, kind) {
  return join(runsRoot(target), 'logs', `${runId}.${kind}`);
}

function strip({ _state, ...rest }) { return rest; }

/**
 * Reap orphaned active runs: those whose supervisor process has died without
 * finalizing the run. We probe the recorded PID with `kill(pid, 0)` — if it
 * throws ESRCH, the process is gone. Such runs are moved to completed/ with
 * status: 'orphaned'.
 *
 * Caveats:
 *  - We only reap runs whose lastEventAt (or startedAt) is older than `minAgeMs`
 *    so we don't race against a supervisor that's still booting.
 *  - PID reuse: if the PID was recycled by an unrelated process, we'll see it
 *    as "alive" and not reap. False-negative; acceptable.
 *  - Runs without a recorded pid are NOT reaped (they may be mid-spawn).
 *
 * Returns the runIds that were reaped.
 */
export function reapOrphanedRuns(target, { minAgeMs = 2000 } = {}) {
  const reaped = [];
  const active = readRunsInState(target, 'active');
  const now = Date.now();
  for (const run of active) {
    if (!run.pid) continue;
    const refMs = new Date(run.lastEventAt || run.startedAt || 0).getTime() || 0;
    if (now - refMs < minAgeMs) continue;
    if (isProcessAlive(run.pid)) continue;
    const startedMs = new Date(run.startedAt || 0).getTime() || 0;
    const final = {
      ...run,
      status: 'orphaned',
      completedAt: new Date().toISOString(),
      durationMs: startedMs ? now - startedMs : null,
      error: 'supervisor process died without finalizing the run',
    };
    delete final._state;
    writeRun(target, { ...final, state: 'completed' });
    const activePath = join(runsRoot(target), 'active', `${run.runId}.json`);
    try { unlinkSync(activePath); } catch {}
    reaped.push(run.runId);
  }
  return reaped;
}

export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }  // EPERM = exists but we can't signal
}

// ─── change-index (used by the watcher to diff runs between scans) ────────

export function indexRuns(target) {
  const idx = new Map();
  for (const state of RUN_STATES) {
    const dir = join(runsRoot(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      const runId = entry.replace(/\.json$/, '');
      const run = readJsonSafe(path);
      idx.set(runId, { state, mtimeMs: stat.mtimeMs, run });
    }
  }
  return idx;
}

export function diffRunIndexes(prev, next) {
  const events = [];
  for (const [runId, cur] of next) {
    const old = prev.get(runId);
    if (!old) {
      events.push({ type: 'run.start', runId, state: cur.state, run: cur.run });
    } else if (old.state !== cur.state) {
      events.push({
        type: cur.state === 'completed' ? finalEventType(cur.run) : 'run.update',
        runId, from: old.state, to: cur.state, run: cur.run,
      });
    } else if (old.mtimeMs !== cur.mtimeMs) {
      events.push({ type: 'run.update', runId, state: cur.state, run: cur.run });
    }
  }
  for (const [runId, old] of prev) {
    if (!next.has(runId)) {
      events.push({ type: 'run.remove', runId, state: old.state });
    }
  }
  return events;
}

function finalEventType(run) {
  if (!run) return 'run.complete';
  if (run.status === 'failed') return 'run.fail';
  if (run.status === 'killed') return 'run.kill';
  return 'run.complete';
}

/**
 * Live tail of one run's normalized event log
 * (.pipeline/runs/logs/<runId>.events.jsonl).
 *
 * Replays every existing line (each tagged with a 0-based `seq` = its ordinal
 * position in the file, so re-reads are idempotent for consumers keyed on seq),
 * then watches the logs dir and emits each newly-appended line. Ends ('end')
 * when getRun() reports the run completed (after a final drain), or on close().
 *
 * Returns an EventEmitter that is also an async-iterable of RunLogLine.
 *   on('line', (RunLogLine) => …) | on('end', () => …) | on('error', err => …)
 *   for await (const line of streamRunLog({target}, runId)) { … }
 */
export function streamRunLog(opts, runId) {
  const target = resolve(opts.target);
  const file = logPath(target, runId, 'events.jsonl');
  const logsDir = join(runsRoot(target), 'logs');
  const base = `${runId}.events.jsonl`;

  const emitter = new EventEmitter();
  let offset = 0;       // byte offset consumed so far
  let seq = 0;          // next line ordinal to assign
  let residual = '';    // bytes after the last newline, not yet a complete line
  let closed = false;
  let watcher = null;
  let pollTimer = null;

  function drain() {
    if (closed) return;
    let size;
    try { size = statSync(file).size; } catch { return; } // file not created yet
    if (size <= offset) return;
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    let fd;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, offset);
    } catch (err) {
      emitter.emit('error', err);
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    offset = size;
    residual += buf.toString('utf8');
    const parts = residual.split('\n');
    residual = parts.pop() ?? ''; // keep an incomplete trailing line buffered
    for (const line of parts) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { seq += 1; continue; } // skip corrupt, keep seq aligned
      const out = { ...ev, seq };
      seq += 1;
      emitter.emit('line', out);
    }
  }

  function finish() {
    if (closed) return;
    closed = true;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    if (pollTimer) clearInterval(pollTimer);
    emitter.emit('end');
  }

  emitter.close = finish;

  // Async-iterable bridge over the 'line'/'end' events — mirrors createWatcher's.
  // The queue only buffers while something is actively async-iterating: the
  // 'line' handler early-returns when `iterating` is false, so '.on(line)'-only
  // consumers (CM, CLI) incur zero queue growth. A `for await` consumer flips
  // `iterating` on first `[Symbol.asyncIterator]()` call and buffers normally.
  // (A late async consumer starts from when it begins iterating — acceptable.)
  // Waiter draining is single-sourced in the 'end' handler.
  const queue = [];
  const waiters = [];
  let iterating = false;
  emitter.on('line', (out) => {
    if (!iterating) return;            // no async-iterator consumer → don't buffer (fixes the leak)
    if (waiters.length) waiters.shift()({ value: out, done: false });
    else queue.push({ value: out, done: false });
  });
  emitter.on('end', () => {
    let w; while ((w = waiters.shift())) w({ value: undefined, done: true });
  });
  emitter[Symbol.asyncIterator] = () => {
    iterating = true;
    return {
      next: () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : closed
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((res) => waiters.push(res)),
      return: () => { finish(); return Promise.resolve({ value: undefined, done: true }); },
    };
  };

  // 1) replay existing lines synchronously on next tick (so callers can attach listeners first)
  setImmediate(() => {
    drain();
    const r = getRun({ target }, runId);
    if (r && r.state === 'completed') { drain(); finish(); return; }
    // 2) live tail: fs.watch the logs dir, filter to this run's file; poll as a backstop.
    // The watcher is `persistent: true` (it keeps the host loop alive during an
    // active tail, exactly like createWatcher's watchers); the poll timer is
    // unref'd so the backstop alone never pins the process — completion is still
    // detected by the poll while the watcher holds the loop open. finish() closes
    // both, letting the loop drain.
    try {
      watcher = fsWatch(logsDir, { persistent: true }, (_evt, fname) => {
        if (fname === base) drain();
      });
    } catch { /* dir watch unavailable; poll-only */ }
    const pollMs = watcher ? 2000 : 250; // slower backstop when fs.watch is healthy
    pollTimer = setInterval(() => {
      drain();
      const cur = getRun({ target }, runId);
      if (cur && cur.state === 'completed') { drain(); finish(); }
    }, pollMs);
    pollTimer.unref?.();
  });

  return emitter;
}
