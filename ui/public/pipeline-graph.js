// Pure topology + reducers for the pipeline graph view.
// No DOM — importable in Node (unit tests) and the browser (pipeline.js).

// SVG canvas; used as the <svg> viewBox. Coordinates below are tunable.
export const VIEW = { w: 1120, h: 560 };

// Each node has a center (x, y). `kind` drives styling. `agent` is the owning
// agent shown beneath the node. `state` (when present) is the queue state whose
// live ticket count the node displays. `agentHome` (default true) marks the node
// where this agent actively works, so running-agent counts show there and not on
// the backlog/park it pulls from — e.g. workers count at `in-progress`, not the
// `needs-work` queue; the reviewer at `needs-review`, not the `needs-info` park.
export const NODES = {
  scanner:             { label: 'scan',        agent: 'scanner',            x: 70,   y: 250, kind: 'entry' },
  'needs-triage':      { label: 'triage',      agent: 'ticket-creator',     x: 210,  y: 250, kind: 'state', state: 'needs-triage' },
  'needs-review':      { label: 'review',      agent: 'ticket-reviewer',    x: 340,  y: 250, kind: 'state', state: 'needs-review' },
  'needs-work':        { label: 'work',        agent: 'worker',             x: 470,  y: 250, kind: 'state', state: 'needs-work', agentHome: false },
  'in-progress':       { label: 'in-progress', agent: 'worker',             x: 600,  y: 250, kind: 'state', state: 'in-progress' },
  'needs-test-review': { label: 'test',        agent: 'tester',             x: 730,  y: 250, kind: 'state', state: 'needs-test-review' },
  'needs-code-review': { label: 'code-review', agent: 'code-reviewer',      x: 870,  y: 250, kind: 'state', state: 'needs-code-review' },
  'ready-for-human':   { label: 'ready',       agent: null,                 x: 1010, y: 250, kind: 'state', state: 'ready-for-human' },
  human:               { label: '\u{1F464} human', agent: null,             x: 1010, y: 110, kind: 'human' },
  done:                { label: 'done',        agent: 'cleanup',            x: 1010, y: 410, kind: 'exit',  state: 'done' },
  'needs-feedback':    { label: 'feedback',    agent: 'feedback-responder', x: 800,  y: 410, kind: 'state', state: 'needs-feedback' },
  'needs-info':        { label: 'needs-info',  agent: 'ticket-reviewer',    x: 340,  y: 410, kind: 'park',  state: 'needs-info', agentHome: false },
  obsolete:            { label: 'obsolete',    agent: 'relevance-checker',  x: 470,  y: 410, kind: 'exit',  state: 'obsolete' },
  // chrome: off-path agents (no state → no count badge). orchestrator pulses
  // when an orchestrator run is active; the feeders flow findings into triage.
  orchestrator:        { label: 'orchestrator', agent: 'orchestrator',      x: 560,  y: 40,  kind: 'meta' },
  detectors:           { label: 'detectors ⟳', agent: null,            x: 70,   y: 120, kind: 'feeder' },
  utility:             { label: 'utility ⛭',   agent: null,            x: 210,  y: 120, kind: 'feeder' },
};

