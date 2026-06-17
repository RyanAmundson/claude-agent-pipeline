// Pure topology for the self-improvement loop band, rendered beneath the pipeline
// spine (and on the features tab). No DOM — importable in Node and the browser.
// The connector from `findings` up into the spine's `needs-triage`, and from
// `improvement-pr` back to the agent definitions, is drawn by the controller
// (it spans two graphs), so every edge here references only META_NODES.

// The band's vertical origin inside the grown pipeline canvas (VIEW.h = 720).
export const BAND_ORIGIN_Y = 600;

const Y = BAND_ORIGIN_Y;

export const META_NODES = {
  corpus:              { label: 'corpus ⟳',   agent: null,                 x: 120,  y: Y + 40, kind: 'feeder' },
  'transcript-reviewer': { label: 'transcripts', agent: 'transcript-reviewer', x: 340, y: Y, kind: 'meta' },
  'pipeline-evaluator':  { label: 'evaluate',  agent: 'pipeline-evaluator',  x: 340,  y: Y + 85, kind: 'meta' },
  findings:            { label: 'findings',    agent: null,                 x: 560,  y: Y + 40, kind: 'feeder' },
  'agent-improver':    { label: 'improve',     agent: 'agent-improver',     x: 780,  y: Y, kind: 'meta' },
  'agent-architect':   { label: 'architect',   agent: 'agent-architect',    x: 780,  y: Y + 85, kind: 'meta' },
  'improvement-pr':    { label: 'PR',          agent: null,                 x: 1000, y: Y + 40, kind: 'feeder' },
};

export const META_EDGES = [
  { id: 'meta:read-tr',     from: 'corpus',              to: 'transcript-reviewer', kind: 'feed',     bend: 0 },
  { id: 'meta:read-pe',     from: 'corpus',              to: 'pipeline-evaluator',  kind: 'feed',     bend: 0 },
  { id: 'meta:tr-findings', from: 'transcript-reviewer', to: 'findings',            kind: 'spine',    bend: 0 },
  { id: 'meta:pe-findings', from: 'pipeline-evaluator',  to: 'findings',            kind: 'spine',    bend: 0 },
  { id: 'meta:improve',     from: 'findings',            to: 'agent-improver',      kind: 'spine',    bend: 0 },
  { id: 'meta:architect',   from: 'findings',            to: 'agent-architect',     kind: 'spine',    bend: 0 },
  { id: 'meta:improver-pr', from: 'agent-improver',      to: 'improvement-pr',      kind: 'spine',    bend: 0 },
  { id: 'meta:architect-pr',from: 'agent-architect',     to: 'improvement-pr',      kind: 'spine',    bend: 0 },
  // the loop closes: a merged improvement PR changes the agents the corpus records
  { id: 'meta:feedback',    from: 'improvement-pr',      to: 'corpus',              kind: 'feedback', bend: 140 },
];
