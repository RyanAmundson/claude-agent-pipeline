// Pure topology for the agents band: the detector + specialist fleet the
// orchestrator dispatches off the main spine, drawn as compact chips beneath the
// pipeline. Each chip names an agent and feeds (a faint edge) the spine stage it
// acts on. No DOM — importable in Node (unit tests) and the browser.
//
// This replaces the old self-improvement ("metaloop") band. The four
// self-improvement agents (transcript-reviewer, pipeline-evaluator,
// agent-improver, agent-architect) are intentionally NOT drawn — that loop was
// removed from the graph.

// The band sits below the spine (the spine and its lower lanes end ~y432).
// Three compact rows, all within the VIEW.h = 720 canvas.
export const BAND_ROW_Y = {
  detectors: 545,
  reviewers: 625,
  maintainers: 695,
};

export const BAND_ROW_LABELS = {
  detectors: 'detectors ⟳',
  reviewers: 'reviewers',
  maintainers: 'maintainers ⟳',
};

// Each entry: { id (agent slug), label (short, for the chip), row, feeds }.
// `feeds` is the id of a spine node in pipeline-graph's NODES — the stage this
// agent acts on. The controller draws that cross-graph edge using merged coords.
// Order within a row sets left→right placement.
export const BAND_AGENTS = [
  // ── detectors: the diff-mode panel gating code-review, plus always-on security
  { id: 'security-detector',           label: 'security',      row: 'detectors', feeds: 'needs-triage' },
  { id: 'a11y-detector',               label: 'a11y',          row: 'detectors', feeds: 'needs-code-review' },
  { id: 'perf-detector',               label: 'perf',          row: 'detectors', feeds: 'needs-code-review' },
  { id: 'access-control-detector',     label: 'access-ctrl',   row: 'detectors', feeds: 'needs-code-review' },
  { id: 'injection-detector',          label: 'injection',     row: 'detectors', feeds: 'needs-code-review' },
  { id: 'data-protection-detector',    label: 'data-prot',     row: 'detectors', feeds: 'needs-code-review' },
  { id: 'supply-chain-detector',       label: 'supply-chain',  row: 'detectors', feeds: 'needs-code-review' },
  { id: 'justification-detector',      label: 'justify',       row: 'detectors', feeds: 'needs-code-review' },
  { id: 'mock-contract-detector',      label: 'mock',          row: 'detectors', feeds: 'needs-code-review' },
  { id: 'density-system-detector',     label: 'density',       row: 'detectors', feeds: 'needs-code-review' },
  { id: 'pipeline-violation-detector', label: 'pipeline-viol', row: 'detectors', feeds: 'needs-code-review' },

  // ── reviewers: deeper PR-stage reviews + CI/branch upkeep + terminology/mapping
  { id: 'data-validator',              label: 'data-valid',    row: 'reviewers', feeds: 'needs-code-review' },
  { id: 'data-fidelity-reviewer',      label: 'data-fidelity', row: 'reviewers', feeds: 'needs-code-review' },
  { id: 'ci-triage',                   label: 'ci-triage',     row: 'reviewers', feeds: 'needs-feedback' },
  { id: 'branch-updater',              label: 'branch-upd',    row: 'reviewers', feeds: 'ready-for-human' },
  { id: 'glossary-maintainer',         label: 'glossary',      row: 'reviewers', feeds: 'needs-triage' },
  { id: 'context-mapper',              label: 'context-map',   row: 'reviewers', feeds: 'needs-triage' },
  { id: 'e2e-test-runner',             label: 'e2e-runner',    row: 'reviewers', feeds: 'needs-test-review' },
  { id: 'e2e-test-quality',            label: 'e2e-quality',   row: 'reviewers', feeds: 'needs-test-review' },

  // ── maintainers: loop-driven refactor/cleanup + docs + load-balancing
  { id: 'code-simplifier',                 label: 'simplifier',    row: 'maintainers', feeds: 'scanner' },
  { id: 'declarative-refactor-specialist', label: 'declarative',   row: 'maintainers', feeds: 'scanner' },
  { id: 'folder-structure-enforcer',       label: 'folder-struct', row: 'maintainers', feeds: 'scanner' },
  { id: 'dead-code-remover',               label: 'dead-code',     row: 'maintainers', feeds: 'needs-work' },
  { id: 'flex-worker',                     label: 'flex-worker',   row: 'maintainers', feeds: 'needs-work' },
  { id: 'git-worktree-manager',            label: 'worktree',      row: 'maintainers', feeds: 'in-progress' },
  { id: 'technical-docs-manager',          label: 'docs',          row: 'maintainers', feeds: 'done' },
];

// Lay the chips out into positioned nodes + feed descriptors. Pure: given the
// canvas width and row Y-coordinates, returns chip nodes keyed by agent id and a
// flat list of feed edges ({ id, from: chipId, to: spine node id }).
export function bandLayout(view = { w: 1260 }, rows = BAND_ROW_Y) {
  const marginX = 90;
  const byRow = new Map();
  for (const a of BAND_AGENTS) {
    if (!byRow.has(a.row)) byRow.set(a.row, []);
    byRow.get(a.row).push(a);
  }
  const chips = {};
  const feeds = [];
  for (const [row, list] of byRow) {
    const y = rows[row];
    const span = view.w - marginX * 2;
    const slot = span / list.length;
    list.forEach((a, i) => {
      const x = marginX + slot * (i + 0.5);
      chips[a.id] = {
        label: a.label,
        agent: a.id,
        x: Math.round(x),
        y,
        kind: 'agent',
        w: Math.round(Math.min(slot - 10, 128)),
      };
      feeds.push({ id: `band:${a.id}`, from: a.id, to: a.feeds });
    });
  }
  return { chips, feeds };
}
