# Pipeline Flow Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default `pipeline` tab to the UI dashboard that renders the agent pipeline as an animated graph — queue states as nodes, all lifecycle transitions (including exits and re-entries) as edges, and tickets as tokens that animate along edges as they move.

**Architecture:** Pure topology + reducers live in a DOM-free module (`ui/public/pipeline-graph.js`) so they unit-test under `node:test`. A browser module (`ui/public/pipeline.js`) imports that, builds an SVG graph, and runs a `requestAnimationFrame` token animator fed by the existing `/api/v1/events` stream. No `server.js`/`api/` changes — the snapshot and `ticket.move`/`upsert`/`remove` events already carry everything.

**Tech Stack:** Vanilla ES modules, inline SVG, CSS (no framework, no runtime deps — consistent with the existing dashboard). Unit tests via Node's built-in `node:test`.

---

## Spec

Implements `docs/superpowers/specs/2026-06-12-pipeline-flow-visual-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `ui/public/pipeline-graph.js` | **new** — pure, DOM-free: `NODES`, `EDGES`, `VIEW`, `pathEdgesForMove`, `pathFor`, and the model reducer (`seedModel`/`applyEvent`/`countsOf`). Importable in Node. |
| `ui/public/pipeline.js` | **new** — browser-only: builds the SVG from the pure module, renders counts + running pulses, runs the rAF token animator, wires its own `EventSource`. Exports `initPipeline()`. |
| `ui/public/index.html` | add the `pipeline` tab + `<section id="pipeline">` with the `<svg>`; flip the default view to `pipeline`. |
| `ui/public/style.css` | view-toggling for 3 panels; node/edge/token/tooltip styles; reduced-motion. |
| `ui/public/app.js` | import + call `initPipeline()` on tab select and on initial load. |
| `test/ui/pipeline-graph.test.js` | **new** — `node:test` units for the pure seams. |
| `package.json` | add `"test:ui": "node --test test/ui/"`. |
| `README.md` | one-line mention of the new tab. |

The pure/DOM split is the key decomposition: every branchy decision (which edge a move animates, how counts evolve, edge geometry) is in `pipeline-graph.js` and tested headless; `pipeline.js` is the thin rendering shell.

---

## Task 1: Pure graph topology + move→edge routing

**Files:**
- Create: `ui/public/pipeline-graph.js`
- Create: `test/ui/pipeline-graph.test.js`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"` (after the existing `"test"` line):

```json
    "test:ui": "node --test test/ui/",
```

- [ ] **Step 2: Write the failing test**

Create `test/ui/pipeline-graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODES, EDGES, VIEW, pathEdgesForMove,
} from '../../ui/public/pipeline-graph.js';

test('every edge references defined nodes', () => {
  for (const e of EDGES) {
    assert.ok(NODES[e.from], `edge ${e.id} from-node ${e.from} missing`);
    assert.ok(NODES[e.to], `edge ${e.id} to-node ${e.to} missing`);
  }
});

test('VIEW has positive dimensions', () => {
  assert.ok(VIEW.w > 0 && VIEW.h > 0);
});

test('happy-path move resolves to its single spine edge', () => {
  assert.deepEqual(pathEdgesForMove('needs-triage', 'needs-review'), ['spine:review']);
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'ready-for-human'), ['spine:ready']);
});

test('review FAIL loops back to needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'needs-feedback'), ['fail:codereview']);
  assert.deepEqual(pathEdgesForMove('needs-test-review', 'needs-feedback'), ['fail:test']);
});

test('feedback re-review returns to code-review', () => {
  assert.deepEqual(pathEdgesForMove('needs-feedback', 'needs-code-review'), ['feedback:rereview']);
});

test('human comment re-enters at needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'needs-feedback'), ['human:reentry']);
});

test('merge routes through the human, then to done (multi-hop)', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'done'), ['handoff:human', 'merge:done']);
});

test('park and resume via needs-info', () => {
  assert.deepEqual(pathEdgesForMove('needs-review', 'needs-info'), ['park:info']);
  assert.deepEqual(pathEdgesForMove('needs-info', 'needs-review'), ['info:resume']);
});

test('stale in-progress re-queues to needs-work', () => {
  assert.deepEqual(pathEdgesForMove('in-progress', 'needs-work'), ['stale:requeue']);
});

test('obsolete exits are wired', () => {
  assert.deepEqual(pathEdgesForMove('needs-work', 'obsolete'), ['obsolete:work']);
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'obsolete'), ['obsolete:ready']);
});

test('entry move (scanner→triage) resolves to the entry spine edge', () => {
  assert.deepEqual(pathEdgesForMove('scanner', 'needs-triage'), ['spine:triage']);
});

test('an unmodeled move returns an empty path', () => {
  assert.deepEqual(pathEdgesForMove('done', 'in-progress'), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `Cannot find module '.../ui/public/pipeline-graph.js'`.

- [ ] **Step 4: Create the pure module**

Create `ui/public/pipeline-graph.js`:

```js
// Pure topology + reducers for the pipeline graph view.
// No DOM — importable in Node (unit tests) and the browser (pipeline.js).

