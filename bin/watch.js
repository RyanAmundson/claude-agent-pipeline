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
      if (isQuitKey(b.toString())) quit();
    });
  }

  refresh();
  render();
}
