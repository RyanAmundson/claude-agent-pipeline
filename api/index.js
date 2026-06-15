// claude-agent-pipeline — public Node API (v1).
//
// Stable surface for host projects to observe the agent pipeline.
// Read-only. Push-based via fs.watch. No runtime dependencies.
//
// import { readSnapshot, createWatcher, getTicket, getAgent, STATES }
//   from 'claude-agent-pipeline/api';

import { existsSync, readFileSync, readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { diffRunIndexes, ensureRunsDirs, getRun, getRunEvents, indexRuns, listRuns, reapOrphanedRuns, runsRoot, RUN_STATES, streamRunLog } from './runs.js';
import { readCycleLines, readCycleTail, computeDeltas, cyclesFileSize } from './cycles.js';
import { readOrchestratorState, orchestratorStatePath } from './orchestrator.js';

export {
  listRuns, getRun, getRunEvents, reapOrphanedRuns, RUN_STATES,
  streamRunLog,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');

export const API_VERSION = 1;

// The 11 queue states, in pipeline order. Anything in `in-progress` is "active".
// `obsolete` is terminal (retired as no-longer-relevant) — distinct from `done`.
export const STATES = Object.freeze([
  'needs-triage',
  'needs-review',
  'needs-work',
  'in-progress',
  'needs-test-review',
  'needs-code-review',
  'needs-feedback',
  'ready-for-human',
  'done',
  'needs-info',
  'obsolete',
]);

const ACTIVE_STATE = 'in-progress';

function queueDir(target) {
  return join(resolve(target), '.pipeline', 'queue');
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readTicketsInState(target, state) {
  const dir = join(queueDir(target), state);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    const ticket = readJsonSafe(path);
    if (!ticket || typeof ticket !== 'object') continue;
    if (!ticket.id) ticket.id = entry.replace(/\.json$/, '');
    out.push({ ...ticket, _state: state });
  }
  return out;
}

// Markdown bold-key headers: `**Role**: text`. Returns a flat map.
function parseAgentMarkdown(md) {
  const lines = md.split('\n');
  const meta = {};
  let title = null;
  for (const line of lines) {
    if (!title) {
      const h1 = line.match(/^#\s+(.+?)\s*$/);
      if (h1) title = h1[1].replace(/\s+Agent$/, '');
    }
    const m = line.match(/^\*\*([^*]+)\*\*:\s*(.+?)\s*$/);
    if (m) meta[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return { title, meta };
}

function readAgentDefinition(pluginRoot, name) {
  const path = join(pluginRoot, 'agents', `${name}.md`);
  if (!existsSync(path)) return null;
  const md = readFileSync(path, 'utf8');
  const { title, meta } = parseAgentMarkdown(md);
  return {
    name,
    title: title || name,
    role: meta.role || null,
    input: meta.input || null,
    output: meta.output || null,
    provenance: meta.provenance || `agent:${name}`,
    scope: meta.scope || null,
    docPath: path,
  };
}

function readManifest(pluginRoot) {
  const path = join(pluginRoot, 'manifest.json');
  return readJsonSafe(path) || { agents: {} };
}

function resolvePluginRoot(opts) {
  return opts?.pluginRoot ? resolve(opts.pluginRoot) : PLUGIN_ROOT;
}

/**
 * Read a full point-in-time snapshot of agents + tickets for a target project.
 * Pure function — no watchers, no side effects.
 */
export function readSnapshot(opts) {
  const target = resolve(opts.target);
  const pluginRoot = resolvePluginRoot(opts);
  const manifest = readManifest(pluginRoot);

  // Tickets by state
  const ticketsByState = {};
  const ticketsById = {};
  for (const state of STATES) {
    const list = readTicketsInState(target, state);
    ticketsByState[state] = list.map(({ _state, ...t }) => t);
    for (const t of list) ticketsById[t.id] = t;
  }

  const liveRuns = listRuns({ target });

  // Latest orchestrator cycle (backend-neutral telemetry). On non-filesystem
  // backends this is the ONLY source of queue-state counts and of which agents
  // are running — the orchestrator self-reports them, since the watcher cannot
  // see Linear/GitHub label state or in-session (Task-dispatched) subagents.
  const { entries: cycleTail } = readCycleTail(target, 2);
  const cycle = cycleTail.length ? cycleTail[cycleTail.length - 1] : null;
  const cyclePrev = cycleTail.length > 1 ? cycleTail[cycleTail.length - 2] : null;
  const cycleDeltas = cycle && cyclePrev ? computeDeltas(cyclePrev.counts, cycle.counts) : null;

  // Agents — union of manifest entries and definition files
  const agents = [];
  const seen = new Set();
  for (const name of Object.keys(manifest.agents || {})) {
    const def = readAgentDefinition(pluginRoot, name);
    const spec = manifest.agents[name];
    const activity = activityForAgent(name, ticketsById, liveRuns.active);
    agents.push({
      name,
      stage: spec.stage || null,
      requires: spec.requires || [],
      optional: spec.optional || [],
      ...(def || { title: name }),
      activity,
    });
    seen.add(name);
  }
  return {
    apiVersion: API_VERSION,
    target,
    generatedAt: new Date().toISOString(),
    states: STATES,
    agents,
    tickets: { byState: ticketsByState, count: Object.keys(ticketsById).length },
    runs: {
      active: liveRuns.active,
      completed: liveRuns.completed,
      activeCount: liveRuns.active.length,
    },
    cycle,
    cycleDeltas,
    orchestrator: readOrchestratorState(target),
  };
}

function activityForAgent(name, ticketsById, activeRuns = []) {
  const provenance = `agent:${name}`;
  let active = 0;
  let owned = 0;
  const recent = [];
  for (const t of Object.values(ticketsById)) {
    const isOwner = t.source?.agent === name || (Array.isArray(t.labels) && t.labels.includes(provenance));
    if (!isOwner) continue;
    owned++;
    if (t._state === ACTIVE_STATE) active++;
    recent.push({ id: t.id, title: t.title || null, state: t._state, updatedAt: t.updated_at || null });
  }
  recent.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const runs = activeRuns
    .filter(r => r.agent === name)
    .map(r => ({ runId: r.runId, status: r.status, startedAt: r.startedAt, lastActivity: r.lastActivity || null }));
  return { active, owned, recent: recent.slice(0, 10), runs };
}

export function getTicket(opts, id) {
  const target = resolve(opts.target);
  for (const state of STATES) {
    const path = join(queueDir(target), state, `${id}.json`);
    if (existsSync(path)) {
      const t = readJsonSafe(path);
      if (t) return { ...t, id: t.id || id, state };
    }
  }
  return null;
}

export function getAgent(opts, name) {
  const pluginRoot = resolvePluginRoot(opts);
  const manifest = readManifest(pluginRoot);
  if (!manifest.agents?.[name]) return null;
  const spec = manifest.agents[name];
  const def = readAgentDefinition(pluginRoot, name);
  const snap = readSnapshot(opts);
  const found = snap.agents.find(a => a.name === name);
  return {
    name,
    stage: spec.stage || null,
    requires: spec.requires || [],
    optional: spec.optional || [],
    ...(def || { title: name }),
    activity: found?.activity || { active: 0, owned: 0, recent: [] },
  };
}

/**
 * Create a push-based watcher over a target's pipeline queue.
 *
 * Returns an object that is BOTH:
 *   - an EventEmitter (event names: 'event', 'snapshot', 'error', 'close')
 *   - async-iterable for `for await (const e of watcher) { ... }`
 *
 * Events emitted (the `event` event and async iterator yields):
 *   { type: 'snapshot', data: <Snapshot> }                    // initial
 *   { type: 'ticket.upsert', state, ticket }                  // new or changed
 *   { type: 'ticket.move',   id, from, to, ticket }           // moved between states
 *   { type: 'ticket.remove', id, state }                      // disappeared
 *
 * A reconciliation scan runs every `reconcileMs` (default 60s) to catch any
 * events the OS dropped (NFS, high churn, etc.). On reconcile, only diffs are
 * emitted — silent if nothing changed.
 */
export function createWatcher(opts) {
  const target = resolve(opts.target);
  const pluginRoot = resolvePluginRoot(opts);
  const debounceMs = opts.debounceMs ?? 50;
  const reconcileMs = opts.reconcileMs ?? 60_000;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  let lastTickets = indexTickets(target);
  let lastRuns = indexRuns(target);
  // Count BEFORE size: an append landing between the two reads then bumps the
  // size check on the next reconcile and gets emitted, instead of being
  // silently swallowed by a size snapshot that already includes it.
  let lastCyclesCount = readCycleLines(target).lineCount;
  let lastCyclesSize = cyclesFileSize(target);
  // state file is rewritten in place (tmp+rename), so size isn't monotonic — mtime is the change signal
  const orchMtime = () => { try { return statSync(orchestratorStatePath(target)).mtimeMs; } catch { return 0; } };
  let lastOrchMtime = orchMtime();
  let closed = false;
  const watchers = [];
  let debounceTimer = null;
  let reconcileTimer = null;

  // Emit initial snapshot synchronously after the consumer has had a tick
  // to attach listeners or enter the for-await loop.
  queueMicrotask(() => {
    if (closed) return;
    const snap = readSnapshot({ target, pluginRoot });
    emit({ type: 'snapshot', data: snap });
  });

  function emit(ev) {
    emitter.emit('event', ev);
    if (ev.type === 'snapshot') emitter.emit('snapshot', ev.data);
  }

  function scheduleReconcile() {
    const nowTickets = indexTickets(target);
    for (const ev of diffIndexes(lastTickets, nowTickets)) emit(ev);
    lastTickets = nowTickets;

    // Reap before re-indexing runs so the diff surfaces orphans as state moves.
    try { reapOrphanedRuns(target); } catch {}
    const nowRuns = indexRuns(target);
    for (const ev of diffRunIndexes(lastRuns, nowRuns)) emit(ev);
    lastRuns = nowRuns;

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

    // Orchestrator state changes (paused/resumed/started/stopped/cadence).
    const om = orchMtime();
    if (om !== lastOrchMtime) {
      const st = readOrchestratorState(target);
      if (st) emit({ type: 'orchestrator.changed', orchestrator: st });
      lastOrchMtime = om;
    }
  }

  function onFsChange() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      try { scheduleReconcile(); }
      catch (err) { emitter.emit('error', err); }
    }, debounceMs);
  }

  // One fs.watch per state dir; tolerate missing dirs (will appear later).
  for (const state of STATES) {
    const dir = join(queueDir(target), state);
    try {
      if (!existsSync(dir)) continue;
      const w = fsWatch(dir, { persistent: true }, onFsChange);
      w.on('error', err => emitter.emit('error', err));
      watchers.push(w);
    } catch (err) {
      // Watcher creation failed for this dir; reconciliation will still cover it.
      emitter.emit('error', err);
    }
  }
  // Pre-create runs dirs so fs.watch attaches before any dispatch happens.
  // Without this, a `runs events` subscriber that starts before the first
  // dispatch would miss every event (active/completed wouldn't exist yet,
  // and the reconcile tick is 60s away).
  try { ensureRunsDirs(target); } catch (err) { emitter.emit('error', err); }
  for (const sub of ['active', 'completed']) {
    const dir = join(runsRoot(target), sub);
    try {
      if (!existsSync(dir)) continue;
      const w = fsWatch(dir, { persistent: true }, onFsChange);
      w.on('error', err => emitter.emit('error', err));
      watchers.push(w);
    } catch (err) {
      emitter.emit('error', err);
    }
  }

  // cycles.jsonl lives directly in the runs root; watch the dir non-recursively.
  try {
    const w = fsWatch(runsRoot(target), { persistent: true }, onFsChange);
    w.on('error', err => emitter.emit('error', err));
    watchers.push(w);
  } catch (err) {
    emitter.emit('error', err);
  }

  reconcileTimer = setInterval(() => {
    if (closed) return;
    try { scheduleReconcile(); }
    catch (err) { emitter.emit('error', err); }
  }, reconcileMs);
  reconcileTimer.unref?.();

  function close() {
    if (closed) return;
    closed = true;
    for (const w of watchers) { try { w.close(); } catch {} }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    emitter.emit('close');
  }

  // Async-iterable bridge over the 'event' emitter.
  const queue = [];
  const waiters = [];
  emitter.on('event', ev => {
    if (waiters.length) waiters.shift().resolve({ value: ev, done: false });
    else queue.push(ev);
  });
  emitter.on('close', () => {
    while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
  });

  const iterable = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => waiters.push({ resolve }));
    },
    return() { close(); return Promise.resolve({ value: undefined, done: true }); },
  };

  return Object.assign(emitter, {
    close,
    [Symbol.asyncIterator]: iterable[Symbol.asyncIterator].bind(iterable),
    next: iterable.next.bind(iterable),
    return: iterable.return.bind(iterable),
  });
}