// SVG canvas; used as the <svg> viewBox. Coordinates below are tunable.
export const VIEW = { w: 1120, h: 560 };

// Each node has a center (x, y). `kind` drives styling. `agent` is the owning
// agent shown beneath the node. `state` (when present) is the queue state whose
// live ticket count the node displays.
export const NODES = {
  scanner:             { label: 'scan',        agent: 'scanner',            x: 70,   y: 250, kind: 'entry' },
  'needs-triage':      { label: 'triage',      agent: 'ticket-creator',     x: 210,  y: 250, kind: 'state', state: 'needs-triage' },
  'needs-review':      { label: 'review',      agent: 'ticket-reviewer',    x: 340,  y: 250, kind: 'state', state: 'needs-review' },
  'needs-work':        { label: 'work',        agent: 'worker',             x: 470,  y: 250, kind: 'state', state: 'needs-work' },
  'in-progress':       { label: 'in-progress', agent: 'worker',             x: 600,  y: 250, kind: 'state', state: 'in-progress' },
  'needs-test-review': { label: 'test',        agent: 'tester',             x: 730,  y: 250, kind: 'state', state: 'needs-test-review' },
  'needs-code-review': { label: 'code-review', agent: 'code-reviewer',      x: 870,  y: 250, kind: 'state', state: 'needs-code-review' },
  'ready-for-human':   { label: 'ready',       agent: null,                 x: 1010, y: 250, kind: 'state', state: 'ready-for-human' },
  human:               { label: '\u{1F464} human', agent: null,             x: 1010, y: 110, kind: 'human' },
  done:                { label: 'done',        agent: 'cleanup',            x: 1010, y: 410, kind: 'exit',  state: 'done' },
  'needs-feedback':    { label: 'feedback',    agent: 'feedback-responder', x: 800,  y: 410, kind: 'state', state: 'needs-feedback' },
  'needs-info':        { label: 'needs-info',  agent: 'ticket-reviewer',    x: 340,  y: 410, kind: 'park',  state: 'needs-info' },
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:ui`
Expected: PASS — all tests in the file green, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add ui/public/pipeline-graph.js test/ui/pipeline-graph.test.js package.json
git commit -m "feat(ui): pipeline graph topology + move→edge routing"
```

---

## Task 2: Edge geometry (`pathFor`)

**Files:**
- Modify: `ui/public/pipeline-graph.js`
- Modify: `test/ui/pipeline-graph.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/ui/pipeline-graph.test.js`:

```js
import { pathFor } from '../../ui/public/pipeline-graph.js';

test('pathFor returns a quadratic bezier between node centers', () => {
  const d = pathFor(EDGES.find(e => e.id === 'spine:review'));
  // M <ax> <ay> Q <cx> <cy> <bx> <by>
  assert.match(d, /^M 210 250 Q [\d.-]+ [\d.-]+ 340 250$/);
});

test('a zero-bend edge keeps the control point on the chord midpoint', () => {
  const d = pathFor({ from: 'needs-triage', to: 'needs-review', bend: 0 });
  assert.match(d, /^M 210 250 Q 275(\.0)? 250(\.0)? 340 250$/);
});

test('a non-zero bend pushes the control point off the chord', () => {
  const straight = pathFor({ from: 'needs-review', to: 'needs-info', bend: 0 });
  const bowed = pathFor({ from: 'needs-review', to: 'needs-info', bend: 40 });
  assert.notEqual(straight, bowed);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `pathFor is not a function` / import resolves to `undefined`.

- [ ] **Step 3: Implement `pathFor`**

Append to `ui/public/pipeline-graph.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/public/pipeline-graph.js test/ui/pipeline-graph.test.js
git commit -m "feat(ui): pipeline edge geometry (pathFor)"
```

---

## Task 3: Live-count model reducer

**Files:**
- Modify: `ui/public/pipeline-graph.js`
- Modify: `test/ui/pipeline-graph.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/ui/pipeline-graph.test.js`:

```js
import { seedModel, applyEvent, countsOf } from '../../ui/public/pipeline-graph.js';

const SNAP = {
  tickets: { byState: {
    'needs-work': [{ id: 'A' }, { id: 'B' }],
    'in-progress': [{ id: 'C' }],
    'ready-for-human': [{ id: 'D' }],
  } },
};

test('seedModel + countsOf reflect the snapshot', () => {
  const counts = countsOf(seedModel(SNAP));
  assert.equal(counts['needs-work'], 2);
  assert.equal(counts['in-progress'], 1);
  assert.equal(counts['ready-for-human'], 1);
  assert.equal(counts['needs-triage'], 0);
});

test('a move decrements the source and increments the destination', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.move', id: 'A', from: 'needs-work', to: 'in-progress' });
  const counts = countsOf(m);
  assert.equal(counts['needs-work'], 1);
  assert.equal(counts['in-progress'], 2);
});

