# New-Feature Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel "feature" pipeline to CAP that turns a rough human intent into an autonomously-built feature (spec → design → decompose → fan-out child tickets on a feature integration branch → integrate → accept → single human gate), with a dashboard tab that matches the existing pipeline visual.

**Architecture:** A new *epic layer* (`feature:*` states) sits above the existing, unchanged *ticket layer*. Five new agents drive the epic front (spec/design/decompose) and back (integrate/accept); the existing build/review agents handle child tickets unchanged. Child tickets auto-merge into a per-feature integration branch as they pass automated review; the assembled feature gets one human review. Epics are stored exactly like tickets (`<id>.json` in state subdirectories) but under `.pipeline/epics/` instead of `.pipeline/queue/`, so the existing atomic queue helpers (`queue-claim.sh`, `queue-update.sh`, `queue-comment.sh` — all accept `--queue-dir`) work on them verbatim.

**Tech Stack:** Node.js ≥ 18, zero runtime dependencies. ES modules. `node:test` + `node:assert/strict` for tests. Vanilla-JS / SVG / SSE dashboard. Bash queue helpers. Agent definitions are markdown (YAML frontmatter + `**Key**: value` body headers).

## Global Constraints

- **Zero runtime dependencies.** Node stdlib only — no npm packages in `api/`, `ui/`, or `bin/`. (Matches the whole repo.)
- **Backend-agnostic, but implement the filesystem backend.** Epic states map to `.pipeline/epics/<state>/` subdirs (filesystem) or `feature:*` labels (Linear/GitHub). This plan implements and tests the filesystem backend; Linear/GitHub mapping is documented in the agent prose only.
- **Additive only.** No change to existing bug-fix pipeline behavior. Tickets without an `epic` field must behave exactly as today.
- **Label/state namespace is `feature`** (parallel to the existing `pipeline` namespace).
- **Epic id format:** `EPIC-<NNN>`, zero-padded to 3 digits, incrementing (`EPIC-001`, `EPIC-002`, …).
- **Agent file format:** YAML frontmatter with `name`, `description`, `model`, `color`, and `pipeline: { stage, consumes, produces, label }`; body opens with `**Role**:`, `**Input**:`, `**Output**:`, `**Provenance**:`, `**Scope**:` bold-key headers (these are parsed by `api/index.js` `parseAgentMarkdown` for the dashboard). Every new agent must be registered in `manifest.json`.
- **Tests must pass before each commit:** `npm test` (CLI smoke), `npm run test:unit`, `npm run test:ui`.
- **No `Date.now()` concerns** — this is normal Node code (the Workflow-script restriction does not apply here); timestamps use `new Date().toISOString()`.

---

## File Structure

**New files:**
- `api/epics.js` — epic store: `EPIC_STATES`, `epicsDir`, `readEpics`, `getEpic`, `nextEpicId`, `indexEpics`, `diffEpicIndexes`. Mirror of the ticket-reading helpers in `api/index.js`. One responsibility: read/index epics from the filesystem.
- `agents/FEATURE-PIPELINE.md` — the feature pipeline's state machine + dispatch rules doc (mirror of `agents/PIPELINE.md`).
- `agents/feature-spec-writer.md`, `agents/feature-architect.md`, `agents/feature-decomposer.md`, `agents/feature-integrator.md`, `agents/feature-acceptance-validator.md` — the 5 new agents.
- `commands/feature.md` — the `/feature` Claude Code command.
- `ui/public/feature-pipeline-graph.js` — pure epic topology + reducers (no DOM). Mirror of `pipeline-graph.js`.
- `ui/public/feature-pipeline.js` — epic graph controller + child drill-in (browser). Mirror of `pipeline.js`.
- `test/unit/epics.test.js` — unit tests for `api/epics.js`.
- `test/unit/feature-cli.test.js` — unit test for the `agent-pipeline feature` command.
- `test/ui/feature-pipeline-graph.test.js` — unit tests for the pure epic topology module.

**Modified files:**
- `api/index.js` — `readSnapshot` includes an `epics` block; `createWatcher` watches `.pipeline/epics/<state>` and emits `epic.*` events.
- `bin/cli.js` — add the `feature` command (create an epic) + HELP entry.
- `manifest.json` — register the 5 new agents under a new `feature` stage.
- `ui/public/index.html` — add the `features` tab + panel.
- `ui/public/app.js` — wire `features` into `selectTab`.
- `ui/public/style.css` — `features` view toggling + child-chip styles.
- `queue/README.md` — document the child fields (`epic`, `depends_on`) and the `.pipeline/epics/` store.
- `agents/orchestrator.md` — add a "Feature pipeline" dispatch section pointing at `FEATURE-PIPELINE.md`.

---

# Phase 1 — Epic substrate

Produces: a readable epic store, the `agent-pipeline feature` entry command, and epics surfaced in the snapshot. Independently testable and shippable (epics can be created and listed; no agents act on them yet).

### Task 1: `api/epics.js` — epic store + states

**Files:**
- Create: `api/epics.js`
- Test: `test/unit/epics.test.js`

**Interfaces:**
- Consumes: nothing (leaf module). Uses `node:fs`, `node:path`.
- Produces:
  - `EPIC_STATES: readonly string[]` — `['needs-spec','needs-design','needs-decomposition','building','needs-integration','needs-acceptance','ready-for-human','blocked','needs-feedback','done']`
  - `epicsDir(target: string): string` → `<target>/.pipeline/epics`
  - `readEpics(opts: {target}): { byState: Record<string, Epic[]>, count: number }`
  - `getEpic(opts: {target}, id: string): Epic | null` (Epic gains a `state` field)
  - `nextEpicId(target: string): string` → `EPIC-<NNN>`
  - `indexEpics(target): Map<id, {state, mtimeMs, hash, epic}>`
  - `diffEpicIndexes(prev, next): Array<{type:'epic.upsert'|'epic.move'|'epic.remove', ...}>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/epics.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EPIC_STATES, epicsDir, readEpics, getEpic, nextEpicId,
  indexEpics, diffEpicIndexes,
} from '../../api/epics.js';

function tmpTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-epics-'));
  return dir;
}
function writeEpic(target, state, epic) {
  const dir = join(epicsDir(target), state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${epic.id}.json`), JSON.stringify(epic));
}

test('EPIC_STATES is the ordered feature state machine', () => {
  assert.equal(EPIC_STATES[0], 'needs-spec');
  assert.ok(EPIC_STATES.includes('building'));
  assert.ok(EPIC_STATES.includes('ready-for-human'));
  assert.ok(Object.isFrozen(EPIC_STATES));
});

test('readEpics groups epics by state and counts them', () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  writeEpic(target, 'building', { id: 'EPIC-002', title: 'b' });
  const { byState, count } = readEpics({ target });
  assert.equal(count, 2);
  assert.equal(byState['needs-spec'][0].id, 'EPIC-001');
  assert.equal(byState['building'][0].id, 'EPIC-002');
  assert.deepEqual(byState['done'], []);
  rmSync(target, { recursive: true, force: true });
});

test('getEpic finds an epic across states and tags its state', () => {
  const target = tmpTarget();
  writeEpic(target, 'building', { id: 'EPIC-007', title: 'x' });
  const e = getEpic({ target }, 'EPIC-007');
  assert.equal(e.id, 'EPIC-007');
  assert.equal(e.state, 'building');
  assert.equal(getEpic({ target }, 'EPIC-404'), null);
  rmSync(target, { recursive: true, force: true });
});

test('nextEpicId increments past the highest existing id, zero-padded', () => {
  const target = tmpTarget();
  assert.equal(nextEpicId(target), 'EPIC-001');
  writeEpic(target, 'needs-spec', { id: 'EPIC-001' });
  writeEpic(target, 'done', { id: 'EPIC-005' });
  assert.equal(nextEpicId(target), 'EPIC-006');
  rmSync(target, { recursive: true, force: true });
});