// Edges. `bend` offsets the bezier control point perpendicular to the chord
// (px): 0 = straight, sign picks the bow direction. `kind` drives styling.
export const EDGES = [
  // base spine (happy path)
  { id: 'spine:triage',      from: 'scanner',           to: 'needs-triage',      kind: 'spine',   bend: 0 },
  { id: 'spine:review',      from: 'needs-triage',      to: 'needs-review',      kind: 'spine',   bend: 0 },
  { id: 'spine:work',        from: 'needs-review',      to: 'needs-work',        kind: 'spine',   bend: 0 },
  { id: 'spine:inprogress',  from: 'needs-work',        to: 'in-progress',       kind: 'spine',   bend: 0 },
  { id: 'spine:test',        from: 'in-progress',       to: 'needs-test-review', kind: 'spine',   bend: 0 },
  { id: 'spine:codereview',  from: 'needs-test-review', to: 'needs-code-review', kind: 'spine',   bend: 0 },
  { id: 'spine:ready',       from: 'needs-code-review', to: 'ready-for-human',   kind: 'spine',   bend: 0 },
  // human handoff <-> re-entry
  { id: 'handoff:human',     from: 'ready-for-human',   to: 'human',             kind: 'exit',    bend: 0 },
  { id: 'merge:done',        from: 'human',             to: 'done',              kind: 'exit',    bend: 40 },
  { id: 'human:reentry',     from: 'ready-for-human',   to: 'needs-feedback',    kind: 'reentry', bend: 60 },
  // review-fail loop
  { id: 'fail:test',         from: 'needs-test-review', to: 'needs-feedback',    kind: 'loop',    bend: 50 },
  { id: 'fail:codereview',   from: 'needs-code-review', to: 'needs-feedback',    kind: 'loop',    bend: 30 },
  { id: 'feedback:rereview', from: 'needs-feedback',    to: 'needs-code-review', kind: 'loop',    bend: -40 },
  // park <-> resume
  { id: 'park:info',         from: 'needs-review',      to: 'needs-info',        kind: 'park',    bend: 0 },
  { id: 'info:resume',       from: 'needs-info',        to: 'needs-review',      kind: 'reentry', bend: 30 },
  // stale re-queue + post-merge re-scan
  { id: 'stale:requeue',     from: 'in-progress',       to: 'needs-work',        kind: 'loop',    bend: -60 },
  { id: 'rescan:regen',      from: 'done',              to: 'scanner',           kind: 'regen',   bend: 120 },
  // reserved: relevance-checker
  { id: 'obsolete:work',     from: 'needs-work',        to: 'obsolete',          kind: 'exit',    bend: 0 },
  { id: 'obsolete:ready',    from: 'ready-for-human',   to: 'obsolete',          kind: 'exit',    bend: 80 },
  // feeders (detectors + utility flow findings into triage)
  { id: 'feed:detectors',    from: 'detectors',         to: 'needs-triage',      kind: 'feed',    bend: 0 },
  { id: 'feed:utility',      from: 'utility',           to: 'needs-triage',      kind: 'feed',    bend: 0 },
];

// Direct from→to → edge id (built from EDGES).
const DIRECT = new Map(EDGES.map(e => [`${e.from}→${e.to}`, e.id]));

// Moves whose visual path is more than one hop (work travels through a node
// that isn't its data destination — e.g. a merge passes through the human).
const MULTI_HOP = {
  'ready-for-human→done': ['handoff:human', 'merge:done'],
};

/**
 * Ordered list of edge ids a ticket move should animate. Empty when the move
 * isn't modeled (the caller falls back to a generic arc).
 * @param {string} from @param {string} to @returns {string[]}
 */
export function pathEdgesForMove(from, to) {
  const key = `${from}→${to}`;
  if (MULTI_HOP[key]) return MULTI_HOP[key];
  const direct = DIRECT.get(key);
  return direct ? [direct] : [];
}

/**
 * SVG path `d` for an edge: a quadratic bezier from the source node center to
 * the target center, with the control point offset perpendicular to the chord
 * by `edge.bend`. Pure string math (no DOM).
 * @param {{from:string,to:string,bend?:number}} edge
 * @param {Record<string,{x:number,y:number}>} nodes
 * @returns {string}
 */
export function pathFor(edge, nodes = NODES) {
  const a = nodes[edge.from];
  const b = nodes[edge.to];
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len; // perpendicular unit vector
  const py = dx / len;
  const bend = edge.bend || 0;
  const cx = mx + px * bend;
  const cy = my + py * bend;
  const r = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `M ${r(a.x)} ${r(a.y)} Q ${r(cx)} ${r(cy)} ${r(b.x)} ${r(b.y)}`;
}

// ─── live-count model ──────────────────────────────────────────────────────
// Tracks id → state so counts are derived (a content-change upsert can't
// double-count, and a move is just a reassignment). `seen` lets the animator
// tell a brand-new ticket (entry) from a content update.