test('upsert of a new id adds it; re-upsert is idempotent', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.upsert', state: 'needs-triage', ticket: { id: 'Z' } });
  assert.equal(countsOf(m)['needs-triage'], 1);
  m = applyEvent(m, { type: 'ticket.upsert', state: 'needs-triage', ticket: { id: 'Z' } });
  assert.equal(countsOf(m)['needs-triage'], 1);
});

test('remove drops the id from its state', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.remove', id: 'D', state: 'ready-for-human' });
  assert.equal(countsOf(m)['ready-for-human'], 0);
});

test('hasTicket reports prior membership (for entry detection)', () => {
  const m = seedModel(SNAP);
  assert.equal(hasTicket(m, 'A'), true);
  assert.equal(hasTicket(m, 'Z'), false);
});
```

Add `hasTicket` to the existing import line for `seedModel`:

```js
import { seedModel, applyEvent, countsOf, hasTicket } from '../../ui/public/pipeline-graph.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `seedModel is not a function`.

- [ ] **Step 3: Implement the reducer**

Append to `ui/public/pipeline-graph.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:ui`
Expected: PASS — full file green.

- [ ] **Step 5: Commit**

```bash
git add ui/public/pipeline-graph.js test/ui/pipeline-graph.test.js
git commit -m "feat(ui): pipeline live-count model reducer"
```

---

## Task 4: HTML — pipeline tab, panel, and default view

**Files:**
- Modify: `ui/public/index.html`

- [ ] **Step 1: Make pipeline the default view and add the tab**

In `ui/public/index.html`, change the `<body>` open tag:

```html
<body data-view="pipeline">
```

Replace the `<nav class="tabs" ...>` block with (pipeline first + selected):

```html
  <nav class="tabs" role="tablist">
    <button class="tab" data-tab="pipeline" role="tab" aria-selected="true">pipeline</button>
    <button class="tab" data-tab="log" role="tab" aria-selected="false">live log</button>
    <button class="tab" data-tab="agents" role="tab" aria-selected="false">agents</button>
  </nav>
```

- [ ] **Step 2: Add the pipeline panel**

In `ui/public/index.html`, inside `<main>`, add this as the FIRST child (before `<pre id="log" ...>`):

```html
  <section id="pipeline" data-panel="pipeline" aria-live="polite">
    <svg id="pipeline-graph" viewBox="0 0 1120 560"
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label="agent pipeline flow"></svg>
    <p id="pipeline-status" class="dim">loading…</p>
  </section>
```

- [ ] **Step 3: Verify it serves**

Run: `node bin/cli.js ui --target . --port 7470 & sleep 1; curl -s localhost:7470/ | grep -c 'data-tab="pipeline"'; curl -s localhost:7470/ | grep -c 'id="pipeline-graph"'; kill %1`
Expected: each `grep -c` prints `1`.

- [ ] **Step 4: Commit**

```bash
git add ui/public/index.html
git commit -m "feat(ui): pipeline tab + panel, default to pipeline view"
```

---

## Task 5: CSS — 3-panel toggling + graph styles

