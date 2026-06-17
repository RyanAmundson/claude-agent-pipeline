# Dashboard coverage for the self-improvement loop + feature pipeline — design

**Date:** 2026-06-17
**Status:** approved (design phase)

## Goal

Make the CAP dashboard show the **whole system**, not just the bug-fix spine:

1. the **self-improvement meta-loop** (`transcript-reviewer`, `pipeline-evaluator` →
   findings → `agent-improver`, `agent-architect` → PR → back into the agent definitions),
2. the **`conflict-resolver`** detour, and
3. a **feature-pipeline view** (`feature:*` flow + a `building` drill-in to child tickets).

All three reuse the existing snapshot / SSE / SVG machinery. No new data substrate, no new
API endpoint, no new SSE event type. The self-improvement band is a **shared component**
rendered on both the pipeline tab and the features tab.

## Why now

The dashboard's flow graph (`ui/public/pipeline-graph.js`) is a hardcoded spine of the
bug-fix queue states. It does not render the improvement stage at all (`transcript-reviewer`,
`agent-improver`, and the new `pipeline-evaluator` / `agent-architect` from PR #6 have no
node), nor `conflict-resolver` / `needs-conflict-resolution` (already a real state in
`api/index.js`'s `STATES`, just unrendered), nor anything about the new-feature pipeline. The
agents **tab** already lists every agent (it renders `snapshot.agents`), so this work is
specifically about the **flow graph**.

## Architecture overview

The dashboard is dependency-free vanilla JS + SVG + SSE (`ui/public/`), fed by
`readSnapshot()` / `createWatcher()` in `api/index.js` via `ui/server.js`. Rendering reads two
immutable topology modules (`NODES`/`EDGES`) and applies live state from
`/api/v1/snapshot` + `/api/v1/events`. Canvas is a `viewBox` of `VIEW.w × VIEW.h`
(currently 1260×560); nodes are placed by hardcoded `x`/`y`.

Five units, each independently understandable and testable:

| Unit | File | Responsibility |
|---|---|---|
| Main-spine topology | `ui/public/pipeline-graph.js` (edit) | Add `needs-conflict-resolution` node + edges; grow `VIEW.h` to host the meta-band beneath the spine. |
| Self-improvement topology | `ui/public/metaloop-graph.js` (new) | `NODES`/`EDGES` for the meta-loop + a `renderMetaBand(svg, originY)` mount helper. Shared by both tabs. |
| Feature-flow topology | `ui/public/feature-graph.js` (new) | `NODES`/`EDGES` for the `feature:*` flow + a `building` drill-in model. |
| Tab + view wiring | `ui/public/app.js`, `index.html`, `pipeline.js` (edit) | New `features` tab; render meta-band into both tabs' SVGs; empty-state handling. |
| Snapshot enabler | `api/index.js` (edit) | Surface a `FEATURE_STATES` set through the same `readSnapshot`/`byState` path; expose `snapshot.featureStates`. |

### 1. Main-spine additions (`pipeline-graph.js`)

- **`needs-conflict-resolution` node** — `{ label: 'conflict', agent: 'conflict-resolver',
  kind: 'state', state: 'needs-conflict-resolution', agentHome: true }`, placed as a detour
  near `ready-for-human`. Edges: a `loop`/detour edge `ready-for-human → needs-conflict-resolution`
  and a `reentry` edge `needs-conflict-resolution → ready-for-human` (conflict-resolver returns
  the PR once clean, per the `STATES` comment). Add its orchestrator `dispatch:` edge so
  `agentHomeNodes()` / dispatch tests stay consistent. The state's ticket data already flows
  through `byState` — this is pure topology.
- **`needs-detector-gate` node** (optional, flagged) — also in `STATES` but unrendered; add it
  on the spine between `needs-code-review` and `needs-regression-check` for graph/backend
  parity. May be deferred without affecting the rest.
- **Grow `VIEW.h`** (≈560 → ≈720) to create vertical room for the meta-band beneath the spine.
  The spine's existing `x`/`y` coordinates are unchanged, so existing geometry tests stay green.

### 2. Self-improvement meta-band — shared component (`metaloop-graph.js`, new)

A standalone topology module mirroring `pipeline-graph.js`'s shape so it is testable in
isolation:

- **`NODES`** (own coordinate space, `kind: 'meta'` reusing the existing `.kind-meta` CSS):
  - `corpus` — source node (runs / lessons / cycles), `kind: 'meta-source'`.
  - `transcript-reviewer`, `pipeline-evaluator` — the read-only evaluators.
  - `agent-improver`, `agent-architect` — the structural implementers.
  - `improvement-pr` — the PR fan-in / exit.
- **`EDGES`**: `corpus → {transcript-reviewer, pipeline-evaluator}` (reads),
  evaluators `→ needs-triage` (findings filed; on the pipeline tab this links up into the
  spine), `needs-triage → {agent-improver, agent-architect}` (consume findings),
  `→ improvement-pr`, and a **`kind: 'feedback'`** arc `improvement-pr → corpus`/agents labeled
  "improves the agents." A new `.kind-feedback` edge style (dashed, accent color) is added to
  `style.css`.
- **`renderMetaBand(svg, originY)`** — appends the band's edges + nodes into a given `<svg>` at a
  vertical offset, reusing `pipeline.js`'s node/edge element builders (extracted to a small
  shared helper if needed). It does **not** own its own SVG, so each tab renders "one diagram."

