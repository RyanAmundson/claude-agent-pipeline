# Dashboard self-improvement + feature-pipeline view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the self-improvement meta-loop and `conflict-resolver` on the dashboard's flow graph, and add a "features" tab over the same snapshot/SSE data, reusing the existing pure-topology + static-render pattern.

**Architecture:** Pure topology modules (`*-graph.js`, no DOM, unit-tested) define nodes/edges; controllers do the DOM. The working spine renderer in `pipeline.js` is left intact; a new shared static renderer (`graph-render.js`) draws the meta-band and the feature graph. Features are surfaced as ordinary tickets through a new `FEATURE_STATES` enumeration in `readSnapshot`.

**Tech Stack:** Vanilla ES modules, SVG, SSE. Node `node --test` for unit/ui tests, bash for e2e. No new runtime dependencies.

## Global Constraints

- **No new runtime dependencies.** Dependency-free vanilla JS + SVG + SSE only.
- **No new API endpoint and no new SSE event type.** Reuse `/api/v1/snapshot` and `/api/v1/events`.
- **Do not modify the bug-fix `STATES` list** in `api/index.js`, and **do not change any existing spine node's `x`/`y`** in `pipeline-graph.js`. New nodes occupy new coordinates only.
- **`ui/public/*.js` is browser code** — no Node built-ins (`fs`, `path`, etc.) there. Pure topology modules must import only other `ui/public/*.js`.
- **Pure topology lives in `*-graph.js`; DOM lives in controllers** (existing pattern: `pipeline-graph.js` is pure, `pipeline.js` does DOM).
- **Tests are claude-free**: `node --test` (unit/ui) and bash (e2e). Match the existing `node:test` + `assert/strict` style.
- **Styling reuses `:root` tokens and `.kind-*` classes**; add at most one new edge class (`.kind-feedback`).
- **Features are tracked as tickets** via `FEATURE_STATES`; the features tab shows an **empty state** until feature tickets exist.
- **Lands on local `main`** at finish, after verifying local `main` is clean and fast-forwardable.

---

### Task 1: `FEATURE_STATES` snapshot enabler (`api/index.js`)

Surface feature-pipeline states through the existing `readSnapshot` → `tickets.byState` path so the features tab consumes the same data as the pipeline tab. Empty until the backend writes feature tickets.

**Files:**
- Modify: `api/index.js` (add `FEATURE_STATES` export near `STATES` ~line 31; extend `readSnapshot` ~lines 127–167)
- Test: `test/unit/feature-states.test.js` (create)

**Interfaces:**
- Consumes: existing `readTicketsInState(target, state)` (handles missing dirs → `[]`), `STATES`, `queueDir()`.
- Produces: `export const FEATURE_STATES` (frozen array); `readSnapshot()` return gains `featureStates: FEATURE_STATES` and `tickets.byState` keys for every feature state.

- [ ] **Step 1: Write the failing test**

Create `test/unit/feature-states.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATES, FEATURE_STATES, readSnapshot } from '../../api/index.js';

test('FEATURE_STATES is frozen and disjoint from the bug-fix STATES', () => {
  assert.ok(Object.isFrozen(FEATURE_STATES), 'FEATURE_STATES must be frozen');
  assert.ok(FEATURE_STATES.length > 0);
  for (const s of FEATURE_STATES) {
    assert.match(s, /^feature:/, `feature state ${s} must be feature:-prefixed`);
    assert.ok(!STATES.includes(s), `feature state ${s} must not be in bug-fix STATES`);
  }
});

test('FEATURE_STATES covers the lifecycle + side states', () => {
  for (const s of [
    'feature:needs-spec', 'feature:needs-design', 'feature:needs-decomposition',
    'feature:building', 'feature:needs-integration', 'feature:needs-acceptance',
    'feature:ready-for-human', 'feature:blocked', 'feature:needs-feedback',
  ]) assert.ok(FEATURE_STATES.includes(s), `missing ${s}`);
});

test('readSnapshot surfaces feature states (empty) without touching bug-fix byState', () => {
  const target = mkdtempSync(join(tmpdir(), 'ap-fs-'));
  mkdirSync(join(target, '.pipeline', 'queue'), { recursive: true });
  const snap = readSnapshot({ target });
  assert.deepEqual(snap.featureStates, FEATURE_STATES);
  for (const s of FEATURE_STATES) {
    assert.deepEqual(snap.tickets.byState[s], [], `${s} should be present and empty`);
  }
  // bug-fix states still present and empty — unchanged behavior
  assert.deepEqual(snap.tickets.byState['needs-triage'], []);
  assert.deepEqual(snap.states, STATES);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/feature-states.test.js`