**Files:**
- Modify: `ui/public/style.css`

- [ ] **Step 1: Replace the view-toggling rules**

In `ui/public/style.css`, replace this block:

```css
/* ─── view toggling ──────────────────────────────────────────────────── */
body[data-view="agents"] .log-only { display: none; }
body[data-view="log"]    [data-panel="agents"] { display: none; }
body[data-view="agents"] [data-panel="log"]    { display: none; }
```

with (generalized for three panels — each inactive panel hidden, active one keeps its natural display):

```css
/* ─── view toggling (3 panels) ───────────────────────────────────────── */
body[data-view="log"]      #pipeline,
body[data-view="log"]      #agents,
body[data-view="agents"]   #pipeline,
body[data-view="agents"]   #log,
body[data-view="pipeline"] #log,
body[data-view="pipeline"] #agents { display: none; }

body:not([data-view="log"]) .log-only { display: none; }
```

- [ ] **Step 2: Add the graph styles**

Append to `ui/public/style.css`:

```css
/* ─── pipeline graph ─────────────────────────────────────────────────── */
#pipeline {
  flex: 1; min-height: 0; overflow: auto;
  padding: 16px 16px 32px;
  display: flex; flex-direction: column; gap: 8px;
}
#pipeline-graph { width: 100%; height: auto; max-height: 78vh; display: block; }
#pipeline-status { margin: 0; }

/* edges */
.pl-edge { fill: none; stroke: var(--line); stroke-width: 1.5; }
.pl-edge.kind-spine   { stroke: var(--dim); stroke-width: 2; }
.pl-edge.kind-loop    { stroke: var(--warn); stroke-dasharray: 4 3; opacity: 0.7; }
.pl-edge.kind-reentry { stroke: var(--accent); stroke-dasharray: 4 3; opacity: 0.7; }
.pl-edge.kind-exit    { stroke: var(--ok); opacity: 0.7; }
.pl-edge.kind-park    { stroke: var(--dim); stroke-dasharray: 2 3; opacity: 0.6; }
.pl-edge.kind-regen   { stroke: var(--dim); stroke-dasharray: 1 5; opacity: 0.35; }
.pl-edge.kind-feed    { stroke: var(--dim); stroke-dasharray: 1 4; opacity: 0.3; }
.pl-edge.flash        { stroke: var(--text); opacity: 1; transition: stroke 0.1s, opacity 0.1s; }

/* nodes */
.pl-node-box {
  fill: var(--panel); stroke: var(--line); stroke-width: 1;
}
.pl-node.kind-human  .pl-node-box { fill: #1c2230; stroke: var(--accent); }
.pl-node.kind-exit   .pl-node-box { stroke: rgba(158,206,106,0.4); }
.pl-node.kind-park   .pl-node-box { stroke-dasharray: 3 3; }
.pl-node.kind-entry  .pl-node-box { stroke: var(--dim); stroke-dasharray: 3 3; }
.pl-node.kind-feeder .pl-node-box { fill: transparent; stroke: var(--dim); stroke-dasharray: 2 3; opacity: 0.7; }
.pl-node.kind-meta   .pl-node-box { fill: #1a1f2b; stroke: var(--accent); }
.pl-node-label { fill: var(--text); font-size: 13px; font-weight: 600; text-anchor: middle; }
.pl-node-agent { fill: var(--dim);  font-size: 10px; text-anchor: middle; }
.pl-node-count {
  fill: var(--bg); font-size: 11px; font-weight: 700; text-anchor: middle;
}
.pl-node-countbg { fill: var(--accent); }
.pl-node.empty .pl-node-countbg { display: none; }
.pl-node.empty .pl-node-count { display: none; }
.pl-node.running .pl-node-box {
  stroke: var(--ok); stroke-width: 2; animation: pulse 2s ease-in-out infinite;
}
.pl-node.flash .pl-node-box { stroke: var(--text); stroke-width: 2; }

/* tokens */
.pl-token { fill: var(--accent); stroke: var(--bg); stroke-width: 0.5; }

@media (prefers-reduced-motion: reduce) {
  .pl-node.running .pl-node-box { animation: none; }
}
```

- [ ] **Step 3: Visual check (manual)**

