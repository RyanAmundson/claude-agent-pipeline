# Per-Rule Detector Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dissolve the monolithic `scanner` agent into many single-purpose, dual-mode (sweep + pre-merge diff-gate) LLM detector agents driven from a single registry, with glob-matched dispatch and a per-PR verdict store the autonomous-merge decider (Spec B) will later aggregate.

**Architecture:** A `detectors.registry.json` is the single source of truth; `scripts/gen-detector.js` generates the per-rule `agents/detectors/<id>.md` files from a shared template so 14+ near-identical files cannot drift. A pure `runner/detector-match.js` intersects changed files against each detector's glob + cheap pre-filter pattern, so a detector's LLM only spawns on a real candidate match. A new `pipeline:needs-detector-gate` state (inserted right after `needs-code-review`) triggers `runner/detector-gate.js`, which fans out the matched detectors in diff-mode, persists `.pipeline/reviews/<pr>/detector-<id>.json`, and computes a deterministic severity-tiered gate. The scanner shrinks to a "frontier scanner" that proposes new detectors.

**Tech Stack:** Node ≥18 ESM, zero runtime dependencies. Tests use the built-in `node --test` runner + `node:assert/strict` (run via `npm run test:unit`). Agents are markdown files dispatched by `runner/dispatch.js` (`claude -p --agent`).

**Spec:** `docs/superpowers/specs/2026-06-15-cap-detector-decomposition-design.md`

---

## File Structure

**New files:**
- `detectors.registry.json` — single source of truth: one entry per detector.
- `agents/detectors/_template.md` — shared agent body with `${...}` placeholders.
- `agents/detectors/<id>.md` — 14 generated per-rule detector agents.
- `scripts/gen-detector.js` — registry → `.md` generator + sync validator.
- `runner/detector-match.js` — pure glob + pre-filter matcher (+ a tiny `globToRegExp`).
- `runner/verdict.js` — extract a fenced ```json``` verdict from a run's final message.
- `runner/detector-gate.js` — diff-mode fan-out, verdict persistence, severity gate.
- Tests under `test/unit/`: `detector-registry.test.js`, `gen-detector.test.js`, `detector-match.test.js`, `verdict.test.js`, `detector-gate.test.js`, `detector-gate-state.test.js`.

**Modified files:**
- `api/index.js` — add `'needs-detector-gate'` to `STATES`.
- `agents/orchestrator.md` — replace round-robin sweep with glob-matched dispatch; add the `needs-detector-gate` trigger rule; remove the catch-all scanner slot.
- `agents/scanner.md` — shrink to the frontier scanner.
- `agents/ticket-creator.md` — strengthen 1-finding-1-ticket; carry `detector:<id>` provenance + single `file:line`.
- `config.schema.json` — add `detectors` block + `maxAutoFixDiffLines`.
- `manifest.json` — register the new agents (done by the generator).

---

## Phase 1 — Registry, template, generator, detector agents

### Task 1: Detector registry + shape test

**Files:**
- Create: `detectors.registry.json`
- Test: `test/unit/detector-registry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/detector-registry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = JSON.parse(readFileSync(join(root, 'detectors.registry.json'), 'utf8'));

const MODES = new Set(['sweep', 'diff', 'both']);
const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);
const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const ROUTES = new Set(['ticket-creator', 'dead-code-remover', 'glossary-maintainer']);

test('registry is a non-empty array with unique ids', () => {
  assert.ok(Array.isArray(registry.detectors), 'registry.detectors must be an array');
  assert.ok(registry.detectors.length >= 14, 'expected at least 14 detectors');
  const ids = registry.detectors.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length, 'detector ids must be unique');
});

test('every detector entry has valid required fields', () => {
  for (const d of registry.detectors) {
    assert.match(d.id, /^[a-z0-9-]+$/, `bad id: ${d.id}`);
    assert.ok(d.title && typeof d.title === 'string', `${d.id}: title required`);
    assert.ok(d.glob && typeof d.glob === 'string', `${d.id}: glob required`);
    assert.ok(d.prefilterPattern && typeof d.prefilterPattern === 'string', `${d.id}: prefilterPattern required`);
    assert.doesNotThrow(() => new RegExp(d.prefilterPattern), `${d.id}: prefilterPattern must be valid regex`);
    assert.ok(MODELS.has(d.model), `${d.id}: bad model ${d.model}`);
    assert.ok(MODES.has(d.mode), `${d.id}: bad mode ${d.mode}`);
    assert.ok(SEVERITIES.has(d.severity), `${d.id}: bad severity ${d.severity}`);
    assert.ok(ROUTES.has(d.routesTo), `${d.id}: bad routesTo ${d.routesTo}`);
    assert.ok(d.detect && d.detect.length > 20, `${d.id}: detect description required`);
    assert.ok(d.suggestedFix && d.suggestedFix.length > 10, `${d.id}: suggestedFix required`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-registry.test.js`
Expected: FAIL — `ENOENT` opening `detectors.registry.json`.

- [ ] **Step 3: Create the registry with all 14 entries**

