// claude-agent-pipeline — `agent-pipeline watch`: live terminal dashboard.
//
// Zero dependencies: raw ANSI (alternate screen, full-frame redraw). The frame
// builder is a pure function (state → string) so it is testable without a TTY.
// Data comes from one createWatcher subscription plus cycles.jsonl for cycle
// context. In non-filesystem backends the watcher sees no queue dirs, so
// STAGES/AWAITING degrade to the latest cycle report's data.

import { basename } from 'node:path';
import { fmtDelta } from '../api/cycles.js';

const LABEL_W = 16;

// Guard frame integrity against newlines/ANSI in agent-generated ticket titles.
// KNOWN LIMITATION: code-point counting means CJK/emoji (2-column glyphs) can
// push the right border out; zero-dep wcwidth is out of scope for v0.4.
function clip(text, w) {
  text = String(text).replace(/[\x00-\x1f\x7f]/g, ' ');
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
  if (cycle?.nextCheckSeconds == null || !cycle.at) return 'no cycle yet';
  const due = new Date(cycle.at).getTime() + cycle.nextCheckSeconds * 1000;
  const remain = Math.floor((due - now.getTime()) / 1000);
  return remain > 0 ? `next check ${remain}s` : 'check due';
}

// Pure: state → frame string. state = { targetName, backend, states, counts,
// deltas, cycle, runs, awaiting, events, now, columns, rows }.
export function buildFrame(s) {
  const w = Math.min(Math.max(s.columns || 80, 60), 110);
  const inner = w - 4; // '│ ' + content + ' │'
  const row = t => '│ ' + clip(t, inner).padEnd(inner) + ' │';
  const blank = row('');

  const title = ` ${s.targetName} · ${s.backend}${s.cycle ? ` · cycle ${s.cycle.cycle}` : ''} · ${countdown(s.cycle, s.now)} `;
  const titleLine = '┌' + clip(`─${title}`, w - 2).padEnd(w - 2, '─') + '┐';
  const footerLine = '└' + clip('─ q quit · refreshes live ', w - 2).padEnd(w - 2, '─') + '┘';

  const counts = s.counts || {};
  const stages = (s.states || [])
    .filter(st => (counts[st] || 0) !== 0 || (s.deltas?.[st] || 0) !== 0)
    .map(st => {
      const d = s.deltas ? ` ${fmtDelta(s.deltas[st] || 0)}` : '';
      const warn = st === 'ready-for-human' && (counts[st] || 0) > 0 ? ' ⚠' : '';
      return `${st.padEnd(18)} ${String(counts[st] || 0).padEnd(3)}${d}${warn}`;
    });

  // Render a section: blank separator + label on first body line, subsequent lines unlabelled.
  const renderSection = (label, items) => {
    const body = items.length ? items : ['—'];
    return [blank, ...body.map((b, i) => row(`${(i === 0 ? label : '').padEnd(LABEL_W)}${b}`))];
  };

  // Fixed content that is never shrunk: title + STAGES section + trailing blank + footer.
  const stagesLines = renderSection('STAGES', stages);
  const fixed = 1 + stagesLines.length + 1 + 1; // titleLine + stages + blank + footerLine

  // Cap: leave 1 line below the frame for the cursor-erase write after it.
  const maxLines = Math.max(10, (s.rows || 30) - 1);
  const budgetForSections = maxLines - fixed; // lines available for RUNS + AWAITING + EVENTS

  // Compute body items for each shrinkable section.
  const runItems   = (s.runs || []).map(r =>
    `${(r.agent || '?').padEnd(20)} ${elapsed(r.startedAt, s.now)}`);
  const awaitItems = (s.awaiting || []).slice(0, 5).map(t =>
    `${String(t.id).padEnd(12)} ${t.title || ''}`);
  const evtItems   = (s.events || []).slice(-8);

  // Distribute budget across sections: shrink EVENTS → RUNS → AWAITING until fits.
  // Section line cost: 1 (blank) + max(1, bodyLines) where bodyLines = shown if shown==total
  // else shown+1 (shown real items + 1 "… +N more" marker line). Min body is always 1.
  let evtShown   = evtItems.length;
  let runShown   = runItems.length;
  let awaitShown = awaitItems.length;

  // Lines a section occupies given its shown count and total item count.
  const secLines = (shown, total) => {
    if (total === 0) return 2; // blank + "—"
    if (shown >= total) return 1 + total; // blank + all items
    // shown < total: blank + shown real lines + 1 marker = shown + 2
    return 1 + shown + 1;
  };

  const sectionCost = () =>
    secLines(evtShown, evtItems.length)
  + secLines(runShown, runItems.length)
  + secLines(awaitShown, awaitItems.length);

  // Shrink EVENTS by dropping oldest lines (no marker in EVENTS — just fewer events shown).
  // EVENTS only shows the newest N, so reducing evtShown means fewer old events.
  while (sectionCost() > budgetForSections && evtShown > 1) evtShown--;

  // Shrink RUNS: min 1 shown (= 1 real item + marker), reducing shown by 1 each step.
  while (sectionCost() > budgetForSections && runShown > 1) runShown--;

  // Shrink AWAITING: min 1 shown.
  while (sectionCost() > budgetForSections && awaitShown > 1) awaitShown--;

  // Render each section with its capped item count, adding a "+N more" marker when items hidden.
  const renderCapped = (label, items, shown) => {
    const total = items.length;
    let body;
    if (total === 0) {
      body = []; // will render "—"
    } else if (shown >= total) {
      body = items;
    } else {
      // shown real items + marker.
      const visible = items.slice(0, shown);
      const hidden  = total - shown;
      body = [...visible, `… +${hidden} more`];
    }
    return renderSection(label, body);
  };

  const secEvents   = renderCapped('EVENTS',       evtItems,   evtShown);
  const secRuns     = renderCapped('RUNS ▶',        runItems,   runShown);
  const secAwaiting = renderCapped('AWAITING YOU',  awaitItems, awaitShown);

  const lines = [
    titleLine,
    ...stagesLines,
    ...secRuns,
    ...secAwaiting,
    ...secEvents,
    blank,
    footerLine,
  ];
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

// Raw-mode stdin: 'q' or Ctrl-C (ETX, 0x03 — raw mode suppresses SIGINT).
export function isQuitKey(k) {
  return k === 'q' || k === '\u0003';
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
    // Home cursor, overwrite frame, erase below — no blank-then-paint flash.
    process.stdout.write('\x1b[H' + frame + '\n\x1b[0J');
  };

  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor

  // Restore the terminal no matter how we die — exit hooks run even after
  // an uncaught exception; a corrupted terminal is the worst TUI failure mode.
  process.on('exit', () => process.stdout.write('\x1b[?25h\x1b[?1049l'));

  const w = createWatcher({ target, pluginRoot });

  // Coalesce synchronous event bursts: N events from one reconcile → ONE render.
  let pending = false;
  let refreshDue = false;
  const scheduleRender = (needsRefresh) => {
    if (needsRefresh) refreshDue = true;
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      if (refreshDue) { refreshDue = false; refresh(); }
      render();
    });
  };

  const timer = setInterval(() => scheduleRender(false), 1000);

  // cleanup clears the timer and closes the watcher; terminal restore is owned
  // by the exit hook registered above.
  const cleanup = () => {
    clearInterval(timer);
    try { w.close(); } catch {}
  };
  const quit = () => { cleanup(); process.exit(0); };

  w.on('event', ev => {
    if (ev.type === 'cycle.report') { state.prevCycle = state.cycle; state.cycle = ev.cycle; }
    const line = formatEventLine(ev, new Date());
    if (line) {
      state.events.push(line);
      if (state.events.length > 8) state.events.shift();
    }
    scheduleRender(true);
  });
  w.on('error', () => {}); // transient fs errors — the reconcile tick recovers

  process.stdout.on('resize', () => scheduleRender(false));
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', b => {
      if (isQuitKey(b.toString())) quit();
    });
  }

  refresh();
  render();
}
