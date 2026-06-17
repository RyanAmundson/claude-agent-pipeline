// Pure topology + reducers for the feature (epic) graph view.
// No DOM — importable in Node (unit tests) and the browser (feature-pipeline.js).
import { pathFor } from './pipeline-graph.js';

export const VIEW = { w: 1180, h: 420 };

export const EPIC_STATES = Object.freeze([
  'needs-spec', 'needs-design', 'needs-decomposition', 'building',
  'needs-integration', 'needs-acceptance', 'ready-for-human',
  'blocked', 'needs-feedback', 'done',
]);

// Epic flow nodes. `state` is the feature:* state whose live epic count the node shows.
export const NODES = {
  'needs-spec':          { label: 'spec',       agent: 'feature-spec-writer',          x: 80,   y: 200, kind: 'state', state: 'needs-spec' },
  'needs-design':        { label: 'design',     agent: 'feature-architect',            x: 230,  y: 200, kind: 'state', state: 'needs-design' },
  'needs-decomposition': { label: 'decompose',  agent: 'feature-decomposer',           x: 390,  y: 200, kind: 'state', state: 'needs-decomposition' },
  'building':            { label: 'building',    agent: null,                           x: 560,  y: 200, kind: 'build',  state: 'building' },
  'needs-integration':   { label: 'integrate',  agent: 'feature-integrator',           x: 740,  y: 200, kind: 'state', state: 'needs-integration' },
  'needs-acceptance':    { label: 'accept',     agent: 'feature-acceptance-validator', x: 900,  y: 200, kind: 'state', state: 'needs-acceptance' },
  'ready-for-human':     { label: 'ready',      agent: null,                           x: 1060, y: 200, kind: 'state', state: 'ready-for-human' },
  human:                 { label: '\u{1F464} human', agent: null,                      x: 1060, y: 80,  kind: 'human' },
  done:                  { label: 'done',       agent: 'cleanup',                      x: 1060, y: 330, kind: 'exit',  state: 'done' },
  'needs-feedback':      { label: 'feedback',   agent: 'feedback-responder',           x: 900,  y: 330, kind: 'state', state: 'needs-feedback' },
  blocked:               { label: 'blocked',    agent: null,                           x: 560,  y: 330, kind: 'park',  state: 'blocked' },
  orchestrator:          { label: 'orchestrator', agent: 'orchestrator',               x: 470,  y: 40,  kind: 'meta' },
};

export const EDGES = [
  { id: 'spine:design',      from: 'needs-spec',          to: 'needs-design',        kind: 'spine',   bend: 0 },
  { id: 'spine:decompose',   from: 'needs-design',        to: 'needs-decomposition', kind: 'spine',   bend: 0 },
  { id: 'spine:building',    from: 'needs-decomposition', to: 'building',            kind: 'spine',   bend: 0 },
  { id: 'spine:integrate',   from: 'building',            to: 'needs-integration',   kind: 'spine',   bend: 0 },
  { id: 'spine:accept',      from: 'needs-integration',   to: 'needs-acceptance',    kind: 'spine',   bend: 0 },
  { id: 'spine:ready',       from: 'needs-acceptance',    to: 'ready-for-human',     kind: 'spine',   bend: 0 },
  { id: 'handoff:human',     from: 'ready-for-human',     to: 'human',               kind: 'exit',    bend: 0 },
  { id: 'merge:done',        from: 'human',               to: 'done',                kind: 'exit',    bend: 40 },
  { id: 'fail:accept',       from: 'needs-acceptance',    to: 'needs-feedback',      kind: 'loop',    bend: 30 },
  { id: 'feedback:revalidate', from: 'needs-feedback',    to: 'needs-acceptance',    kind: 'loop',    bend: -30 },
  { id: 'block:building',    from: 'building',            to: 'blocked',             kind: 'park',    bend: 0 },
  { id: 'block:resume',      from: 'blocked',             to: 'building',            kind: 'reentry', bend: 30 },
];

const DIRECT = new Map(EDGES.map(e => [`${e.from}→${e.to}`, e.id]));

export function pathEdgesForMove(from, to) {
  const id = DIRECT.get(`${from}→${to}`);
  return id ? [id] : [];
}

export { pathFor };

export function seedEpicModel(snapshot) {
  const idState = new Map();
  const byState = snapshot?.epics?.byState || {};
  for (const [state, list] of Object.entries(byState)) {
    for (const e of list || []) idState.set(e.id, state);
  }
  return { idState };
}

export function applyEpicEvent(model, ev) {
  const idState = new Map(model.idState);
  if (ev.type === 'epic.move') idState.set(ev.id, ev.to);
  else if (ev.type === 'epic.upsert') {
    const id = ev.epic?.id ?? ev.id;
    if (id != null) idState.set(id, ev.state);
  } else if (ev.type === 'epic.remove') idState.delete(ev.id);
  return { idState };
}

export function epicCountsOf(model) {
  const counts = {};
  for (const node of Object.values(NODES)) if (node.state) counts[node.state] = 0;
  for (const state of model.idState.values()) if (state in counts) counts[state] += 1;
  return counts;
}

// An epic's child tickets, grouped by their (ticket-layer) state. Children are
// tickets whose `epic` field matches; non-children are ignored.
export function childProgress(snapshot, epicId) {
  const byState = {};
  let total = 0, ready = 0;
  const ticketStates = snapshot?.tickets?.byState || {};
  for (const [state, list] of Object.entries(ticketStates)) {
    for (const t of list || []) {
      if (t.epic !== epicId) continue;
      byState[state] = (byState[state] || 0) + 1;
      total++;
      if (state === 'done' || state === 'ready-for-human') ready++;
    }
  }
  return { byState, total, ready };
}