Run: `node bin/cli.js ui --target . --port 7471 --open`
Expected: dashboard opens on the **pipeline** tab; the panel is present (empty SVG so far — graph drawing comes next). Click `live log` / `agents` — they still work and `pipeline` hides. Stop the server (Ctrl-C) when done.

- [ ] **Step 4: Commit**

```bash
git add ui/public/style.css
git commit -m "feat(ui): pipeline graph styles + 3-panel view toggling"
```

---

## Task 6: Render the static graph (nodes, edges, counts, running pulse)

**Files:**
- Create: `ui/public/pipeline.js`
- Modify: `ui/public/app.js`

- [ ] **Step 1: Create `pipeline.js` with the static renderer**

Create `ui/public/pipeline.js`:

```js
// Pipeline graph view. Builds an SVG from the pure topology module, shows live
// per-node counts and running-agent pulses, and (Task 7) animates ticket tokens.
// Browser-only; the pure logic lives in pipeline-graph.js.

import {
  NODES, EDGES, VIEW, pathFor,
  seedModel, applyEvent, countsOf, hasTicket, pathEdgesForMove,
} from './pipeline-graph.js';

const SVGNS = 'http://www.w3.org/2000/svg';

let built = false;
let svg = null;
let statusEl = null;
const edgeEls = new Map();   // edge id → <path>
const nodeEls = new Map();   // node id → { g, countText, countBg }
let model = { idState: new Map() };

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function buildGraph() {
  svg = document.getElementById('pipeline-graph');
  statusEl = document.getElementById('pipeline-status');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${VIEW.w} ${VIEW.h}`);

  const edgeLayer = el('g', { class: 'pl-edges' });
  const tokenLayer = el('g', { class: 'pl-tokens', id: 'pl-tokens' });
  const nodeLayer = el('g', { class: 'pl-nodes' });

  for (const edge of EDGES) {
    const p = el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge), 'data-edge': edge.id });
    edgeEls.set(edge.id, p);
    edgeLayer.append(p);
  }

  for (const [id, n] of Object.entries(NODES)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label;
    g.append(label);
    if (n.agent) {
      const ag = el('text', { class: 'pl-node-agent', y: 13 });
      ag.textContent = n.agent;
      g.append(ag);
    }
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    nodeEls.set(id, { g, countText, countBg });
    nodeLayer.append(g);

    const title = el('title');
    title.textContent = n.agent ? `${n.label} — ${n.agent}` : n.label;
    g.append(title);
  }

  svg.append(edgeLayer, tokenLayer, nodeLayer);
  return true;
}

function renderCounts() {
  const counts = countsOf(model);
  for (const [id, n] of Object.entries(NODES)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}

function renderRunning(snapshot) {
  const runningAgents = new Set(
    (snapshot.agents || [])
      .filter(a => (a.activity?.runs || []).length)
      .map(a => a.name),
  );
  for (const [id, n] of Object.entries(NODES)) {
    nodeEls.get(id).g.classList.toggle('running', !!n.agent && runningAgents.has(n.agent));
  }
}

function applySnapshot(snapshot) {
  model = seedModel(snapshot);
  renderCounts();
  renderRunning(snapshot);
  if (statusEl) {
    const total = Object.values(countsOf(model)).reduce((a, b) => a + b, 0);
    statusEl.textContent = `${total} ticket${total === 1 ? '' : 's'} in flight`;
  }
}

let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/v1/events');
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'snapshot') return applySnapshot(data.data);
    handleEvent(data);
  };
  es.onerror = () => { es.close(); es = null; setTimeout(connect, 3000); };
}

// Task 7 replaces this with token animation; for now just keep counts current.
function handleEvent(ev) {
  if (ev.type === 'ticket.move' || ev.type === 'ticket.upsert' || ev.type === 'ticket.remove') {
    model = applyEvent(model, ev);
    renderCounts();
  }
}

