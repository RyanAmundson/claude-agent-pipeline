# Runtime-QA Fan-Out Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pipeline:needs-runtime-qa` fan-out gate that drives the running app and proves per-PR runtime correctness, modeled 1:1 on the existing `runner/detector-gate.js`.

**Architecture:** A pure member registry + matcher decide which single-purpose runtime members run for a PR's changed files; a gate runner fans them out via the existing `dispatch.js`, folds in per-member console errors, persists per-member verdicts under `.pipeline/reviews/<pr>/`, and computes one severity gate by **reusing** `computeGate()` from `detector-gate.js`. The new stage sits after `regression-tester` and before `feature-validator`. Wiring is agent-markdown-driven exactly like the detector-gate (no new JS entry point).

**Tech Stack:** Node.js ESM (zero runtime deps), `node:test` + `node:assert/strict`, agent markdown prompts, JSON config schema.

## Global Constraints

- **Zero runtime dependencies** in `runner/` modules — `node:*` built-ins only (matches `detector-gate.js`, `dispatch.js`).
- **ESM** — `import`/`export`, `.js` extensions in import paths.
- **Reuse, do not fork** — import `computeGate` and `finalMessageOf` from `runner/detector-gate.js`, `extractVerdict` from `runner/verdict.js`, `globToRegExp` from `runner/detector-match.js`, `dispatch` from `runner/dispatch.js`. Do not reimplement them.
- **Fail-closed** — a crashed/malformed member run becomes a synthetic veto `{ verdict: 'veto', findings: [], reason: 'malformed-or-missing' }`.
- **Verdict contract** (every member's final message, parsed by the runner): a single fenced ` ```json ` block `{ "verdict": "pass|veto", "summary": "...", "findings": [ { "severity": "blocker|major|minor|nit", ... } ] }`. `verdict: "veto"` iff at least one `blocker`/`major` finding.
- **Severity gate** — any `blocker`/`major` (or any `veto`) → `needs-feedback`; only `minor`/`nit` → advance.
- **Orphaned-process rule** — members never start a dev server; if the app/`agent-browser` is unavailable they report a blocker and stop.
- **Evidence layout** — verdicts at `.pipeline/reviews/<pr>/runtime-qa-<member>.json` + `.pipeline/reviews/<pr>/runtime-qa-gate.json`; screenshots/console at `.pipeline/evidence/<pr>/runtime-qa/<member>/`.
- **Run tests with** `node --test test/unit/<file>` from the repo root.

---

### Task 1: Member registry + matcher

**Files:**
- Create: `runner/runtime-qa-members.js`
- Create: `runner/runtime-qa-match.js`
- Test: `test/unit/runtime-qa-match.test.js`

**Interfaces:**
- Consumes: `globToRegExp` from `runner/detector-match.js` (signature `globToRegExp(glob: string): RegExp`, anchored `^…$`).
- Produces:
  - `MEMBERS: Array<{ id: string, agent: string, globs?: string[], always?: boolean, model?: string }>` (from `runtime-qa-members.js`)
  - `matchMembers(members, changedFiles): Member[]` where `changedFiles: Array<{ path: string }>` (from `runtime-qa-match.js`) — returns active members in registry order; `always` members always included.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-match.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS } from '../../runner/runtime-qa-members.js';
import { matchMembers } from '../../runner/runtime-qa-match.js';

const ids = (members) => members.map(m => m.id);

test('data member runs on every PR, even with no UI changes', () => {
  const active = matchMembers(MEMBERS, [{ path: 'README.md' }]);
  assert.deepEqual(ids(active), ['data']);
});

test('a changed .tsx screen activates the screen members (+ data)', () => {
  const active = matchMembers(MEMBERS, [{ path: 'src/features/x/[components]/Foo/Foo.tsx' }]);
  assert.deepEqual(
    ids(active).sort(),
    ['a11y', 'data', 'interaction', 'network', 'perf', 'responsive', 'state', 'visual'].sort(),
  );
});

test('an [apis] change activates network + data but not the screen-only members', () => {
  const active = matchMembers(MEMBERS, [{ path: 'src/features/x/[apis]/foo/foo.api.ts' }]);
  assert.deepEqual(ids(active).sort(), ['data', 'network'].sort());
});