test('diffEpicIndexes detects upsert, move, and remove', () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  const a = indexEpics(target);
  // move EPIC-001 to needs-design by re-writing under a new state dir + removing old
  rmSync(join(epicsDir(target), 'needs-spec', 'EPIC-001.json'));
  writeEpic(target, 'needs-design', { id: 'EPIC-001', title: 'a' });
  const b = indexEpics(target);
  const evs = diffEpicIndexes(a, b);
  assert.equal(evs[0].type, 'epic.move');
  assert.equal(evs[0].from, 'needs-spec');
  assert.equal(evs[0].to, 'needs-design');
  rmSync(target, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/epics.test.js`
Expected: FAIL — `Cannot find module '../../api/epics.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `api/epics.js`:

```js
// claude-agent-pipeline — epic store (filesystem backend).
// Epics are the feature-pipeline's unit of work. Stored exactly like tickets
// (<id>.json in state subdirectories) but under .pipeline/epics/. Read-only here;
// mutations go through the same queue-*.sh helpers with --queue-dir .pipeline/epics.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Feature epic states, in pipeline order. `blocked` and `needs-feedback` are
// side-states; `done` is terminal (integration branch merged to main).
export const EPIC_STATES = Object.freeze([
  'needs-spec',
  'needs-design',
  'needs-decomposition',
  'building',
  'needs-integration',
  'needs-acceptance',
  'ready-for-human',
  'blocked',
  'needs-feedback',
  'done',
]);

export function epicsDir(target) {
  return join(resolve(target), '.pipeline', 'epics');
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readEpicsInState(target, state) {
  const dir = join(epicsDir(target), state);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const epic = readJsonSafe(join(dir, entry));
    if (!epic || typeof epic !== 'object') continue;
    if (!epic.id) epic.id = entry.replace(/\.json$/, '');
    out.push({ ...epic, _state: state });
  }
  return out;
}

export function readEpics(opts) {
  const target = resolve(opts.target);
  const byState = {};
  let count = 0;
  for (const state of EPIC_STATES) {
    const list = readEpicsInState(target, state);
    byState[state] = list.map(({ _state, ...e }) => e);
    count += list.length;
  }
  return { byState, count };
}

export function getEpic(opts, id) {
  const target = resolve(opts.target);
  for (const state of EPIC_STATES) {
    const path = join(epicsDir(target), state, `${id}.json`);
    if (existsSync(path)) {
      const e = readJsonSafe(path);
      if (e) return { ...e, id: e.id || id, state };
    }
  }
  return null;
}

export function nextEpicId(target) {
  let max = 0;
  for (const state of EPIC_STATES) {
    const dir = join(epicsDir(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^EPIC-(\d+)\.json$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `EPIC-${String(max + 1).padStart(3, '0')}`;
}

function cheapHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export function indexEpics(target) {
  const idx = new Map();
  for (const state of EPIC_STATES) {
    const dir = join(epicsDir(target), state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      const id = entry.replace(/\.json$/, '');
      const epic = readJsonSafe(path);
      const hash = epic ? cheapHash(JSON.stringify(epic)) : 0;
      idx.set(id, { state, mtimeMs: stat.mtimeMs, hash, epic });
    }
  }
  return idx;
}

export function diffEpicIndexes(prev, next) {
  const events = [];
  for (const [id, cur] of next) {
    const old = prev.get(id);
    if (!old) events.push({ type: 'epic.upsert', state: cur.state, epic: cur.epic });
    else if (old.state !== cur.state) events.push({ type: 'epic.move', id, from: old.state, to: cur.state, epic: cur.epic });
    else if (old.hash !== cur.hash || old.mtimeMs !== cur.mtimeMs) events.push({ type: 'epic.upsert', state: cur.state, epic: cur.epic });
  }
  for (const [id, old] of prev) {
    if (!next.has(id)) events.push({ type: 'epic.remove', id, state: old.state });
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/epics.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/epics.js test/unit/epics.test.js
git commit -m "feat(epics): add filesystem epic store (EPIC_STATES, readEpics, getEpic, nextEpicId)"
```

---

### Task 2: Surface epics in the snapshot

**Files:**
- Modify: `api/index.js` — import from `./epics.js`, add an `epics` block to `readSnapshot`'s return.
- Test: `test/unit/epics.test.js` (add one test).

**Interfaces:**
- Consumes: `readEpics`, `EPIC_STATES` from `api/epics.js`.
- Produces: `readSnapshot(opts)` return gains `epicStates: EPIC_STATES` and `epics: { byState, count }`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/epics.test.js`:

```js
import { readSnapshot } from '../../api/index.js';

test('readSnapshot includes an epics block', () => {
  const target = tmpTarget();
  writeEpic(target, 'building', { id: 'EPIC-001', title: 'darkmode' });
  const snap = readSnapshot({ target });
  assert.equal(snap.epics.count, 1);
  assert.equal(snap.epics.byState['building'][0].id, 'EPIC-001');
  assert.ok(Array.isArray(snap.epicStates));
  assert.equal(snap.epicStates[0], 'needs-spec');
  rmSync(target, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/epics.test.js`
Expected: FAIL — `snap.epics` is undefined (`Cannot read properties of undefined`).

- [ ] **Step 3: Write minimal implementation**

In `api/index.js`, add the import near the other api imports (after line 15):

```js
import { readEpics, EPIC_STATES } from './epics.js';
```

In `readSnapshot`, add an epics read after the tickets loop (after line 133, before `const liveRuns`):

```js
  const epics = readEpics({ target });
```

And add two fields to the returned object (inside the `return { ... }` near line 163), right after the `states: STATES,` line:

```js
    epicStates: EPIC_STATES,
    epics,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/epics.test.js && npm test`
Expected: PASS (epics tests) and `cli smoke ok`.

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/unit/epics.test.js
git commit -m "feat(epics): include epics in readSnapshot"
```

---

### Task 3: `agent-pipeline feature "<intent>"` entry command

**Files:**
- Modify: `bin/cli.js` — add `feature` to the dispatch switch, a `runFeature` handler, and a HELP line.
- Test: `test/unit/feature-cli.test.js`

**Interfaces:**
- Consumes: `nextEpicId`, `epicsDir` from `api/epics.js`; `resolveQueueDir`/`targetOf` already in cli.js.
- Produces: a new epic JSON file at `.pipeline/epics/needs-spec/<EPIC-NNN>.json` with shape:

```json
{ "id": "EPIC-001", "title": "<first line of intent>", "intent": "<full intent>",
  "spec": null, "design": null, "acceptance": [],
  "integration_branch": null, "children": [], "pr_url": null,
  "created_at": "<iso>", "updated_at": "<iso>" }
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/feature-cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.js');

test('feature command creates an epic in needs-spec', () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-feat-'));
  const out = execFileSync('node', [CLI, 'feature', 'Add dark mode toggle to settings', '--target', target], { encoding: 'utf8' });
  assert.match(out, /EPIC-001/);
  const path = join(target, '.pipeline', 'epics', 'needs-spec', 'EPIC-001.json');
  assert.ok(existsSync(path), 'epic file written');
  const epic = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(epic.id, 'EPIC-001');
  assert.equal(epic.intent, 'Add dark mode toggle to settings');
  assert.equal(epic.title, 'Add dark mode toggle to settings');
  assert.deepEqual(epic.children, []);
  rmSync(target, { recursive: true, force: true });
});

test('a second feature increments the id', () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-feat-'));
  execFileSync('node', [CLI, 'feature', 'first', '--target', target]);
  const out = execFileSync('node', [CLI, 'feature', 'second', '--target', target], { encoding: 'utf8' });
  assert.match(out, /EPIC-002/);
  rmSync(target, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/feature-cli.test.js`
Expected: FAIL — `Unknown command: feature` (cli exits non-zero, execFileSync throws).

- [ ] **Step 3: Write minimal implementation**

In `bin/cli.js`, add a HELP line after the `agent-pipeline run ...` block (around line 44, inside the `Usage:` section of the `HELP` template):

```
  agent-pipeline feature "<intent>" [--target <p>] [--json]
                                              Create a new feature epic (feature pipeline) from a rough intent
```

Add the dispatch case in the `switch (cmd)` block (after `case 'run': ...`, around line 351):

```js
  case 'feature': runFeature(positional, flags); break;
```

Add the handler near the other `runX` functions (e.g. after `runComment`, around line 398):

```js
async function runFeature(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline feature "<intent>" [--target <p>] [--json]`);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { nextEpicId, epicsDir } = await import('../api/epics.js');
  const target = targetOf(flags);
  const intent = positional[0].trim();
  if (!intent) die(`feature: intent must not be empty`);
  const id = nextEpicId(target);
  const now = new Date().toISOString();
  const epic = {
    id, title: intent.split('\n')[0].slice(0, 120), intent,
    spec: null, design: null, acceptance: [],
    integration_branch: null, children: [], pr_url: null,
    created_at: now, updated_at: now,
  };
  const dir = join(epicsDir(target), 'needs-spec');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(epic, null, 2));
  if (flags.json) { console.log(JSON.stringify(epic, null, 2)); return; }
  console.log(`Created ${id} in feature:needs-spec`);
  console.log(`  ${epic.title}`);
  console.log(`  The orchestrator will dispatch feature-spec-writer on its next cycle.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/feature-cli.test.js && npm test`
Expected: PASS (both feature-cli tests) and `cli smoke ok`.

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/unit/feature-cli.test.js
git commit -m "feat(cli): add 'agent-pipeline feature' to create a feature epic"
```

---

### Task 4: Document child fields + the epic store

**Files:**
- Modify: `queue/README.md`

**Interfaces:**
- Consumes: nothing. Documentation only; consumed by the agents in Phase 2/3.
- Produces: the contract that child tickets may carry `epic` and `depends_on`, and that epics live under `.pipeline/epics/` using the same helpers with `--queue-dir`.

- [ ] **Step 1: Add the documentation**

Append this section to `queue/README.md` (at the end of the file):

````markdown
## Feature epics (`.pipeline/epics/`)

The feature pipeline stores **epics** with the exact same layout as tickets —
`<id>.json` files in state subdirectories — but under `.pipeline/epics/` and
using the `feature:*` state set (`needs-spec`, `needs-design`,
`needs-decomposition`, `building`, `needs-integration`, `needs-acceptance`,
`ready-for-human`, `blocked`, `needs-feedback`, `done`). Because the layout is
identical, the same helpers operate on epics by passing `--queue-dir`:

```bash
queue/queue-claim.sh EPIC-001 needs-spec needs-design --queue-dir .pipeline/epics
queue/queue-update.sh needs-design EPIC-001 '.design = "..."' --queue-dir .pipeline/epics
```

Epic file shape:

```json
{
  "id": "EPIC-001",
  "title": "Dark mode",
  "intent": "rough one-liner from the human",
  "spec": "...",
  "design": "...",
  "acceptance": ["criterion 1", "criterion 2"],
  "integration_branch": "feature/EPIC-001",
  "children": ["TKT-001-1", "TKT-001-2"],
  "pr_url": null,
  "created_at": "2026-06-17T10:00:00Z",
  "updated_at": "2026-06-17T10:00:00Z"
}
```

### Child ticket fields

A feature's child tickets are ordinary tickets in `.pipeline/queue/` with two
optional fields and a non-default `base`:

- `epic` — the parent epic id (e.g. `"EPIC-001"`).
- `depends_on` — array of sibling child ids that must merge into the integration
  branch before this child may start.
- `base` — set to the epic's `integration_branch` (e.g. `"feature/EPIC-001"`)
  instead of `"main"`.

Tickets with no `epic` field behave exactly as today. Dependency gating is owned
by the orchestrator (see `agents/FEATURE-PIPELINE.md`): dependency-free children
start in `needs-work`; dependency-blocked children are parked in `needs-info` and
promoted to `needs-work` once their `depends_on` siblings reach `done`.
````

- [ ] **Step 2: Commit**

```bash
git add queue/README.md
git commit -m "docs(queue): document feature epics store and child ticket fields"
```

---

# Phase 2 — Front agents + orchestrator monitor

Produces: the three front agents and the orchestrator rules that drive an epic from intent through decomposition and fan-out, including child auto-merge. After this phase, a created epic is specced, designed, decomposed into child tickets on an integration branch, and its children build + auto-merge — stopping at `feature:needs-integration`.

> Agent prompts below give the **complete** frontmatter and the `**Role/Input/Output/Provenance/Scope**` header block verbatim (these drive the dashboard and must match exactly), plus the numbered body sections each agent must contain with their exact commands. Model the prose density and structure on `agents/conflict-resolver.md`. Where a section says "include the commands below," those commands are the literal content — do not paraphrase the transition commands.

### Task 5: `agents/FEATURE-PIPELINE.md` — the feature state machine doc

**Files:**
- Create: `agents/FEATURE-PIPELINE.md`

**Interfaces:**
- Consumes: nothing (doc). Referenced by every feature agent and by `orchestrator.md`.
- Produces: the authoritative description of the `feature:*` states, transitions, dispatch triggers, the integration-branch mechanism, dependency gating, and child auto-merge.

- [ ] **Step 1: Write the doc**

Create `agents/FEATURE-PIPELINE.md` containing, in order:

1. A title + one-paragraph overview: the feature pipeline is an epic-level state machine layered above the ticket pipeline; epics are autonomous until a single human gate.
2. A **states table** (mirror the `agents/PIPELINE.md` table format) with these rows — label, meaning, owned-by:

   | State Label | Meaning | Owned By |
   |---|---|---|
   | `feature:needs-spec` | Rough intent captured; needs elaboration into a spec | feature-spec-writer |
   | `feature:needs-design` | Spec ready; needs a technical design + integration branch | feature-architect |
   | `feature:needs-decomposition` | Design ready; needs breakdown into child tickets | feature-decomposer |
   | `feature:building` | Children created and flowing through the ticket pipeline; orchestrator monitors + auto-merges them | (orchestrator) |
   | `feature:needs-integration` | All children merged into the integration branch; needs reconcile + epic PR | feature-integrator |
   | `feature:needs-acceptance` | Epic PR open; needs feature-level acceptance validation | feature-acceptance-validator |
   | `feature:ready-for-human` | Assembled feature passes all checks; single human review | (terminal) |
   | `feature:blocked` | A child or stage is stuck and needs a human | (human) |
   | `feature:needs-feedback` | Human left comments on the epic PR; route back to the relevant stage | (orchestrator) |
   | `feature:done` | Integration branch merged to main | (cleanup) |

3. An **Integration branch** section stating: the architect creates `feature/<EPIC-id>` off `main`; children set `base` to it and auto-merge into it on passing automated review (no per-child human gate); the epic PR is `feature/<EPIC-id>` → `main`.
4. A **Dependency gating** section: decomposer files dependency-free children into `.pipeline/queue/needs-work/` and dependency-blocked children into `.pipeline/queue/needs-info/` (each carrying `epic` + `depends_on` + `base`); the orchestrator promotes a parked child to `needs-work` once every id in its `depends_on` is in `done`.
5. A **Child auto-merge** section with the exact orchestrator procedure for a child whose `epic` is set that reaches `ready-for-human` (filesystem backend):

   ```bash
   EPIC_BRANCH=$(jq -r .integration_branch .pipeline/epics/building/<EPIC-id>.json)
   git fetch origin
   git checkout "$EPIC_BRANCH"
   git merge --no-ff "<child-branch>" -m "merge <child-id> into $EPIC_BRANCH"
   git push origin "$EPIC_BRANCH"
   queue/queue-claim.sh <child-id> ready-for-human done --queue-dir .pipeline/queue
   ```

   On a merge conflict, route the child to `needs-conflict-resolution` (existing conflict-resolver handles it against its `base`). When **every** child id in the epic's `children` is in `done`, advance the epic:

   ```bash
   queue/queue-claim.sh <EPIC-id> building needs-integration --queue-dir .pipeline/epics
   ```

6. A **Dispatch triggers** table (mirror `PIPELINE.md`'s "On-demand" table):

   | Agent | Dispatched when |
   |---|---|
   | feature-spec-writer | `feature:needs-spec` epics exist |
   | feature-architect | `feature:needs-design` epics exist |
   | feature-decomposer | `feature:needs-decomposition` epics exist |
   | feature-integrator | `feature:needs-integration` epics exist |
   | feature-acceptance-validator | `feature:needs-acceptance` epics exist |
   | (orchestrator rules) | `feature:building` epics exist → gate deps, auto-merge passing children, advance when all `done` |

7. A **Backends** section: filesystem uses `.pipeline/epics/<state>/` with the helpers + `--queue-dir`; Linear maps an epic to a project (or parent issue with sub-issues) with `feature:*` labels; GitHub uses `feature:*` labels on a tracking issue with children as PRs labeled with the epic id.

- [ ] **Step 2: Verify it renders as plain markdown (no build step)**

Run: `node -e "console.log(require('fs').readFileSync('agents/FEATURE-PIPELINE.md','utf8').length)"`
Expected: a positive byte count (sanity check the file exists and is non-empty).

- [ ] **Step 3: Commit**

```bash
git add agents/FEATURE-PIPELINE.md
git commit -m "docs(feature): add FEATURE-PIPELINE state machine + dispatch doc"
```

---

### Task 6: `feature-spec-writer` agent

**Files:**
- Create: `agents/feature-spec-writer.md`
- Modify: `manifest.json` (register the agent)

**Interfaces:**
- Consumes: an epic in `feature:needs-spec` (`intent` field set).
- Produces: the same epic in `feature:needs-design` with `spec` and `acceptance` populated.

- [ ] **Step 1: Write the agent file**

Create `agents/feature-spec-writer.md`. Frontmatter (verbatim):

```yaml
---
name: feature-spec-writer
description: >
  Turns a rough feature intent into a structured spec. Picks up epics labeled
  feature:needs-spec, explores the codebase and context to understand what the
  feature touches, and writes a spec (problem, goals, non-goals, acceptance
  criteria, UX notes) onto the epic, then advances it to feature:needs-design.
  The autonomous embodiment of the brainstorming step — no human gate.
model: sonnet
color: cyan
pipeline:
  stage: feature
  consumes: [feature-epic]
  produces: [feature-epic]
  label: "feature-spec-writer (rough intent → spec)"
---
```

Body — open with this header block (verbatim), then the numbered sections:

```markdown
**Role**: Turn a rough feature intent into a structured, buildable spec with explicit acceptance criteria.
**Input**: Epics in `feature:needs-spec` — `.pipeline/epics/needs-spec/<id>.json` (filesystem) or `feature:needs-spec`-labeled items (Linear/GitHub). The epic's `intent` is the rough one-liner from the human.
**Output**: The epic advanced to `feature:needs-design` with `spec` (markdown) and `acceptance` (string array) populated.
**Provenance**: `agent:feature-spec-writer`
**Scope**: `${REPO_SLUG}` only. One epic per cycle. Never writes code or creates branches — spec only.
```

Required sections (model density on conflict-resolver.md):
- **1. CYCLE OVERVIEW** — identify one `feature:needs-spec` epic → explore the codebase for affected areas → write spec + acceptance → advance.
- **2. IDENTIFY** — read epics with `agent-pipeline status --json` is not epic-aware; instead read `.pipeline/epics/needs-spec/*.json` directly (filesystem) and pick the oldest by `created_at`.
- **3. EXPLORE** — use read-only tools to map which modules/files the feature touches; do not edit anything.
- **4. WRITE THE SPEC** — produce a markdown spec (problem, goals, non-goals, acceptance criteria, UX notes) and a flat `acceptance` array of testable criteria. Persist them with the **canonical epic-field write recipe** below.

  > **Epic-field write recipe (referenced by Tasks 7, 8, 10).** `queue-update.sh` takes only `<state> <id> <jq-expr>` plus `--queue-dir`/`--by` — it has **no** `--arg`/`--rawfile`/`--argjson` passthrough (unknown flags are silently dropped; verified in `queue/queue-update.sh`), so it is usable only for jq expressions whose values are self-contained. For multi-line markdown (`spec`, `design`) and JSON arrays (`acceptance`, `children`), write each value to a temp file and do a `jq` read-modify-write with an atomic rename. Epics are single-writer in practice (one feature agent per epic per cycle under the single orchestrator loop), so a plain atomic rename is safe; wrap in `flock .pipeline/epics/.lock -c '…'` when `flock` is available (it is absent on macOS — see `queue/queue-update.sh`):
  >
  > ```bash
  > EPIC=.pipeline/epics/needs-spec/<id>.json
  > SPEC_F=$(mktemp); ACC_F=$(mktemp)
  > printf '%s' "<spec markdown>" > "$SPEC_F"
  > printf '%s' '<json array, e.g. ["criterion 1","criterion 2"]>' > "$ACC_F"
  > jq --rawfile spec "$SPEC_F" --slurpfile acc "$ACC_F" \
  >    '.spec = $spec | .acceptance = $acc[0] | .updated_at = (now | todateiso8601)' \
  >    "$EPIC" > "$EPIC.tmp" && mv "$EPIC.tmp" "$EPIC"
  > rm -f "$SPEC_F" "$ACC_F"
  > ```
  >
  > For a single scalar field with no shell-quoting hazard, `queue/queue-update.sh <state> <id> '<jq-expr>' --queue-dir .pipeline/epics` is fine (e.g. `'.integration_branch = "feature/EPIC-001" | .updated_at = (now|todateiso8601)'`).

- **5. ADVANCE** — `queue/queue-claim.sh <id> needs-spec needs-design --queue-dir .pipeline/epics`
- **6. IDLE BEHAVIOR** — if no `feature:needs-spec` epics, print `[agent:feature-spec-writer] No epics awaiting a spec. Idle.` and stop.
- **Rules** — never create branches or PRs; never touch `.pipeline/queue/` (that's the ticket layer); one epic per cycle.

- [ ] **Step 2: Register in manifest.json**

In `manifest.json`, add inside `"agents"` (place the five feature agents together, after `cleanup` is fine), each entry:

```json
    "feature-spec-writer": {
      "stage": "feature",
      "requires": []
    },
```

- [ ] **Step 3: Verify manifest validity + agent loads**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
npm test
node bin/cli.js agent feature-spec-writer --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);if(a.role&&a.stage==='feature')console.log('agent ok');else throw new Error('agent parse failed')})"
```
Expected: `manifest ok`, `cli smoke ok`, `agent ok`.

- [ ] **Step 4: Commit**

```bash
git add agents/feature-spec-writer.md manifest.json
git commit -m "feat(feature): add feature-spec-writer agent"
```

---

### Task 7: `feature-architect` agent

**Files:**
- Create: `agents/feature-architect.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: an epic in `feature:needs-design` (`spec` set).
- Produces: the epic in `feature:needs-decomposition` with `design` populated and `integration_branch` created + recorded.

- [ ] **Step 1: Write the agent file**

Create `agents/feature-architect.md`. Frontmatter as in Task 6 but:

```yaml
---
name: feature-architect
description: >
  Turns a feature spec into a technical design and creates the feature's
  integration branch. Picks up epics labeled feature:needs-design, produces a
  design (affected modules, approach, data flow, risks, test strategy), creates
  feature/<EPIC-id> off main, records it on the epic, and advances to
  feature:needs-decomposition.
model: sonnet
color: blue
pipeline:
  stage: feature
  consumes: [feature-epic]
  produces: [feature-epic]
  label: "feature-architect (spec → design + integration branch)"
---
```

Header block (verbatim):

```markdown
**Role**: Turn a feature spec into a technical design and stand up the feature's integration branch.
**Input**: Epics in `feature:needs-design` with a populated `spec`.
**Output**: The epic advanced to `feature:needs-decomposition` with `design` set and `integration_branch` created off `main` and recorded.
**Provenance**: `agent:feature-architect`
**Scope**: `${REPO_SLUG}` only. One epic per cycle. Creates exactly one branch (`feature/<EPIC-id>`); writes no feature code.
```

Required sections:
- **1. CYCLE OVERVIEW**.
- **2. IDENTIFY** — oldest epic in `.pipeline/epics/needs-design/`.
- **3. DESIGN** — read the `spec`, explore the code, produce a design covering affected modules, approach, data flow, risks, and test strategy.
- **4. CREATE THE INTEGRATION BRANCH** — exact commands:

  ```bash
  git fetch origin
  git checkout -b "feature/<EPIC-id>" origin/main
  git push -u origin "feature/<EPIC-id>"
  ```

- **5. RECORD** — set `design` (multi-line markdown → `--rawfile`) and `integration_branch` (scalar) on the epic using the **epic-field write recipe in Task 6 §4**. `integration_branch` alone may use `queue/queue-update.sh needs-design <id> '.integration_branch = "feature/<EPIC-id>" | .updated_at = (now|todateiso8601)' --queue-dir .pipeline/epics`.
- **6. ADVANCE** — `queue/queue-claim.sh <id> needs-design needs-decomposition --queue-dir .pipeline/epics`.
- **7. IDLE BEHAVIOR** — `[agent:feature-architect] No epics awaiting design. Idle.`
- **Rules** — branch off `origin/main` only; never write feature code (that's the children's job); one epic per cycle; if the branch already exists, reuse it (idempotent).

- [ ] **Step 2: Register in manifest.json**

```json
    "feature-architect": {
      "stage": "feature",
      "requires": ["github"]
    },
```

- [ ] **Step 3: Verify**

Run: `npm test && node bin/cli.js agent feature-architect --json | grep -q feature && echo agent-ok`
Expected: `cli smoke ok` and `agent-ok`.

- [ ] **Step 4: Commit**

```bash
git add agents/feature-architect.md manifest.json
git commit -m "feat(feature): add feature-architect agent"
```

---

### Task 8: `feature-decomposer` agent

**Files:**
- Create: `agents/feature-decomposer.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: an epic in `feature:needs-decomposition` (`design` + `integration_branch` set).
- Produces: child tickets filed into `.pipeline/queue/` (`needs-work` for dependency-free, `needs-info` for blocked), the epic's `children` array populated, the epic advanced to `feature:building`.

- [ ] **Step 1: Write the agent file**

Create `agents/feature-decomposer.md`. Frontmatter:

```yaml
---
name: feature-decomposer
description: >
  Breaks a feature design into ordered child tickets with dependencies. Picks up
  epics labeled feature:needs-decomposition, files child tickets into the ticket
  queue (base = the epic's integration branch, epic = the epic id, depends_on =
  prerequisite siblings), records the children on the epic, and advances it to
  feature:building.
model: sonnet
color: purple
pipeline:
  stage: feature
  consumes: [feature-epic]
  produces: [ticket]
  label: "feature-decomposer (design → child tickets)"
---
```

Header block (verbatim):

```markdown
**Role**: Break a feature design into ordered, dependency-aware child tickets the existing build pipeline can implement in parallel.
**Input**: Epics in `feature:needs-decomposition` with a populated `design` and `integration_branch`.
**Output**: Child tickets in `.pipeline/queue/` (each with `epic`, `base`, and optional `depends_on`), the epic's `children` recorded, and the epic advanced to `feature:building`.
**Provenance**: `agent:feature-decomposer`
**Scope**: `${REPO_SLUG}` only. One epic per cycle. Creates child tickets only — never writes code or branches.
```

Required sections:
- **1. CYCLE OVERVIEW**.
- **2. IDENTIFY** — oldest epic in `.pipeline/epics/needs-decomposition/`.
- **3. DECOMPOSE** — derive an ordered set of child tickets from the `design`. Each child id is `<EPIC-id>-<n>` (e.g. `EPIC-001-1`). Determine `depends_on` from the design's ordering.
- **4. FILE CHILDREN** — for each child, write a ticket JSON. Dependency-free children go to `.pipeline/queue/needs-work/`; children with unmet deps go to `.pipeline/queue/needs-info/`. Exact shape (note `base`, `epic`, `depends_on`):

  ```json
  {
    "id": "EPIC-001-1",
    "title": "...",
    "description": "...",
    "priority": 2,
    "labels": ["agent:feature-decomposer"],
    "epic": "EPIC-001",
    "depends_on": [],
    "base": "feature/EPIC-001",
    "branch": "feature/EPIC-001-1",
    "comments": [],
    "created_at": "<iso>",
    "updated_at": "<iso>"
  }
  ```

- **5. RECORD** — set the epic's `children` array to the filed child ids using the **epic-field write recipe in Task 6 §4** (a JSON array → `--slurpfile`, e.g. write `["EPIC-001-1","EPIC-001-2"]` to a temp file and apply `'.children = $arr[0] | .updated_at = (now|todateiso8601)'`).
- **6. ADVANCE** — `queue/queue-claim.sh <id> needs-decomposition building --queue-dir .pipeline/epics`.
- **7. IDLE BEHAVIOR** — `[agent:feature-decomposer] No epics awaiting decomposition. Idle.`
- **Rules** — every child must set `base` to the integration branch and `epic` to the epic id; never set `base` to `main`; dependency-blocked children start in `needs-info`; one epic per cycle.

- [ ] **Step 2: Register in manifest.json**

```json
    "feature-decomposer": {
      "stage": "feature",
      "requires": []
    },
```

- [ ] **Step 3: Verify**

Run: `npm test && node bin/cli.js agent feature-decomposer --json | grep -q feature && echo agent-ok`
Expected: `cli smoke ok` and `agent-ok`.

- [ ] **Step 4: Commit**

```bash
git add agents/feature-decomposer.md manifest.json
git commit -m "feat(feature): add feature-decomposer agent"
```

---

### Task 9: Orchestrator feature-pipeline dispatch rules

**Files:**
- Modify: `agents/orchestrator.md`

**Interfaces:**
- Consumes: `agents/FEATURE-PIPELINE.md` (Task 5).
- Produces: orchestrator behavior that dispatches the 5 feature agents on their states and runs the `building` monitor (dependency gating + child auto-merge + advance).

- [ ] **Step 1: Add the dispatch section**

Add a new top-level section to `agents/orchestrator.md` titled `## Feature pipeline (epics)`. It must instruct the orchestrator to, each cycle:

1. Read epics from `.pipeline/epics/<state>/` (filesystem) or `feature:*` labels.
2. Dispatch, when the corresponding state is non-empty: `feature-spec-writer` (needs-spec), `feature-architect` (needs-design), `feature-decomposer` (needs-decomposition), `feature-integrator` (needs-integration), `feature-acceptance-validator` (needs-acceptance).
3. For each epic in `feature:building`, run the **building monitor** exactly as specified in `agents/FEATURE-PIPELINE.md` §Dependency gating and §Child auto-merge:
   - Promote parked children (`needs-info`) to `needs-work` once every id in their `depends_on` is in `done`.
   - Auto-merge each child with an `epic` field that reaches `ready-for-human` into the epic's `integration_branch`, then move the child to `done`.
   - When all of an epic's `children` are in `done`, advance the epic `building → needs-integration`.
4. Reference: "See `agents/FEATURE-PIPELINE.md` for the full state machine and the exact merge/transition commands."

Include a one-line addition to the existing dispatch/cadence narrative so feature epics are scanned every cycle alongside tickets.

- [ ] **Step 2: Verify the doc still installs**

Run: `npm test`
Expected: `cli smoke ok` (orchestrator.md is prose; the smoke test confirms `list-agents` still parses everything).

- [ ] **Step 3: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(feature): orchestrator dispatches feature agents + runs the building monitor"
```

---

# Phase 3 — Back agents + epic PR + feedback

Produces: the two back agents that assemble, validate, and open the epic PR, plus the feedback loop. After this phase the full epic lifecycle runs end-to-end to `feature:ready-for-human`.

### Task 10: `feature-integrator` agent

**Files:**
- Create: `agents/feature-integrator.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: an epic in `feature:needs-integration` (all `children` in `done`, integration branch holds their merges).
- Produces: the epic in `feature:needs-acceptance` with `pr_url` set (PR `integration_branch` → `main`).

- [ ] **Step 1: Write the agent file**

Create `agents/feature-integrator.md`. Frontmatter:

```yaml
---
name: feature-integrator
description: >
  Assembles a feature once all its child tickets have merged into the integration
  branch. Picks up epics labeled feature:needs-integration, reconciles the branch
  with main, runs the full verify suite, opens the epic PR (integration branch →
  main), records it, and advances to feature:needs-acceptance.
model: sonnet
color: green
pipeline:
  stage: feature
  consumes: [feature-epic]
  produces: [feature-epic]
  label: "feature-integrator (assemble + open epic PR)"
---
```

Header block (verbatim):

```markdown
**Role**: Assemble a feature whose children have all landed on its integration branch, then open the single epic PR for human review.
**Input**: Epics in `feature:needs-integration` — every id in `children` is in `done`.
**Output**: The epic advanced to `feature:needs-acceptance` with `pr_url` set (PR: `integration_branch` → `main`).
**Provenance**: `agent:feature-integrator`
**Scope**: `${REPO_SLUG}` only. One epic per cycle. Opens exactly one PR per epic.
```

Required sections:
- **1. CYCLE OVERVIEW**.
- **2. IDENTIFY** — oldest epic in `.pipeline/epics/needs-integration/`.
- **3. RECONCILE** — bring `main` into the integration branch (merge, never rebase), resolving any conflicts with the existing tiered approach (cite conflict-resolver):

  ```bash
  git fetch origin
  git checkout "feature/<EPIC-id>"
  git merge origin/main
  ```

- **4. VERIFY** — run the repo's configured `verify` commands (from `.pipeline/config.json`); never run a long-lived test process beyond `verify`.
- **5. OPEN THE EPIC PR** — exact command:

  ```bash
  git push origin "feature/<EPIC-id>"
  gh pr create --base main --head "feature/<EPIC-id>" \
    --title "<EPIC title>" --body "<spec summary + child list + acceptance criteria>"
  ```

- **6. RECORD + ADVANCE** — set `pr_url` (scalar) on the epic — `queue/queue-update.sh needs-integration <id> '.pr_url = "<url>" | .updated_at = (now|todateiso8601)' --queue-dir .pipeline/epics` — then `queue/queue-claim.sh <id> needs-integration needs-acceptance --queue-dir .pipeline/epics`.
- **7. IDLE BEHAVIOR** — `[agent:feature-integrator] No epics awaiting integration. Idle.`
- **Rules** — merge, never rebase; never force-push; never run the full test suite (route acceptance to feature-acceptance-validator); one epic per cycle.

- [ ] **Step 2: Register in manifest.json**

```json
    "feature-integrator": {
      "stage": "feature",
      "requires": ["github"]
    },
```

- [ ] **Step 3: Verify**

Run: `npm test && node bin/cli.js agent feature-integrator --json | grep -q feature && echo agent-ok`
Expected: `cli smoke ok` and `agent-ok`.

- [ ] **Step 4: Commit**

```bash
git add agents/feature-integrator.md manifest.json
git commit -m "feat(feature): add feature-integrator agent"
```

---

### Task 11: `feature-acceptance-validator` agent

**Files:**
- Create: `agents/feature-acceptance-validator.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: an epic in `feature:needs-acceptance` (`pr_url` set, `acceptance` criteria present).
- Produces: the epic in `feature:ready-for-human` (pass) or `feature:needs-feedback` (fail).

- [ ] **Step 1: Write the agent file**

Create `agents/feature-acceptance-validator.md`. Frontmatter:

```yaml
---
name: feature-acceptance-validator
description: >
  Validates an assembled feature against its original spec's acceptance criteria.
  Picks up epics labeled feature:needs-acceptance, checks each acceptance criterion
  against the integration branch (screenshots / e2e where relevant), and advances to
  feature:ready-for-human on success or feature:needs-feedback with findings on
  failure.
model: sonnet
color: green
pipeline:
  stage: feature
  consumes: [feature-epic]
  produces: [feature-epic]
  label: "feature-acceptance-validator (validate feature vs spec)"
---
```

Header block (verbatim):

```markdown
**Role**: Validate the assembled feature against the original spec's acceptance criteria — the feature-scope counterpart to feature-validator.
**Input**: Epics in `feature:needs-acceptance` with `pr_url` set and `acceptance` criteria populated.
**Output**: The epic advanced to `feature:ready-for-human` (all criteria met) or `feature:needs-feedback` (with a comment listing unmet criteria).
**Provenance**: `agent:feature-acceptance-validator`
**Scope**: `${REPO_SLUG}` only. One epic per cycle. Read-and-verify only; never edits feature code.
```

Required sections:
- **1. CYCLE OVERVIEW**.
- **2. IDENTIFY** — oldest epic in `.pipeline/epics/needs-acceptance/`.
- **3. VALIDATE** — check out the integration branch, run/inspect against each `acceptance` criterion; capture evidence (screenshots / e2e output) where the criterion is observable.
- **4. RECORD** — append a verdict comment to the epic:

  ```bash
  queue/queue-comment.sh <id> --author feature-acceptance-validator --verdict pass|fail \
    --body "<per-criterion results>" --queue-dir .pipeline/epics
  ```

- **5. ROUTE** — pass: `queue/queue-claim.sh <id> needs-acceptance ready-for-human --queue-dir .pipeline/epics`; fail: `queue/queue-claim.sh <id> needs-acceptance needs-feedback --queue-dir .pipeline/epics`.
- **6. IDLE BEHAVIOR** — `[agent:feature-acceptance-validator] No epics awaiting acceptance. Idle.`
- **Rules** — never edit feature code (route failures to needs-feedback); validate against the spec's `acceptance`, not your own judgment; one epic per cycle.

- [ ] **Step 2: Register in manifest.json**

```json
    "feature-acceptance-validator": {
      "stage": "feature",
      "requires": ["github"],
      "optional": ["agent-browser", "playwright", "chrome-devtools"]
    },
```

- [ ] **Step 3: Verify all 5 feature agents are registered + load**

Run:
```bash
npm test
for a in feature-spec-writer feature-architect feature-decomposer feature-integrator feature-acceptance-validator; do
  node bin/cli.js agent "$a" --json | grep -q '"stage": "feature"' && echo "$a ok" || { echo "$a FAIL"; exit 1; }
done
node bin/cli.js list-agents | grep -A6 '  feature' | head -8
```
Expected: `cli smoke ok`, five `… ok` lines, and a `feature` stage group listing all five.

- [ ] **Step 4: Commit**

```bash
git add agents/feature-acceptance-validator.md manifest.json
git commit -m "feat(feature): add feature-acceptance-validator agent"
```

---

### Task 12: Epic feedback loop in FEATURE-PIPELINE doc

**Files:**
- Modify: `agents/FEATURE-PIPELINE.md`

**Interfaces:**
- Consumes: existing `feedback-responder` agent.
- Produces: documented routing for `feature:needs-feedback`.

- [ ] **Step 1: Add the feedback section**

Append a `## Feedback loop` section to `agents/FEATURE-PIPELINE.md` stating: when an epic is in `feature:needs-feedback` (from a failed acceptance check or human comments on the epic PR), the orchestrator dispatches `feedback-responder` against the epic PR. After the responder addresses comments and pushes, the orchestrator returns the epic to `feature:needs-acceptance` for re-validation:

```bash
queue/queue-claim.sh <EPIC-id> needs-feedback needs-acceptance --queue-dir .pipeline/epics
```

A human merging the epic PR moves it to `feature:done` (cleanup handles post-merge, as in the ticket pipeline).

- [ ] **Step 2: Commit**

```bash
git add agents/FEATURE-PIPELINE.md
git commit -m "docs(feature): document the epic feedback loop"
```

---

# Phase 4 — UI features tab

Produces: a `features` dashboard tab matching the existing pipeline visual — an epic flow graph plus a child drill-in — wired into the existing SPA and fed by the existing snapshot/SSE.

### Task 13: `ui/public/feature-pipeline-graph.js` — pure epic topology + reducers

**Files:**
- Create: `ui/public/feature-pipeline-graph.js`
- Test: `test/ui/feature-pipeline-graph.test.js`

**Interfaces:**
- Consumes: `pathFor` from `./pipeline-graph.js` (reuse — DRY).
- Produces:
  - `VIEW`, `NODES`, `EDGES`, `EPIC_STATES`
  - `pathEdgesForMove(from, to): string[]`
  - `seedEpicModel(snapshot): {idState: Map}` (from `snapshot.epics.byState`)
  - `applyEpicEvent(model, ev): model` (handles `epic.move|upsert|remove`)
  - `epicCountsOf(model): Record<state, number>`
  - `childProgress(snapshot, epicId): { byState: Record<string,number>, total: number, ready: number }`

- [ ] **Step 1: Write the failing test**

Create `test/ui/feature-pipeline-graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODES, EDGES, VIEW, EPIC_STATES, pathEdgesForMove,
  seedEpicModel, applyEpicEvent, epicCountsOf, childProgress,
} from '../../ui/public/feature-pipeline-graph.js';

test('every edge references a defined node', () => {
  for (const e of EDGES) {
    assert.ok(NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('VIEW has positive dimensions', () => {
  assert.ok(VIEW.w > 0 && VIEW.h > 0);
});

test('the front spine is wired spec→design→decompose→building', () => {
  assert.deepEqual(pathEdgesForMove('needs-spec', 'needs-design'), ['spine:design']);
  assert.deepEqual(pathEdgesForMove('needs-design', 'needs-decomposition'), ['spine:decompose']);
  assert.deepEqual(pathEdgesForMove('needs-decomposition', 'building'), ['spine:building']);
});

test('the back spine is wired building→integrate→accept→ready', () => {
  assert.deepEqual(pathEdgesForMove('building', 'needs-integration'), ['spine:integrate']);
  assert.deepEqual(pathEdgesForMove('needs-integration', 'needs-acceptance'), ['spine:accept']);
  assert.deepEqual(pathEdgesForMove('needs-acceptance', 'ready-for-human'), ['spine:ready']);
});

test('acceptance failure loops to needs-feedback and back', () => {
  assert.deepEqual(pathEdgesForMove('needs-acceptance', 'needs-feedback'), ['fail:accept']);
  assert.deepEqual(pathEdgesForMove('needs-feedback', 'needs-acceptance'), ['feedback:revalidate']);
});

test('an unmodeled move returns an empty path', () => {
  assert.deepEqual(pathEdgesForMove('done', 'building'), []);
});

const SNAP = {
  epics: { byState: {
    'needs-spec': [{ id: 'EPIC-002' }],
    'building': [{ id: 'EPIC-001', children: ['EPIC-001-1', 'EPIC-001-2', 'EPIC-001-3'] }],
  } },
  tickets: { byState: {
    'needs-work': [{ id: 'EPIC-001-3', epic: 'EPIC-001' }],
    'needs-code-review': [{ id: 'EPIC-001-2', epic: 'EPIC-001' }],
    'done': [{ id: 'EPIC-001-1', epic: 'EPIC-001' }, { id: 'TKT-900' }],
  } },
};

test('seedEpicModel + epicCountsOf reflect the snapshot', () => {
  const c = epicCountsOf(seedEpicModel(SNAP));
  assert.equal(c['needs-spec'], 1);
  assert.equal(c['building'], 1);
  assert.equal(c['done'], 0);
});

test('applyEpicEvent move reassigns an epic state', () => {
  let m = seedEpicModel(SNAP);
  m = applyEpicEvent(m, { type: 'epic.move', id: 'EPIC-002', from: 'needs-spec', to: 'needs-design' });
  const c = epicCountsOf(m);
  assert.equal(c['needs-spec'], 0);
  assert.equal(c['needs-design'], 1);
});

test('childProgress groups an epic\'s children by their ticket state, ignoring non-children', () => {
  const p = childProgress(SNAP, 'EPIC-001');
  assert.equal(p.total, 3);
  assert.equal(p.byState['needs-work'], 1);
  assert.equal(p.byState['needs-code-review'], 1);
  assert.equal(p.byState['done'], 1);
  assert.equal(p.ready, 1);          // children in done
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui/feature-pipeline-graph.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `ui/public/feature-pipeline-graph.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui/feature-pipeline-graph.test.js && npm run test:ui`
Expected: PASS (all tests, including the existing `pipeline-graph.test.js`).

- [ ] **Step 5: Commit**

```bash
git add ui/public/feature-pipeline-graph.js test/ui/feature-pipeline-graph.test.js
git commit -m "feat(ui): pure epic topology + reducers for the features graph"
```

---

### Task 14: Live epic events in the watcher

**Files:**
- Modify: `api/index.js` — `createWatcher` watches `.pipeline/epics/<state>` and emits `epic.*` events.

**Interfaces:**
- Consumes: `indexEpics`, `diffEpicIndexes`, `EPIC_STATES`, `epicsDir` from `api/epics.js`.
- Produces: `epic.upsert | epic.move | epic.remove` events on the watcher's `event` stream (already fanned to `/api/v1/events` SSE by `ui/server.js` with no server change).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/epics.test.js`:

```js
import { createWatcher } from '../../api/index.js';

test('createWatcher emits epic.move when an epic changes state', async () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  const w = createWatcher({ target, reconcileMs: 50, debounceMs: 10 });
  const seen = [];
  w.on('event', ev => { if (ev.type?.startsWith('epic.')) seen.push(ev); });
  await new Promise(r => setTimeout(r, 30));
  // move the epic
  const { renameSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(epicsDir(target), 'needs-design'), { recursive: true });
  renameSync(join(epicsDir(target), 'needs-spec', 'EPIC-001.json'),
             join(epicsDir(target), 'needs-design', 'EPIC-001.json'));
  await new Promise(r => setTimeout(r, 150));
  w.close();
  const move = seen.find(e => e.type === 'epic.move');
  assert.ok(move, 'epic.move emitted');
  assert.equal(move.to, 'needs-design');
  rmSync(target, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/epics.test.js`
Expected: FAIL — no `epic.move` event is ever emitted (`move` is undefined).

- [ ] **Step 3: Write minimal implementation**

In `api/index.js`:

1. Extend the import from `./epics.js` (Task 2 added `readEpics, EPIC_STATES`) to also bring in the watcher helpers:

```js
import { readEpics, EPIC_STATES, epicsDir, indexEpics, diffEpicIndexes } from './epics.js';
```

2. In `createWatcher`, seed an epic index alongside `lastTickets` (after line 256):

```js
  let lastEpics = indexEpics(target);
```

3. In `scheduleReconcile`, after the tickets diff block (after line 287, `lastTickets = nowTickets;`), add:

```js
    const nowEpics = indexEpics(target);
    for (const ev of diffEpicIndexes(lastEpics, nowEpics)) emit(ev);
    lastEpics = nowEpics;
```

4. Add `fs.watch` on each epic state dir, mirroring the ticket-state watch loop (after the ticket-state loop ends, around line 342):

```js
  for (const state of EPIC_STATES) {
    const dir = join(epicsDir(target), state);
    try {
      if (!existsSync(dir)) continue;
      const w = fsWatch(dir, { persistent: true }, onFsChange);
      w.on('error', err => emitter.emit('error', err));
      watchers.push(w);
    } catch (err) {
      emitter.emit('error', err);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/epics.test.js && npm run test:unit && npm test`
Expected: PASS (epic.move test + all unit tests + `cli smoke ok`).

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/unit/epics.test.js
git commit -m "feat(epics): watcher emits epic.* events for live dashboard updates"
```

---

### Task 15: `ui/public/feature-pipeline.js` — controller + child drill-in

**Files:**
- Create: `ui/public/feature-pipeline.js`

**Interfaces:**
- Consumes: the pure module from Task 13; `colorForAgent` from `./colors.js`; `/api/v1/snapshot` + `/api/v1/events` (now carrying `epic.*`).
- Produces: `initFeaturePipeline()` (idempotent), imported by `app.js`.

> This is browser DOM code, validated by the `agent-pipeline ui` smoke step at the end of Phase 4 (consistent with `pipeline.js`, which has no unit test — only its pure module `pipeline-graph.js` is tested in Task 13).

- [ ] **Step 1: Write the controller**

Create `ui/public/feature-pipeline.js`. It mirrors `pipeline.js`'s structure: build the SVG from `NODES`/`EDGES` (`buildGraph`), render per-node epic counts (`renderCounts` using `epicCountsOf`), subscribe to `/api/v1/events`, and additionally render a **child drill-in** panel below the graph. Concretely:

```js
// Feature (epic) graph view. Builds an SVG from the pure topology module, shows
// live per-state epic counts, and a drill-in of each building epic's children.
// Browser-only; pure logic lives in feature-pipeline-graph.js.
import {
  NODES, EDGES, VIEW, pathFor, pathEdgesForMove,
  seedEpicModel, applyEpicEvent, epicCountsOf, childProgress,
} from './feature-pipeline-graph.js';
import { colorForAgent } from './colors.js';

const SVGNS = 'http://www.w3.org/2000/svg';
let built = false, svg = null, statusEl = null, drillEl = null;
const nodeEls = new Map();
let model = { idState: new Map() };
let lastSnapshot = null;

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function buildGraph() {
  svg = document.getElementById('feature-graph');
  statusEl = document.getElementById('feature-status');
  drillEl = document.getElementById('feature-epics');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${VIEW.w} ${VIEW.h}`);
  const edgeLayer = el('g', { class: 'pl-edges' });
  const nodeLayer = el('g', { class: 'pl-nodes' });
  for (const edge of EDGES) {
    edgeLayer.append(el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge, NODES), 'data-edge': edge.id }));
  }
  for (const [id, n] of Object.entries(NODES)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label; g.append(label);
    if (n.agent) { const a = el('text', { class: 'pl-node-agent', y: 13 }); a.textContent = n.agent; g.append(a); }
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    nodeEls.set(id, { g, countText });
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  return true;
}

function renderCounts() {
  const counts = epicCountsOf(model);
  for (const [id, n] of Object.entries(NODES)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}

// One row per building epic: title + a chip per child-state with counts.
function renderDrill() {
  if (!drillEl) return;
  drillEl.textContent = '';
  const building = lastSnapshot?.epics?.byState?.['building'] || [];
  const acceptance = lastSnapshot?.epics?.byState?.['needs-acceptance'] || [];
  for (const epic of [...building, ...acceptance]) {
    const p = childProgress(lastSnapshot, epic.id);
    const row = document.createElement('div');
    row.className = 'epic-row';
    const title = document.createElement('span');
    title.className = 'epic-title';
    title.textContent = `${epic.id} ${epic.title || ''}`;
    const prog = document.createElement('span');
    prog.className = 'epic-prog';
    prog.textContent = ` ${p.ready}/${p.total} ready`;
    row.append(title, prog);
    const chips = document.createElement('span');
    chips.className = 'epic-chips';
    for (const [state, n] of Object.entries(p.byState)) {
      const chip = document.createElement('span');
      chip.className = 'child-chip';
      chip.style.borderColor = colorForAgent(state);
      chip.textContent = `${state} ${n}`;
      chips.append(chip);
    }
    row.append(chips);
    drillEl.append(row);
  }
  if (statusEl) {
    const total = (lastSnapshot?.epics?.count) || 0;
    statusEl.textContent = `${total} epic${total === 1 ? '' : 's'}`;
  }
}

function applySnapshot(snap) {
  model = seedEpicModel(snap);
  lastSnapshot = snap;
  renderCounts();
  renderDrill();
}

function handleEvent(ev) {
  if (ev.type && ev.type.startsWith('epic.')) {
    model = applyEpicEvent(model, ev);
    renderCounts();
    return;
  }
  // ticket.* changes affect child progress; cheapest correct refresh is a refetch.
  if (ev.type && ev.type.startsWith('ticket.')) {
    fetch('/api/v1/snapshot').then(r => r.json()).then(s => { lastSnapshot = s; renderDrill(); }).catch(() => {});
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

export function initFeaturePipeline() {
  if (built) return;
  if (!buildGraph()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(applySnapshot).catch(() => {
    if (statusEl) statusEl.textContent = 'failed to load features';
  });
  connect();
}
```

- [ ] **Step 2: Syntax-check the module**

Run: `node --check ui/public/feature-pipeline.js`
Expected: no output, exit 0 (valid JS).

- [ ] **Step 3: Commit**

```bash
git add ui/public/feature-pipeline.js
git commit -m "feat(ui): feature graph controller + child drill-in"
```

---

### Task 16: Wire the features tab into the SPA

**Files:**
- Modify: `ui/public/index.html` (tab + panel)
- Modify: `ui/public/app.js` (selectTab)
- Modify: `ui/public/style.css` (view toggling + chip styles)

**Interfaces:**
- Consumes: `initFeaturePipeline` from `./feature-pipeline.js`.
- Produces: a working `features` tab.

- [ ] **Step 1: Add the tab + panel in `index.html`**

Add a tab button to the `<nav class="tabs">` block, after the `agents` tab (line 15):

```html
    <button class="tab" data-tab="features" role="tab" aria-selected="false">features</button>
```

Add a panel inside `<main>`, after the `agents` section (after line 40):

```html
  <section id="features" data-panel="features" aria-live="polite">
    <svg id="feature-graph" viewBox="0 0 1180 420"
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label="feature pipeline flow"></svg>
    <p id="feature-status" class="dim" aria-live="polite">loading…</p>
    <div id="feature-epics"></div>
  </section>
```

- [ ] **Step 2: Wire `selectTab` in `app.js`**

Add the import at the top of `app.js` (after line 1, the existing `initPipeline` import):

```js
import { initFeaturePipeline } from './feature-pipeline.js';
```

Add a branch in `selectTab` (after line 519, the `if (view === 'pipeline')` line):

```js
  if (view === 'features') initFeaturePipeline();
```

- [ ] **Step 3: Add CSS in `style.css`**

Append to `ui/public/style.css`:

```css
/* features tab: hide other panels when active, mirror the pipeline/agents toggles */
body[data-view="features"] #pipeline,
body[data-view="features"] #log,
body[data-view="features"] #agents { display: none; }
body:not([data-view="features"]) #features { display: none; }

#feature-epics { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.epic-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 6px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.epic-title { color: var(--text); font-weight: 600; }
.epic-prog { color: var(--ok); }
.epic-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.child-chip { font-size: 11px; color: var(--dim); border: 1px solid var(--line);
  border-radius: 10px; padding: 1px 7px; }
```

Also confirm the existing toggles hide `#features` for the other views. The other views already only show their own panel via `body[data-view="..."] #other { display:none }` rules; add the symmetric hides for the three existing views if they use an allowlist approach. If the existing CSS hides panels per-view explicitly, add `#features` to each of the `pipeline`, `log`, and `agents` view blocks:

```css
body[data-view="pipeline"] #features,
body[data-view="log"] #features,
body[data-view="agents"] #features { display: none; }
```

- [ ] **Step 4: Verify the dashboard launches and the tab works**

Run:
```bash
# create a demo epic so the tab has data
TMP=$(mktemp -d)
node bin/cli.js feature "Demo: dark mode" --target "$TMP"
node bin/cli.js ui --target "$TMP" --port 7printf 7470 >/dev/null 2>&1 &
sleep 1
curl -s http://127.0.0.1:7470/api/v1/snapshot | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.epics.count>=1&&j.epicStates[0]==='needs-spec')console.log('snapshot epics ok');else throw new Error('no epics in snapshot')})"
curl -s http://127.0.0.1:7470/feature-pipeline.js | head -1
curl -s http://127.0.0.1:7470/feature-pipeline-graph.js | head -1
kill %1 2>/dev/null; rm -rf "$TMP"
```
Expected: `snapshot epics ok`, and the two `curl` calls return JS (the static files serve). Then open `agent-pipeline ui --target <a project with epics>` manually, click the **features** tab, and confirm the epic graph renders with a count on `spec` and the demo epic appears in the drill-in.

> Note the port in the launch command is illustrative; use any free port. The static-file route in `ui/server.js` already serves any root-level `*.js`, so `feature-pipeline.js` and `feature-pipeline-graph.js` need no server change.

- [ ] **Step 5: Commit**

```bash
git add ui/public/index.html ui/public/app.js ui/public/style.css
git commit -m "feat(ui): wire the features tab into the dashboard"
```

---

### Task 17: Full verification + final commit

**Files:** none (verification only).

- [ ] **Step 1: Run the full test + smoke suite**

Run:
```bash
npm test
npm run test:unit
npm run test:ui
node bin/cli.js list-agents | grep -c feature
```
Expected: `cli smoke ok`; all unit tests pass; all ui tests pass; the `feature` grep shows the stage + 5 agents.

- [ ] **Step 2: End-to-end dry check of the epic lifecycle (filesystem)**

Run:
```bash
TMP=$(mktemp -d); ( cd "$TMP" && git init -q )
node bin/cli.js feature "End-to-end smoke epic" --target "$TMP"
node bin/cli.js status --target "$TMP" --json >/dev/null   # snapshot builds without error
node -e "const {getEpic}=require('$PWD/api/epics.js'); const e=getEpic({target:'$TMP'},'EPIC-001'); if(e.state!=='needs-spec')throw new Error('bad state'); console.log('epic lifecycle entry ok')"
# simulate the front transitions with the shared helper
bash queue/queue-claim.sh EPIC-001 needs-spec needs-design --queue-dir "$TMP/.pipeline/epics"
node -e "const {getEpic}=require('$PWD/api/epics.js'); if(getEpic({target:'$TMP'},'EPIC-001').state!=='needs-design')throw new Error('claim failed'); console.log('epic transition ok')"
rm -rf "$TMP"
```
Expected: `epic lifecycle entry ok` and `epic transition ok` (note: `api/epics.js` is ESM — if the inline `require` fails, use `node --input-type=module -e` with `import`).

- [ ] **Step 3: Self-review against the spec**

Confirm against `docs/superpowers/specs/2026-06-17-new-feature-pipeline-design.md`:
- 5 new agents exist + registered (Tasks 6,7,8,10,11). ✓
- Epic state machine + integration branch + dependency gating + child auto-merge documented (Tasks 5,9,12). ✓
- Two-level features tab (graph + drill-in) (Tasks 13,15,16). ✓
- Entry command (Task 3). ✓
- No change to the bug-fix pipeline (tickets without `epic` are untouched). ✓

- [ ] **Step 4: Final commit (if any docs/cleanup remain)**

```bash
git add -A
git commit -m "chore(feature): finalize new-feature pipeline (agents, states, UI)" || echo "nothing to finalize"
```