```json
{
  "$comment": "Single source of truth for per-rule detectors. agents/detectors/<id>.md is generated from this by scripts/gen-detector.js. severity is the default for sweep findings; diff-mode findings carry their own per-instance severity.",
  "detectors": [
    {
      "id": "ts-suppression",
      "title": "Unjustified TypeScript suppression",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "@ts-(nocheck|ignore|expect-error)",
      "model": "haiku",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "A `@ts-nocheck`, `@ts-ignore`, or `@ts-expect-error` comment that has NO justification comment on the same or adjacent line explaining why the suppression is necessary. A suppression WITH a clear written reason is NOT a finding.",
      "suggestedFix": "Remove the suppression and fix the underlying type error, or add a one-line justification comment explaining why the suppression is unavoidable."
    },
    {
      "id": "unjustified-any",
      "title": "Unjustified `any`",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "\\bas any\\b|:\\s*any\\b|<any>",
      "model": "haiku",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "An `any` type — `as any`, `: any`, or `<any>` — with no adjacent justification comment. Ignore `any` in `.d.ts` ambient declarations and in third-party type shims. A cast to `any` immediately narrowed back to a real type on the next line is still a finding.",
      "suggestedFix": "Replace `any` with the real type, `unknown` + a type guard, or a generic. If genuinely unavoidable, add a justification comment."
    },
    {
      "id": "unjustified-eslint-disable",
      "title": "Unjustified eslint-disable",
      "glob": "src/**/*.{ts,tsx,js,jsx}",
      "prefilterPattern": "eslint-disable",
      "model": "haiku",
      "mode": "both",
      "severity": "minor",
      "routesTo": "ticket-creator",
      "detect": "An `eslint-disable` or `eslint-disable-next-line` directive with no trailing comment explaining why the rule is being disabled. A disable WITH a written reason is NOT a finding. A bare `eslint-disable` (whole-file, no rule named) is always a finding.",
      "suggestedFix": "Fix the lint violation, or name the specific rule and add a justification after the directive."
    },
    {
      "id": "todo-without-ticket",
      "title": "TODO without a ticket reference",
      "glob": "src/**/*.{ts,tsx,js,jsx}",
      "prefilterPattern": "TODO|FIXME|HACK",
      "model": "haiku",
      "mode": "both",
      "severity": "minor",
      "routesTo": "ticket-creator",
      "detect": "A `TODO`, `FIXME`, or `HACK` comment with no ticket reference (e.g. `CER-123` or a URL). A comment that references a tracking ticket is NOT a finding.",
      "suggestedFix": "File a ticket for the deferred work and reference its id in the comment, or resolve it and delete the comment."
    },
    {
      "id": "catch-only-console",
      "title": "Catch that only logs",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "catch\\s*\\(",
      "model": "sonnet",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "A `catch` block whose ONLY effect is a `console.error`/`warn`/`log` — no user-facing feedback (toast, error state, surfaced message), no rethrow, no recovery. The error is silently swallowed from the user's perspective. A catch that sets error state, shows a toast, or rethrows is NOT a finding.",
      "suggestedFix": "Surface the failure to the user (toast / error state) or rethrow; keep the console log only as a secondary diagnostic."
    },
    {
      "id": "server-data-manual-effect",
      "title": "Manual effect for server data",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "useEffect",
      "model": "sonnet",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "A `useState` + `useEffect` (often + `useCallback`) pattern that fetches SERVER data (calls a service/api, awaits a fetch) and stores it in local state, instead of using React Query (`useQuery`/`useMutation`). Effects that compute from props, subscribe to non-server events, or sync the DOM are NOT findings.",
      "suggestedFix": "Replace the manual fetch-into-state with a `useQuery`/`useMutation` hook following the project's data-pipeline convention."
    },
    {
      "id": "naming-convention",
      "title": "Naming-convention violation",
      "glob": "src/**/*",
      "prefilterPattern": ".",
      "model": "haiku",
      "mode": "both",
      "severity": "minor",
      "routesTo": "ticket-creator",
      "detect": "A file or folder name that violates `.claude/rules/naming-conventions.md` (read that rule file before flagging). Only flag concrete violations of a stated rule; do not invent conventions.",
      "suggestedFix": "Rename the file/folder to match the documented convention and update its imports."
    },
    {
      "id": "test-without-assertion",
      "title": "Test with no assertion",
      "glob": "src/**/*.{test,spec}.{ts,tsx}",
      "prefilterPattern": "\\b(it|test)\\s*\\(",
      "model": "haiku",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "A test body (`it(...)`/`test(...)`) that contains no assertion — no `expect`, no `assert`, no `toThrow`, no explicit failure. A test that only renders without asserting is a finding. Setup-only helpers invoked by other tests are NOT findings.",
      "suggestedFix": "Add an assertion that captures the behavior under test, or delete the empty test."
    },
    {
      "id": "skipped-test-without-ticket",
      "title": "Skipped/focused test",
      "glob": "src/**/*.{test,spec}.{ts,tsx}",
      "prefilterPattern": "\\.(skip|only)\\b|\\bx(it|describe)\\b",
      "model": "haiku",
      "mode": "both",
      "severity": "major",
      "routesTo": "ticket-creator",
      "detect": "A `.skip`/`xit`/`xdescribe` with no ticket reference explaining why it is skipped, OR any `.only` (focused tests must never land — always a finding regardless of comment).",
      "suggestedFix": "Remove `.only`; for skips, either re-enable the test or reference the ticket tracking why it is disabled."
    },
    {
      "id": "unused-export",
      "title": "Unused export",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "export\\b",
      "model": "sonnet",
      "mode": "sweep",
      "severity": "minor",
      "routesTo": "dead-code-remover",
      "detect": "An exported symbol (function/const/type/component) that is never imported anywhere in `src/`. Exclude public entrypoints (index barrels re-exported by package consumers), test utilities, and framework-required exports (e.g. Next.js page default exports, Storybook stories).",
      "suggestedFix": "Delete the unused export (and the symbol if nothing else uses it), or wire it up if it was meant to be consumed."
    },
    {
      "id": "orphaned-module",
      "title": "Orphaned module",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": ".",
      "model": "sonnet",
      "mode": "sweep",
      "severity": "minor",
      "routesTo": "dead-code-remover",
      "detect": "A component/hook/service module whose exports are imported only from within its own folder, or not at all — an island disconnected from the app. Distinguish from `unused-export`: this is whole-module orphaning. Exclude entrypoints and test files.",
      "suggestedFix": "Remove the orphaned module, or connect it to the feature that was meant to use it."
    },
    {
      "id": "commented-out-block",
      "title": "Commented-out code block",
      "glob": "src/**/*.{ts,tsx,js,jsx}",
      "prefilterPattern": "//|/\\*",
      "model": "haiku",
      "mode": "both",
      "severity": "minor",
      "routesTo": "dead-code-remover",
      "detect": "A contiguous block of commented-out CODE longer than 10 lines (configurable). Prose comments, JSDoc, and short illustrative snippets are NOT findings — only disabled real code.",
      "suggestedFix": "Delete the commented-out code (git history preserves it)."
    },
    {
      "id": "unreachable-code",
      "title": "Unreachable code",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": "return|throw|break|continue",
      "model": "sonnet",
      "mode": "both",
      "severity": "major",
      "routesTo": "dead-code-remover",
      "detect": "Code after an unconditional `return`/`throw`/`break`/`continue` in the same block, or a branch whose condition is statically always-false/always-true making a branch dead.",
      "suggestedFix": "Remove the unreachable code or fix the control flow that made it unreachable."
    },
    {
      "id": "terminology-drift",
      "title": "Terminology drift",
      "glob": "src/**/*.{ts,tsx}",
      "prefilterPattern": ".",
      "model": "sonnet",
      "mode": "sweep",
      "severity": "nit",
      "routesTo": "glossary-maintainer",
      "detect": "A domain term used in a way that is absent from or conflicts with `docs/glossary.md`. Only fires when a glossary exists. Read the glossary entry before flagging; never paraphrase a definition.",
      "suggestedFix": "Align the usage with the glossary, or file a glossary update if the term genuinely evolved."
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/detector-registry.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add detectors.registry.json test/unit/detector-registry.test.js
git commit -m "feat(detectors): add detector registry (single source of truth) + shape test"
```

