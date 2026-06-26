# Agent Read Model — Plan 1: Local Mirror + Sync Foundation (poll-driven)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Linear backend a local materialized mirror in the existing
`.pipeline/queue/<state>/` JSON layout, refreshed each orchestrator cycle, so
dispatched agents read tickets locally (filesystem-backend read path) instead of
querying Linear live per dispatch.

**Architecture:** A pure JS module (`runner/mirror-sync.js`) normalizes fetched
Linear issues into pipeline ticket JSON and idempotently mirrors them into the
queue layout, retiring tickets that vanished from the source. The Linear *fetch*
is performed by the orchestrator cycle agent (which already holds the Linear MCP)
and handed to the JS via a new `agent-pipeline mirror sync --issues <file>` CLI
subcommand. Reconciliation cadence = the orchestrator cycle cadence. This plan is
**poll-driven and relay-free**; Plan 2 layers webhook push on top of the same
`applyMirror` write path.

**Tech Stack:** Node 18+ ESM, `node:fs`/`node:path`/`node:test` (zero runtime
deps — matches the API layer's no-dependency ethos), existing `bin/cli.js`
command router, existing `.pipeline/queue/` filesystem layout.

## Global Constraints

- **Zero runtime dependencies** in `api/`, `runner/`, and `bin/` — use only
  `node:*` built-ins (copied verbatim from `api/index.js`: "No runtime
  dependencies").
- **Atomic file writes**: write `<file>.tmp` then `renameSync` — never write a
  ticket file in place. (Established pattern: `api/runs.js`, `api/orchestrator.js`.)
- **Queue layout**: tickets live at `<target>/.pipeline/queue/<state>/<id>.json`;
  state is encoded by subdirectory; `id` is the Linear identifier (e.g. `CER-123`).
- **Pipeline state on the Linear backend is a label** named
  `<labelNamespace>:<state>` (default namespace `pipeline`, e.g.
  `pipeline:needs-work`). The 16 valid states are `STATES` in `api/index.js`.
- **ESM**: `"type": "module"`; use `import`, not `require`.
- **Tests**: `node --test` under `test/unit/**/*.test.js`; run via
  `npm run test:unit`.

---

## File Structure

- **Create** `runner/mirror-sync.js` — normalization + idempotent mirror writes +
  reconcile. The only new logic module. One responsibility: keep the queue mirror
  faithful to a fetched issue set.
- **Create** `test/unit/mirror-sync.test.js` — unit tests for the above against a
  temp `.pipeline` dir.
- **Modify** `bin/cli.js` — add a `mirror sync` subcommand that reads a raw-issues
  JSON file and calls `runMirrorSync`.
- **Modify** `api/orchestrator.js` — record `lastMirrorSyncAt` in orchestrator
  state and expose it (health readout).
- **Modify** `agents/ORCHESTRATION.md` and the orchestrator cycle prompt
  (`ORCHESTRATOR_CYCLE_PROMPT` in `api/orchestrator.js`) — fetch matching Linear
  issues each cycle and invoke `mirror sync`.
- **Modify** the Linear-reading agent rules (`rules/` + affected `agents/*.md`) —
  read the local mirror for discovery; **confirm-live against Linear before any
  mutation**.

---

### Task 1: Normalize a Linear issue → pipeline ticket

**Files:**
- Create: `runner/mirror-sync.js`
- Test: `test/unit/mirror-sync.test.js`

**Interfaces:**
- Consumes: nothing (entry module).
- Produces:
  - `STATE_LABEL_RE(namespace) → RegExp` matching `<namespace>:<state>`.
  - `mapIssueToTicket(issue, opts) → { ticket, state } | null` where
    `opts = { namespace: string, now: string }`, `now` is an ISO string.
    Returns `null` when the issue carries no `<namespace>:<state>` label (not
    pipeline-managed). `ticket` is the JSON written to disk; `state` is the
    target subdirectory.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/mirror-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapIssueToTicket } from '../../runner/mirror-sync.js';

const NOW = '2026-06-26T00:00:00.000Z';

test('mapIssueToTicket: extracts state from the pipeline:<state> label', () => {
  const issue = {
    identifier: 'CER-123',
    title: 'fix: silent error in dashboard fetch',
    description: 'details',
    priority: 2,
    url: 'https://linear.app/team/issue/CER-123',
    assignee: { displayName: 'agent:worker' },
    labels: { nodes: [{ name: 'pipeline:needs-work' }, { name: 'smell' }] },
    updatedAt: '2026-06-25T12:00:00.000Z',
  };
  const out = mapIssueToTicket(issue, { namespace: 'pipeline', now: NOW });
  assert.equal(out.state, 'needs-work');
  assert.equal(out.ticket.id, 'CER-123');
  assert.equal(out.ticket.title, 'fix: silent error in dashboard fetch');
  assert.deepEqual(out.ticket.labels, ['pipeline:needs-work', 'smell']);
  assert.equal(out.ticket.claim, 'agent:worker');
  assert.equal(out.ticket.url, 'https://linear.app/team/issue/CER-123');
  assert.equal(out.ticket._syncedAt, NOW);
  assert.equal(out.ticket._source, 'reconcile');
  assert.equal(out.ticket._rev, '2026-06-25T12:00:00.000Z');
});

test('mapIssueToTicket: returns null when no pipeline state label present', () => {
  const issue = { identifier: 'CER-9', title: 'x', labels: { nodes: [{ name: 'smell' }] } };
  assert.equal(mapIssueToTicket(issue, { namespace: 'pipeline', now: NOW }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: FAIL — `Cannot find module '../../runner/mirror-sync.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// runner/mirror-sync.js
// Local mirror of the Linear backend in the filesystem-backend queue layout.
// Zero runtime deps (node:* only). Poll-driven (relay-free); Plan 2 reuses
// applyMirror() for webhook push.

const VALID_STATES = new Set([
  'needs-triage', 'needs-review', 'needs-work', 'in-progress',
  'needs-test-review', 'needs-code-review', 'needs-detector-gate',
  'needs-regression-check', 'needs-runtime-qa', 'needs-feature-validation',
  'needs-feedback', 'needs-conflict-resolution', 'ready-for-human', 'done',
  'needs-info', 'obsolete',
]);

export function stateLabelRe(namespace) {
  return new RegExp(`^${namespace}:(.+)$`);
}

/**
 * @param {any} issue Linear issue (MCP shape).
 * @param {{ namespace: string, now: string }} opts
 * @returns {{ ticket: object, state: string } | null}
 */
export function mapIssueToTicket(issue, opts) {
  const re = stateLabelRe(opts.namespace);
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  let state = null;
  for (const name of labels) {
    const m = re.exec(name);
    if (m && VALID_STATES.has(m[1])) { state = m[1]; break; }
  }
  if (!state) return null;
  const ticket = {
    id: issue.identifier,
    title: issue.title ?? '',
    description: issue.description ?? '',
    priority: issue.priority ?? 99,
    labels,
    claim: issue.assignee?.displayName ?? null,
    url: issue.url ?? null,
    raw: issue,
    _syncedAt: opts.now,
    _rev: issue.updatedAt ?? opts.now,
    _source: 'reconcile',
  };
  return { ticket, state };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/mirror-sync.js test/unit/mirror-sync.test.js
git commit -m "feat(mirror): normalize Linear issue → pipeline ticket"
```

---

### Task 2: Idempotent mirror write (upsert + move-on-state-change)

**Files:**
- Modify: `runner/mirror-sync.js`
- Test: `test/unit/mirror-sync.test.js`

**Interfaces:**
- Consumes: `mapIssueToTicket` (Task 1).
- Produces:
  - `applyMirror(target, entries, opts) → { created, updated, moved, unchanged }`
    where `entries` is an array of `{ ticket, state }` (Task 1 output) and
    `opts = { now: string }`. Writes each ticket to
    `<target>/.pipeline/queue/<state>/<id>.json` atomically; if the same id
    already exists in a **different** state dir, removes the stale copy (move).
    Idempotent: re-applying identical entries yields all-`unchanged`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/unit/mirror-sync.test.js
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMirror } from '../../runner/mirror-sync.js';

function tmpTarget() { return mkdtempSync(join(tmpdir(), 'mirror-')); }
function qpath(t, state, id) { return join(t, '.pipeline', 'queue', state, `${id}.json`); }

test('applyMirror: creates a ticket file in the right state dir', () => {
  const t = tmpTarget();
  try {
    const entry = { ticket: { id: 'CER-1', title: 'a', _syncedAt: NOW }, state: 'needs-work' };
    const res = applyMirror(t, [entry], { now: NOW });
    assert.equal(res.created, 1);
    assert.ok(existsSync(qpath(t, 'needs-work', 'CER-1')));
    assert.equal(JSON.parse(readFileSync(qpath(t, 'needs-work', 'CER-1'), 'utf8')).id, 'CER-1');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('applyMirror: re-applying identical entry is unchanged (idempotent)', () => {
  const t = tmpTarget();
  try {
    const entry = { ticket: { id: 'CER-1', title: 'a', _syncedAt: NOW }, state: 'needs-work' };
    applyMirror(t, [entry], { now: NOW });
    const res = applyMirror(t, [entry], { now: NOW });
    assert.equal(res.unchanged, 1);
    assert.equal(res.created, 0);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('applyMirror: moves a ticket when its state changed', () => {
  const t = tmpTarget();
  try {
    applyMirror(t, [{ ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' }], { now: NOW });
    const res = applyMirror(t, [{ ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'in-progress' }], { now: NOW });
    assert.equal(res.moved, 1);
    assert.ok(!existsSync(qpath(t, 'needs-work', 'CER-1')));
    assert.ok(existsSync(qpath(t, 'in-progress', 'CER-1')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: FAIL — `applyMirror is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

```js
// add imports at top of runner/mirror-sync.js
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ALL_STATES = [...VALID_STATES];

function queueDir(target) { return join(resolve(target), '.pipeline', 'queue'); }
function ticketPath(target, state, id) { return join(queueDir(target), state, `${id}.json`); }

function writeAtomic(path, obj) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

/** Find which state dir currently holds <id>, or null. */
function findExistingState(target, id) {
  for (const state of ALL_STATES) {
    if (existsSync(ticketPath(target, state, id))) return state;
  }
  return null;
}

/**
 * @param {string} target
 * @param {Array<{ ticket: object, state: string }>} entries
 * @param {{ now: string }} _opts
 */
export function applyMirror(target, entries, _opts) {
  const res = { created: 0, updated: 0, moved: 0, unchanged: 0 };
  for (const { ticket, state } of entries) {
    const id = ticket.id;
    const dest = ticketPath(target, state, id);
    const prevState = findExistingState(target, id);

    if (prevState && prevState !== state) {
      unlinkSync(ticketPath(target, prevState, id));
      writeAtomic(dest, ticket);
      res.moved += 1;
      continue;
    }
    if (!prevState) {
      writeAtomic(dest, ticket);
      res.created += 1;
      continue;
    }
    // same state already present — write only if content differs
    const current = readFileSync(dest, 'utf8');
    const next = JSON.stringify(ticket, null, 2);
    if (current === next) { res.unchanged += 1; }
    else { writeAtomic(dest, ticket); res.updated += 1; }
  }
  return res;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add runner/mirror-sync.js test/unit/mirror-sync.test.js
git commit -m "feat(mirror): idempotent applyMirror with move-on-state-change"
```

---

### Task 3: Reconcile — retire tickets that vanished from the source

**Files:**
- Modify: `runner/mirror-sync.js`
- Test: `test/unit/mirror-sync.test.js`

**Interfaces:**
- Consumes: `applyMirror` (Task 2).
- Produces:
  - `reconcile(target, entries, opts) → { applied: {...}, retired: number }`.
    Calls `applyMirror`, then for any mirror ticket whose id is **not** in
    `entries` and that lives in a **non-terminal** state, moves it to `obsolete/`
    (retired — source no longer lists it). `opts = { now, terminalStates? }`;
    `terminalStates` defaults to `['done', 'obsolete']`. Reconcile operates over
    the **active working set** only: tickets already in terminal states are left
    untouched.

- [ ] **Step 1: Write the failing test**

```js
// append to test/unit/mirror-sync.test.js
import { reconcile } from '../../runner/mirror-sync.js';

test('reconcile: retires a mirror ticket absent from the fetched set', () => {
  const t = tmpTarget();
  try {
    // seed two tickets via a first reconcile
    reconcile(t, [
      { ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' },
      { ticket: { id: 'CER-2', _syncedAt: NOW }, state: 'in-progress' },
    ], { now: NOW });
    // second fetch only contains CER-1 → CER-2 must be retired
    const res = reconcile(t, [
      { ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' },
    ], { now: NOW });
    assert.equal(res.retired, 1);
    assert.ok(existsSync(qpath(t, 'obsolete', 'CER-2')));
    assert.ok(!existsSync(qpath(t, 'in-progress', 'CER-2')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('reconcile: does not touch tickets already in terminal states', () => {
  const t = tmpTarget();
  try {
    mkdirSync(join(t, '.pipeline', 'queue', 'done'), { recursive: true });
    writeFileSync(qpath(t, 'done', 'CER-9'), JSON.stringify({ id: 'CER-9' }, null, 2));
    const res = reconcile(t, [], { now: NOW });
    assert.equal(res.retired, 0);
    assert.ok(existsSync(qpath(t, 'done', 'CER-9')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: FAIL — `reconcile is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to runner/mirror-sync.js
function readMirrorIds(target) {
  const out = []; // [{ id, state }]
  for (const state of ALL_STATES) {
    const dir = join(queueDir(target), state);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) out.push({ id: f.slice(0, -5), state });
    }
  }
  return out;
}

/**
 * @param {string} target
 * @param {Array<{ ticket: object, state: string }>} entries  fetched, normalized
 * @param {{ now: string, terminalStates?: string[] }} opts
 */
export function reconcile(target, entries, opts) {
  const terminal = new Set(opts.terminalStates ?? ['done', 'obsolete']);
  const applied = applyMirror(target, entries, { now: opts.now });
  const fetchedIds = new Set(entries.map((e) => e.ticket.id));
  let retired = 0;
  for (const { id, state } of readMirrorIds(target)) {
    if (fetchedIds.has(id) || terminal.has(state)) continue;
    const ticket = JSON.parse(readFileSync(ticketPath(target, state, id), 'utf8'));
    ticket._source = 'reconcile';
    ticket._syncedAt = opts.now;
    unlinkSync(ticketPath(target, state, id));
    writeAtomic(ticketPath(target, 'obsolete', id), ticket);
    retired += 1;
  }
  return { applied, retired };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add runner/mirror-sync.js test/unit/mirror-sync.test.js
git commit -m "feat(mirror): reconcile retires vanished tickets, spares terminal states"
```

---

### Task 4: `runMirrorSync` + `mirror sync` CLI subcommand

**Files:**
- Modify: `runner/mirror-sync.js`
- Modify: `bin/cli.js`
- Test: `test/unit/mirror-sync.test.js`

**Interfaces:**
- Consumes: `mapIssueToTicket` (Task 1), `reconcile` (Task 3).
- Produces:
  - `runMirrorSync(target, rawIssues, opts) → { mapped, skipped, applied, retired }`
    where `rawIssues` is an array of Linear-issue objects and
    `opts = { namespace?: string, now: string }` (`namespace` defaults to
    `'pipeline'`). Maps each issue, drops nulls (`skipped`), reconciles.
  - CLI: `agent-pipeline mirror sync --issues <path> [--target <p>]
    [--namespace <ns>]` — reads the JSON file (array of issues), calls
    `runMirrorSync`, prints a one-line summary, exits non-zero on read/parse error.

- [ ] **Step 1: Write the failing test**

```js
// append to test/unit/mirror-sync.test.js
import { runMirrorSync } from '../../runner/mirror-sync.js';

test('runMirrorSync: maps issues, skips unmanaged, reconciles', () => {
  const t = tmpTarget();
  try {
    const issues = [
      { identifier: 'CER-1', title: 'a', labels: { nodes: [{ name: 'pipeline:needs-work' }] }, updatedAt: NOW },
      { identifier: 'CER-2', title: 'b', labels: { nodes: [{ name: 'no-state' }] }, updatedAt: NOW }, // skipped
    ];
    const res = runMirrorSync(t, issues, { now: NOW });
    assert.equal(res.mapped, 1);
    assert.equal(res.skipped, 1);
    assert.ok(existsSync(qpath(t, 'needs-work', 'CER-1')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: FAIL — `runMirrorSync is not a function`.

- [ ] **Step 3: Write minimal implementation (module)**

```js
// add to runner/mirror-sync.js
/**
 * @param {string} target
 * @param {any[]} rawIssues
 * @param {{ namespace?: string, now: string }} opts
 */
export function runMirrorSync(target, rawIssues, opts) {
  const namespace = opts.namespace ?? 'pipeline';
  const entries = [];
  let skipped = 0;
  for (const issue of rawIssues) {
    const mapped = mapIssueToTicket(issue, { namespace, now: opts.now });
    if (mapped) entries.push(mapped); else skipped += 1;
  }
  const { applied, retired } = reconcile(target, entries, { now: opts.now });
  return { mapped: entries.length, skipped, applied, retired };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/mirror-sync.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Wire the CLI subcommand**

Locate the command router in `bin/cli.js` (the `switch`/`if` dispatch on
`argv[0]`). Add a `mirror` command branch:

```js
// bin/cli.js — inside the top-level command dispatch
if (cmd === 'mirror') {
  const sub = args[0];
  if (sub === 'sync') {
    const issuesPath = flagValue(args, '--issues');
    const target = flagValue(args, '--target') || process.cwd();
    const namespace = flagValue(args, '--namespace') || 'pipeline';
    if (!issuesPath) { console.error('mirror sync: --issues <path> is required'); process.exit(2); }
    const { readFileSync } = await import('node:fs');
    const { runMirrorSync } = await import('../runner/mirror-sync.js');
    let raw;
    try { raw = JSON.parse(readFileSync(issuesPath, 'utf8')); }
    catch (e) { console.error(`mirror sync: cannot read ${issuesPath}: ${e.message}`); process.exit(1); }
    const issues = Array.isArray(raw) ? raw : (raw.issues ?? []);
    const res = runMirrorSync(target, issues, { namespace, now: new Date().toISOString() });
    console.log(`mirror sync: mapped ${res.mapped}, skipped ${res.skipped}, retired ${res.retired}`);
    process.exit(0);
  }
  console.error('usage: agent-pipeline mirror sync --issues <path> [--target <p>] [--namespace <ns>]');
  process.exit(2);
}
```

> If `bin/cli.js` has no `flagValue` helper, reuse the existing flag-parsing
> helper it already uses for other commands (grep `--target` in `bin/cli.js` to
> find it) rather than adding a new one (DRY).

- [ ] **Step 6: Verify the CLI end-to-end**

```bash
mkdir -p /tmp/cli-mirror && cd /tmp/cli-mirror
printf '[{"identifier":"CER-7","title":"t","labels":{"nodes":[{"name":"pipeline:needs-work"}]},"updatedAt":"2026-06-26T00:00:00Z"}]' > issues.json
node "$OLDPWD/bin/cli.js" mirror sync --issues issues.json --target .
test -f .pipeline/queue/needs-work/CER-7.json && echo OK
cd "$OLDPWD"
```

Expected: prints `mirror sync: mapped 1, skipped 0, retired 0` then `OK`.

- [ ] **Step 7: Commit**

```bash
git add runner/mirror-sync.js bin/cli.js test/unit/mirror-sync.test.js
git commit -m "feat(mirror): runMirrorSync + 'mirror sync' CLI subcommand"
```

---

### Task 5: Wire reconciliation into the orchestrator cycle + health readout

**Files:**
- Modify: `api/orchestrator.js`
- Test: `test/unit/orchestrator.test.js` (or the existing orchestrator-state test file — grep `readOrchestratorState` in `test/`)

**Interfaces:**
- Consumes: existing `readOrchestratorState` / `writeOrchestratorState` in
  `api/orchestrator.js`.
- Produces:
  - `recordMirrorSync(target, { at }) → void` — persists `lastMirrorSyncAt` into
    orchestrator state (merge, don't clobber other fields).
  - `ORCHESTRATOR_CYCLE_PROMPT` updated to instruct the cycle agent to refresh the
    mirror when `backend === 'linear'`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/orchestrator.test.js (append; mirror imports of the existing file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordMirrorSync, readOrchestratorState } from '../../api/orchestrator.js';

test('recordMirrorSync: persists lastMirrorSyncAt without clobbering state', () => {
  const t = mkdtempSync(join(tmpdir(), 'orch-'));
  try {
    recordMirrorSync(t, { at: '2026-06-26T01:02:03.000Z' });
    const state = readOrchestratorState(t);
    assert.equal(state.lastMirrorSyncAt, '2026-06-26T01:02:03.000Z');
  } finally { rmSync(t, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/orchestrator.test.js`
Expected: FAIL — `recordMirrorSync is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// api/orchestrator.js — add near writeOrchestratorState
export function recordMirrorSync(target, { at }) {
  const current = readOrchestratorState(target) ?? {};
  writeOrchestratorState(target, { ...current, lastMirrorSyncAt: at });
}
```

> If `readOrchestratorState` returns a frozen/defaulted object, spread a shallow
> copy as shown so the merge keeps every existing field (paused/runningFireAt/etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/orchestrator.test.js`
Expected: PASS.

- [ ] **Step 5: Update the cycle prompt + ORCHESTRATION docs**

In `api/orchestrator.js`, extend `ORCHESTRATOR_CYCLE_PROMPT` with a first step
(only acted on when `config.backend === 'linear'`):

```
MIRROR REFRESH (Linear backend only): Before surveying work, fetch the Linear
issues this pipeline manages — team config.linear.teamId, scoped by
config.linear.projectFilter, excluding config.linear.excludeProjects /
excludeLabels — including each issue's labels, assignee, url, and updatedAt.
Write the raw issue array to .pipeline/mirror/issues.json, then run:
  agent-pipeline mirror sync --issues .pipeline/mirror/issues.json --target <repo>
This refreshes the local read mirror so every agent dispatched this cycle reads
tickets locally instead of querying Linear. Then survey the queue as usual.
```

Add a short "Read mirror" subsection to `agents/ORCHESTRATION.md` describing that,
on the Linear backend, the queue under `.pipeline/queue/` is a **read mirror**
refreshed each cycle, and agents must **confirm-live against Linear before any
mutation** (forward-reference to Task 6).

- [ ] **Step 6: Commit**

```bash
git add api/orchestrator.js agents/ORCHESTRATION.md test/unit/orchestrator.test.js
git commit -m "feat(mirror): refresh mirror each cycle + record lastMirrorSyncAt"
```

---

### Task 6: Agent read-path decoupling + confirm-live-before-write rule

**Files:**
- Modify: `rules/` (the rule file that governs how agents read/transition tickets
  — grep `rules/` for `linear` / `mcp__linear` / "claim" to find it)
- Modify: affected `agents/*.md` that currently query Linear directly for
  discovery (grep `agents/` for `mcp__linear` / `list_issues` / `searchIssues`)

**Interfaces:**
- Consumes: the populated mirror (Tasks 1–5) and the existing `queue/` read
  helpers + `api/index.js` read path.
- Produces: no code — a behavioral contract change. Agents **read** ticket state
  from the local mirror; agents **confirm-live** (re-fetch just that issue from
  Linear MCP) immediately before any state-changing write, then write live.

- [ ] **Step 1: Inventory the live-query touchpoints**

Run: `grep -rln "mcp__linear\|list_issues\|searchIssues" agents/ rules/`
Record which agents read Linear for **discovery** (candidates to switch to the
mirror) vs. **mutation** (must keep a live confirm-then-write).

- [ ] **Step 2: Add the read/write contract to the shared rule**

In the governing rule file, add a section verbatim:

```
## Read the mirror, confirm-live before writing (Linear backend)

When config.backend = "linear", the local .pipeline/queue/ is a READ MIRROR of
Linear, refreshed each orchestrator cycle. For DISCOVERY and CONTEXT (what tickets
exist, their state, labels, claim), READ THE MIRROR via the queue helpers / read
API — do NOT query Linear live. This is what eliminates redundant empty queries.

Before any STATE CHANGE (claim, transition/label change, comment that gates a
handoff), CONFIRM-LIVE: re-fetch just that one issue from Linear, verify it still
holds the state you read from the mirror, then write live to Linear. Never treat
the mirror as authority for a decision to mutate. The mirror self-heals from your
write on the next cycle — do not hand-edit mirror files.
```

- [ ] **Step 3: Switch discovery reads in the affected agents**

For each agent identified in Step 1 as doing **discovery** via Linear MCP, replace
the "query Linear for tickets in state X" instruction with "read tickets in state
X from the mirror (queue helpers / read API)". Leave mutation steps as
confirm-live-then-write. Keep each edit minimal and within the agent's existing
prose style.

- [ ] **Step 4: Verify nothing reads Linear for plain discovery anymore**

Run: `grep -rn "list_issues\|searchIssues" agents/`
Expected: remaining hits are inside **confirm-live / mutation** steps only (single
-issue re-fetch), not bulk discovery scans. Eyeball each remaining hit.

- [ ] **Step 5: Commit**

```bash
git add rules/ agents/
git commit -m "feat(mirror): agents read mirror for discovery, confirm-live before write"
```

---

### Task 7: End-to-end smoke — mirror visible through the read API

**Files:**
- Create: `test/e2e/09-mirror-sync.sh` (follow the structure of an existing
  `test/e2e/0N-*.sh`; register it in `test/e2e/run-all.sh`)

**Interfaces:**
- Consumes: the `mirror sync` CLI (Task 4) and `readSnapshot` (`api/index.js`).
- Produces: a claude-free e2e proving a synthetic Linear issue set lands in the
  mirror and surfaces through the public read snapshot.

- [ ] **Step 1: Write the e2e smoke test**

```bash
#!/usr/bin/env bash
# test/e2e/09-mirror-sync.sh — mirror sync lands tickets visible via readSnapshot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/issues.json" <<'JSON'
[{"identifier":"CER-100","title":"smoke","priority":1,
  "labels":{"nodes":[{"name":"pipeline:needs-work"}]},
  "updatedAt":"2026-06-26T00:00:00Z","url":"https://linear.app/x/CER-100"}]
JSON

node "$ROOT/bin/cli.js" mirror sync --issues "$WORK/issues.json" --target "$WORK"

node --input-type=module -e "
import { readSnapshot } from '$ROOT/api/index.js';
const snap = readSnapshot({ target: '$WORK' });
const t = snap.ticketsByState['needs-work']?.find(x => x.id === 'CER-100');
if (!t) { console.error('FAIL: CER-100 not in needs-work snapshot'); process.exit(1); }
console.log('OK: mirror ticket visible via readSnapshot');
"
```

- [ ] **Step 2: Run it**

Run: `bash test/e2e/09-mirror-sync.sh`
Expected: prints `mirror sync: mapped 1 ...` then `OK: mirror ticket visible via readSnapshot`.

- [ ] **Step 3: Register in the e2e runner**

Add `09-mirror-sync.sh` to the list in `test/e2e/run-all.sh` (match how the other
`0N-*.sh` scripts are invoked there).

- [ ] **Step 4: Run the full unit suite to confirm no regressions**

Run: `npm run test:unit`
Expected: all green, including the new `mirror-sync` and `orchestrator` tests.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/09-mirror-sync.sh test/e2e/run-all.sh
git commit -m "test(mirror): e2e smoke — mirror ticket visible via readSnapshot"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-26-agent-read-model-design.md`,
slice 1, poll-driven portion):

| Spec element | Task |
|---|---|
| `work_item` mirror in `.pipeline/queue/<state>/` JSON | 1–2 |
| Sync metadata `_syncedAt` / `_rev` / `_source` | 1 |
| Idempotent `applyToStore` (here `applyMirror`), last-writer by content | 2 |
| Backfill (cold store seeded by first reconcile) | 3–4 (first `mirror sync` = backfill) |
| Reconciliation (retire vanished, spare terminal/active-set) | 3 |
| Reconciliation cadence = orchestrator cycle | 5 |
| Read interface reuse (existing queue helpers / read API / SSE / fs.watch) | 6 (+ no new API by construction) |
| Confirm-live-before-write contract | 6 |
| Health readout (`lastMirrorSyncAt`) | 5 |
| Read model visible end-to-end | 7 |

**Out of scope for Plan 1 (→ Plan 2):** relay, outbound push connection, webhook
signature validation, replay-since-cursor. Backfill here is the first cycle's
full reconcile rather than a distinct boot step — acceptable because the cycle
runs on startup; if a dedicated cold-boot seed is wanted, it's a one-line call to
`mirror sync` in init, not a new mechanism.

**Placeholder scan:** none — every code step carries complete code; the only
prose-only edits (Task 6) are inherently behavioral and specify exact rule text
and a grep-based verification.

**Type consistency:** `mapIssueToTicket → { ticket, state }` is consumed
unchanged by `applyMirror`/`reconcile`/`runMirrorSync`; `applyMirror` returns
`{created,updated,moved,unchanged}` referenced only as `applied` in `reconcile`;
CLI calls `runMirrorSync(target, issues, { namespace, now })` matching its
signature. Consistent.

**Known follow-ups (not blockers):** the cycle prompt assumes the orchestrator
agent can write `.pipeline/mirror/issues.json` and run the CLI — both already in
its tool surface. `priority` mapping from Linear's 0–4 scale is passed through
verbatim; revisit if the dashboard's priority sort needs inversion.