// ─── internal: index + diff ────────────────────────────────────────────────

function indexTickets(target) {
  const idx = new Map(); // id → { state, mtimeMs, hash }
  for (const state of STATES) {
    const dir = join(queueDir(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      const id = entry.replace(/\.json$/, '');
      const ticket = readJsonSafe(path);
      const hash = ticket ? cheapHash(JSON.stringify(ticket)) : 0;
      idx.set(id, { state, mtimeMs: stat.mtimeMs, hash, ticket });
    }
  }
  return idx;
}

function diffIndexes(prev, next) {
  const events = [];
  // Detect moves and upserts
  for (const [id, cur] of next) {
    const old = prev.get(id);
    if (!old) {
      events.push({ type: 'ticket.upsert', state: cur.state, ticket: cur.ticket });
    } else if (old.state !== cur.state) {
      events.push({
        type: 'ticket.move', id, from: old.state, to: cur.state, ticket: cur.ticket,
      });
    } else if (old.hash !== cur.hash || old.mtimeMs !== cur.mtimeMs) {
      events.push({ type: 'ticket.upsert', state: cur.state, ticket: cur.ticket });
    }
  }
  for (const [id, old] of prev) {
    if (!next.has(id)) events.push({ type: 'ticket.remove', id, state: old.state });
  }
  return events;
}

function cheapHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}