---

### Task 2: Shared detector template

**Files:**
- Create: `agents/detectors/_template.md`

- [ ] **Step 1: Create the template**

The generator substitutes `${id}`, `${title}`, `${model}`, `${mode}`, `${severity}`, `${glob}`, `${routesTo}`, `${detect}`, `${suggestedFix}`. Leave the `${...}` tokens literally in the file — Task 3's test asserts they exist.

```markdown
---
name: ${id}-detector
model: ${model}
---

# ${title} Detector

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms. If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer. Never paraphrase a definition — read the glossary entry or ask.

**Role**: ${title}. Single responsibility — if it's not this exact issue class, don't file it.
**Scope**: `${glob}` in ${REPO_SLUG} only. No code edits, no PRs.
**Provenance**: `agent:${id}-detector` / `detector:${id}`
**Default severity**: ${severity} (override per-instance when the impact differs).
**Modes**: ${mode}

## What to Detect (and ONLY this)

${detect}

## Suggested Fix

${suggestedFix}

## Mode: sweep (codebase scan → ticket)

Triggered with a list of changed files (or a full `src/` sweep). For each real instance, write a finding file to `.pipeline/findings/${id}-<YYYY-MM-DD>-<counter>-<kebab-slug>.md`:

\```markdown
---
detector: ${id}
severity: ${severity}
routesTo: ${routesTo}
labels: pipeline:needs-triage
fingerprint: ${id}:<file-path>:<line>
---

# [${id}] <short title>

**File**: \`<path>:<line>\`

## Problem
<what's wrong and why, specific to this instance>

## Suggested fix
<concrete fix>
\```

Before filing, check `.pipeline/findings/filed/` for the same `fingerprint:` — if present, skip (already ticketed). Max 15 findings per cycle; report any overflow as a count.

## Mode: diff-gate (PR diff → verdict)

Triggered with a PR diff. Judge ONLY the added/changed lines. Emit your verdict as your **final message**, a single fenced ```json``` block (the runner parses it and writes the verdict file — you do not write files in this mode):

\```json
{
  "verdict": "pass" | "veto",
  "summary": "one line",
  "findings": [
    { "severity": "blocker|major|minor|nit", "file": "src/x.ts", "line": 12, "title": "...", "detail": "..." }
  ]
}
\```

Set `verdict: "veto"` if and only if you emit at least one `blocker` or `major` finding. `minor`/`nit` findings still go in the array but do not by themselves veto.

## Report Format (sweep mode, under 150 words)

\```
[agent:${id}-detector] Scan complete
Findings filed: <N> (suppressed dedup: <M>)
Top examples: <file:line — short>, ...
\```
```

- [ ] **Step 2: Commit**

```bash
git add agents/detectors/_template.md
git commit -m "feat(detectors): shared detector agent template"
```

---

### Task 3: Generator + sync validator

