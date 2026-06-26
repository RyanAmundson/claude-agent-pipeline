// import-sources — the source projector.
//
// Projects the host project's real work sources (bd-ready beads + incomplete
// plans) into the filesystem queue as `needs-work` tickets, so the existing
// orchestrator routes them like any other ticket. Zero runtime deps. Idempotent.
// One-way: never writes back to beads or plans.
//
// Cross-repo contract (verified against context-manager):
//   CM joins a work item to its pipeline ticket on
//   `ticketId === ${entityType}:${entityId}`, and CM derives `ticketId` from the
//   ticket's JSON `id` field. So the JSON `id` is canonical and verbatim:
//     bead:<beadId>            plan:<relativePath>   (relativePath = `${dirRel}/${filename}`)
//   The file basename is a sanitized form (relativePath contains `/`), so
//   id ≠ basename for nested plans — accepted; CAP's queue machinery is
//   filename-keyed and CM reads the JSON `id`. See docs/plans/2026-06-26-*.

import {
  existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { STATES, FEATURE_STATES } from '../api/index.js';

const NEEDS_WORK = 'needs-work';
const DEFAULT_PLAN_PRIORITY = 2;

// resolveQueueDir mirrors bin/cli.js's helper. bin/cli.js runs the CLI dispatch
// at top level so it cannot be imported as a library; this small, schema-default-
// locked duplication is the lesser evil. Stays in sync with config.schema.json's
// filesystem.queueDir default ('.pipeline/queue').
export function resolveQueueDir(target) {
  let queueDir = '.pipeline/queue';
  const cfgPath = join(target, '.pipeline', 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.filesystem?.queueDir) queueDir = cfg.filesystem.queueDir;
    } catch (err) {
      console.warn(`import-sources: could not parse ${cfgPath} (${err.message}); using default queueDir '${queueDir}'`);
    }
  }
  return resolve(target, queueDir);
}

// File basename for a canonical ticket id: flatten path separators + colons so the
// ticket is a single flat JSON file. JSON `id` keeps the canonical value.
export function safeBasename(id) {
  return id.replace(/[/:]+/g, '_');
}

// A filesystem-safe display slug (lowercase kebab). Not the join id — kept for
// labels/display where a compact identifier is wanted.
export function planSlug(relPath) {
  return relPath
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A plan is complete iff it has ≥1 task checkbox and all are checked. No
// checkboxes ⇒ incomplete (actionable). Mirrors CM parsePlanMeta semantics.
export function planIsComplete(md) {
  const boxes = md.match(/^[ \t]*[-*]\s+\[[ xX]\]/gm) || [];
  if (boxes.length === 0) return false;
  return boxes.every((b) => /\[[xX]\]/.test(b));
}

function firstHeading(md, fallback) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

export function beadToTicket(bead, now) {
  return {
    id: `bead:${bead.id}`,
    title: bead.title || bead.id,
    description: bead.description || '',
    priority: typeof bead.priority === 'number' ? bead.priority : DEFAULT_PLAN_PRIORITY,
    labels: ['source:beads'],
    source: { type: 'beads', beadId: bead.id, issueType: bead.issue_type || null },
    created_at: now,
    updated_at: now,
  };
}

export function planToTicket(plan, now) {
  return {
    id: `plan:${plan.relativePath}`,
    title: plan.title || plan.relativePath,
    description: '',
    priority: DEFAULT_PLAN_PRIORITY,
    labels: ['source:plans'],
    source: { type: 'plans', path: plan.path, relativePath: plan.relativePath },
    created_at: now,
    updated_at: now,
  };
}

// ─── default readers (injectable for tests) ─────────────────────────────────

export function defaultReadBeads(target) {
  try {
    const out = execFileSync('bd', ['ready', '--json'], { cwd: target, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Surface, don't swallow — bd may be absent or the repo may have no DB.
    console.warn(`import-sources: \`bd ready --json\` failed (${err.message}); skipping beads`);
    return [];
  }
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function defaultScanPlans(dirs, target) {
  const plans = [];
  for (const dirRel of dirs || []) {
    const expanded = expandHome(dirRel);
    const dirAbs = isAbsolute(expanded) ? expanded : resolve(target, expanded);
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      continue; // dir missing — fine
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      let md;
      try {
        md = readFileSync(join(dirAbs, ent.name), 'utf8');
      } catch {
        continue; // unreadable — skip
      }
      // relativePath must match CM's `${dirRel}/${filename}` exactly.
      plans.push({
        relativePath: `${dirRel}/${ent.name}`,
        path: join(dirAbs, ent.name),
        title: firstHeading(md, ent.name.replace(/\.md$/, '')),
        complete: planIsComplete(md),
      });
    }
  }
  return plans;
}

// All ticket file basenames currently in the queue, across every state (ticket
// AND feature states) — the idempotency key set. Projected ids never land in a
// feature:* dir, but scanning them keeps the "every state" guarantee literal.
export function existingTicketIds(queueDir) {
  const ids = new Set();
  for (const state of [...STATES, ...FEATURE_STATES]) {
    const dir = join(queueDir, state);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.json')) ids.add(entry.replace(/\.json$/, ''));
    }
  }
  return ids;
}

/**
 * Project beads + plans into the queue. Pure-ish: side effect is writing
 * `needs-work/<basename>.json` for each new item. Readers are injectable.
 * @returns {{ created: string[], skipped: string[] }} canonical ids
 */
export function importSources({
  target,
  queueDir = resolveQueueDir(target),
  sources = {},
  only = null,
  readBeads = defaultReadBeads,
  scanPlans = defaultScanPlans,
  now = () => new Date().toISOString(),
}) {
  const ts = typeof now === 'function' ? now() : now;
  const existing = existingTicketIds(queueDir);

  const candidates = [];
  if (sources.beads) {
    for (const bead of readBeads(target)) candidates.push(beadToTicket(bead, ts));
  }
  if (sources.plans && sources.plans.length) {
    for (const plan of scanPlans(sources.plans, target)) {
      if (plan.complete) continue;
      candidates.push(planToTicket(plan, ts));
    }
  }

  const created = [];
  const skipped = [];
  for (const ticket of candidates) {
    if (only && ticket.id !== only) continue;
    const base = safeBasename(ticket.id);
    if (existing.has(base)) {
      skipped.push(ticket.id);
      continue;
    }
    const dir = join(queueDir, NEEDS_WORK);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(ticket, null, 2));
    existing.add(base); // guard against duplicate candidates within one run
    created.push(ticket.id);
  }
  return { created, skipped };
}

/**
 * Read the project's `.pipeline/config.json` `sources` block and project. The
 * shared entry for both the CLI and the orchestrator pre-cycle step. Opt-in:
 * returns `{ created:[], skipped:[], configured:false }` when no `sources` block
 * exists. A malformed config warns and is treated as unconfigured, so callers
 * stay best-effort.
 * @returns {{ created: string[], skipped: string[], configured: boolean }}
 */
export function importSourcesFromConfig(target, { only = null } = {}) {
  const cfgPath = join(target, '.pipeline', 'config.json');
  let sources = null;
  if (existsSync(cfgPath)) {
    try {
      sources = JSON.parse(readFileSync(cfgPath, 'utf8')).sources ?? null;
    } catch (err) {
      console.warn(`import-sources: could not parse ${cfgPath} (${err.message}); treating as no sources`);
    }
  }
  const hasSources = sources && (sources.beads || (sources.plans && sources.plans.length));
  if (!hasSources) return { created: [], skipped: [], configured: false };
  return { ...importSources({ target, sources, only }), configured: true };
}
