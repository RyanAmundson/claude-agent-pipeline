// Local mirror of the Linear backend in the filesystem-backend queue layout.
// Zero runtime deps (node:* only). Poll-driven (relay-free); Plan 2 reuses
// applyMirror() for webhook push.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VALID_STATES = new Set([
  'needs-triage', 'needs-review', 'needs-work', 'in-progress',
  'needs-test-review', 'needs-code-review', 'needs-detector-gate',
  'needs-regression-check', 'needs-runtime-qa', 'needs-feature-validation',
  'needs-feedback', 'needs-conflict-resolution', 'ready-for-human', 'done',
  'needs-info', 'obsolete',
]);

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
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  let state = null;
  for (const name of labels) {
    const m = re.exec(name);
    if (m && VALID_STATES.has(m[1])) { state = m[1]; break; }
  }
  if (!state) return null;
  const ticket = {
    id: issue.identifier,
    title: issue.title ?? '',
    description: issue.description ?? '',
    priority: issue.priority ?? 99,
    labels,
    claim: issue.assignee?.displayName ?? null,
    url: issue.url ?? null,
    raw: issue,
    _syncedAt: opts.now,
    _rev: issue.updatedAt ?? opts.now,
    _source: 'reconcile',
  };
  return { ticket, state };
}

const ALL_STATES = [...VALID_STATES];

function queueDir(target) { return join(resolve(target), '.pipeline', 'queue'); }
function ticketPath(target, state, id) { return join(queueDir(target), state, `${id}.json`); }

function writeAtomic(path, obj) {
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
