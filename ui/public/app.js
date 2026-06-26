import { initPipeline } from './pipeline.js';
import { initFeatures } from './features.js';
import { initFeaturePipeline } from './feature-pipeline.js';
import { colorForAgent } from './colors.js';

// Live log viewer for agent-pipeline. Subscribes to /api/v1/log (SSE) and
// renders each RunEvent as a line. Color-coded per agent so concurrent runs
// are easy to tell apart.

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const autoscrollEl = document.getElementById('autoscroll');
const showSystemEl = document.getElementById('show-system');
const clearBtn = document.getElementById('clear');

// Project identity — so several dashboards open at once (one per product) are
// distinguishable both in the header and, crucially, in the browser tab title.
const projectNameEl = document.getElementById('project-name');
const DEFAULT_TITLE = document.title;
function applyProject(project) {
  const label = project && (project.repo || project.name) || '';
  if (projectNameEl) {
    projectNameEl.textContent = label;
    projectNameEl.title = (project && project.path) || '';
    projectNameEl.hidden = !label;
  }
  document.title = label ? `${label} · agent-pipeline` : DEFAULT_TITLE;
}

// runId → agent name cache. Snapshot fetched once at startup; new runs are
// resolved lazily by re-fetching when an unknown runId appears.
const runAgents = new Map();
async function loadSnapshot() {
  try {
    const snap = await fetch('/api/v1/snapshot').then(r => r.json());
    applyProject(snap.project);
    for (const run of [...(snap.runs?.active || []), ...(snap.runs?.completed || [])]) {
      runAgents.set(run.runId, run.agent);
    }
  } catch {}
}
async function getAgentForRun(runId) {
  if (runAgents.has(runId)) return runAgents.get(runId);
  await loadSnapshot();
  return runAgents.get(runId) || '?';
}

function fmtTime(iso) {
  try { return new Date(iso).toISOString().slice(11, 23); }
  catch { return iso || ''; }
}

function shortId(runId) {
  const m = String(runId).match(/-([0-9a-f]{4,8})$/);
  return m ? m[1].slice(0, 4) : String(runId).slice(0, 4);
}

async function append(ev) {
  if (!showSystemEl.checked && ev.type === 'system') return;
  const agent = await getAgentForRun(ev.runId);
  const color = colorForAgent(agent);

  const line = document.createElement('div');
  line.className = `line type-${ev.type}`;
  const t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(ev.ts);
  const r = document.createElement('span'); r.className = 'runid'; r.textContent = shortId(ev.runId);
  const a = document.createElement('span'); a.className = 'agent'; a.textContent = agent.padEnd(18);
  a.style.color = color;
  const ty = document.createElement('span'); ty.className = 'type'; ty.textContent = `[${ev.type}]`;
  const body = document.createElement('span'); body.className = 'body';

  if (ev.type === 'result') {
    const cost = ev.cost?.usd ? ` $${ev.cost.usd.toFixed(4)}` : '';
    body.textContent = ` ${ev.activity || 'done'}${cost}`;
  } else if (ev.toolUse) {
    const tail = ev.activity ? ev.activity.replace(new RegExp(`^${ev.toolUse.name}\\s*:?\\s*`), '') : '';
    body.textContent = ` ${ev.toolUse.name}${tail ? ': ' + tail : ''}`;
  } else if (ev.activity) {
    body.textContent = ` ${ev.activity}`;
  } else if (ev.subtype) {
    body.textContent = ` ${ev.subtype}`;
  }

  line.append(t, r, a, ty, body);
  logEl.append(line);

  if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
}

let es = null;
function connect() {
  if (es) es.close();
  statusEl.textContent = 'connecting…';
  statusEl.className = 'status';
  es = new EventSource('/api/v1/log?limit=200');
  es.onopen = () => { statusEl.textContent = '● live'; statusEl.className = 'status ok'; };
  es.onerror = () => {
    statusEl.textContent = '● disconnected — retrying';
    statusEl.className = 'status err';
    setTimeout(connect, 2000);
  };
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    append(data);
  };
}

clearBtn.addEventListener('click', () => { logEl.textContent = ''; });

// ─── Agents view ────────────────────────────────────────────────────────
// Grouped list of every agent: what it does (role), the bounds it works
// within (scope), and its live status (running run + activity, or idle with
// owned-ticket counts). Card structure is built once from a snapshot; status
// rows update on every snapshot pushed or refetched via /api/v1/events.