/** @param {*} snapshot @returns {{idState: Map<string,string>}} */
export function seedModel(snapshot) {
  const idState = new Map();
  const byState = snapshot?.tickets?.byState || {};
  for (const [state, list] of Object.entries(byState)) {
    for (const t of list || []) idState.set(t.id, state);
  }
  return { idState };
}

export function hasTicket(model, id) {
  return model.idState.has(id);
}

/** Apply one watcher event, returning a new model (does not mutate). */
export function applyEvent(model, ev) {
  const idState = new Map(model.idState);
  if (ev.type === 'ticket.move') {
    idState.set(ev.id, ev.to);
  } else if (ev.type === 'ticket.upsert') {
    const id = ev.ticket?.id ?? ev.id;
    if (id != null) idState.set(id, ev.state);
  } else if (ev.type === 'ticket.remove') {
    idState.delete(ev.id);
  }
  return { idState };
}

/** Per-state counts for every state-bearing node (zero-filled). */
export function countsOf(model) {
  const counts = {};
  for (const node of Object.values(NODES)) {
    if (node.state) counts[node.state] = 0;
  }
  for (const state of model.idState.values()) {
    if (state in counts) counts[state] += 1;
  }
  return counts;
}

// ─── backend-neutral count source ───────────────────────────────────────────
// Filesystem backends have a real queue the watcher tails, so per-state counts
// come from the ticket model (seedModel/applyEvent). Linear/GitHub backends
// have no queue — the orchestrator's cycle.report is the ONLY source of counts
// and of which agents are running. These pure helpers let pipeline.js pick the
// right source without importing any DOM.

/** Zero-filled per-state counts overlaid with a cycle report's `counts`. */
export function countsFromCycle(cycle) {
  const counts = {};
  for (const node of Object.values(NODES)) {
    if (node.state) counts[node.state] = 0;
  }
  for (const [state, n] of Object.entries(cycle?.counts || {})) {
    if (state in counts) counts[state] = n;
  }
  return counts;
}

/** Agent names a cycle report lists as running (skips malformed entries). */
export function runningAgentsFromCycle(cycle) {
  const out = [];
  for (const r of cycle?.running || []) {
    if (r && typeof r.agent === 'string') out.push(r.agent);
  }
  return out;
}

/**
 * Which count source to trust for a given cycle: 'cycle' for non-filesystem
 * backends (Linear/GitHub — no queue to model), 'model' for filesystem or when
 * no cycle has been reported yet.
 */
export function countSourceForCycle(cycle) {
  const backend = cycle?.backend;
  return backend && backend !== 'filesystem' ? 'cycle' : 'model';
}

// ─── per-node agent allocation ──────────────────────────────────────────────
// How many agents are working at each node, alongside the ticket backlog — the
// orchestrator dispatches agents by back-pressure, so this makes allocation vs
// queue depth visible at a glance.

/** Agent name → the single node id where its running instances are shown. */
export function agentHomeNodes() {
  const map = {};
  for (const [id, n] of Object.entries(NODES)) {
    if (n.agent && n.agentHome !== false) map[n.agent] = id;
  }
  return map;
}

/** Array of running agent names (repeats = instances) → { nodeId: count }. */
export function agentCountsByNode(names) {
  const home = agentHomeNodes();
  const counts = {};
  for (const name of names || []) {
    const node = home[name];
    if (node) counts[node] = (counts[node] || 0) + 1;
  }
  return counts;
}

/**
 * The running-agent instances to display, as a flat array of agent names. Uses
 * the cycle report's `running` list when present (the orchestrator's
 * authoritative dispatch list — the only signal on Linear/GitHub and the
 * superset on filesystem), else falls back to filesystem run records. Never
 * unions the two, so an agent can't be double-counted.
 */
export function runningAgentNames(snapshot, cycle) {
  if (cycle && Array.isArray(cycle.running) && cycle.running.length) {
    return cycle.running.filter(r => r && typeof r.agent === 'string').map(r => r.agent);
  }
  const names = [];
  for (const a of snapshot?.agents || []) {
    const k = (a.activity?.runs || []).length;
    for (let i = 0; i < k; i++) names.push(a.name);
  }
  return names;
}