Expected: FAIL — `FEATURE_STATES` is `undefined` (not exported).

- [ ] **Step 3: Add the `FEATURE_STATES` export**

In `api/index.js`, immediately after the `STATES` declaration (after line 47), add:

```js
// Feature-pipeline states (parallel to STATES). Tracked as ordinary tickets in
// the same queue layout (queueDir/<state>/), surfaced through readSnapshot so the
// dashboard's features tab consumes the same data. Empty until the feature
// pipeline backend (spec-only today) writes tickets here.
export const FEATURE_STATES = Object.freeze([
  'feature:needs-spec',
  'feature:needs-design',
  'feature:needs-decomposition',
  'feature:building',
  'feature:needs-integration',
  'feature:needs-acceptance',
  'feature:ready-for-human',
  'feature:blocked',
  'feature:needs-feedback',
]);
```

- [ ] **Step 4: Enumerate feature states in `readSnapshot`**

In `readSnapshot`, the loop that builds `ticketsByState` (lines 129–133) currently iterates `STATES`. Right after that loop, add a second loop for feature states that **mirrors the existing `STATES` loop's body exactly** (copy whatever the adjacent loop does to populate `ticketsByState[state]` and `ticketsById`, substituting `FEATURE_STATES`). The expected form, matching the current loop:

```js
  for (const state of FEATURE_STATES) {
    const list = readTicketsInState(target, state);
    ticketsByState[state] = list.map(({ _state, ...t }) => t);
    for (const t of list) ticketsById[t.id] = t;
  }
```

Then in the returned object (after `states: STATES,` on line 167) add:

```js
    featureStates: FEATURE_STATES,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/feature-states.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm nothing else regressed**

Run: `npm run test:unit`
Expected: all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add api/index.js test/unit/feature-states.test.js
git commit -m "feat(api): surface FEATURE_STATES through readSnapshot"
```

---

### Task 2: `conflict-resolver` spine node + grow canvas (`pipeline-graph.js`)

Add the `needs-conflict-resolution` detour (data already flows — it is in `STATES`) and grow `VIEW.h` to make room for the meta-band beneath the spine. No existing node coordinates change.

> **Scope note:** the spec marks the `needs-detector-gate` node as optional ("may be deferred without affecting the rest"). It is **intentionally deferred** here — adding it inline on the spine would shift existing node coordinates, which Global Constraints forbid. This task adds only `needs-conflict-resolution` (a detour with new coordinates).

