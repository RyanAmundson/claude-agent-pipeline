// claude-agent-pipeline — epic store (filesystem backend).
// Epics are the feature-pipeline's unit of work. Stored exactly like tickets
// (<id>.json in state subdirectories) but under .pipeline/epics/. Read-only here;
// mutations go through the same queue-*.sh helpers with --queue-dir .pipeline/epics.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Feature epic states, in pipeline order. `blocked` and `needs-feedback` are
// side-states; `done` is terminal (integration branch merged to main).
export const EPIC_STATES = Object.freeze([
  'needs-spec',
  'needs-design',
  'needs-decomposition',
  'building',
  'needs-integration',
  'needs-acceptance',
  'ready-for-human',
  'blocked',
  'needs-feedback',
  'done',
]);

export function epicsDir(target) {
  return join(resolve(target), '.pipeline', 'epics');
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readEpicsInState(target, state) {
  const dir = join(epicsDir(target), state);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const epic = readJsonSafe(join(dir, entry));
    if (!epic || typeof epic !== 'object') continue;
    if (!epic.id) epic.id = entry.replace(/\.json$/, '');
    out.push({ ...epic, _state: state });
  }
  return out;
}

export function readEpics(opts) {
  const target = resolve(opts.target);
  const byState = {};
  let count = 0;
  for (const state of EPIC_STATES) {
    const list = readEpicsInState(target, state);
    byState[state] = list.map(({ _state, ...e }) => e);
    count += list.length;
  }
  return { byState, count };
}

export function getEpic(opts, id) {
  const target = resolve(opts.target);
  for (const state of EPIC_STATES) {
    const path = join(epicsDir(target), state, `${id}.json`);
    if (existsSync(path)) {
      const e = readJsonSafe(path);
      if (e) return { ...e, id: e.id || id, state };
    }
  }
  return null;
}

export function nextEpicId(target) {
  let max = 0;
  for (const state of EPIC_STATES) {
    const dir = join(epicsDir(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^EPIC-(\d+)\.json$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `EPIC-${String(max + 1).padStart(3, '0')}`;
}

function cheapHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export function indexEpics(target) {
  const idx = new Map();
  for (const state of EPIC_STATES) {
    const dir = join(epicsDir(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      const id = entry.replace(/\.json$/, '');
      const epic = readJsonSafe(path);
      const hash = epic ? cheapHash(JSON.stringify(epic)) : 0;
      idx.set(id, { state, mtimeMs: stat.mtimeMs, hash, epic });
    }
  }
  return idx;
}

export function diffEpicIndexes(prev, next) {
  const events = [];
  for (const [id, cur] of next) {
    const old = prev.get(id);
    if (!old) events.push({ type: 'epic.upsert', id, state: cur.state, epic: cur.epic });
    else if (old.state !== cur.state) events.push({ type: 'epic.move', id, from: old.state, to: cur.state, epic: cur.epic });
    else if (old.hash !== cur.hash || old.mtimeMs !== cur.mtimeMs) events.push({ type: 'epic.upsert', id, state: cur.state, epic: cur.epic });
  }
  for (const [id, old] of prev) {
    if (!next.has(id)) events.push({ type: 'epic.remove', id, state: old.state });
  }
  return events;
}