export function initPipeline() {
  if (built) return;
  if (!buildGraph()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(applySnapshot).catch(() => {
    if (statusEl) { statusEl.textContent = 'failed to load pipeline'; statusEl.className = 'agents-empty'; }
  });
  connect();
}
```

- [ ] **Step 2: Wire it into `app.js`**

In `ui/public/app.js`, add as the very first line:

```js
import { initPipeline } from './pipeline.js';
```

In `app.js`, update `selectTab` to init the pipeline when its tab is shown:

```js
function selectTab(view) {
  document.body.dataset.view = view;
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === view));
  if (view === 'agents') renderAgents();
  if (view === 'pipeline') initPipeline();
}
```

In `app.js`, at the very end of the file (after `connectEvents();`), add:

```js
// Default view is pipeline (set in index.html); initialize it on load.
selectTab(document.body.dataset.view || 'pipeline');
```

- [ ] **Step 3: Visual check (manual) — static graph renders with live counts**

Run: `node bin/cli.js ui --target . --port 7472 --open`
Expected: the pipeline tab shows the node-and-edge graph; nodes with tickets show a count badge; if an agent is running, its node pulses green. `pipeline-status` shows "N tickets in flight". (Use the seeded fixture in Task 8 if your `.pipeline/queue` is empty.) Stop the server when done.

- [ ] **Step 4: Commit**

```bash
git add ui/public/pipeline.js ui/public/app.js
git commit -m "feat(ui): render static pipeline graph with live counts + running pulse"
```

---

## Task 7: Animate ticket tokens along edges

**Files:**
- Modify: `ui/public/pipeline.js`

- [ ] **Step 1: Add the token animator**

In `ui/public/pipeline.js`, add these module-level constants near the top (after `const SVGNS = ...`):

```js
const EDGE_MS = 750;                       // time a token spends per edge
const PALETTE = ['#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#ff9e64', '#73daca', '#c0caf5'];
const agentColors = new Map();
function colorForAgent(agent) {
  if (!agent) return PALETTE[0];
  if (!agentColors.has(agent)) agentColors.set(agent, PALETTE[agentColors.size % PALETTE.length]);
  return agentColors.get(agent);
}
const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const tokens = [];
let raf = null;
let lastTs = 0;
```

In `pipeline.js`, add the animation functions (place above `handleEvent`):

```js
function tick(ts) {
  const dt = lastTs ? ts - lastTs : 16;
  lastTs = ts;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tk = tokens[i];
    tk.t += dt / EDGE_MS;
    const clamped = Math.min(tk.t, 1);
    const pt = tk.pathEl.getPointAtLength(clamped * tk.len);
    tk.el.setAttribute('cx', pt.x);
    tk.el.setAttribute('cy', pt.y);
    if (tk.t >= 1) {
      tk.el.remove();
      tokens.splice(i, 1);
      tk.onDone && tk.onDone();
    }
  }
  raf = tokens.length ? requestAnimationFrame(tick) : ((lastTs = 0), null);
}

function spawnToken(edgeId, color, onDone) {
  const pathEl = edgeEls.get(edgeId);
  if (!pathEl) { onDone && onDone(); return; }
  const len = pathEl.getTotalLength();
  const dot = el('circle', { class: 'pl-token', r: 5, cx: 0, cy: 0 });
  if (color) dot.style.fill = color;
  document.getElementById('pl-tokens').append(dot);
  tokens.push({ el: dot, pathEl, len, t: 0, onDone });
  if (!raf) raf = requestAnimationFrame(tick);
}

// Animate an ordered list of edges as one continuous token (chains hops).
function animatePath(edgeIds, color) {
  if (!edgeIds.length) return;
  const run = i => { if (i < edgeIds.length) spawnToken(edgeIds[i], color, () => run(i + 1)); };
  run(0);
}

function flashEdge(edgeId) {
  const p = edgeEls.get(edgeId);
  if (!p) return;
  p.classList.add('flash');
  setTimeout(() => p.classList.remove('flash'), 220);
}

function flashNode(id) {
  const els = nodeEls.get(id);
  if (!els) return;
  els.g.classList.add('flash');
  setTimeout(() => els.g.classList.remove('flash'), 260);
}

