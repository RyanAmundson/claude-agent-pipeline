// Local mirror of the Linear backend in the filesystem-backend queue layout.
// Zero runtime deps (node:* only). Poll-driven (relay-free); Plan 2 reuses
// applyMirror() for webhook push.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATES } from '../api/index.js';

const VALID_STATES = new Set(STATES);

export function stateLabelRe(namespace) {
  return new RegExp(`^${namespace}:(.+)$`);
}

/**
 * @param {any} issue Linear issue (MCP shape).
 * @param {{ namespace: string, now: string }} opts
 * @returns {{ ticket: object, state: string } | null}
 */
export function mapIssueToTicket(issue, opts) {
  const re = stateLabelRe(opts.namespace);
  const labels = normalizeLabels(issue.labels);
  let state = null;
  for (const name of labels) {
    const m = re.exec(name);
    if (m && VALID_STATES.has(m[1])) { state = m[1]; break; }
  }
  if (!state) return null;
  const ticket = {
    id: issue.identifier ?? issue.id,
    title: issue.title ?? '',
    description: issue.description ?? '',
    priority: normalizePriority(issue.priority),
    labels,
    claim: normalizeAssignee(issue.assignee),
    url: issue.url ?? null,
    raw: issue,
    _syncedAt: opts.now,
    _rev: issue.updatedAt ?? opts.now,
    _source: 'reconcile',
  };
  return { ticket, state };
}

// Linear reaches us in two shapes depending on which tool produced it:
//   - GraphQL-native: labels {nodes:[{name}]}, assignee {displayName}, priority <number>, identifier
//   - flattened MCP (linear-certiv list_issues): labels [<string>], assignee <string>,
//     priority {value,name}, id
// Normalize both so the mirror maps regardless of producer.
function normalizeLabels(labels) {
  if (Array.isArray(labels)) {
    return labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  }
  if (Array.isArray(labels?.nodes)) {
    return labels.nodes.map((l) => l?.name).filter(Boolean);
  }
  return [];
}

function normalizePriority(p) {
  if (typeof p === 'number') return p;
  if (p && typeof p === 'object' && typeof p.value === 'number') return p.value;
  return 99;
}

function normalizeAssignee(a) {
  if (a == null) return null;
  if (typeof a === 'string') return a;
  return a.displayName ?? a.name ?? null;
}

export const ALL_STATES = [...VALID_STATES];

export function queueDir(target) { return join(resolve(target), '.pipeline', 'queue'); }
export function ticketPath(target, state, id) { return join(queueDir(target), state, `${id}.json`); }

export function writeAtomic(path, obj) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

/** Find which state dir currently holds <id>, or null. */
function findExistingState(target, id) {
  for (const state of ALL_STATES) {
    if (existsSync(ticketPath(target, state, id))) return state;
  }
  return null;
}

/**
 * @param {string} target
 * @param {Array<{ ticket: object, state: string }>} entries
 * @param {{ now: string }} _opts
 */
export function applyMirror(target, entries, _opts) {
  const res = { created: 0, updated: 0, moved: 0, unchanged: 0 };
  for (const { ticket, state } of entries) {
    const id = ticket.id;
    const dest = ticketPath(target, state, id);
    const prevState = findExistingState(target, id);

    if (prevState && prevState !== state) {
      unlinkSync(ticketPath(target, prevState, id));
      writeAtomic(dest, ticket);
      res.moved += 1;
      continue;
    }
    if (!prevState) {
      writeAtomic(dest, ticket);
      res.created += 1;
      continue;
    }
    // same state already present — write only if content differs
    const current = readFileSync(dest, 'utf8');
    const next = JSON.stringify(ticket, null, 2);
    if (current === next) { res.unchanged += 1; }
    else { writeAtomic(dest, ticket); res.updated += 1; }
  }
  return res;
}

function readMirrorIds(target) {
  const out = []; // [{ id, state }]
  for (const state of ALL_STATES) {
    const dir = join(queueDir(target), state);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) out.push({ id: f.slice(0, -5), state });
    }
  }
  return out;
}

/**
 * @param {string} target
 * @param {Array<{ ticket: object, state: string }>} entries  fetched, normalized
 * @param {{ now: string, terminalStates?: string[] }} opts
 */
export function reconcile(target, entries, opts) {
  const terminal = new Set(opts.terminalStates ?? ['done', 'obsolete']);
  const applied = applyMirror(target, entries, { now: opts.now });
  const fetchedIds = new Set(entries.map((e) => e.ticket.id));
  let retired = 0;
  for (const { id, state } of readMirrorIds(target)) {
    if (fetchedIds.has(id) || terminal.has(state)) continue;
    const ticket = JSON.parse(readFileSync(ticketPath(target, state, id), 'utf8'));
    ticket._source = 'reconcile';
    ticket._syncedAt = opts.now;
    unlinkSync(ticketPath(target, state, id));
    writeAtomic(ticketPath(target, 'obsolete', id), ticket);
    retired += 1;
  }
  return { applied, retired };
}

/**
 * @param {string} target
 * @param {any[]} rawIssues
 * @param {{ namespace?: string, now: string }} opts
 */
export function runMirrorSync(target, rawIssues, opts) {
  const namespace = opts.namespace ?? 'pipeline';
  const entries = [];
  let skipped = 0;
  for (const issue of rawIssues) {
    const mapped = mapIssueToTicket(issue, { namespace, now: opts.now });
    if (mapped) entries.push(mapped); else skipped += 1;
  }
  const { applied, retired } = reconcile(target, entries, { now: opts.now });
  return { mapped: entries.length, skipped, applied, retired };
}
