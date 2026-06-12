// Live log viewer for agent-pipeline. Subscribes to /api/v1/log (SSE) and
// renders each RunEvent as a line. Color-coded per agent so concurrent runs
// are easy to tell apart.

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const autoscrollEl = document.getElementById('autoscroll');
const showSystemEl = document.getElementById('show-system');
const clearBtn = document.getElementById('clear');

const agentColors = new Map();
const palette = [
  '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7',
  '#ff9e64', '#73daca', '#c0caf5',
];
function colorForAgent(agent) {
  if (!agentColors.has(agent)) {
    agentColors.set(agent, palette[agentColors.size % palette.length]);
  }
  return agentColors.get(agent);
}

// runId → agent name cache. Snapshot fetched once at startup; new runs are
// resolved lazily by re-fetching when an unknown runId appears.
const runAgents = new Map();
async function loadSnapshot() {
  try {
    const snap = await fetch('/api/v1/snapshot').then(r => r.json());
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

function updateAgentStatuses(snap) {
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

// ─── Live status feed ───────────────────────────────────────────────────
// /api/v1/events replays a snapshot on connect and pushes ticket.* / run.*
// diffs as they happen. Any diff triggers one debounced snapshot refetch,
// which refreshes agent status badges and the log view's runId→agent cache.

let esEvents = null;
let refetchTimer = null;

function onSnapshot(snap) {
  latestSnap = snap;
  for (const run of [...(snap.runs?.active || []), ...(snap.runs?.completed || [])]) {
    runAgents.set(run.runId, run.agent);
  }
  if (agentsBuilt) updateAgentStatuses(snap);
  else if (document.body.dataset.view === 'agents') renderAgents();
}

function connectEvents() {
  if (esEvents) esEvents.close();
  esEvents = new EventSource('/api/v1/events');
  esEvents.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'snapshot') return onSnapshot(data.data);
    if (refetchTimer) return;
    refetchTimer = setTimeout(async () => {
      refetchTimer = null;
      try { onSnapshot(await fetch('/api/v1/snapshot').then(r => r.json())); } catch {}
    }, 300);
  };
  esEvents.onerror = () => {
    esEvents.close();
    esEvents = null;
    setTimeout(connectEvents, 3000);
  };
}

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
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
}

loadSnapshot().then(connect);
connectEvents();
