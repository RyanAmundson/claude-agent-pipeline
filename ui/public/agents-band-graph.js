// Pure topology for the agents band: the off-spine fleet the orchestrator
// dispatches, arranged in COLUMNS beneath the spine stage each agent works at.
// A column's height shows where work concentrates — code-review carries the
// whole detector panel, while a lone chip under another stage shows an agent
// that belongs there instead (e.g. the ticket-reviewer under review). No DOM —
// importable in Node (unit tests) and the browser.
//
// This replaced the old self-improvement ("metaloop") band; the four
// self-improvement agents (transcript-reviewer, pipeline-evaluator,
// agent-improver, agent-architect) are intentionally NOT drawn — that loop was
// removed, not relocated.

// The band sits below the spine's lower lane (which ends ~y432), within the
// VIEW.h = 720 canvas. Columns stack downward from BAND_TOP.
export const BAND_TOP = 460;
export const CHIP_H = 16;       // chip box height
export const ROW_STEP = 20;     // vertical centre-to-centre spacing in a column
export const CHIP_W = 104;      // chip box width (< the 120px spine stage spacing)

// Each agent: { id (slug), label (short, for the chip), stage }. `stage` is the
// id of the spine node (pipeline-graph NODES) the agent works at — it anchors the
// column (x = that node's x) AND is the feed target. Order within a stage sets
// top→bottom placement.
export const BAND_AGENTS = [
  // scanner — loop-driven refactor / cleanup sweeps off the merged main
  { id: 'code-simplifier',                 label: 'simplifier',    stage: 'scanner' },
  { id: 'declarative-refactor-specialist', label: 'declarative',   stage: 'scanner' },
  { id: 'folder-structure-enforcer',       label: 'folder-struct', stage: 'scanner' },

  // triage — always-on security sweep + terminology / reference mapping
  { id: 'security-detector',    label: 'security',    stage: 'needs-triage' },
  { id: 'glossary-maintainer',  label: 'glossary',    stage: 'needs-triage' },
  { id: 'context-mapper',       label: 'context-map', stage: 'needs-triage' },

  // review — the ticket reviewer is a reviewer that works HERE, not at code-review
  { id: 'ticket-reviewer',      label: 'ticket-rev',  stage: 'needs-review' },

  // work — dead-code removal + load-balancing into the worker pool
  { id: 'dead-code-remover',    label: 'dead-code',   stage: 'needs-work' },
  { id: 'flex-worker',          label: 'flex-worker', stage: 'needs-work' },

  // in-progress — worktree plumbing for the active worker
  { id: 'git-worktree-manager', label: 'worktree',    stage: 'in-progress' },

  // test — the e2e runners pair with the tester
  { id: 'e2e-test-runner',      label: 'e2e-runner',  stage: 'needs-test-review' },
  { id: 'e2e-test-quality',     label: 'e2e-quality', stage: 'needs-test-review' },

  // code-review — the whole detector panel + data reviewers + proportionality
  // (simplify) gate here
  { id: 'a11y-detector',               label: 'a11y',          stage: 'needs-code-review' },
  { id: 'perf-detector',               label: 'perf',          stage: 'needs-code-review' },
  { id: 'access-control-detector',     label: 'access-ctrl',   stage: 'needs-code-review' },
  { id: 'injection-detector',          label: 'injection',     stage: 'needs-code-review' },
  { id: 'data-protection-detector',    label: 'data-prot',     stage: 'needs-code-review' },
  { id: 'supply-chain-detector',       label: 'supply-chain',  stage: 'needs-code-review' },
  { id: 'justification-detector',      label: 'justify',       stage: 'needs-code-review' },
  { id: 'mock-contract-detector',      label: 'mock',          stage: 'needs-code-review' },
  { id: 'density-system-detector',     label: 'density',       stage: 'needs-code-review' },
  { id: 'pipeline-violation-detector', label: 'pipeline-viol', stage: 'needs-code-review' },
  { id: 'data-validator',              label: 'data-valid',    stage: 'needs-code-review' },
  { id: 'data-fidelity-reviewer',      label: 'data-fidelity', stage: 'needs-code-review' },
  { id: 'simplify',                    label: 'simplify',      stage: 'needs-code-review' },

  // regression — CI-failure triage rides the verification gate
  { id: 'ci-triage',            label: 'ci-triage',   stage: 'needs-regression-check' },

  // ready-for-human — keep the branch current, ship the docs, and (for PRs
  // explicitly tagged agent-mergeable) the merge agent lands them
  { id: 'branch-updater',          label: 'branch-upd', stage: 'ready-for-human' },
  { id: 'technical-docs-manager',  label: 'docs',       stage: 'ready-for-human' },
  { id: 'merge-agent',             label: 'merge',      stage: 'ready-for-human', kind: 'merge' },
];

// Lay the agents out into columns anchored under their spine stage. Pure: given
// the spine nodes (for each stage's x), returns chip nodes keyed by agent id and
// one faint feed per column (stage → the column's bottom chip, so a single stem
// runs behind the stack).
export function bandLayout(spineNodes, top = BAND_TOP) {
  const byStage = new Map();
  for (const a of BAND_AGENTS) {
    if (!byStage.has(a.stage)) byStage.set(a.stage, []);
    byStage.get(a.stage).push(a);
  }
  const chips = {};
  const feeds = [];
  for (const [stage, list] of byStage) {
    const sx = spineNodes[stage] ? spineNodes[stage].x : 0;
    list.forEach((a, i) => {
      chips[a.id] = {
        label: a.label,
        agent: a.id,
        x: sx,
        y: top + i * ROW_STEP,
        w: CHIP_W,
        h: CHIP_H,
        kind: a.kind || 'agent',
      };
    });
    const bottom = list[list.length - 1].id;
    feeds.push({ id: `band:${stage}`, from: stage, to: bottom });
  }
  return { chips, feeds };
}