The band carries **no live ticket counts of its own** beyond what the findings (which are
ordinary `domain:pipeline-improvement` tickets in `needs-triage`/`needs-work`) already show on
the spine. Running-agent halos for the four meta agents use the existing
`runningAgentNames(snapshot, cycle)` path (they appear in `snapshot.agents`).

### 3. Features tab (`feature-graph.js` + wiring)

- **Features are tickets**, tracked the same way as today. `feature-graph.js` defines a
  `feature:*` flow graph: `feature:needs-spec → needs-design → needs-decomposition → building
  → needs-integration → needs-acceptance → ready-for-human`, with side nodes `feature:blocked`
  and `feature:needs-feedback`. Rendered with the **same** count / SSE / token machinery as the
  spine (counts from `byState['feature:*']`).
- **`building` drill-in**: clicking/expanding the `building` node shows the epic's child tickets
  as chips colored by the standard pipeline state each currently occupies. Children are ordinary
  tickets carrying an `epic` field; the drill-in groups `byState` tickets by their `epic`. (If
  no child-linking data is present, the drill-in shows the empty state.)
- **Shared meta-band**: `renderMetaBand()` renders beneath the feature flow (no spine feedback
  arc on this tab; the arc terminates at the generic "agents" marker).
- **Empty state**: when no `feature:*` tickets exist (today's reality), the tab shows a
  "No features in flight yet" placeholder over a dimmed flow diagram. It lights up automatically
  when feature tickets appear — same data path, no code change required.

### 4. Snapshot enabler (`api/index.js`)

- Add `export const FEATURE_STATES = Object.freeze([...])` (the `feature:*` states above),
  kept **separate** from the bug-fix `STATES` list so the existing queue model is untouched.
- `readSnapshot()` enumerates `FEATURE_STATES` through the **same** read path — the same
  `queueDir(target)/<state>/` layout `STATES` uses, with the state string as the subdir name —
  reading defensively (missing directory → empty list, exactly like the current `existsSync`
  guard), and merges the keys into `tickets.byState`. It additionally exposes
  `featureStates: FEATURE_STATES` on the snapshot (parallel to the existing `states: STATES`).
- The existing `.pipeline/queue` watcher provides SSE liveness; no new event type. (Physical
  storage of feature tickets follows the 2026-06-17 new-feature-pipeline spec's intent; the
  reader is defensive so it is correct whether or not that backend has shipped.)

## Data flow

`readSnapshot` → `tickets.byState` (now including `feature:*` keys, empty until backend writes
them) + `agents[]` + `cycle` → `/api/v1/snapshot` and `/api/v1/events` SSE → `pipeline.js`
applies counts/halos/token-animations to whichever topology a tab mounts. Unchanged for the
bug-fix spine; the features tab is a second consumer of the same stream.

## Error handling / edge cases

- **Absent feature data** → empty-state placeholder, never an error (defensive reads).
- **Unknown `byState` keys** the graph has no node for → ignored (rendering iterates `NODES`,
  not states), as today.
- **Growing `VIEW.h`** must not shift spine coordinates → spine `x`/`y` frozen; only the band
  occupies the new vertical space.

## Testing

All pure-function, claude-free (Node `node --test`, the existing `test/ui` pattern):

- `test/ui/pipeline-graph.test.js` (extend): every new edge references a defined node; the new
  `needs-conflict-resolution` (and optional `needs-detector-gate`) node has a dispatch edge and a
  home agent; `VIEW.h` still positive; spine path geometry unchanged for existing edges.
- `test/ui/metaloop-graph.test.js` (new): every meta edge references a defined meta/spine node;
  the feedback edge exists; `renderMetaBand` is a pure topology export (no DOM in the model).
- `test/ui/feature-graph.test.js` (new): `feature:*` flow edges reference defined nodes; the
  `building` drill-in groups child tickets by `epic`; empty `byState` yields the empty-state model.
- `api` tests (extend): `FEATURE_STATES` is frozen and disjoint from `STATES`; `readSnapshot`
  includes the `feature:*` keys (empty) and `featureStates` without touching bug-fix `byState`.

## Decisions locked (operator-confirmed)

- Self-improvement loop renders as a **unified meta-band in one diagram** on the pipeline tab
  (grown `viewBox`, feedback arc into the spine).
- `conflict-resolver` is a **main-spine node** (`needs-conflict-resolution`); data already flows.
- Features are **tickets, tracked the same way** — surfaced through the existing
  `readSnapshot`/`byState`/SSE path via a separate `FEATURE_STATES` list; **empty state** until
  feature tickets exist.
- The meta-band is a **shared component rendered on both tabs**.
- Lands on `feat/cap-meta-self-improvement` → **local `main`** at finish, after verifying local
  `main` is clean and fast-forwardable (a prior local merge was unsafe due to divergence / a
  dirty shared checkout).

## Out of scope

- Implementing the feature-pipeline **backend** (front/back agents, epic substrate) — spec-only;
  this is the dashboard view only.
- Any change to the bug-fix `STATES` list or existing spine geometry.
- A new API endpoint or SSE event type.