**Files:**
- Modify: `ui/public/pipeline-graph.js` (`VIEW` line 5; `NODES` add entry; `EDGES` add 3 edges; `STAGES` add entry)
- Test: `test/ui/pipeline-graph.test.js` (append assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: `NODES['needs-conflict-resolution']`; edges `conflict:detour`, `conflict:resolved`, `dispatch:needs-conflict-resolution`; `VIEW.h === 720`; `agentHomeNodes()['conflict-resolver'] === 'needs-conflict-resolution'`.

- [ ] **Step 1: Write the failing test**

Append to `test/ui/pipeline-graph.test.js`:

```js
// ─── conflict-resolver detour ───────────────────────────────────────────────
test('needs-conflict-resolution node exists with conflict-resolver as its agent', () => {
  const n = NODES['needs-conflict-resolution'];
  assert.ok(n, 'needs-conflict-resolution node missing');
  assert.equal(n.agent, 'conflict-resolver');
  assert.equal(n.state, 'needs-conflict-resolution');
});

test('the conflict detour and return are wired both ways', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'needs-conflict-resolution'), ['conflict:detour']);
  assert.deepEqual(pathEdgesForMove('needs-conflict-resolution', 'ready-for-human'), ['conflict:resolved']);
});

test('conflict-resolver has a home node and a dispatch edge', () => {
  assert.equal(agentHomeNodes()['conflict-resolver'], 'needs-conflict-resolution');
  const d = EDGES.find(e => e.id === 'dispatch:needs-conflict-resolution');
  assert.ok(d, 'dispatch edge missing');
  assert.equal(d.from, 'orchestrator');
  assert.equal(d.to, 'needs-conflict-resolution');
});

test('VIEW grew tall enough for the self-improvement band', () => {
  assert.ok(VIEW.h >= 720, `VIEW.h is ${VIEW.h}, expected >= 720`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/pipeline-graph.test.js`
Expected: FAIL — `needs-conflict-resolution node missing`.

- [ ] **Step 3: Grow the canvas**

Change line 5:

```js
export const VIEW = { w: 1260, h: 720 };
```

- [ ] **Step 4: Add the node**

In `NODES`, after the `obsolete` entry (line 28), add (note: bottom row, no existing coordinate changes):

```js
  'needs-conflict-resolution': { label: 'conflict', agent: 'conflict-resolver', x: 1010, y: 410, kind: 'state', state: 'needs-conflict-resolution' },
```

- [ ] **Step 5: Add the edges**

In `EDGES`, after the obsolete edges (line 65), add:

```js
  // conflict-resolution detour: a conflicted PR leaves ready-for-human until clean
  { id: 'conflict:detour',   from: 'ready-for-human',           to: 'needs-conflict-resolution', kind: 'loop',     bend: 30 },
  { id: 'conflict:resolved', from: 'needs-conflict-resolution', to: 'ready-for-human',           kind: 'reentry',  bend: -30 },
```

And in the dispatch block (after line 80, the `dispatch:done` entry), add:

```js
  { id: 'dispatch:needs-conflict-resolution', from: 'orchestrator', to: 'needs-conflict-resolution', kind: 'dispatch', bend: 55 },
```

- [ ] **Step 6: Register the stage**

In `STAGES` (after the `needs-feedback` entry, line 274), add:

```js
  { node: 'needs-conflict-resolution', queue: 'needs-conflict-resolution' },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/ui/pipeline-graph.test.js`
Expected: PASS — including the existing "every edge references defined nodes", "every stage has an orchestrator dispatch edge", and the 4 new tests.

- [ ] **Step 8: Commit**

```bash
git add ui/public/pipeline-graph.js test/ui/pipeline-graph.test.js
git commit -m "feat(ui): add conflict-resolver detour node + grow graph canvas"
```

---

### Task 3: Self-improvement meta-band topology (`metaloop-graph.js`)

A self-contained pure topology module for the self-improvement loop. Reuses `pathFor` from `pipeline-graph.js`. The connector into the spine's `needs-triage` is drawn at render time (Task 5), not here, so this module stays self-referential and testable.

> **Design note:** the spec named a `renderMetaBand(svg, originY)` helper living in this module. That helper would touch the DOM, which conflicts with the binding constraint "pure topology lives in `*-graph.js`; DOM lives in controllers." Its responsibility is therefore fulfilled by the shared `buildStaticGraph` in `graph-render.js` (Task 5) applied to `META_NODES`/`META_EDGES` — keeping this module DOM-free. `BAND_ORIGIN_Y` replaces the `originY` argument (the band's coordinates are baked into `META_NODES`).

**Files:**
- Create: `ui/public/metaloop-graph.js`
- Test: `test/ui/metaloop-graph.test.js` (create)

**Interfaces:**
- Consumes: `pathFor` from `./pipeline-graph.js`.
- Produces: `META_NODES`, `META_EDGES`, `BAND_ORIGIN_Y` (number). Node ids: `corpus`, `transcript-reviewer`, `pipeline-evaluator`, `findings`, `agent-improver`, `agent-architect`, `improvement-pr`. One edge has `kind: 'feedback'`.

- [ ] **Step 1: Write the failing test**

Create `test/ui/metaloop-graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { META_NODES, META_EDGES, BAND_ORIGIN_Y } from '../../ui/public/metaloop-graph.js';
import { pathFor } from '../../ui/public/pipeline-graph.js';

test('every meta edge references a defined meta node', () => {
  for (const e of META_EDGES) {
    assert.ok(META_NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(META_NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('the four self-improvement agents and the corpus/findings/pr nodes exist', () => {
  for (const id of ['corpus', 'transcript-reviewer', 'pipeline-evaluator',
    'findings', 'agent-improver', 'agent-architect', 'improvement-pr']) {
    assert.ok(META_NODES[id], `meta node ${id} missing`);
  }
});

test('the loop closes with a feedback edge from the PR back to the corpus', () => {
  const fb = META_EDGES.find(e => e.kind === 'feedback');
  assert.ok(fb, 'no feedback edge');
  assert.equal(fb.from, 'improvement-pr');
  assert.equal(fb.to, 'corpus');
});

test('the band sits below the spine and pathFor renders a meta edge', () => {
  assert.ok(BAND_ORIGIN_Y >= 560, 'band must sit below the 560px spine region');
  const d = pathFor(META_EDGES.find(e => e.id === 'meta:tr-findings'), META_NODES);
  assert.equal(typeof d, 'string');
  assert.ok(d.startsWith('M') && d.length > 5, `expected an SVG path, got ${d}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/metaloop-graph.test.js`
Expected: FAIL — cannot find module `metaloop-graph.js`.

- [ ] **Step 3: Create the module**

Create `ui/public/metaloop-graph.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui/metaloop-graph.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/public/metaloop-graph.js test/ui/metaloop-graph.test.js
git commit -m "feat(ui): self-improvement meta-band topology module"
```

---

### Task 4: Feature-flow topology + drill-in model (`feature-graph.js`)

Pure topology for the `feature:*` flow plus the model helpers the features controller uses: per-state counts and the `building` drill-in (children grouped by `epic`). `childrenByEpic` is consumed by the click-to-drill-in panel wired in Task 6.

**Files:**
- Create: `ui/public/feature-graph.js`
- Test: `test/ui/feature-graph.test.js` (create)

**Interfaces:**
- Consumes: nothing (uses its own nodes; `pathFor` reused from `pipeline-graph.js` by the controller).
- Produces: `FEATURE_NODES`, `FEATURE_EDGES`, `FEATURE_VIEW`; `featureCountsOf(snapshot)` → `{ 'feature:*': n }`; `childrenByEpic(snapshot)` → `{ epicId: [{ id, state }] }`; `isEmptyCounts(counts)` → boolean. Node ids are the feature state strings from `FEATURE_STATES`.

- [ ] **Step 1: Write the failing test**

Create `test/ui/feature-graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_NODES, FEATURE_EDGES, FEATURE_VIEW,
  featureCountsOf, childrenByEpic, isEmptyCounts,
} from '../../ui/public/feature-graph.js';

test('every feature edge references a defined feature node', () => {
  for (const e of FEATURE_EDGES) {
    assert.ok(FEATURE_NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(FEATURE_NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('the feature lifecycle nodes exist and FEATURE_VIEW is positive', () => {
  for (const id of ['feature:needs-spec', 'feature:building', 'feature:ready-for-human']) {
    assert.ok(FEATURE_NODES[id], `node ${id} missing`);
  }
  assert.ok(FEATURE_VIEW.w > 0 && FEATURE_VIEW.h > 0);
});

test('featureCountsOf counts tickets per feature state, zero-filled', () => {
  const snap = { tickets: { byState: {
    'feature:building': [{ id: 'EPIC-1' }, { id: 'EPIC-2' }],
    'feature:needs-spec': [{ id: 'EPIC-3' }],
  } } };
  const counts = featureCountsOf(snap);
  assert.equal(counts['feature:building'], 2);
  assert.equal(counts['feature:needs-spec'], 1);
  assert.equal(counts['feature:ready-for-human'], 0);
});

test('childrenByEpic groups tickets carrying an epic field by their epic', () => {
  const snap = { tickets: { byState: {
    'needs-work': [{ id: 'T1', epic: 'EPIC-1' }, { id: 'T2', epic: 'EPIC-1' }],
    'needs-code-review': [{ id: 'T3', epic: 'EPIC-2' }, { id: 'T4' }],
  } } };
  const byEpic = childrenByEpic(snap);
  assert.equal(byEpic['EPIC-1'].length, 2);
  assert.deepEqual(byEpic['EPIC-1'].map(c => c.state).sort(), ['needs-work', 'needs-work']);
  assert.equal(byEpic['EPIC-2'][0].id, 'T3');
  assert.equal('undefined' in byEpic, false); // T4 (no epic) is not grouped
});

test('isEmptyCounts is true only when every state is zero', () => {
  assert.equal(isEmptyCounts({ 'feature:building': 0, 'feature:needs-spec': 0 }), true);
  assert.equal(isEmptyCounts({ 'feature:building': 1 }), false);
  assert.equal(isEmptyCounts({}), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/feature-graph.test.js`
Expected: FAIL — cannot find module `feature-graph.js`.

- [ ] **Step 3: Create the module**

Create `ui/public/feature-graph.js`:

```js
// Pure topology + model for the feature-pipeline ("features" tab). Features are
// ordinary tickets in feature:* states (see api FEATURE_STATES); this renders
// their flow with the same machinery as the bug-fix spine. No DOM.
//
// h is 720 (not 560) so the shared self-improvement band — whose nodes live at
// y ≈ 600-690 (metaloop-graph BAND_ORIGIN_Y) — fits within the same viewBox
// when rendered beneath the feature flow on this tab.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui/feature-graph.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/public/feature-graph.js test/ui/feature-graph.test.js
git commit -m "feat(ui): feature-flow topology + drill-in model"
```

---

### Task 5: Shared static renderer + meta-band on the pipeline tab (`graph-render.js`, `pipeline.js`, `style.css`)

Extract a small reusable static SVG renderer used by the meta-band (this task) and the features tab (Task 6). Render the meta-band into the existing `#pipeline-graph` SVG beneath the spine, with a connector up to `needs-triage`. The working spine renderer is **not** refactored — the band is appended after it.

> DOM rendering is not unit-tested in this repo (no jsdom). This task's automated check is a module-import smoke test (catches syntax/export errors) plus the existing pure tests; visual correctness is verified manually with the running server.

**Files:**
- Create: `ui/public/graph-render.js`
- Modify: `ui/public/pipeline.js` (import + call after `buildGraph`)
- Modify: `ui/public/style.css` (add `.kind-feedback` edge style)
- Test: `test/ui/graph-render.test.js` (create — export smoke)

**Interfaces:**
- Consumes: `pathFor` from `./pipeline-graph.js`; `META_NODES`, `META_EDGES` from `./metaloop-graph.js`.
- Produces: `graph-render.js` exports `buildStaticGraph(svg, { nodes, edges, counts })` → `{ nodeEls: Map, edgeEls: Map }`, and `renderStaticCounts(nodeEls, nodes, counts)`. `pipeline.js` exports unchanged (`initPipeline`).

- [ ] **Step 1: Write the failing test**

Create `test/ui/graph-render.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gr from '../../ui/public/graph-render.js';

test('graph-render exports the static builder and count renderer', () => {
  assert.equal(typeof gr.buildStaticGraph, 'function');
  assert.equal(typeof gr.renderStaticCounts, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/graph-render.test.js`
Expected: FAIL — cannot find module `graph-render.js`.

- [ ] **Step 3: Create the shared renderer**

Create `ui/public/graph-render.js`:

```js
// Minimal static SVG renderer shared by the self-improvement band and the
// features tab. Draws edges + nodes from a pure topology into a target <svg>
// (or sub-<g>), with optional per-state count badges. No animation, no live
// model — controllers re-call renderStaticCounts() on each snapshot.

import { pathFor } from './pipeline-graph.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Append an edge layer + node layer for `nodes`/`edges` to `svg`. Returns maps
 * of the created elements so a controller can update counts later.
 * @param {SVGElement} svg
 * @param {{nodes:object, edges:object[], counts?:object}} opts
 */
export function buildStaticGraph(svg, { nodes, edges, counts = {} }) {
  const edgeEls = new Map();
  const nodeEls = new Map();
  const edgeLayer = el('g', { class: 'pl-edges' });
  const nodeLayer = el('g', { class: 'pl-nodes' });

  for (const edge of edges) {
    const p = el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge, nodes), 'data-edge': edge.id });
    edgeEls.set(edge.id, p);
    edgeLayer.append(p);
  }
  for (const [id, n] of Object.entries(nodes)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    const title = el('title');
    title.textContent = n.agent ? `${n.label} — ${n.agent}` : n.label;
    g.append(title);
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label;
    g.append(label);
    if (n.agent) {
      const ag = el('text', { class: 'pl-node-agent', y: 13 });
      ag.textContent = n.agent;
      g.append(ag);
    }
    let countText = null;
    if (n.state) {
      g.append(el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 }));
      countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
      g.append(countText);
    }
    nodeEls.set(id, { g, countText });
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  renderStaticCounts(nodeEls, nodes, counts);
  return { nodeEls, edgeEls };
}

/** Update count badges + the `empty` class for state-bearing nodes. */
export function renderStaticCounts(nodeEls, nodes, counts = {}) {
  for (const [id, n] of Object.entries(nodes)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    if (!els || !els.countText) continue;
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}
```

- [ ] **Step 4: Render the meta-band in `pipeline.js`**

In `ui/public/pipeline.js`, add to the imports (after line 12):

```js
import { buildStaticGraph } from './graph-render.js';
import { META_NODES, META_EDGES } from './metaloop-graph.js';
```

Then in `buildGraph()`, just before `return true;` (line 112), append the band + a connector from `findings` up to the spine's `needs-triage`:

```js
  // Self-improvement band: appended into the same SVG beneath the spine.
  buildStaticGraph(svg, { nodes: META_NODES, edges: META_EDGES });
  // Connector spanning both graphs: findings flow up into the spine's triage.
  // Use a dedicated layer so it can't collide with the spine's own edge layer.
  const combined = { ...NODES, ...META_NODES };
  const connectorLayer = el('g', { class: 'pl-connectors' });
  connectorLayer.append(el('path', {
    class: 'pl-edge kind-feed',
    d: pathFor({ from: 'findings', to: 'needs-triage', bend: 80 }, combined),
    'data-edge': 'meta:into-triage',
  }));
  svg.append(connectorLayer);
```

`el`, `pathFor`, and `NODES` are already in scope in `pipeline.js` (used by the spine renderer). `pathFor` needs only `from`/`to`/`bend`, so the connector's bare edge object is sufficient.

- [ ] **Step 5: Add the feedback edge style**

In `ui/public/style.css`, find the edge `.kind-*` block (e.g. near `.kind-dispatch`) and add:

```css
.pl-edge.kind-feedback { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 2 5; opacity: 0.6; fill: none; }
```

- [ ] **Step 6: Run the smoke test + the full ui suite**

Run: `node --test test/ui/graph-render.test.js && npm run test:ui`
Expected: PASS (graph-render smoke + all pipeline-graph/metaloop/feature tests).

- [ ] **Step 7: Manual visual verification**

Run the dashboard against this repo as the target and load the pipeline tab:

```bash
node bin/cli.js ui --target . --port 4410 &
# open http://localhost:4410 — the pipeline tab shows the spine,
# the conflict detour node, and the self-improvement band beneath it
# with a dashed feedback arc. Then:
kill %1
```

Expected: spine renders unchanged; band visible below it; no console errors.

- [ ] **Step 8: Commit**

```bash
git add ui/public/graph-render.js ui/public/pipeline.js ui/public/style.css test/ui/graph-render.test.js
git commit -m "feat(ui): render self-improvement band on the pipeline tab"
```

---

### Task 6: Features tab wiring + shared band + empty state (`index.html`, `app.js`, `features.js`)

Add the `features` tab: a controller renders the feature flow (counts from `byState['feature:*']`) and the shared meta-band, with an empty state until feature tickets exist, refreshing on the same SSE stream.

> Same testing note as Task 5: automated check is a module-import smoke + a server snapshot check; visual correctness is manual.

**Files:**
- Modify: `ui/public/index.html` (nav button + `<section id="features">` with drill-in panel)
- Modify: `ui/public/app.js` (import + `selectTab` branch)
- Modify: `ui/public/style.css` (drill-in panel + chip styles)
- Create: `ui/public/features.js`
- Test: `test/ui/features.test.js` (create — export smoke)

**Interfaces:**
- Consumes: `FEATURE_NODES`, `FEATURE_EDGES`, `FEATURE_VIEW`, `featureCountsOf`, `childrenByEpic`, `isEmptyCounts` from `./feature-graph.js`; `META_NODES`, `META_EDGES` from `./metaloop-graph.js`; `buildStaticGraph`, `renderStaticCounts` from `./graph-render.js`.
- Produces: `features.js` exports `initFeatures()`.

- [ ] **Step 1: Write the failing test**

Create `test/ui/features.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../ui/public/features.js';

test('features module exports initFeatures', () => {
  assert.equal(typeof f.initFeatures, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/features.test.js`
Expected: FAIL — cannot find module `features.js`.

- [ ] **Step 3: Add the tab + panel to `index.html`**

In the `<nav>` (after line 15, the agents tab), add:

```html
    <button class="tab" data-tab="features" role="tab" aria-selected="false">features</button>
```

In `<main>` (after the agents `<section>`, line 40), add:

```html
  <section id="features" data-panel="features" aria-live="polite">
    <svg id="feature-graph" viewBox="0 0 1260 720"
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label="feature pipeline flow"></svg>
    <p id="feature-empty" class="dim" hidden>No features in flight yet — feature tickets will appear here as epics enter the pipeline.</p>
    <div id="feature-drill" class="feature-drill" hidden></div>
    <p id="feature-status" class="dim" aria-live="polite">loading…</p>
  </section>
```

The `building` node is clickable: clicking it toggles `#feature-drill`, which lists the building epics' child tickets (grouped by `epic`) as state-colored chips.

- [ ] **Step 4: Create the features controller**

Create `ui/public/features.js`:

```js
// Features tab controller. Renders the feature:* flow + the shared
// self-improvement band into #feature-graph, fed by the same /api/v1 snapshot
// and SSE stream as the pipeline tab. Features are ordinary tickets, so counts
// come straight from snapshot.tickets.byState. Empty state until any exist.

import {
  FEATURE_NODES, FEATURE_EDGES, FEATURE_VIEW,
  featureCountsOf, childrenByEpic, isEmptyCounts,
} from './feature-graph.js';
import { META_NODES, META_EDGES } from './metaloop-graph.js';
import { buildStaticGraph, renderStaticCounts } from './graph-render.js';

let built = false;
let svg = null;
let emptyEl = null;
let statusEl = null;
let featureNodeEls = null;
let lastSnapshot = null;
let es = null;

function build() {
  svg = document.getElementById('feature-graph');
  emptyEl = document.getElementById('feature-empty');
  statusEl = document.getElementById('feature-status');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${FEATURE_VIEW.w} ${FEATURE_VIEW.h}`);
  const flow = buildStaticGraph(svg, { nodes: FEATURE_NODES, edges: FEATURE_EDGES });
  featureNodeEls = flow.nodeEls;
  // Shared self-improvement band beneath the feature flow.
  buildStaticGraph(svg, { nodes: META_NODES, edges: META_EDGES });
  // Building drill-in: clicking the building node toggles its child-ticket panel.
  const building = featureNodeEls.get('feature:building');
  if (building) {
    building.g.style.cursor = 'pointer';
    building.g.addEventListener('click', toggleDrill);
  }
  return true;
}

// Render the building epics' child tickets (grouped by epic) as state-colored chips.
function toggleDrill() {
  const drill = document.getElementById('feature-drill');
  if (!drill) return;
  if (!drill.hidden) { drill.hidden = true; return; }
  drill.textContent = '';
  const byEpic = childrenByEpic(lastSnapshot || {});
  const epics = Object.keys(byEpic);
  if (!epics.length) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = 'No child tickets linked to a building epic yet.';
    drill.append(p);
  } else {
    for (const epic of epics) {
      const row = document.createElement('div');
      row.className = 'feature-epic';
      const id = document.createElement('span');
      id.className = 'feature-epic-id';
      id.textContent = epic;
      row.append(id);
      for (const c of byEpic[epic]) {
        const chip = document.createElement('span');
        chip.className = `feature-child-chip kind-${c.state}`;
        chip.textContent = `${c.id} · ${c.state}`;
        row.append(chip);
      }
      drill.append(row);
    }
  }
  drill.hidden = false;
}

function apply(snapshot) {
  lastSnapshot = snapshot;
  const counts = featureCountsOf(snapshot);
  renderStaticCounts(featureNodeEls, FEATURE_NODES, counts);
  const empty = isEmptyCounts(counts);
  if (emptyEl) emptyEl.hidden = !empty;
  if (statusEl) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    statusEl.textContent = empty ? '' : `${total} feature ticket${total === 1 ? '' : 's'} in flight`;
  }
}

function connect() {
  if (es) es.close();
  es = new EventSource('/api/v1/events');
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'snapshot') apply(data.data);
    else if (data.type === 'ticket.move' || data.type === 'ticket.upsert' || data.type === 'ticket.remove') {
      // feature counts are cheap to refetch; keep it simple and authoritative
      fetch('/api/v1/snapshot').then(r => r.json()).then(apply).catch(() => {});
    }
  };
  es.onerror = () => { es.close(); es = null; setTimeout(connect, 3000); };
}

export function initFeatures() {
  if (built) return;
  if (!build()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(apply).catch(() => {
    if (statusEl) statusEl.textContent = 'failed to load features';
  });
  connect();
}
```

- [ ] **Step 5: Wire the tab in `app.js`**

Add to the imports (after line 1):

```js
import { initFeatures } from './features.js';
```

In `selectTab` (lines 515–520), add a branch alongside the others:

```js
  if (view === 'features') initFeatures();
```

- [ ] **Step 6: Add drill-in panel styles**

In `ui/public/style.css`, add (reusing existing tokens):

```css
.feature-drill { margin: 0.5rem 0; padding: 0.5rem; border: 1px solid var(--border); border-radius: 6px; }
.feature-epic { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0.25rem 0; }
.feature-epic-id { font-weight: 600; margin-right: 0.35rem; }
.feature-child-chip { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); }
```

If a referenced token (`--border`, `--surface`) is not defined in `:root`, substitute the nearest existing token used elsewhere in `style.css`.

- [ ] **Step 7: Run the smoke test + full ui suite**

Run: `node --test test/ui/features.test.js && npm run test:ui`
Expected: PASS.

- [ ] **Step 8: Manual + server verification**

```bash
node bin/cli.js ui --target . --port 4410 &
sleep 1
# Task 1 end-to-end: snapshot exposes featureStates + empty feature byState keys
curl -s http://localhost:4410/api/v1/snapshot | node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log('featureStates:',Array.isArray(s.featureStates)&&s.featureStates.length);console.log('feature:building present:',Array.isArray(s.tickets.byState['feature:building']))"
# open http://localhost:4410 — click the "features" tab: the feature flow renders
# with the empty-state line and the shared self-improvement band beneath it.
kill %1
```

Expected: `featureStates: 9` (truthy), `feature:building present: true`; the features tab shows the empty state + band with no console errors. Click the building node → the drill-in panel toggles ("No child tickets linked…" while empty).

- [ ] **Step 9: Commit**

```bash
git add ui/public/index.html ui/public/app.js ui/public/style.css ui/public/features.js test/ui/features.test.js
git commit -m "feat(ui): features tab with shared self-improvement band + empty state"
```

---

## Final verification (run after all tasks)

- [ ] `npm run test:unit && npm run test:ui` — all green.
- [ ] `npm run test:e2e` — unaffected suites still green (13 passed / 0 failed pattern).
- [ ] Manual: pipeline tab shows spine + conflict detour + meta-band; features tab shows feature flow + empty state + meta-band.

## Landing (finishing-a-development-branch)

Lands on local `main`. Before merging, verify local `main` is clean and fast-forwardable (a prior local merge was unsafe due to divergence / a dirty shared checkout). If it is not, surface that rather than clobbering, and fall back to push + PR under the `RyanAmundson` account (then restore `ryan-amundson`).
