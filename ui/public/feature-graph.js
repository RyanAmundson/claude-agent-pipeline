// Pure topology + model for the feature-pipeline ("features" tab). Features are
// ordinary tickets in feature:* states (see api FEATURE_STATES); this renders
// their flow with the same machinery as the bug-fix spine. No DOM.
//
// Shares the pipeline tab's 1260×720 viewBox so the feature flow renders at the
// same scale as the bug-fix spine.
export const FEATURE_VIEW = { w: 1260, h: 720 };

// Lifecycle on the top row; side states (blocked / needs-feedback) below.
export const FEATURE_NODES = {
  'feature:needs-spec':          { label: 'spec',       agent: null, x: 130,  y: 220, kind: 'state', state: 'feature:needs-spec' },
  'feature:needs-design':        { label: 'design',     agent: null, x: 320,  y: 220, kind: 'state', state: 'feature:needs-design' },
  'feature:needs-decomposition': { label: 'decompose',  agent: null, x: 510,  y: 220, kind: 'state', state: 'feature:needs-decomposition' },
  'feature:building':            { label: 'building',   agent: null, x: 700,  y: 220, kind: 'state', state: 'feature:building' },
  'feature:needs-integration':   { label: 'integrate',  agent: null, x: 890,  y: 220, kind: 'state', state: 'feature:needs-integration' },
  'feature:needs-acceptance':    { label: 'accept',     agent: null, x: 1060, y: 220, kind: 'state', state: 'feature:needs-acceptance' },
  'feature:ready-for-human':     { label: 'ready',      agent: null, x: 1210, y: 220, kind: 'exit',  state: 'feature:ready-for-human' },
  'feature:blocked':             { label: 'blocked',    agent: null, x: 700,  y: 360, kind: 'park',  state: 'feature:blocked' },
  'feature:needs-feedback':      { label: 'feedback',   agent: null, x: 1060, y: 360, kind: 'state', state: 'feature:needs-feedback' },
};

export const FEATURE_EDGES = [
  { id: 'feat:design',      from: 'feature:needs-spec',          to: 'feature:needs-design',        kind: 'spine',   bend: 0 },
  { id: 'feat:decompose',   from: 'feature:needs-design',        to: 'feature:needs-decomposition', kind: 'spine',   bend: 0 },
  { id: 'feat:build',       from: 'feature:needs-decomposition', to: 'feature:building',            kind: 'spine',   bend: 0 },
  { id: 'feat:integrate',   from: 'feature:building',            to: 'feature:needs-integration',   kind: 'spine',   bend: 0 },
  { id: 'feat:accept',      from: 'feature:needs-integration',   to: 'feature:needs-acceptance',    kind: 'spine',   bend: 0 },
  { id: 'feat:ready',       from: 'feature:needs-acceptance',    to: 'feature:ready-for-human',     kind: 'spine',   bend: 0 },
  { id: 'feat:blocked',     from: 'feature:building',            to: 'feature:blocked',             kind: 'loop',    bend: 40 },
  { id: 'feat:unblock',     from: 'feature:blocked',             to: 'feature:building',            kind: 'reentry', bend: -40 },
  { id: 'feat:fail',        from: 'feature:needs-acceptance',    to: 'feature:needs-feedback',      kind: 'loop',    bend: 40 },
  { id: 'feat:refeedback',  from: 'feature:needs-feedback',      to: 'feature:needs-acceptance',    kind: 'reentry', bend: -40 },
];

/** Per-feature-state ticket counts, zero-filled for every feature node. */
export function featureCountsOf(snapshot) {
  const byState = snapshot?.tickets?.byState || {};
  const counts = {};
  for (const n of Object.values(FEATURE_NODES)) counts[n.state] = (byState[n.state] || []).length;
  return counts;
}

/** Group every ticket carrying an `epic` field by that epic → [{ id, state }]. */
export function childrenByEpic(snapshot) {
  const byState = snapshot?.tickets?.byState || {};
  const out = {};
  for (const [state, list] of Object.entries(byState)) {
    for (const t of list || []) {
      if (!t || !t.epic) continue;
      (out[t.epic] ||= []).push({ id: t.id, state });
    }
  }
  return out;
}

export function isEmptyCounts(counts) {
  return Object.values(counts || {}).every(n => !n);
}