const STAGE_ORDER = [
  'meta', 'intake', 'routing', 'implementation',
  'quality', 'review', 'detector', 'utility',
];

// Render inline `code` spans without trusting the source as HTML.
function withCode(text) {
  const frag = document.createDocumentFragment();
  String(text).split('`').forEach((part, i) => {
    if (part === '') return;
    if (i % 2 === 1) {
      const c = document.createElement('code');
      c.textContent = part;
      frag.append(c);
    } else {
      frag.append(document.createTextNode(part));
    }
  });
  return frag;
}

const statusEls = new Map(); // agent name → { card, badge, meta }

function fmtElapsed(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function agentCard(a) {
  const card = document.createElement('div');
  card.className = 'agent-card';

  const head = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'agent-name';
  name.textContent = a.title || a.name;
  const slug = document.createElement('span');
  slug.className = 'agent-slug';
  slug.textContent = a.name;
  head.append(name, slug);
  card.append(head);

  const status = document.createElement('div');
  status.className = 'agent-status';
  const badge = document.createElement('span');
  badge.className = 'badge idle';
  badge.textContent = 'idle';
  const meta = document.createElement('span');
  meta.className = 'status-meta';
  status.append(badge, meta);
  card.append(status);
  statusEls.set(a.name, { card, badge, meta });

  if (a.role) {
    const role = document.createElement('p');
    role.className = 'agent-role';
    role.append(withCode(a.role));
    card.append(role);
  }

  if (a.scope) {
    const bounds = document.createElement('div');
    bounds.className = 'agent-bounds';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'bounds';
    const val = document.createElement('span');
    val.append(withCode(a.scope));
    bounds.append(label, val);
    card.append(bounds);
  }

  const flow = document.createElement('div');
  flow.className = 'agent-flow';
  for (const [k, v] of [['input', a.input], ['output', a.output]]) {
    if (!v) continue;
    const row = document.createElement('div');
    row.className = 'row';
    const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
    const vs = document.createElement('span'); vs.className = 'v'; vs.append(withCode(v));
    row.append(ks, vs);
    flow.append(row);
  }
  if (flow.childElementCount) card.append(flow);

  const deps = [
    ...(a.requires || []).map(d => ({ d, kind: 'required' })),
    ...(a.optional || []).map(d => ({ d, kind: 'optional' })),
  ];
  if (deps.length) {
    const wrap = document.createElement('div');
    wrap.className = 'agent-deps';
    for (const { d, kind } of deps) {
      const tag = document.createElement('span');
      tag.className = `dep ${kind}`;
      tag.textContent = kind === 'optional' ? `${d} (optional)` : d;
      tag.title = kind === 'optional' ? `optional dependency: ${d}` : `required dependency: ${d}`;
      wrap.append(tag);
    }
    card.append(wrap);
  }

  return card;
}

let agentsBuilt = false;
let latestSnap = null;

// ─── Live cycle strip ────────────────────────────────────────────────────
// The latest orchestrator cycle (snapshot.cycle on load, then cycle.report
// events). On non-filesystem backends (Linear/GitHub) this is the ONLY source
// of queue-state counts and of which agents are running — the watcher cannot
// see label state or in-session (Task-dispatched) subagents, so the orchestrator
// self-reports them each cycle.

let latestCycle = null;
let latestCycleDeltas = null;
const cycleEl = document.getElementById('cycle');

// Pipeline-order states for the count chips (mirrors api STATES).
const QUEUE_STATES = [
  'needs-triage', 'needs-review', 'needs-work', 'in-progress',
  'needs-test-review', 'needs-code-review', 'needs-feedback',
  'ready-for-human', 'done', 'needs-info', 'obsolete',
];

// agent name → { item, minutes } for agents the latest cycle reports as running.
function cycleRunningMap() {
  const m = new Map();
  for (const r of latestCycle?.running || []) {
    if (r && typeof r.agent === 'string') m.set(r.agent, r);
  }
  return m;
}

function fmtCountdown(c) {
  if (!c || c.nextCheckSeconds == null || !c.at) return '';
  const due = new Date(c.at).getTime() + c.nextCheckSeconds * 1000;
  let s = Math.round((due - Date.now()) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s <= 0) return 'check due';
  const m = Math.floor(s / 60); s %= 60;
  return m ? `next check ${m}m${String(s).padStart(2, '0')}s` : `next check ${s}s`;
}

function deltasBetween(prev, cur) {
  if (!prev) return null;
  const out = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(cur || {})])) {
    out[k] = (cur?.[k] || 0) - (prev[k] || 0);
  }
  return out;
}