**Files:**
- Create: `scripts/gen-detector.js`
- Test: `test/unit/gen-detector.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gen-detector.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetector, validateSync } from '../../scripts/gen-detector.js';

const entry = {
  id: 'unjustified-any', title: 'Unjustified `any`', glob: 'src/**/*.{ts,tsx}',
  prefilterPattern: ':\\s*any\\b', model: 'haiku', mode: 'both', severity: 'major',
  routesTo: 'ticket-creator', detect: 'An any type with no justification comment nearby.',
  suggestedFix: 'Replace any with the real type.',
};
const template = [
  '---', 'name: ${id}-detector', 'model: ${model}', '---',
  '# ${title} Detector', 'mode ${mode} sev ${severity} glob ${glob} routes ${routesTo}',
  '${detect}', '${suggestedFix}',
].join('\n');

test('renderDetector substitutes every token and leaves none behind', () => {
  const out = renderDetector(template, entry);
  assert.ok(out.includes('name: unjustified-any-detector'));
  assert.ok(out.includes('model: haiku'));
  assert.ok(out.includes('# Unjustified `any` Detector'));
  assert.ok(out.includes('mode both sev major glob src/**/*.{ts,tsx} routes ticket-creator'));
  assert.ok(out.includes('An any type with no justification comment nearby.'));
  assert.ok(!/\$\{[a-zA-Z]+\}/.test(out), 'no unsubstituted ${...} tokens may remain');
});

test('validateSync flags a registry id with no generated file', () => {
  const res = validateSync(['unjustified-any', 'ts-suppression'], ['unjustified-any']);
  assert.deepEqual(res.missingFiles, ['ts-suppression']);
  assert.deepEqual(res.orphanFiles, []);
});

test('validateSync flags a generated file with no registry entry', () => {
  const res = validateSync(['unjustified-any'], ['unjustified-any', 'stale-detector']);
  assert.deepEqual(res.missingFiles, []);
  assert.deepEqual(res.orphanFiles, ['stale-detector']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gen-detector.test.js`
Expected: FAIL — cannot import `scripts/gen-detector.js`.

- [ ] **Step 3: Write the generator**

```js
// scripts/gen-detector.js
// Generates agents/detectors/<id>.md from detectors.registry.json + _template.md.
// Pure helpers (renderDetector, validateSync) are exported for tests; the CLI
// entry (run directly) writes files and updates manifest.json.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOKENS = ['id', 'title', 'glob', 'model', 'mode', 'severity', 'routesTo', 'detect', 'suggestedFix'];

export function renderDetector(template, entry) {
  let out = template;
  for (const t of TOKENS) {
    out = out.split('${' + t + '}').join(String(entry[t] ?? ''));
  }
  return out;
}

/** @returns {{missingFiles:string[], orphanFiles:string[]}} */
export function validateSync(registryIds, fileIds) {
  const reg = new Set(registryIds), files = new Set(fileIds);
  return {
    missingFiles: registryIds.filter(id => !files.has(id)),
    orphanFiles: fileIds.filter(id => !reg.has(id)),
  };
}

function detectorFileIds(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== '_template.md')
    .map(f => f.replace(/\.md$/, ''));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const registry = JSON.parse(readFileSync(join(root, 'detectors.registry.json'), 'utf8'));
  const template = readFileSync(join(root, 'agents/detectors/_template.md'), 'utf8');
  const outDir = join(root, 'agents/detectors');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const ids = registry.detectors.map(d => d.id);
  for (const entry of registry.detectors) {
    writeFileSync(join(outDir, `${entry.id}.md`), renderDetector(template, entry));
  }
  const { orphanFiles } = validateSync(ids, detectorFileIds(outDir));
  if (orphanFiles.length) {
    console.error(`[gen-detector] orphan files with no registry entry: ${orphanFiles.join(', ')}`);
    process.exitCode = 1;
  }

  // Register detectors in manifest.json under agents (idempotent).
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.agents ||= {};
  for (const entry of registry.detectors) {
    manifest.agents[`${entry.id}-detector`] ||= { path: `agents/detectors/${entry.id}.md`, stage: 'detect' };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[gen-detector] wrote ${ids.length} detectors`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/gen-detector.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-detector.js test/unit/gen-detector.test.js
git commit -m "feat(detectors): registry→agent generator with sync validation"
```

---

### Task 4: Generate the 14 detector agents

**Files:**
- Create: `agents/detectors/*.md` (14 files, generated)
- Modify: `manifest.json` (generator registers agents)
- Test: extend `test/unit/detector-registry.test.js`

- [ ] **Step 1: Add a registry↔files sync test**

Append to `test/unit/detector-registry.test.js`:

```js
import { readdirSync, existsSync } from 'node:fs';
import { validateSync } from '../../scripts/gen-detector.js';

test('every registry detector has a generated agent file and vice versa', () => {
  const dir = join(root, 'agents', 'detectors');
  assert.ok(existsSync(dir), 'agents/detectors/ must exist');
  const fileIds = readdirSync(dir).filter(f => f.endsWith('.md') && f !== '_template.md').map(f => f.replace(/\.md$/, ''));
  const ids = registry.detectors.map(d => d.id);
  const { missingFiles, orphanFiles } = validateSync(ids, fileIds);
  assert.deepEqual(missingFiles, [], `registry ids missing a .md: ${missingFiles}`);
  assert.deepEqual(orphanFiles, [], `.md files with no registry entry: ${orphanFiles}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-registry.test.js`
Expected: FAIL — `agents/detectors/` has no generated files yet.

- [ ] **Step 3: Run the generator**

Run: `node scripts/gen-detector.js`
Expected: stdout `[gen-detector] wrote 14 detectors`; 14 files appear under `agents/detectors/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/detector-registry.test.js && npm run test:unit`
Expected: PASS. Spot-check `agents/detectors/unjustified-any.md` contains no literal `${...}` tokens.

- [ ] **Step 5: Commit**

```bash
git add agents/detectors/ manifest.json test/unit/detector-registry.test.js
git commit -m "feat(detectors): generate 14 per-rule detector agents from registry"
```

---

## Phase 2 — Glob-matched sweep dispatch + frontier scanner

### Task 5: Glob + pre-filter matcher

**Files:**
- Create: `runner/detector-match.js`
- Test: `test/unit/detector-match.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/detector-match.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchDetectors } from '../../runner/detector-match.js';

test('globToRegExp handles **, *, {a,b}, and ?', () => {
  assert.match('src/a/b/c.ts', globToRegExp('src/**/*.ts'));
  assert.match('src/x.tsx', globToRegExp('src/**/*.{ts,tsx}'));
  assert.doesNotMatch('src/x.js', globToRegExp('src/**/*.{ts,tsx}'));
  assert.match('src/x.test.ts', globToRegExp('src/**/*.{test,spec}.{ts,tsx}'));
  assert.doesNotMatch('docs/x.ts', globToRegExp('src/**/*.ts'));
});