test('every member declares an agent and is either path-gated or always-on', () => {
  for (const m of MEMBERS) {
    assert.ok(m.id && m.agent, `member ${JSON.stringify(m)} missing id/agent`);
    assert.ok(m.always === true || (Array.isArray(m.globs) && m.globs.length), `member ${m.id} needs globs or always`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-match.test.js`
Expected: FAIL — `Cannot find module '../../runner/runtime-qa-members.js'`.

- [ ] **Step 3: Write the member registry**

```js
// runner/runtime-qa-members.js
// The runtime-QA fan-out members. Each member owns one runtime concern and maps to an
// agent that drives the running app via agent-browser and emits a JSON verdict (the
// runner parses it). `globs` = changed-file surfaces that activate the member;
// `always: true` = runs every PR regardless of the diff.

export const MEMBERS = [
  { id: 'interaction', agent: 'interaction-validator', globs: ['src/**/*.tsx'] },
  { id: 'visual',      agent: 'visual-validator',      globs: ['src/**/*.tsx'] },
  { id: 'state',       agent: 'state-validator',       globs: ['src/**/*.tsx'] },
  { id: 'network',     agent: 'network-validator',     globs: ['src/**/*.tsx', 'src/**/[apis]/**', 'src/**/[services]/**'] },
  { id: 'data',        agent: 'data-validator',        always: true },
  { id: 'responsive',  agent: 'responsive-validator',  globs: ['src/**/*.tsx'] },
  { id: 'a11y',        agent: 'a11y-validator',        globs: ['src/**/*.tsx'] },
  { id: 'perf',        agent: 'perf-validator',        globs: ['src/**/*.tsx'] },
];
```

- [ ] **Step 4: Write the matcher**

```js
// runner/runtime-qa-match.js
// Pure: given the member registry + a PR's changed files, return the members whose
// surface changed. `always` members are returned regardless. Mirrors detector-match.js
// and reuses its glob engine. Zero deps beyond globToRegExp.
import { globToRegExp } from './detector-match.js';

/**
 * @param {Array<{id,agent,globs?:string[],always?:boolean}>} members
 * @param {Array<{path:string}>} changedFiles
 * @returns {Array} active members (registry order)
 */
export function matchMembers(members, changedFiles) {
  const paths = (changedFiles || []).map(f => f.path);
  return members.filter(m => {
    if (m.always) return true;
    const res = (m.globs || []).map(globToRegExp);
    return paths.some(p => res.some(re => re.test(p)));
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-match.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add runner/runtime-qa-members.js runner/runtime-qa-match.js test/unit/runtime-qa-match.test.js
git commit -m "feat(runtime-qa): member registry + path-gated matcher"
```

---

### Task 2: Console fold-in helper

**Files:**
- Create: `runner/runtime-qa-gate.js` (partial — the pure helpers; the runner is added in Task 3)
- Test: `test/unit/runtime-qa-gate.test.js` (partial — fold-in tests; fan-out tests added in Task 3)

**Interfaces:**
- Consumes: `computeGate` from `runner/detector-gate.js` (signature `computeGate(verdicts): { gate:'pass'|'veto', label, blocking }`).
- Produces:
  - `CONSOLE_FAIL_DEFAULT: string[]` = `['uncaught', 'hydration']`
  - `foldConsoleFindings(verdict, consoleEvents?, failOn?): { verdict, findings }` — appends one finding per console event (`failOn` kinds → `major`, else `minor`), preserving existing findings.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldConsoleFindings, CONSOLE_FAIL_DEFAULT } from '../../runner/runtime-qa-gate.js';

test('an uncaught console event folds in as a major finding', () => {
  const out = foldConsoleFindings({ verdict: 'pass', findings: [] }, [{ kind: 'uncaught', text: 'boom' }]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'major');
  assert.equal(out.findings[0].source, 'console');
});

test('a non-failOn console kind folds in as a minor finding and preserves existing findings', () => {
  const out = foldConsoleFindings(
    { verdict: 'pass', findings: [{ severity: 'nit', title: 'pre' }] },
    [{ kind: 'react-warning', text: 'key prop' }],
  );
  assert.equal(out.findings.length, 2);
  assert.equal(out.findings.find(f => f.source === 'console').severity, 'minor');
});

test('CONSOLE_FAIL_DEFAULT covers uncaught + hydration', () => {
  assert.deepEqual(CONSOLE_FAIL_DEFAULT, ['uncaught', 'hydration']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-gate.test.js`
Expected: FAIL — `Cannot find module '../../runner/runtime-qa-gate.js'`.

- [ ] **Step 3: Write the helpers (module header + fold-in)**

```js
// runner/runtime-qa-gate.js
// The needs-runtime-qa fan-out gate. Mirrors detector-gate.js: reuses computeGate() and
// finalMessageOf(), fans out matched members against the running app, folds in per-member
// console errors, persists verdicts, and computes one severity gate.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from './dispatch.js';
import { computeGate, finalMessageOf } from './detector-gate.js';
import { extractVerdict } from './verdict.js';
import { matchMembers } from './runtime-qa-match.js';
import { MEMBERS } from './runtime-qa-members.js';

export const CONSOLE_FAIL_DEFAULT = ['uncaught', 'hydration'];

/**
 * Fold a member's captured console errors into its verdict as findings.
 * `failOn` kinds become `major` (→ veto); everything else becomes `minor`.
 * @param {{verdict:string, findings?:any[]}} verdict
 * @param {Array<{kind:string, text?:string}>} [consoleEvents]
 * @param {string[]} [failOn]
 */
export function foldConsoleFindings(verdict, consoleEvents = [], failOn = CONSOLE_FAIL_DEFAULT) {
  const findings = [...(verdict.findings || [])];
  for (const e of consoleEvents) {
    findings.push({
      severity: failOn.includes(e.kind) ? 'major' : 'minor',
      title: `console: ${e.kind}`,
      detail: e.text || '',
      source: 'console',
    });
  }
  return { ...verdict, findings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-gate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/runtime-qa-gate.js test/unit/runtime-qa-gate.test.js
git commit -m "feat(runtime-qa): console-error fold-in helper"
```

---

### Task 3: Gate runner — fan-out, persistence, fail-closed

**Files:**
- Modify: `runner/runtime-qa-gate.js` (append the console source + the runner)
- Test: `test/unit/runtime-qa-gate.test.js` (append the fan-out tests)

**Interfaces:**
- Consumes: `dispatch` from `runner/dispatch.js` (returns `{ runId, result: Promise<{ status, runId }> }`); `extractVerdict` from `runner/verdict.js`; `MEMBERS`/`matchMembers` (Task 1); `foldConsoleFindings`/`computeGate` (Task 2).
- Produces:
  - `consoleEventsOf(target, pr, memberId): Array<{kind,text?}>` — reads `<target>/.pipeline/evidence/<pr>/runtime-qa/<member>/console.json` (array) or `[]`.
  - `runRuntimeQaGate({ target, pr, changedFiles, members?, qaPrompt, config? }, deps?): Promise<{gate,label,blocking}>` — fans out active members, persists `.pipeline/reviews/<pr>/runtime-qa-<member>.json` + `runtime-qa-gate.json`, returns the gate. `qaPrompt(member): string` builds each member's prompt (injected exactly like `detector-gate`'s `diffPrompt`). `deps` seams: `{ dispatch, finalMessageOf, consoleEventsOf }`.

- [ ] **Step 1: Write the failing test (append to test/unit/runtime-qa-gate.test.js)**

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRuntimeQaGate } from '../../runner/runtime-qa-gate.js';

test('runRuntimeQaGate persists per-member verdicts, fails closed on crash, folds console, writes the gate', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-rtqa-'));
  try {
    const members = [
      { id: 'interaction', agent: 'interaction-validator', globs: ['src/**/*.tsx'] },
      { id: 'visual',      agent: 'visual-validator',      globs: ['src/**/*.tsx'] },
      { id: 'data',        agent: 'data-validator',        always: true },
    ];
    const changedFiles = [{ path: 'src/features/x/[components]/Foo/Foo.tsx' }];

    // interaction completes clean; visual crashes (status !== 'completed'); data completes clean.
    const fakeDispatch = ({ agent }) => {
      const runId = `run-${agent}`;
      const status = agent === 'visual-validator' ? 'failed' : 'completed';
      return { runId, result: Promise.resolve({ status, runId }) };
    };
    const fakeFinal = (_t, runId) => runId === 'run-visual-validator'
      ? ''
      : '```json\n{"verdict":"pass","findings":[]}\n```';
    // interaction's browser logged an uncaught error → folds in as major → veto.
    const fakeConsole = (_t, _pr, memberId) => memberId === 'interaction'
      ? [{ kind: 'uncaught', text: 'TypeError x' }]
      : [];

    const result = await runRuntimeQaGate(
      { target, pr: '9', changedFiles, members, qaPrompt: () => 'validate the running app' },
      { dispatch: fakeDispatch, finalMessageOf: fakeFinal, consoleEventsOf: fakeConsole },
    );

    assert.equal(result.gate, 'veto'); // crash veto + folded console major

    const dir = join(target, '.pipeline', 'reviews', '9');
    const inter = JSON.parse(readFileSync(join(dir, 'runtime-qa-interaction.json'), 'utf8'));
    assert.equal(inter.member, 'interaction');
    assert.equal(inter.findings.find(f => f.source === 'console').severity, 'major');

    const vis = JSON.parse(readFileSync(join(dir, 'runtime-qa-visual.json'), 'utf8'));
    assert.equal(vis.verdict, 'veto');
    assert.equal(vis.reason, 'malformed-or-missing');

    const data = JSON.parse(readFileSync(join(dir, 'runtime-qa-data.json'), 'utf8'));
    assert.equal(data.member, 'data'); // dispatched via agent 'data-validator'

    const gate = JSON.parse(readFileSync(join(dir, 'runtime-qa-gate.json'), 'utf8'));
    assert.equal(gate.gate, 'veto');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('empty active set (data disabled, util-only PR) passes', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-rtqa-empty-'));
  try {
    const members = [{ id: 'data', agent: 'data-validator', always: true }];
    const result = await runRuntimeQaGate(
      { target, pr: '10', changedFiles: [{ path: 'README.md' }], members,
        qaPrompt: () => 'x', config: { members: { data: { enabled: false } } } },
      { dispatch: () => { throw new Error('should not dispatch'); } },
    );
    assert.equal(result.gate, 'pass');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-gate.test.js`
Expected: FAIL — `runRuntimeQaGate is not a function` / not exported.

- [ ] **Step 3: Append the console source + runner to runner/runtime-qa-gate.js**

```js
/** Default console source: <target>/.pipeline/evidence/<pr>/runtime-qa/<member>/console.json (JSON array). */
export function consoleEventsOf(target, pr, memberId) {
  const p = join(target, '.pipeline', 'evidence', String(pr), 'runtime-qa', memberId, 'console.json');
  if (!existsSync(p)) return [];
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

/**
 * Fan out matched runtime-QA members for a PR, persist verdicts, compute the gate.
 * @param {{target:string, pr:string|number, changedFiles:Array<{path:string}>,
 *          members?:any[], qaPrompt:(m:any)=>string, config?:any}} o
 * @param {{dispatch?:Function, finalMessageOf?:Function, consoleEventsOf?:Function}} [deps]
 */
export async function runRuntimeQaGate({ target, pr, changedFiles, members = MEMBERS, qaPrompt, config = {} }, deps = {}) {
  const dispatchFn = deps.dispatch || dispatch;
  const readFinal = deps.finalMessageOf || finalMessageOf;
  const readConsole = deps.consoleEventsOf || consoleEventsOf;
  const memberCfg = config.members || {};
  const consoleEnabled = config.consoleErrors?.enabled !== false;
  const failOn = config.consoleErrors?.failOn || CONSOLE_FAIL_DEFAULT;

  const active = matchMembers(members, changedFiles)
    .filter(m => memberCfg[m.id]?.enabled !== false);

  const reviewsDir = join(target, '.pipeline', 'reviews', String(pr));
  mkdirSync(reviewsDir, { recursive: true });

  const verdicts = await Promise.all(active.map(async (m) => {
    const h = dispatchFn({ agent: m.agent, prompt: qaPrompt(m), target, model: m.model });
    const run = await h.result;
    let verdict = run.status === 'completed'
      ? extractVerdict(readFinal(target, run.runId))
      : { verdict: 'veto', findings: [], reason: 'malformed-or-missing' }; // crash → fail-closed
    if (consoleEnabled) verdict = foldConsoleFindings(verdict, readConsole(target, pr, m.id), failOn);
    writeFileSync(join(reviewsDir, `runtime-qa-${m.id}.json`), JSON.stringify({ member: m.id, ...verdict }, null, 2));
    return verdict;
  }));

  const result = computeGate(verdicts);
  writeFileSync(join(reviewsDir, 'runtime-qa-gate.json'), JSON.stringify(result, null, 2));
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-gate.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add runner/runtime-qa-gate.js test/unit/runtime-qa-gate.test.js
git commit -m "feat(runtime-qa): fan-out gate runner with fail-closed + console fold-in"
```

---

### Task 4: Pipeline state + config schema

**Files:**
- Modify: `api/index.js` (insert `needs-runtime-qa` into `STATES`)
- Modify: `config.schema.json` (add the `runtimeQa` block)
- Test: `test/unit/runtime-qa-gate-state.test.js`

**Interfaces:**
- Consumes: `STATES` from `api/index.js`; the schema JSON.
- Produces: `STATES` now contains `'needs-runtime-qa'` between `'needs-regression-check'` and `'needs-feature-validation'`; `schema.properties.runtimeQa` with `enabled`, `members`, `consoleErrors`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-gate-state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATES } from '../../api/index.js';

test('needs-runtime-qa sits between regression-check and feature-validation', () => {
  assert.ok(STATES.includes('needs-runtime-qa'), 'needs-runtime-qa missing');
  const rc = STATES.indexOf('needs-regression-check');
  const rq = STATES.indexOf('needs-runtime-qa');
  const fv = STATES.indexOf('needs-feature-validation');
  assert.equal(rq, rc + 1, `expected runtime-qa right after regression-check (rc=${rc} rq=${rq})`);
  assert.equal(fv, rq + 1, `expected feature-validation right after runtime-qa (rq=${rq} fv=${fv})`);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'));

test('config schema declares runtimeQa with enabled, members, consoleErrors', () => {
  const rq = schema.properties.runtimeQa;
  assert.ok(rq, 'runtimeQa property missing');
  assert.equal(rq.properties.enabled.type, 'boolean');
  assert.ok(rq.properties.members.properties.interaction, 'members.interaction missing');
  assert.ok(rq.properties.members.properties.data, 'members.data missing');
  assert.ok(rq.properties.consoleErrors.properties.failOn, 'consoleErrors.failOn missing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-gate-state.test.js`
Expected: FAIL — `needs-runtime-qa missing`.

- [ ] **Step 3: Insert the state in `api/index.js`**

In the `STATES` array (around line 40), add `'needs-runtime-qa'` between `'needs-regression-check'` and `'needs-feature-validation'`:

```js
  'needs-regression-check',
  'needs-runtime-qa',
  'needs-feature-validation',
```

Also update the comment above `STATES` (line 26): change `// The 14 queue states` to `// The 15 queue states`.

- [ ] **Step 4: Add the `runtimeQa` block to `config.schema.json`**

Insert immediately after the `detectors` property's closing `},` (after line 203, before `"maxAutoFixDiffLines"`):

```json
    "runtimeQa": {
      "type": "object",
      "additionalProperties": false,
      "description": "The needs-runtime-qa fan-out gate: drives the running app and proves runtime correctness per PR. Absent ⇒ defaults apply.",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": true,
          "description": "When false, regression-tester advances straight to needs-feature-validation with no runtime-QA panel."
        },
        "members": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "interaction": { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true } } },
            "visual":      { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true } } },
            "state":       { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true } } },
            "network":     { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true }, "allowedHosts": { "type": "array", "items": { "type": "string" }, "default": [] } } },
            "data":        { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true }, "everyPr": { "type": "boolean", "default": true } } },
            "responsive":  { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true }, "breakpoints": { "type": "array", "items": { "type": "integer" }, "default": [375, 768, 1280] } } },
            "a11y":        { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true } } },
            "perf":        { "type": "object", "additionalProperties": false, "properties": { "enabled": { "type": "boolean", "default": true }, "budgets": { "type": "object", "additionalProperties": false, "properties": { "inpMs": { "type": "integer", "default": 200 }, "cls": { "type": "number", "default": 0.1 } } } } }
          }
        },
        "consoleErrors": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "enabled": { "type": "boolean", "default": true },
            "failOn": { "type": "array", "items": { "type": "string" }, "default": ["uncaught", "hydration"] }
          }
        }
      }
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-gate-state.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify the schema is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log('schema ok')"`
Expected: `schema ok`

- [ ] **Step 7: Commit**

```bash
git add api/index.js config.schema.json test/unit/runtime-qa-gate-state.test.js
git commit -m "feat(runtime-qa): add needs-runtime-qa state + config.runtimeQa schema"
```

---

### Task 5: Member agents + manifest registration

**Files:**
- Create: `agents/interaction-validator.md`, `agents/visual-validator.md`, `agents/state-validator.md`, `agents/network-validator.md`, `agents/responsive-validator.md`, `agents/a11y-validator.md`, `agents/perf-validator.md`
- Modify: `agents/data-validator.md` (add the gate-mode verdict contract)
- Modify: `manifest.json` (register the 7 new member agents under stage `quality`)
- Test: `test/unit/runtime-qa-agents.test.js`

**Interfaces:**
- Consumes: `MEMBERS` from `runner/runtime-qa-members.js` (Task 1) — the source of truth for which agent files/manifest entries must exist.
- Produces: one `.md` per non-`data` member; `manifest.json.agents['<id>-validator'] = { stage: 'quality', requires: ['github','agent-browser'] }` for each.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-agents.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MEMBERS } from '../../runner/runtime-qa-members.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('every member maps to an agent file that emits the JSON verdict contract', () => {
  for (const m of MEMBERS) {
    const file = join(root, 'agents', `${m.agent}.md`);
    assert.ok(existsSync(file), `missing agent file agents/${m.agent}.md`);
    const body = readFileSync(file, 'utf8');
    assert.match(body, /```json/, `${m.agent}.md must document the json verdict block`);
    assert.match(body, /"verdict"/, `${m.agent}.md must document the verdict field`);
  }
});

test('every non-data member agent is registered in the manifest quality stage with agent-browser', () => {
  for (const m of MEMBERS) {
    if (m.id === 'data') continue; // data-validator is pre-registered
    const entry = manifest.agents[m.agent];
    assert.ok(entry, `manifest missing ${m.agent}`);
    assert.equal(entry.stage, 'quality');
    assert.ok(entry.requires.includes('github') && entry.requires.includes('agent-browser'),
      `${m.agent} must require github + agent-browser`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-agents.test.js`
Expected: FAIL — `missing agent file agents/interaction-validator.md`.

- [ ] **Step 3: Create `agents/interaction-validator.md`**

```markdown
---
name: interaction-validator
model: sonnet
---

# Interaction Validator (runtime-QA member)

**Role**: Prove every interactive control on the changed screens responds correctly in the running app — buttons, filters, toggles, dropdowns, hovers/tooltips.
**Scope**: Drives the running app via the `agent-browser` CLI; READS only — no code edits, no PRs, no state transitions (the runtime-qa gate owns those).
**Provenance**: `agent:interaction-validator`

## What to validate (and ONLY this)
For each changed/affected screen: exercise each interactive control and confirm it does the right thing — a click triggers its action, a filter filters, a toggle toggles, a dropdown opens/selects, a hover/tooltip appears.

**Veto (emit a `blocker`/`major` finding) when:** a control is dead, throws, no-ops, or does the wrong thing; a hover/tooltip never appears. Cosmetic-only quibbles are `minor`/`nit`.

## Process
1. If the app/dev server or `agent-browser` is unavailable: emit a single `blocker` finding "app/agent-browser unavailable" and stop — NEVER start a server (orphaned-process rule).
2. Navigate to each changed screen; drive its controls.
3. Save screenshots of any failure to `.pipeline/evidence/<pr>/runtime-qa/interaction/<slug>.png`.
4. If the browser surfaced console errors, write them to `.pipeline/evidence/<pr>/runtime-qa/interaction/console.json` as `[{ "kind": "uncaught|hydration|react-warning", "text": "..." }]` (the runner folds these into the gate).

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{
  "verdict": "pass | veto",
  "summary": "one line",
  "findings": [
    { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/interaction/<slug>.png" }
  ]
}
```
Set `verdict: "veto"` iff you emit at least one `blocker`/`major` finding.
```

- [ ] **Step 4: Create the other six member agents**

Create each file with the same structure as `interaction-validator.md`, changing the frontmatter `name`, the title, the **Role**, **Provenance**, the **What to validate** + **Veto** section, and the evidence path segment. Full content for each:

`agents/visual-validator.md`:
```markdown
---
name: visual-validator
model: sonnet
---

# Visual Validator (runtime-QA member)

**Role**: Prove rendered text, positioning, and alignment are correct on the changed screens.
**Scope**: Drives the running app via the `agent-browser` CLI; READS only — no code edits, no PRs, no transitions.
**Provenance**: `agent:visual-validator`

## What to validate (and ONLY this)
Rendered text correctness (no wrong/placeholder/truncated copy), element positioning, and alignment on each changed/affected screen.

**Veto when:** wrong or truncated text, overlapping elements, misalignment, or broken wrapping. Subjective taste is `minor`/`nit`.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. Navigate to each changed screen; inspect text, layout, alignment.
3. Save failure screenshots to `.pipeline/evidence/<pr>/runtime-qa/visual/<slug>.png`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/visual/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/visual/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

`agents/state-validator.md`:
```markdown
---
name: state-validator
model: sonnet
---

# State Validator (runtime-QA member)

**Role**: Prove loading / empty / error states exist where required, sequence correctly, and fire only when appropriate on the changed screens.
**Scope**: Drives the running app via the `agent-browser` CLI; READS only — no code edits, no PRs, no transitions.
**Provenance**: `agent:state-validator`

## What to validate (and ONLY this)
For each async surface: a loading state shows while loading, an empty state shows only when truly empty, an error state shows only on error. The empty state must NOT flash during loading; the error state must NOT show when there is no error.

**Veto when:** a required state is missing, states render out of order (empty during load), or a state shows/hides at the wrong time. Minor flicker is `minor`.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. Drive each async surface through loading → loaded, empty, and error paths (throttle/force where the harness allows).
3. Save failure screenshots to `.pipeline/evidence/<pr>/runtime-qa/state/<slug>.png`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/state/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/state/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

`agents/network-validator.md`:
```markdown
---
name: network-validator
model: sonnet
---

# Network Validator (runtime-QA member)

**Role**: Prove the changed screens make sane network calls — no request storms, no calls to disallowed hosts, and graceful handling of recoverable failures.
**Scope**: Drives the running app via the `agent-browser` CLI and inspects its network log; READS only — no code edits, no PRs, no transitions.
**Provenance**: `agent:network-validator`

## What to validate (and ONLY this)
Request volume (no duplicate/refetch storms for one interaction), destinations (only expected hosts — see `config.runtimeQa.members.network.allowedHosts`; default = the app's API base), error handling (4xx/5xx/timeout handled, not an infinite spinner/retry).

**Veto when:** duplicate/refetch-storm calls, a call to a non-allowlisted host, an unhandled 4xx/5xx/timeout, or an infinite spinner/retry loop.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. Navigate each changed screen; record the network requests for representative interactions.
3. Save evidence (HAR/screenshot) to `.pipeline/evidence/<pr>/runtime-qa/network/<slug>.*`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/network/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/network/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

`agents/responsive-validator.md`:
```markdown
---
name: responsive-validator
model: sonnet
---

# Responsive Validator (runtime-QA member)

**Role**: Prove the changed screens hold their layout across the configured breakpoints.
**Scope**: Drives the running app via the `agent-browser` CLI at multiple viewport widths; READS only — no code edits, no PRs, no transitions.
**Provenance**: `agent:responsive-validator`

## What to validate (and ONLY this)
At each width in `config.runtimeQa.members.responsive.breakpoints` (default 375 / 768 / 1280): no breakage, no overflow, no controls hidden-and-unreachable.

**Veto when:** layout breakage, content overflow, or a control made unreachable at a configured width.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. For each breakpoint, resize and capture each changed screen.
3. Save failure screenshots to `.pipeline/evidence/<pr>/runtime-qa/responsive/<width>-<slug>.png`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/responsive/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/responsive/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

`agents/a11y-validator.md`:
```markdown
---
name: a11y-validator
model: sonnet
---

# Accessibility Validator (runtime-QA member)

**Role**: Prove the changed screens are accessible at runtime — axe checks plus keyboard navigation, focus order/traps, ARIA, and contrast.
**Scope**: Drives the running app via the `agent-browser` CLI (axe + keyboard); READS only. Complements (does NOT replace) the static `a11y-detector`.
**Provenance**: `agent:a11y-validator`

## What to validate (and ONLY this)
Runtime a11y on each changed screen: critical axe violations, keyboard reachability, focus order and absence of focus traps, correct ARIA, and contrast.

**Veto when:** a critical axe violation, a keyboard trap, a control unreachable by keyboard, or failing contrast on a changed screen.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. Run axe + drive keyboard nav on each changed screen.
3. Save evidence to `.pipeline/evidence/<pr>/runtime-qa/a11y/<slug>.png`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/a11y/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/a11y/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

`agents/perf-validator.md`:
```markdown
---
name: perf-validator
model: sonnet
---

# Performance Validator (runtime-QA member)

**Role**: Prove the changed screens stay within their runtime performance budgets — INP/CLS/LCP, long tasks, and interaction jank.
**Scope**: Drives the running app via the `agent-browser` CLI and measures while interacting; READS only. Complements (does NOT replace) the static `perf-detector`.
**Provenance**: `agent:perf-validator`

## What to validate (and ONLY this)
On each changed screen, measure INP / CLS / LCP, long tasks, and jank while interacting; compare against `config.runtimeQa.members.perf.budgets` (default INP 200ms, CLS 0.1).

**Veto when:** a metric exceeds its configured budget on a changed screen.

## Process
1. App/`agent-browser` unavailable → single `blocker` finding, stop (never start a server).
2. Measure each changed screen under a representative interaction.
3. Save traces/screenshots to `.pipeline/evidence/<pr>/runtime-qa/perf/<slug>.*`.
4. Console errors → `.pipeline/evidence/<pr>/runtime-qa/perf/console.json` as `[{ "kind": "...", "text": "..." }]`.

## Output — your final message is the verdict (the runner parses it; you write no verdict file)
```json
{ "verdict": "pass | veto", "summary": "one line",
  "findings": [ { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "...", "detail": "...", "evidence": ".pipeline/evidence/<pr>/runtime-qa/perf/<slug>.png" } ] }
```
Set `verdict: "veto"` iff at least one `blocker`/`major` finding.
```

- [ ] **Step 5: Add the gate-mode contract to `agents/data-validator.md`**

Append a new section to the end of `agents/data-validator.md` so the existing data-validator can serve as the runtime-QA `data` member (it keeps its cron sweep + ticket-filing behavior unchanged):

```markdown
## Gate mode (runtime-QA member)

When dispatched as the runtime-QA `data` member on a PR (state `pipeline:needs-runtime-qa`), do NOT file tickets. Instead:

1. Scope the DB→API→service→hook→component trace to the metrics on the PR's **changed pages** only.
2. Apply the tolerances above.
3. Emit your verdict as your **final message** — a single fenced json block (the runner parses it and writes the verdict file; you write no files in this mode):

```json
{
  "verdict": "pass | veto",
  "summary": "one line",
  "findings": [
    { "severity": "blocker|major|minor|nit", "screen": "/route", "title": "metric drift", "detail": "DB=127 vs UI=4 (hook filter)", "evidence": "src/.../useStats.ts:23" }
  ]
}
```

Set `verdict: "veto"` iff at least one `blocker`/`major` drift. Drift introduced by a transformation (stages 3–5) is `major` regardless of size; within-tolerance surprises are `minor`.
```

- [ ] **Step 6: Register the 7 member agents in `manifest.json`**

In `manifest.json` under `"agents"`, after the `"regression-tester"` entry (around line 198), add:

```json
    "interaction-validator": { "stage": "quality", "requires": ["github", "agent-browser"] },
    "visual-validator":      { "stage": "quality", "requires": ["github", "agent-browser"] },
    "state-validator":       { "stage": "quality", "requires": ["github", "agent-browser"] },
    "network-validator":     { "stage": "quality", "requires": ["github", "agent-browser"] },
    "responsive-validator":  { "stage": "quality", "requires": ["github", "agent-browser"] },
    "a11y-validator":        { "stage": "quality", "requires": ["github", "agent-browser"] },
    "perf-validator":        { "stage": "quality", "requires": ["github", "agent-browser"] },
```

- [ ] **Step 7: Run the test + verify manifest JSON**

Run: `node --test test/unit/runtime-qa-agents.test.js`
Expected: PASS (2 tests).
Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`

- [ ] **Step 8: Commit**

```bash
git add agents/interaction-validator.md agents/visual-validator.md agents/state-validator.md agents/network-validator.md agents/responsive-validator.md agents/a11y-validator.md agents/perf-validator.md agents/data-validator.md manifest.json test/unit/runtime-qa-agents.test.js
git commit -m "feat(runtime-qa): 7 member agents + data-validator gate mode + manifest"
```

---

### Task 6: Trim overlap — regression-tester + feature-validator

**Files:**
- Modify: `agents/regression-tester.md` (remove the visual-adjacency duty; retarget PASS to `needs-runtime-qa`)
- Modify: `agents/feature-validator.md` (note generic runtime correctness is proven upstream; stay acceptance-only)
- Test: `test/unit/runtime-qa-trim.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `regression-tester.md` PASS transitions target `pipeline:needs-runtime-qa` (when the gate is enabled) and no longer contain the "Visual adjacency check" section; `feature-validator.md` references the upstream runtime-QA gate.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-trim.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rt = readFileSync(join(root, 'agents', 'regression-tester.md'), 'utf8');
const fv = readFileSync(join(root, 'agents', 'feature-validator.md'), 'utf8');

test('regression-tester no longer owns visual adjacency and hands off to runtime-qa', () => {
  assert.doesNotMatch(rt, /Visual adjacency check/i, 'visual-adjacency section should be removed');
  assert.match(rt, /needs-runtime-qa/, 'regression-tester PASS should target needs-runtime-qa');
});

test('feature-validator references the upstream runtime-QA gate (acceptance-only scope)', () => {
  assert.match(fv, /runtime-QA gate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-trim.test.js`
Expected: FAIL — visual-adjacency still present / `needs-runtime-qa` absent.

- [ ] **Step 3: Edit `agents/regression-tester.md` — remove the visual duty**

1. **Description** (frontmatter, lines ~6-7): replace "runs ONLY the impacted test subset, and visually verifies the changed screen plus adjacent screens with agent-browser." with "runs ONLY the impacted test subset. Generic runtime/visual correctness is proven downstream by the runtime-QA gate."
2. **`label`** (line 29): change `"regression-tester (blast-radius + visual regression)"` to `"regression-tester (blast-radius + targeted tests)"`.
3. **Role** (line 32): drop "and visual verification of the changed and adjacent screens" — end the sentence at "targeted test execution."
4. **Delete Section 3** entirely — the "## 3. Visual adjacency check (agent-browser)" heading and its body (lines ~71-79).
5. **Renumber** the following sections (4→3 Verdict, 5→4 Output, 6→5 What NOT to flag, 7→6 Idle).
6. **Verdict section** (now §3): change "no visual regression is observed" to "no impacted-test failures", and remove the "visual regression is found" branch from FAIL.
7. **Output format**: remove the `**Visual check:** …` line from the verdict template.

- [ ] **Step 4: Edit `agents/regression-tester.md` — retarget the handoff**

1. **Output** (line 34): change "pass → `pipeline:needs-feature-validation`" to "pass → `pipeline:needs-runtime-qa` (or `pipeline:needs-feature-validation` when `config.runtimeQa.enabled` is false)".
2. **Chain** (line 136): change "on PASS → `feature-validator` (item now at `needs-feature-validation`)" to "on PASS → runtime-QA gate (item now at `needs-runtime-qa`; or `needs-feature-validation` when `config.runtimeQa.enabled` is false)".
3. **GitHub PASS transition** (line 142): change the `--add-label` target from `pipeline:needs-feature-validation` to `pipeline:needs-runtime-qa`.
4. **Filesystem transition** (line 162): change `queue/queue-claim.sh <id> needs-regression-check needs-feature-validation` to `queue/queue-claim.sh <id> needs-regression-check needs-runtime-qa`.

- [ ] **Step 5: Edit `agents/feature-validator.md` — assert acceptance-only scope**

In the "You are the Feature Validation Engineer." paragraph (line 37), append: "Generic runtime correctness — interactions, layout, async states, network, responsive, a11y, perf — has already been proven upstream by the **runtime-QA gate**; your sole job here is the ticket's acceptance criteria."

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-trim.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add agents/regression-tester.md agents/feature-validator.md test/unit/runtime-qa-trim.test.js
git commit -m "refactor(runtime-qa): trim regression-tester visual duty + scope feature-validator"
```

---

### Task 7: Pipeline wiring — orchestrator, PIPELINE, labels

**Files:**
- Modify: `agents/orchestrator.md` (cycle map + dispatch table + detailed bullet)
- Modify: `agents/PIPELINE.md` (states table + dispatch-trigger row)
- Modify: `commands/pipeline-init.md` (filesystem queue dir + GitHub label + provenance loop)
- Test: `test/unit/runtime-qa-wiring.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: orchestrator/PIPELINE/init all reference `needs-runtime-qa` and `runner/runtime-qa-gate.js`; the init script creates the `needs-runtime-qa` label and the 7 `agent:*-validator` provenance labels.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/runtime-qa-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const orch = readFileSync(join(root, 'agents', 'orchestrator.md'), 'utf8');
const pipe = readFileSync(join(root, 'agents', 'PIPELINE.md'), 'utf8');
const init = readFileSync(join(root, 'commands', 'pipeline-init.md'), 'utf8');

test('orchestrator dispatches the runtime-qa gate runner', () => {
  assert.match(orch, /needs-runtime-qa/);
  assert.match(orch, /runner\/runtime-qa-gate\.js/);
});

test('PIPELINE documents the needs-runtime-qa state', () => {
  assert.match(pipe, /needs-runtime-qa/);
});

test('pipeline-init creates the state label + the *-validator provenance labels', () => {
  assert.match(init, /needs-runtime-qa/);
  assert.match(init, /interaction-validator/);
  assert.match(init, /perf-validator/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/runtime-qa-wiring.test.js`
Expected: FAIL — `needs-runtime-qa` absent from orchestrator.

- [ ] **Step 3: Edit `agents/orchestrator.md`**

1. **Cycle map** (after line 25, the `pipeline:needs-regression-check` line): insert
   `pipeline:needs-runtime-qa     ?    → run runner/runtime-qa-gate.js (runtime-QA member fan-out)`
2. **Dispatch table** (after the `needs-regression-check` row, line 77): insert
   `| `pipeline:needs-runtime-qa` (only when `config.runtimeQa.enabled`, default true) | `runner/runtime-qa-gate.js` (runtime-QA member fan-out) | — |`
3. **Detailed bullet** (after the `needs-detector-gate` bullet, line 109): insert
   ```markdown
   - **`pipeline:needs-runtime-qa`** (only when `config.runtimeQa.enabled`, default true): trigger `runner/runtime-qa-gate.js` for the PR. It path-gates the runtime-QA members to the PR's changed surfaces (data-validator always runs), fans them out against the running app, folds in each member's captured console errors, persists `.pipeline/reviews/<pr>/runtime-qa-*.json`, and computes the severity gate: any `blocker`/`major` (or any `veto`) → re-label `pipeline:needs-feedback`; otherwise advance to `pipeline:needs-feature-validation`. When `runtimeQa.enabled` is false, `regression-tester` advances straight to `needs-feature-validation` with no panel. If the app/`agent-browser` is unavailable, the members post a blocker and the PR stays in `needs-runtime-qa` for retry (no server is started).
   ```

- [ ] **Step 4: Edit `agents/PIPELINE.md`**

1. **States table** (after the `pipeline:needs-regression-check` row, line 35): insert
   `| `pipeline:needs-runtime-qa` | Regression passed; needs runtime-QA validation in the running app | runtime-qa gate (`*-validator` members) |`
   and change the existing `needs-feature-validation` row's "Regression passed" to "Runtime-QA passed".
2. **Dispatch-trigger table** (after the `regression-tester` row, line 142): insert
   `| runtime-qa-gate (`runner/runtime-qa-gate.js`) | `pipeline:needs-runtime-qa` items exist |`

- [ ] **Step 5: Edit `commands/pipeline-init.md`**

1. **Filesystem queue tree** (line 46): add `needs-runtime-qa` between `needs-regression-check` and `needs-feature-validation` inside the `mkdir -p` brace list.
2. **GitHub state labels** (after line 77, the `needs-regression-check` label): insert
   `gh label create "$labelNamespace:needs-runtime-qa"        --color "FBCA04" --description "PR needs runtime-QA validation"`
3. **Provenance loop** (line 83): add `interaction-validator visual-validator state-validator network-validator responsive-validator a11y-validator perf-validator` to the `for agent in …` list.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/unit/runtime-qa-wiring.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add agents/orchestrator.md agents/PIPELINE.md commands/pipeline-init.md test/unit/runtime-qa-wiring.test.js
git commit -m "feat(runtime-qa): wire needs-runtime-qa into orchestrator, PIPELINE, init"
```

---

### Task 8: Full suite green + default-on validation

**Files:**
- No source changes (verification task).

- [ ] **Step 1: Run the full unit suite**

Run: `node --test test/unit/`
Expected: PASS — including all five new files (`runtime-qa-match`, `runtime-qa-gate`, `runtime-qa-gate-state`, `runtime-qa-agents`, `runtime-qa-trim`, `runtime-qa-wiring`) and the unchanged `detector-gate*` / `gate-states` tests (the new state must not break the existing state-position assertions).

- [ ] **Step 2: Run the project's configured checks**

Run: `npm test` (or the script in `package.json`; if there is a `lint`/`type-check` script, run those too).
Expected: PASS. If `package.json` has no `test` script, state that and rely on `node --test test/unit/`.

- [ ] **Step 3: Sanity-check the gate end to end with a stub**

Run:
```bash
node -e '
import("./runner/runtime-qa-gate.js").then(async ({ runRuntimeQaGate }) => {
  const os = await import("node:os"); const fs = await import("node:fs"); const p = await import("node:path");
  const t = fs.mkdtempSync(p.join(os.tmpdir(), "rtqa-smoke-"));
  const members = [{ id: "data", agent: "data-validator", always: true }];
  const r = await runRuntimeQaGate(
    { target: t, pr: "1", changedFiles: [{ path: "src/x.tsx" }], members, qaPrompt: () => "x" },
    { dispatch: () => ({ runId: "r", result: Promise.resolve({ status: "completed", runId: "r" }) }),
      finalMessageOf: () => "```json\n{\"verdict\":\"pass\",\"findings\":[]}\n```",
      consoleEventsOf: () => [] });
  console.log("gate:", r.gate);
  fs.rmSync(t, { recursive: true, force: true });
});
'
```
Expected: `gate: pass`

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(runtime-qa): full suite green for the runtime-QA gate" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-24-runtime-qa-fanout-gate-design.md`):
- Gate runner mirroring detector-gate (reuse `computeGate`) → Task 2/3. ✓
- Member matcher, path-gated, data every-PR → Task 1. ✓
- 8 members (7 new + data) → Task 1 (registry) + Task 5 (agents). ✓
- Console-error cross-cutting fold-in → Task 2 (helper) + Task 3 (wired) + Task 5 (agents write `console.json`). ✓
- Verdict/evidence store paths → Task 3. ✓
- New `needs-runtime-qa` state after regression, before feature-validation → Task 4 + Task 7. ✓
- `config.runtimeQa` block mirroring `config.detectors` → Task 4. ✓
- Trim regression-tester (drop visual) + feature-validator (acceptance-only) → Task 6. ✓
- Manifest registration + provenance labels + init wiring → Task 5 + Task 7. ✓
- Error handling: app-down blocker/no-server, fail-closed crash, empty match passes → Tasks 3/5 (app-down in agent prose; crash + empty in gate tests). ✓
- Disabled-gate regression guard (`runtimeQa.enabled: false` → regression advances to feature-validation) → encoded in regression-tester (Task 6) + orchestrator bullet (Task 7). ✓

**Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N" — each member agent file is written in full; every code step shows complete code.

**Type consistency:** `matchMembers(members, changedFiles)`, `foldConsoleFindings(verdict, consoleEvents, failOn)`, `consoleEventsOf(target, pr, memberId)`, `runRuntimeQaGate({…}, deps)` are used with identical signatures across Tasks 1–3 and the tests. Member ids in `runtime-qa-members.js` (`interaction|visual|state|network|data|responsive|a11y|perf`) match the agent filenames, manifest keys, config `members.*` keys, and evidence path segments throughout.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-runtime-qa-fanout-gate.md`.