function renderCycle() {
  if (!cycleEl) return;
  const c = latestCycle;
  if (!c) { cycleEl.hidden = true; return; }
  cycleEl.hidden = false;
  cycleEl.textContent = '';

  const head = document.createElement('span');
  head.className = 'cycle-head';
  head.textContent = `cycle ${c.cycle}`;
  cycleEl.append(head);
  if (c.backend) {
    const b = document.createElement('span');
    b.className = 'cycle-backend dim';
    b.textContent = c.backend;
    cycleEl.append(b);
  }
  const cd = document.createElement('span');
  cd.className = 'cycle-countdown dim';
  cd.id = 'cycle-countdown';
  cd.textContent = fmtCountdown(c);
  cycleEl.append(cd);

  // Queue-state counts with deltas vs the prior cycle. For Linear/GitHub this
  // is the only place real ticket-state counts surface on the dashboard.
  const counts = c.counts || {};
  const shown = QUEUE_STATES.filter(s => (counts[s] || 0) !== 0 || (latestCycleDeltas?.[s] || 0) !== 0);
  if (shown.length) {
    const wrap = document.createElement('span');
    wrap.className = 'cycle-counts';
    for (const s of shown) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (s === 'ready-for-human' && (counts[s] || 0) > 0 ? ' awaiting' : '');
      const label = document.createElement('span'); label.className = 'k'; label.textContent = s;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = ` ${counts[s] || 0}`;
      chip.append(label, n);
      const d = latestCycleDeltas?.[s] || 0;
      if (d) {
        const ds = document.createElement('span');
        ds.className = 'd ' + (d > 0 ? 'up' : 'down');
        ds.textContent = d > 0 ? `▲${d}` : `▼${-d}`;
        chip.append(ds);
      }
      wrap.append(chip);
    }
    cycleEl.append(wrap);
  }

  // Running agents and what each is working on (agent · item · minutes).
  const running = c.running || [];
  if (running.length) {
    const wrap = document.createElement('span');
    wrap.className = 'cycle-running';
    const lead = document.createElement('span'); lead.className = 'lead'; lead.textContent = '▶ running';
    wrap.append(lead);
    for (const r of running) {
      const t = document.createElement('span');
      t.className = 'run-tag';
      const item = r.item ? ` · ${r.item}` : '';
      const mins = r.minutes != null ? ` ${r.minutes}m` : '';
      t.textContent = `${r.agent}${item}${mins}`;
      wrap.append(t);
    }
    cycleEl.append(wrap);
  }

  // Awaiting human.
  const awaiting = c.awaiting || [];
  if (awaiting.length) {
    const a = document.createElement('span');
    a.className = 'cycle-awaiting';
    const ids = awaiting.slice(0, 6).join(', ');
    const more = awaiting.length > 6 ? ` +${awaiting.length - 6}` : '';
    a.textContent = `⚠ awaiting you: ${ids}${more}`;
    cycleEl.append(a);
  }
}

function updateAgentStatuses(snap) {
  const cycRun = cycleRunningMap();
  let running = 0;
  for (const a of snap.agents || []) {
    const els = statusEls.get(a.name);
    if (!els) continue;
    const act = a.activity || {};
    const runs = act.runs || [];
    if (runs.length) {
      running++;
      els.card.classList.add('running');
      els.badge.className = 'badge running';
      els.badge.textContent = runs.length > 1 ? `● running ×${runs.length}` : '● running';
      const r = runs[0];
      const bits = [
        shortId(r.runId),
        r.startedAt ? fmtElapsed(r.startedAt) : '',
        r.lastActivity || '',
      ].filter(Boolean);
      els.meta.textContent = bits.join(' · ');
    } else if (cycRun.has(a.name)) {
      // Dispatched in-session this cycle (Task subagent — no run record), so the
      // orchestrator's cycle report is the only signal that it's active.
      running++;
      const r = cycRun.get(a.name);
      els.card.classList.add('running');
      els.badge.className = 'badge running';
      els.badge.textContent = '● running';
      const bits = [r.item || '', r.minutes != null ? `${r.minutes}m` : ''].filter(Boolean);
      els.meta.textContent = bits.length ? `this cycle · ${bits.join(' · ')}` : 'this cycle';
    } else {
      els.card.classList.remove('running');
      els.badge.className = 'badge idle';
      els.badge.textContent = 'idle';
      els.meta.textContent = act.owned
        ? `${act.owned} ticket${act.owned === 1 ? '' : 's'} owned${act.active ? `, ${act.active} active` : ''}`
        : '';
    }
  }
  const statusAgentsEl = document.getElementById('agents-status');
  const agents = snap.agents || [];
  if (agents.length) {
    statusAgentsEl.textContent =
      `${agents.length} agents — ${running ? `${running} running` : 'all idle'}`;
    statusAgentsEl.className = running ? 'agents-running' : 'dim';
  }
}

