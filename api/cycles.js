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
  catch (err) {
    console.warn(`warning: could not parse ${cfgPath} (${err.message}); assuming backend 'filesystem'`);
    return 'filesystem';
  }
}

// Agent role → the queue state its dispatch annotation attaches to in the block.
// Roles not listed here (detectors, cleanup, scanner, ...) render in the footer.
export const DISPATCH_STATE = Object.freeze({
  'ticket-creator': 'needs-triage',
  'ticket-reviewer': 'needs-review',
  'worker': 'needs-work',
  'tester': 'needs-test-review',
  'code-reviewer': 'needs-code-review',
  'regression-tester': 'needs-regression-check',
  'feature-validator': 'needs-feature-validation',
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
        return;
      }
      if (d.item != null && typeof d.item !== 'string') {
        errs.push(`${field}[${i}].item: must be a string, got ${JSON.stringify(d.item)}`);
      }
      if (field === 'running' && d.minutes != null && typeof d.minutes !== 'number') {
        errs.push(`${field}[${i}].minutes: must be a number, got ${JSON.stringify(d.minutes)}`);
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
// Torn-read safety: an in-flight append lacks its trailing newline, so an
// unterminated final line is ignored — counting it would advance the watcher's
// cursor past a line that completes a moment later, and it would never be
// emitted. (The watcher is this function's only consumer.)
export function readCycleLines(target) {
  let content;
  try { content = readFileSync(cyclesPath(target), 'utf8'); } catch { return { lineCount: 0, entries: [] }; }
  const raw = content.split('\n');
  if (raw.length && raw[raw.length - 1] !== '') raw.pop(); // unterminated tail = in-flight append
  const lines = raw.filter(l => l.trim());
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
    cycle: (Number.isInteger(prev?.cycle) ? prev.cycle : 0) + 1,
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

export function fmtDelta(d) { return d > 0 ? `(+${d})` : d < 0 ? `(${d})` : '(=)'; }

function fmtAwaiting(awaiting) {
  const ids = awaiting.slice(0, 6).join(', ');
  const more = awaiting.length > 6 ? ` +${awaiting.length - 6} more` : '';
  return `⚠ awaiting you: ${ids}${more}`;
}

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
  let awaitingRendered = false;
  for (const s of shown) {
    const count = entry.counts[s] || 0;
    let line = `  ${s.padEnd(nameW)} ${String(count).padEnd(3)}`;
    if (deltas) line += ` ${fmtDelta(deltas[s] || 0).padEnd(5)}`;
    const ann = [];
    if (byState[s]) ann.push(`→ ${byState[s].join(', ')}`);
    if (s === 'ready-for-human' && entry.awaiting.length) {
      ann.push(fmtAwaiting(entry.awaiting));
      awaitingRendered = true;
    }
    if (ann.length) line += `  ${ann.join('  ')}`;
    lines.push(line.trimEnd());
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
  if (entry.awaiting.length && !awaitingRendered) lines.push(`  ${fmtAwaiting(entry.awaiting)}`);
  if (footerDispatch.length) lines.push(`  also: ${footerDispatch.join(', ')}`);
  if (entry.nextCheckSeconds != null) lines.push(`  next check in ${entry.nextCheckSeconds}s`);
  for (const n of entry.notes) lines.push(`  ✓ ${n}`);
  return lines.join('\n');
}