const registry = [
  { id: 'unjustified-any', glob: 'src/**/*.{ts,tsx}', prefilterPattern: ':\\s*any\\b', mode: 'both' },
  { id: 'skipped-test', glob: 'src/**/*.{test,spec}.{ts,tsx}', prefilterPattern: '\\.only\\b', mode: 'both' },
  { id: 'unused-export', glob: 'src/**/*.{ts,tsx}', prefilterPattern: 'export\\b', mode: 'sweep' },
];

test('matchDetectors fires only on glob hit AND prefilter hit', () => {
  const files = [
    { path: 'src/foo.ts', content: 'const x: any = 1;' },        // matches unjustified-any
    { path: 'src/foo.test.ts', content: 'it.only("x", () => {})' }, // matches skipped-test (+ glob of any, but no `: any`)
  ];
  const ids = matchDetectors(registry, files).map(d => d.id).sort();
  assert.deepEqual(ids, ['skipped-test', 'unjustified-any']);
});

test('matchDetectors can filter by mode', () => {
  const files = [{ path: 'src/foo.ts', content: 'export const y = 1;' }];
  assert.deepEqual(matchDetectors(registry, files, { mode: 'diff' }).map(d => d.id), []); // unused-export is sweep-only
  assert.deepEqual(matchDetectors(registry, files, { mode: 'sweep' }).map(d => d.id), ['unused-export']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-match.test.js`
Expected: FAIL — cannot import `runner/detector-match.js`.

- [ ] **Step 3: Write the matcher**

```js
// runner/detector-match.js
// Pure: given detector registry entries + changed files (path+content), return
// the detectors whose glob matches a file AND whose prefilter pattern appears in it.
// Zero deps; minimal glob support (**, *, ?, {a,b}).

/** Convert a glob to an anchored RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map(escapeRe).join('|');
      re += `(?:${alts})`; i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) { return s.replace(/[.+^$()|[\]\\]/g, '\\$&'); }

/**
 * @param {Array<{id,glob,prefilterPattern,mode}>} registry
 * @param {Array<{path:string, content:string}>} files
 * @param {{mode?: 'sweep'|'diff'}} [opts]
 * @returns {Array} matched registry entries (deduped)
 */
export function matchDetectors(registry, files, opts = {}) {
  const matched = new Map();
  for (const d of registry) {
    if (opts.mode && d.mode !== 'both' && d.mode !== opts.mode) continue;
    const globRe = globToRegExp(d.glob);
    let preRe;
    try { preRe = new RegExp(d.prefilterPattern); } catch { continue; }
    for (const f of files) {
      if (globRe.test(f.path) && preRe.test(f.content)) { matched.set(d.id, d); break; }
    }
  }
  return [...matched.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/detector-match.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/detector-match.js test/unit/detector-match.test.js
git commit -m "feat(detectors): pure glob + prefilter matcher for dispatch"
```

---

### Task 6: Orchestrator sweep dispatch (doc)

**Files:**
- Modify: `agents/orchestrator.md` (the detector-dispatch section, around the round-robin table)

- [ ] **Step 1: Replace the round-robin sweep rule for the new fleet**

In `agents/orchestrator.md`, find the bullet beginning "**Specialized detectors** … rotate round-robin — one per cycle" and the "**General scanner (catch-all)**" bullet. Replace the catch-all-scanner bullet and ADD a new bullet for the registry detectors (leave the existing 7 broad detectors' round-robin untouched — they are re-split lazily later):

```markdown
- **Registry detectors (glob-matched sweep)**: The per-rule detectors in `detectors.registry.json` are dispatched by changed files, not round-robin. Each cycle:
  1. Compute changed files since the last scan cursor: `git diff --name-only <lastScan>..main` (the cursor is the commit SHA recorded in `.pipeline/runs/last-scan` after the previous sweep).
  2. Load `detectors.registry.json`; using the same glob + prefilter logic as `runner/detector-match.js`, find detectors (`mode` = `sweep` or `both`) whose glob matches a changed file AND whose `prefilterPattern` appears in it.
  3. Dispatch ONLY those detectors in sweep-mode against the matched files (subject to the existing `maxAgentsPerCycle` cap and the 25-PR saturation backoff).
  4. After the sweep, write the current `main` SHA to `.pipeline/runs/last-scan`.
- **Periodic full sweep**: Every `config.detectors.fullSweepEveryNCycles` (default 20) cycles, ignore the cursor and run all `sweep`/`both` registry detectors whose prefilter matches anywhere under their glob in `src/`. This backstops detectors added since the last cursor and any cursor gaps.
- **General scanner is retired as a catch-all** — see the frontier-scanner role in `agents/scanner.md`; dispatch it only per its own (reduced) trigger.
```

- [ ] **Step 2: Verify the doc still parses / lists**

Run: `node bin/cli.js list-agents > /dev/null && echo ok`
Expected: `ok` (no agent-loading errors introduced by the edit).

- [ ] **Step 3: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(detectors): glob-matched sweep dispatch replaces round-robin catch-all"
```

---

### Task 7: Shrink scanner to frontier scanner

**Files:**
- Modify: `agents/scanner.md`

- [ ] **Step 1: Rewrite scanner.md as the frontier scanner**

Replace the body of `agents/scanner.md` (keep the terminology preamble at top) with:

```markdown
**Role**: Frontier scanner. Find issue CLASSES that no existing detector covers yet, and propose a NEW detector for them. Do NOT re-file issues any registry detector or the 7 broad detectors already own.

**Input**: Periodic dispatch (the orchestrator runs this infrequently — every ~10 cycles).
**Output**: A `domain:pipeline-improvement` finding proposing a new detector → `agent-improver`.
**Scope**: ${REPO_SLUG} `src/` only. No code edits.

## What to do

1. Read `detectors.registry.json` and the existing `agents/*-detector.md` to learn what is already covered.
2. Scan `src/` for recurring quality problems that fall OUTSIDE every covered class.
3. For each genuinely new class (seen ≥3 times), file ONE improvement finding to `.pipeline/findings/pipeline-improvement-<date>-<slug>.md` proposing a new detector: a draft registry entry (`id`, `glob`, `prefilterPattern`, `model`, `mode`, `severity`, `routesTo`, `detect`, `suggestedFix`) plus 2–3 real example sites.

## What NOT to do

- Do NOT file individual instances of an already-covered class — that is the relevant detector's job.
- Do NOT propose a detector for a one-off; require a recurring pattern (≥3 instances).
- Do NOT edit the registry yourself — `agent-improver` reviews and lands new detectors.
```

- [ ] **Step 2: Verify**

Run: `node bin/cli.js list-agents > /dev/null && echo ok`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add agents/scanner.md
git commit -m "refactor(scanner): shrink to frontier scanner that proposes new detectors"
```

---

## Phase 3 — Diff-gate stage + runner

### Task 8: Add the `needs-detector-gate` pipeline state

**Files:**
- Modify: `api/index.js` (the `STATES` array)
- Test: `test/unit/detector-gate-state.test.js`

- [ ] **Step 1: Write the failing test** (mirrors the existing `gate-states.test.js` pattern)

```js
// test/unit/detector-gate-state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../api/index.js';

test('needs-detector-gate sits immediately after needs-code-review', () => {
  assert.ok(STATES.includes('needs-detector-gate'), 'needs-detector-gate missing');
  const cr = STATES.indexOf('needs-code-review');
  const dg = STATES.indexOf('needs-detector-gate');
  assert.equal(dg, cr + 1, `expected detector-gate right after code-review, got cr=${cr} dg=${dg}`);
});

test('detector-gate precedes the regression/feature gates and ready-for-human', () => {
  const dg = STATES.indexOf('needs-detector-gate');
  const rh = STATES.indexOf('ready-for-human');
  assert.ok(dg < rh, 'detector-gate must precede ready-for-human');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-gate-state.test.js`
Expected: FAIL — `needs-detector-gate missing`.

- [ ] **Step 3: Insert the state**

In `api/index.js`, edit the `STATES` array to insert `'needs-detector-gate'` between `'needs-code-review'` and `'needs-regression-check'`:

```js
  'needs-code-review',
  'needs-detector-gate',
  'needs-regression-check',
  'needs-feature-validation',
```

- [ ] **Step 4: Run tests to verify pass (incl. the existing gate-states test still passes)**

Run: `node --test test/unit/detector-gate-state.test.js test/unit/gate-states.test.js`
Expected: PASS — both the new test and the existing order test (code-review < regression < feature < ready still holds with detector-gate inserted before regression).

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/unit/detector-gate-state.test.js
git commit -m "feat(detectors): add needs-detector-gate pipeline state after code-review"
```

---

### Task 9: Verdict extractor

**Files:**
- Create: `runner/verdict.js`
- Test: `test/unit/verdict.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/verdict.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerdict } from '../../runner/verdict.js';

test('extracts a fenced json verdict from a messy final message', () => {
  const msg = 'Here is my review.\n```json\n{ "verdict": "veto", "findings": [{"severity":"major","file":"a.ts","line":1,"title":"x","detail":"y"}] }\n```\nDone.';
  const v = extractVerdict(msg);
  assert.equal(v.verdict, 'veto');
  assert.equal(v.findings.length, 1);
});

test('missing or unparseable verdict fails closed (synthetic veto)', () => {
  assert.equal(extractVerdict('no json here').verdict, 'veto');
  assert.equal(extractVerdict('').verdict, 'veto');
  assert.equal(extractVerdict('```json\n{ not valid }\n```').verdict, 'veto');
  assert.match(extractVerdict('nothing').reason, /malformed-or-missing/);
});

test('a pass verdict with no findings parses cleanly', () => {
  const v = extractVerdict('```json\n{"verdict":"pass","findings":[]}\n```');
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.findings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/verdict.test.js`
Expected: FAIL — cannot import `runner/verdict.js`.

- [ ] **Step 3: Write the extractor**

```js
// runner/verdict.js
// Extract a strict JSON verdict from an agent's final message. Fail-closed:
// anything missing/unparseable becomes a synthetic veto.

const SYNTHETIC_VETO = { verdict: 'veto', summary: 'malformed or missing verdict', findings: [], reason: 'malformed-or-missing' };

/** @param {string} finalMessage @returns {{verdict:'pass'|'veto', summary?:string, findings:any[], reason?:string}} */
export function extractVerdict(finalMessage) {
  if (!finalMessage || typeof finalMessage !== 'string') return { ...SYNTHETIC_VETO };
  const block = finalMessage.match(/```json\s*([\s\S]*?)```/i);
  const raw = block ? block[1] : finalMessage;
  let parsed;
  try { parsed = JSON.parse(raw.trim()); }
  catch { return { ...SYNTHETIC_VETO }; }
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'veto')) return { ...SYNTHETIC_VETO };
  return { verdict: parsed.verdict, summary: parsed.summary || '', findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/verdict.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/verdict.js test/unit/verdict.test.js
git commit -m "feat(detectors): fail-closed verdict extractor for diff-gate"
```

---

### Task 10: Severity-tiered gate aggregation

**Files:**
- Create: `runner/detector-gate.js`
- Test: `test/unit/detector-gate.test.js`

The runner's fan-out (dispatch matched detectors in parallel) wraps `runner/dispatch.js` and is integration-tested via the e2e harness; this task unit-tests the **pure gate aggregation**, which is the decision logic Spec B will also rely on.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/detector-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGate } from '../../runner/detector-gate.js';

test('all pass / only minor → ready-for-human', () => {
  const r = computeGate([
    { verdict: 'pass', findings: [] },
    { verdict: 'pass', findings: [{ severity: 'minor', title: 'm' }, { severity: 'nit', title: 'n' }] },
  ]);
  assert.equal(r.gate, 'pass');
  assert.equal(r.nextState, 'needs-detector-gate->advance');
  assert.equal(r.blocking.length, 0);
});

test('any major → veto → needs-feedback', () => {
  const r = computeGate([{ verdict: 'pass', findings: [{ severity: 'major', title: 'big' }] }]);
  assert.equal(r.gate, 'veto');
  assert.equal(r.label, 'needs-feedback');
  assert.equal(r.blocking.length, 1);
});

test('an explicit veto verdict with no findings still vetoes', () => {
  assert.equal(computeGate([{ verdict: 'veto', findings: [] }]).gate, 'veto');
});

test('a synthetic/malformed veto (fail-closed) vetoes', () => {
  assert.equal(computeGate([{ verdict: 'veto', findings: [], reason: 'malformed-or-missing' }]).gate, 'veto');
});

test('empty verdict set passes (no detector matched the diff)', () => {
  assert.equal(computeGate([]).gate, 'pass');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-gate.test.js`
Expected: FAIL — cannot import `runner/detector-gate.js`.

- [ ] **Step 3: Write the gate (pure aggregation + a documented fan-out entry)**

```js
// runner/detector-gate.js
// Diff-gate for the needs-detector-gate stage.
// computeGate() is the pure, deterministic decision Spec B reuses.
// runDetectorGate() fans out matched detectors in diff-mode and persists verdicts.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from './dispatch.js';
import { matchDetectors } from './detector-match.js';
import { extractVerdict } from './verdict.js';
import { getRunEvents } from '../api/runs.js';

const BLOCKING = new Set(['blocker', 'major']);

/** Pure gate over a set of provider verdicts. @param {Array<{verdict,findings,reason?}>} verdicts */
export function computeGate(verdicts) {
  const blocking = [];
  let veto = false;
  for (const v of verdicts) {
    if (v.verdict === 'veto') veto = true;
    for (const f of v.findings || []) if (BLOCKING.has(f.severity)) { veto = true; blocking.push(f); }
  }
  return veto
    ? { gate: 'veto', label: 'needs-feedback', blocking }
    : { gate: 'pass', label: 'advance', nextState: 'needs-detector-gate->advance', blocking: [] };
}

/** Read a completed run's final assistant text from its events log. */
function finalMessageOf(target, runId) {
  const events = getRunEvents(target, runId); // array of normalized events
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant') {
      const blocks = e.raw?.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text.trim()) return text;
      }
    }
  }
  return '';
}

/**
 * Fan out matched diff-mode detectors for a PR, persist verdicts, compute the gate.
 * @param {{target:string, pr:string, changedFiles:Array<{path,content}>, registry:any[], diffPrompt:(d:any)=>string}} o
 */
export async function runDetectorGate({ target, pr, changedFiles, registry, diffPrompt }) {
  const matched = matchDetectors(registry, changedFiles, { mode: 'diff' });
  const reviewsDir = join(target, '.pipeline', 'reviews', String(pr));
  mkdirSync(reviewsDir, { recursive: true });

  const verdicts = await Promise.all(matched.map(async (d) => {
    const h = dispatch({ agent: `${d.id}-detector`, prompt: diffPrompt(d), target, model: d.model });
    const run = await h.result;
    const verdict = run.status === 'completed'
      ? extractVerdict(finalMessageOf(target, run.runId))
      : { verdict: 'veto', findings: [], reason: 'malformed-or-missing' }; // crash → fail-closed
    writeFileSync(join(reviewsDir, `detector-${d.id}.json`), JSON.stringify({ detector: d.id, ...verdict }, null, 2));
    return verdict;
  }));

  const result = computeGate(verdicts);
  writeFileSync(join(reviewsDir, 'detector-gate.json'), JSON.stringify(result, null, 2));
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/detector-gate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/detector-gate.js test/unit/detector-gate.test.js
git commit -m "feat(detectors): severity-tiered diff-gate runner + pure gate aggregation"
```

---

### Task 11: Config + orchestrator gate trigger

**Files:**
- Modify: `config.schema.json`
- Modify: `agents/orchestrator.md`
- Test: extend `test/unit/detector-gate-state.test.js` with a config-shape check

- [ ] **Step 1: Write the failing test**

Append to `test/unit/detector-gate-state.test.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root2, 'config.schema.json'), 'utf8'));

test('config schema declares detectors block and maxAutoFixDiffLines', () => {
  assert.ok(schema.properties.detectors, 'detectors property missing');
  assert.ok(schema.properties.detectors.properties.diffGate, 'detectors.diffGate missing');
  assert.ok(schema.properties.detectors.properties.fullSweepEveryNCycles, 'fullSweepEveryNCycles missing');
  assert.equal(schema.properties.maxAutoFixDiffLines.type, 'integer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/detector-gate-state.test.js`
Expected: FAIL — `detectors property missing`.

- [ ] **Step 3: Add the config properties**

In `config.schema.json`, add to the top-level `properties` object:

```json
"detectors": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "registryPath": { "type": "string", "default": "detectors.registry.json" },
    "fullSweepEveryNCycles": { "type": "integer", "default": 20, "minimum": 1 },
    "diffGate": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "enabled": { "type": "boolean", "default": true } }
    }
  }
},
"maxAutoFixDiffLines": { "type": "integer", "default": 150, "minimum": 1 }
```

- [ ] **Step 4: Add the orchestrator trigger rule**

In `agents/orchestrator.md`, add a dispatch rule alongside the other gate states:

```markdown
- **`pipeline:needs-detector-gate`** (only when `config.detectors.diffGate.enabled`, default true): trigger `runner/detector-gate.js` for the PR. It fans out the diff-mode detectors whose glob+prefilter match the PR's changed files, persists `.pipeline/reviews/<pr>/detector-*.json`, and computes the severity gate: any `blocker`/`major` (or any `veto`) → re-label `pipeline:needs-feedback` (feedback-responder consumes it); otherwise advance to the next state (`pipeline:needs-regression-check`, or `pipeline:ready-for-human` if the regression/feature gates are disabled). When `diffGate.enabled` is false, `code-reviewer` advances straight past this state with no panel.
```

- [ ] **Step 5: Run tests + smoke**

Run: `node --test test/unit/detector-gate-state.test.js && node bin/cli.js list-agents > /dev/null && echo ok`
Expected: PASS, then `ok`.

- [ ] **Step 6: Commit**

```bash
git add config.schema.json agents/orchestrator.md test/unit/detector-gate-state.test.js
git commit -m "feat(detectors): config block + orchestrator needs-detector-gate trigger"
```

---

## Phase 4 — Small-PR discipline

### Task 12: One-finding-one-ticket + size cap + provenance

**Files:**
- Modify: `agents/ticket-creator.md`
- Modify: `agents/worker.md`

- [ ] **Step 1: Strengthen ticket-creator for detector findings**

In `agents/ticket-creator.md`, near the existing "One issue per ticket" rule (line ~182), add:

```markdown
### Detector findings: strictly 1 finding = 1 ticket

A detector finding file in `.pipeline/findings/` maps to **exactly one** ticket — never bundle multiple findings, even from the same detector or the same file. Each created ticket MUST carry:
- the `detector:<id>` provenance label (from the finding's `detector:` frontmatter),
- a single `file:line` location,
- a scope line: "Fix ONLY this one issue; do not refactor surrounding code."

This 1:1 mapping is what makes each resulting PR tiny and revertible. If a finding is genuinely too large for one small PR, file it and add the `needs-split` label for human attention rather than bundling.
```

- [ ] **Step 2: Add the size cap to worker**

In `agents/worker.md`, add a guard:

```markdown
### Diff-size ceiling (revertibility guard)

Keep each PR within `config.maxAutoFixDiffLines` (default 150) changed lines. Before opening the PR, run `git diff --stat main...HEAD`. If the change exceeds the ceiling:
1. Do NOT open one large PR.
2. Either split the work into multiple sequential tickets (one tiny PR each), or, if it cannot be split, label the ticket `needs-split` and stop for human guidance.

Carry the originating `detector:<id>` label onto the PR so a single `git revert` of one PR cleanly undoes one detector's fix.
```

- [ ] **Step 3: Verify**

Run: `node bin/cli.js list-agents > /dev/null && echo ok`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add agents/ticket-creator.md agents/worker.md
git commit -m "feat(detectors): enforce 1-finding-1-ticket, diff-size cap, per-rule provenance"
```

---

## Final verification

- [ ] **Run the full unit suite**

Run: `npm run test:unit`
Expected: all unit tests pass, including `detector-registry`, `gen-detector`, `detector-match`, `verdict`, `detector-gate`, `detector-gate-state`, and the pre-existing `gate-states` / `orchestrator-*`.

- [ ] **Run the CLI smoke test**

Run: `npm test`
Expected: `cli smoke ok` (agents + presets load; the 14 new detectors load without error).

- [ ] **Confirm registry↔file sync holds**

Run: `node scripts/gen-detector.js && git diff --exit-code agents/detectors/ manifest.json`
Expected: no diff (generation is idempotent; committed files match the registry).

---

## Self-Review notes (author)

- **Spec coverage:** registry+generator (§Architecture/Components 1–3) → Tasks 1–4; cost-model pre-filter (§cost model) → Task 5; glob-matched sweep + frontier scanner (§Components 5–6) → Tasks 6–7; catalog (§catalog) → Task 1 registry; new gate stage + verdict store + severity gate (§Components 4, §gate semantics) → Tasks 8–11; small-PR discipline (§small-PR) → Task 12; config (§config) → Task 11.
- **Out of scope (unchanged):** autonomous merge (Spec B); re-splitting the existing 7 broad detectors; replacing the adversarial panel. The detector-gate is independent of the (unbuilt) `review-panel.js`.
- **Type consistency:** `matchDetectors(registry, files, {mode})`, `globToRegExp(glob)`, `extractVerdict(finalMessage)`, `computeGate(verdicts)`, `renderDetector(template, entry)`, `validateSync(registryIds, fileIds)` are referenced with identical signatures in their defining task and any caller (`runDetectorGate` uses `matchDetectors`/`extractVerdict`/`computeGate`).
