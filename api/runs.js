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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

function isProcessAlive(pid) {
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