async function renderAgents() {
  const listEl = document.getElementById('agents-list');
  const statusAgentsEl = document.getElementById('agents-status');
  let snap = latestSnap;
  if (!snap) {
    try {
      snap = latestSnap = await fetch('/api/v1/snapshot').then(r => r.json());
    } catch {
      statusAgentsEl.textContent = 'failed to load agents';
      statusAgentsEl.className = 'agents-empty';
      return;
    }
  }
  if (agentsBuilt) return updateAgentStatuses(snap);
  const agents = snap.agents || [];
  if (!agents.length) {
    statusAgentsEl.textContent = 'no agents found';
    return;
  }

  // Group by stage, ordered by the known pipeline order, with any
  // unrecognized stages appended at the end.
  const byStage = new Map();
  for (const a of agents) {
    const stage = a.stage || 'other';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(a);
  }
  const stages = [...byStage.keys()].sort((x, y) => {
    const ix = STAGE_ORDER.indexOf(x), iy = STAGE_ORDER.indexOf(y);
    return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
  });

  listEl.textContent = '';
  for (const stage of stages) {
    const group = byStage.get(stage);
    const section = document.createElement('div');
    section.className = 'stage-group';

    const headEl = document.createElement('div');
    headEl.className = 'stage-head';
    const nameEl = document.createElement('span');
    nameEl.className = 'stage-name';
    nameEl.textContent = stage;
    const countEl = document.createElement('span');
    countEl.className = 'stage-count';
    countEl.textContent = `${group.length} agent${group.length === 1 ? '' : 's'}`;
    headEl.append(nameEl, countEl);
    section.append(headEl);

    const grid = document.createElement('div');
    grid.className = 'agent-grid';
    for (const a of group) grid.append(agentCard(a));
    section.append(grid);
    listEl.append(section);
  }

  agentsBuilt = true;
  updateAgentStatuses(snap);
}

// ─── Control plane (start orchestrator / hard reset) ─────────────────────
// POST /api/v1/orchestrator/start and POST /api/v1/reset. Button enablement
// reflects the latest snapshot: start is disabled while the orchestrator is
// running; kill-all shows the live active-run count.
const startOrchBtn = document.getElementById('orchestrator-start');
const hardResetBtn = document.getElementById('hard-reset');

function flashStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind || ''}`.trim();
}

function updateControls(snap) {
  const running = snap?.orchestrator?.state === 'running';
  const active = snap?.runs?.activeCount ?? 0;
  if (startOrchBtn) {
    startOrchBtn.disabled = running;
    startOrchBtn.textContent = running ? 'orchestrator running' : 'start orchestrator';
  }
  if (hardResetBtn) {
    hardResetBtn.disabled = !running && active === 0;
    hardResetBtn.textContent = active > 0 ? `kill all (${active})` : 'kill all';
  }
}

async function postControl(path) {
  const r = await fetch(path, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

if (startOrchBtn) startOrchBtn.addEventListener('click', async () => {
  startOrchBtn.disabled = true;
  try {
    const r = await postControl('/api/v1/orchestrator/start');
    flashStatus(r.alreadyRunning
      ? `orchestrator already running (pid ${r.supervisorPid})`
      : `orchestrator started (pid ${r.supervisorPid})`, 'ok');
  } catch (err) {
    flashStatus(`start failed: ${err.message}`, 'err');
    startOrchBtn.disabled = false;
  }
});

if (hardResetBtn) hardResetBtn.addEventListener('click', async () => {
  const active = latestSnap?.runs?.activeCount ?? 0;
  if (!confirm(`Hard reset: stop the orchestrator and SIGTERM ${active} in-flight agent run${active === 1 ? '' : 's'}. Continue?`)) return;
  hardResetBtn.disabled = true;
  try {
    const r = await postControl('/api/v1/reset');
    const n = r.runs?.killed?.length ?? 0;
    flashStatus(`hard reset — killed ${n} run${n === 1 ? '' : 's'}, orchestrator stopped`, 'ok');
  } catch (err) {
    flashStatus(`reset failed: ${err.message}`, 'err');
    hardResetBtn.disabled = false;
  }
});

// ─── Live status feed ───────────────────────────────────────────────────
// /api/v1/events replays a snapshot on connect and pushes ticket.* / run.*
// diffs as they happen. Any diff triggers one debounced snapshot refetch,
// which refreshes agent status badges and the log view's runId→agent cache.

let esEvents = null;
let refetchTimer = null;

function onSnapshot(snap) {
  latestSnap = snap;
  applyProject(snap.project);
  // Cycles are append-only — once we have one, a later null snapshot (a race on
  // refetch) must not clear the strip.
  if (snap.cycle) {
    latestCycle = snap.cycle;
    latestCycleDeltas = snap.cycleDeltas || null;
  }
  for (const run of [...(snap.runs?.active || []), ...(snap.runs?.completed || [])]) {
    runAgents.set(run.runId, run.agent);
  }
  renderCycle();
  updateControls(snap);
  if (agentsBuilt) updateAgentStatuses(snap);
  else if (document.body.dataset.view === 'agents') renderAgents();
}

function onCycleReport(cycle) {
  const prevCounts = latestCycle?.counts || null;
  latestCycle = cycle;
  latestCycleDeltas = deltasBetween(prevCounts, cycle.counts || {});
  renderCycle();
  // Relight agent cards from the new cycle's running list (no snapshot refetch
  // needed — the event already carries everything the strip and cards show).
  if (agentsBuilt && latestSnap) updateAgentStatuses(latestSnap);
}

// Live-reload state. The server's `hello` frame carries a per-process bootId;
// when it changes the server was restarted (`ui --watch`), so we reload to pull
// fresh assets. devReload also tightens the reconnect delay so the brief gap
// during a restart is caught quickly rather than after the prod 3s backoff.
let serverBootId = null;
let reconnectDelayMs = 3000;

function connectEvents() {
  if (esEvents) esEvents.close();
  esEvents = new EventSource('/api/v1/events');
  esEvents.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'hello') {
      if (data.devReload) reconnectDelayMs = 400;
      if (serverBootId === null) serverBootId = data.bootId;
      else if (data.bootId !== serverBootId) { location.reload(); }
      return;
    }
    if (data.type === 'snapshot') return onSnapshot(data.data);
    if (data.type === 'cycle.report') return onCycleReport(data.cycle);
    if (refetchTimer) return;
    refetchTimer = setTimeout(async () => {
      refetchTimer = null;
      try { onSnapshot(await fetch('/api/v1/snapshot').then(r => r.json())); } catch {}
    }, 300);
  };
  esEvents.onerror = () => {
    esEvents.close();
    esEvents = null;
    setTimeout(connectEvents, reconnectDelayMs);
  };
}

// Tick the cycle countdown every second (cheap — text-only update).
setInterval(() => {
  if (!latestCycle) return;
  const el = document.getElementById('cycle-countdown');
  if (el) el.textContent = fmtCountdown(latestCycle);
}, 1000);

// Keep elapsed-time readouts on running agents ticking between events.
setInterval(() => {
  if (agentsBuilt && latestSnap && document.body.dataset.view === 'agents') {
    updateAgentStatuses(latestSnap);
  }
}, 10_000);

// ─── Tab switching ──────────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
function selectTab(view) {
  document.body.dataset.view = view;
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === view));
  if (view === 'agents') renderAgents();
  if (view === 'pipeline') initPipeline();
  if (view === 'features') initFeatures();
  if (view === 'feature-pipeline') initFeaturePipeline();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
}

loadSnapshot().then(connect);
connectEvents();

// Default view is pipeline (set in index.html); initialize it on load.
selectTab(document.body.dataset.view || 'pipeline');