function colorForTicket(ticket) {
  return colorForAgent(ticket?.source?.agent);
}
```

- [ ] **Step 2: Replace `handleEvent` with the animating version**

In `ui/public/pipeline.js`, replace the entire `handleEvent` function with:

```js
function handleEvent(ev) {
  if (ev.type === 'ticket.move') {
    const edges = pathEdgesForMove(ev.from, ev.to);
    const color = colorForTicket(ev.ticket);
    if (REDUCED || !edges.length) {
      flashNode(ev.to);
    } else {
      animatePath(edges, color);
      flashEdge(edges[edges.length - 1]);
    }
    // Post-merge re-scan: when work lands in done, hint the regen edge.
    if (ev.to === 'done') flashEdge('rescan:regen');
    model = applyEvent(model, ev);
    renderCounts();
    return;
  }
  if (ev.type === 'ticket.upsert') {
    const isNew = !hasTicket(model, ev.ticket?.id ?? ev.id);
    model = applyEvent(model, ev);
    renderCounts();
    if (isNew && ev.state === 'needs-triage' && !REDUCED) {
      animatePath(['spine:triage'], colorForTicket(ev.ticket));
    } else if (isNew) {
      flashNode(ev.state);
    }
    return;
  }
  if (ev.type === 'ticket.remove') {
    model = applyEvent(model, ev);
    renderCounts();
    flashNode(ev.state);
  }
}
```

- [ ] **Step 3: Run the unit tests (regression — no pure code changed, but confirm nothing broke)**

Run: `npm run test:ui`
Expected: PASS — unchanged green.

- [ ] **Step 4: Visual check (manual) — tokens animate on moves**

Run (seed a queue, start the UI, then drive a move):

```bash
node bin/cli.js ui --target . --port 7473 --open &
sleep 1
mkdir -p .pipeline/queue/needs-work .pipeline/queue/in-progress
printf '{"id":"DEMO-1","title":"demo","source":{"agent":"worker"}}' > .pipeline/queue/needs-work/DEMO-1.json
sleep 2
# move it — a token should glide needs-work → in-progress and the count update
mv .pipeline/queue/needs-work/DEMO-1.json .pipeline/queue/in-progress/DEMO-1.json
sleep 3
```

Expected: on creation a token enters at `scan`/lands in `needs-work` (count→1); on the `mv`, a token glides along the `needs-work → in-progress` edge and the counts swap. Then stop the server (`kill %1`) and clean up: `rm -f .pipeline/queue/in-progress/DEMO-1.json`.

- [ ] **Step 5: Commit**

```bash
git add ui/public/pipeline.js
git commit -m "feat(ui): animate ticket tokens along pipeline edges (moves, entry, exit, reduced-motion)"
```

---

## Task 8: Docs + full verification

**Files:**
- Modify: `README.md`
- Modify: `test/ui/pipeline-graph.test.js` (only if a gap surfaced)

- [ ] **Step 1: Document the tab**

In `README.md`, find the dashboard / `ui` section (search for `agent-pipeline ui`) and add one line describing the new default tab. Example addition under the dashboard description:

```markdown
The dashboard opens on the **pipeline** tab — an animated graph of the whole
work lifecycle (queue states as nodes, transitions as edges, tickets as tokens
that flow along edges as they move, including exits to the human and re-entries).
The **live log** and **agents** tabs remain one click away.
```

- [ ] **Step 2: Full unit-test run**

Run: `npm run test:ui`
Expected: PASS — every test green, `fail 0`.

- [ ] **Step 3: CLI smoke (existing tests still pass)**

Run: `npm test`
Expected: prints `cli smoke ok`.

- [ ] **Step 4: End-to-end visual pass against the fixture**

Run:

```bash
node bin/cli.js ui --target test/fixtures/full-pipeline --port 7474 --open
```

Expected: pipeline tab renders the full graph; any fixture tickets show counts at their nodes. Confirm the three tabs switch cleanly and pipeline is the default on load. Stop the server when done.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the pipeline dashboard tab"
```

---

## Self-Review Notes (spec coverage)

- **Default pipeline tab** → Task 4 (HTML default) + Task 6 (init on load).
- **Spine + satellites + obsolete node** → Task 1 (`NODES`).
- **Orchestrator banner + detectors/utility feeders** → Task 1 (`NODES` chrome + `feed:*` edges), Task 5 (`kind-meta`/`kind-feeder`/`kind-feed` styles); orchestrator pulses via the existing running logic.
- **All four edge bundles + reserved obsolete** → Task 1 (`EDGES`) + Task 1 tests.
- **Animated tokens (incl. exits/re-entries, multi-hop merge)** → Task 7.
- **Live counts + running pulse** → Task 6.
- **Zero backend changes** → only `ui/`, `test/ui/`, `package.json`, `README.md` touched.
- **No new deps** → vanilla SVG/JS; tests via `node:test`.
- **`edgeForMove`/reducer/`pathFor` testable seams** → Tasks 1–3.
- **Reduced-motion** → Task 5 (CSS) + Task 7 (`REDUCED` branch).
```
