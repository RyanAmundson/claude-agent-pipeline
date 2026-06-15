# Regression Tester & Feature Validator Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two blocking gate agents — `regression-tester` and `feature-validator` — between code review and `ready-for-human`, so nothing reaches a human without (a) a blast-radius regression check and (b) screenshot-backed acceptance validation.

**Architecture:** Two new queue states (`needs-regression-check`, `needs-feature-validation`) are added to the canonical `STATES` list, the UI pipeline graph topology, and the docs/state-machine. `code-reviewer`'s pass transition is retargeted from `ready-for-human` to `needs-regression-check`. Each new agent is a prompt-driven Claude agent (`agents/*.md`) that supports both the GitHub-PR backend (labels) and the filesystem backend (`queue/*.sh`). The mechanical, testable seams are the API state list, the graph topology, and the queue-dir creation; the agent judgment itself is prompt-driven and untested (consistent with the rest of the pipeline's PR agents).

**Tech Stack:** Node ESM (`api/*.js`, `ui/public/*.js`), `node --test` unit tests, bash queue scripts, markdown agent definitions, `manifest.json` registry. Browser evidence via `agent-browser` CLI; targeted tests via Playwright/vitest with strict process discipline.

**Spec:** `docs/superpowers/specs/2026-06-15-regression-and-feature-validation-agents-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `api/index.js` | Canonical `STATES` list | Insert 2 states after `needs-code-review` |
| `api/index.d.ts` | `QueueState` union type | Add 2 states |
| `api/cycles.js` | `DISPATCH_STATE` agent→state map | Add 2 agent mappings |
| `ui/public/pipeline-graph.js` | Graph topology (NODES/EDGES/STAGES) | Add 2 nodes, retarget `spine:ready`, add spine + fail + dispatch edges, reflow x-coords, widen VIEW |
| `test/unit/gate-states.test.js` | Unit test for the new states + dispatch map | **New** |
| `test/ui/pipeline-graph.test.js` | Graph topology test | Update the `needs-code-review→ready-for-human` assertion; add new-transition assertions |
| `agents/regression-tester.md` | Regression gate agent prompt | **New** |
| `agents/feature-validator.md` | Feature-validation gate agent prompt | **New** |
| `manifest.json` | Agent registry | Register 2 agents |
| `agents/code-reviewer.md` | Code-review gate | Retarget On-Pass → `needs-regression-check` (both backends) |
| `scripts/demo-run-loop.sh` | Demo queue scaffolding | Add 2 queue dirs to `mkdir -p` |
| `commands/pipeline-init.md` | Init instructions | Add 2 queue dirs, 2 gh state labels, 2 provenance labels |
| `agents/orchestrator.md` | Dispatch tables | Add 2 state→agent rows in both tables |
| `agents/ORCHESTRATION.md` | Mermaid state diagram | Chain CodeReviewer → RegressionTester → FeatureValidator → `[*]` |
| `agents/PIPELINE.md` | Flow diagram + state/provenance/dispatch tables | Add the 2 gates throughout |

**Implementation note on `manifest.json`:** this file has **uncommitted edits on the current branch** (`feat/cap-adversarial-review`). Insert the two new agent entries with anchored `Edit` calls (relative to the existing `"data-validator":` and `"code-reviewer":` lines), never by overwriting the file.

---

### Task 1: Add the two gate states to the core API

**Files:**
- Create: `test/unit/gate-states.test.js`
- Modify: `api/index.js` (STATES array, ~line 30-42)
- Modify: `api/index.d.ts` (QueueState union, ~line 8-20)
- Modify: `api/cycles.js` (DISPATCH_STATE, ~line 35-44)

- [ ] **Step 1: Write the failing test**

Create `test/unit/gate-states.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../api/index.js';
import { DISPATCH_STATE } from '../../api/cycles.js';

test('STATES includes the two gate states in order after needs-code-review', () => {
  assert.ok(STATES.includes('needs-regression-check'), 'needs-regression-check missing');
  assert.ok(STATES.includes('needs-feature-validation'), 'needs-feature-validation missing');
  const cr = STATES.indexOf('needs-code-review');
  const rc = STATES.indexOf('needs-regression-check');
  const fv = STATES.indexOf('needs-feature-validation');
  const rh = STATES.indexOf('ready-for-human');
  assert.ok(cr < rc && rc < fv && fv < rh,
    `expected order code-review < regression < feature-validation < ready, got ${cr},${rc},${fv},${rh}`);
});

test('DISPATCH_STATE maps the two new gate agents to their states', () => {
  assert.equal(DISPATCH_STATE['regression-tester'], 'needs-regression-check');
  assert.equal(DISPATCH_STATE['feature-validator'], 'needs-feature-validation');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/gate-states.test.js`
Expected: FAIL — `needs-regression-check missing` and `DISPATCH_STATE['regression-tester']` is `undefined`.

- [ ] **Step 3: Add the two states to `api/index.js`**

In `api/index.js`, change the `STATES` array so the two new states sit between `needs-code-review` and `needs-feedback`:

```js
export const STATES = Object.freeze([
  'needs-triage',
  'needs-review',
  'needs-work',
  'in-progress',
  'needs-test-review',
  'needs-code-review',
  'needs-regression-check',
  'needs-feature-validation',
  'needs-feedback',
  'ready-for-human',
  'done',
  'needs-info',
  'obsolete',
]);
```

- [ ] **Step 4: Add the two states to the `QueueState` union in `api/index.d.ts`**

```ts
export type QueueState =
  | 'needs-triage'
  | 'needs-review'
  | 'needs-work'
  | 'in-progress'
  | 'needs-test-review'
  | 'needs-code-review'
  | 'needs-regression-check'
  | 'needs-feature-validation'
  | 'needs-feedback'
  | 'ready-for-human'
  | 'done'
  | 'needs-info'
  | 'obsolete';
```

- [ ] **Step 5: Add the dispatch mappings to `api/cycles.js`**

In the `DISPATCH_STATE` object, add the two agents (keep `branch-updater` last):

```js
export const DISPATCH_STATE = Object.freeze({
  'ticket-creator': 'needs-triage',
  'ticket-reviewer': 'needs-review',
  'worker': 'needs-work',
  'tester': 'needs-test-review',
  'code-reviewer': 'needs-code-review',
  'regression-tester': 'needs-regression-check',
  'feature-validator': 'needs-feature-validation',
  'feedback-responder': 'needs-feedback',
  'branch-updater': 'ready-for-human',
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/unit/gate-states.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full unit + UI suites to confirm no regressions**

Run: `npm run test:unit && npm run test:ui`
Expected: all pass EXCEPT possibly `test/ui/pipeline-graph.test.js` (it still asserts the old `needs-code-review → ready-for-human` spine edge — fixed in Task 2). If only that file fails on that assertion, proceed; otherwise investigate.

- [ ] **Step 8: Commit**

```bash
git add api/index.js api/index.d.ts api/cycles.js test/unit/gate-states.test.js
git commit -m "feat(api): add needs-regression-check and needs-feature-validation states"
```

---

### Task 2: Add the two gates to the UI pipeline graph topology

**Files:**
- Modify: `ui/public/pipeline-graph.js` (VIEW, NODES, EDGES, STAGES)
- Modify: `test/ui/pipeline-graph.test.js` (update + add transition assertions)

- [ ] **Step 1: Update the failing/old test assertion and add new-transition tests**

In `test/ui/pipeline-graph.test.js`, find the line asserting the old spine:

```js
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'ready-for-human'), ['spine:ready']);
```

Replace it with the new spine chain assertions, and add the fail-loop assertions. Use this block (place it inside the same `test(...)` that previously checked the spine, or add a new `test`):

```js
test('happy path chains code-review → regression → feature-validation → ready', () => {
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'needs-regression-check'), ['spine:regression']);
  assert.deepEqual(pathEdgesForMove('needs-regression-check', 'needs-feature-validation'), ['spine:featureval']);
  assert.deepEqual(pathEdgesForMove('needs-feature-validation', 'ready-for-human'), ['spine:ready']);
});

test('gate FAILs loop back to needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('needs-regression-check', 'needs-feedback'), ['fail:regression']);
  assert.deepEqual(pathEdgesForMove('needs-feature-validation', 'needs-feedback'), ['fail:featureval']);
});
```

Leave the existing `fail:test` / `fail:codereview` / `feedback:rereview` / human-reentry assertions unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ui/pipeline-graph.test.js`
Expected: FAIL — `pathEdgesForMove('needs-code-review','needs-regression-check')` returns `[]` (edge not defined yet), and the `every edge references defined nodes` test still passes.

- [ ] **Step 3: Widen the canvas and add the two nodes**

In `ui/public/pipeline-graph.js`, change `VIEW`:

```js
export const VIEW = { w: 1260, h: 560 };
```

Then reflow the spine x-coordinates and add the two new nodes. Replace the `NODES` object's state nodes with these coordinates (spine at `y: 250`, step 120; lower row at `y: 410`; right column at `x: 1150`):

```js
export const NODES = {
  scanner:                  { label: 'scan',        agent: 'scanner',            x: 70,   y: 250, kind: 'entry' },
  'needs-triage':           { label: 'triage',      agent: 'ticket-creator',     x: 190,  y: 250, kind: 'state', state: 'needs-triage' },
  'needs-review':           { label: 'review',      agent: 'ticket-reviewer',    x: 310,  y: 250, kind: 'state', state: 'needs-review' },
  'needs-work':             { label: 'work',        agent: 'worker',             x: 430,  y: 250, kind: 'state', state: 'needs-work', agentHome: false },
  'in-progress':            { label: 'in-progress', agent: 'worker',             x: 550,  y: 250, kind: 'state', state: 'in-progress' },
  'needs-test-review':      { label: 'test',        agent: 'tester',             x: 670,  y: 250, kind: 'state', state: 'needs-test-review' },
  'needs-code-review':      { label: 'code-review', agent: 'code-reviewer',      x: 790,  y: 250, kind: 'state', state: 'needs-code-review' },
  'needs-regression-check': { label: 'regression',  agent: 'regression-tester',  x: 910,  y: 250, kind: 'state', state: 'needs-regression-check' },
  'needs-feature-validation':{ label: 'validate',   agent: 'feature-validator',  x: 1030, y: 250, kind: 'state', state: 'needs-feature-validation' },
  'ready-for-human':        { label: 'ready',       agent: null,                 x: 1150, y: 250, kind: 'state', state: 'ready-for-human' },
  human:                    { label: '\u{1F464} human', agent: null,             x: 1150, y: 110, kind: 'human' },
  done:                     { label: 'done',        agent: 'cleanup',            x: 1150, y: 410, kind: 'exit',  state: 'done' },
  'needs-feedback':         { label: 'feedback',    agent: 'feedback-responder', x: 850,  y: 410, kind: 'state', state: 'needs-feedback' },
  'needs-info':             { label: 'needs-info',  agent: 'ticket-reviewer',    x: 310,  y: 410, kind: 'park',  state: 'needs-info', agentHome: false },
  obsolete:                 { label: 'obsolete',    agent: 'relevance-checker',  x: 430,  y: 410, kind: 'exit',  state: 'obsolete' },
  orchestrator:             { label: 'orchestrator', agent: 'orchestrator',      x: 600,  y: 40,  kind: 'meta' },
  detectors:                { label: 'detectors ⟳', agent: null,            x: 70,   y: 120, kind: 'feeder' },
  utility:                  { label: 'utility ⛭',   agent: null,            x: 190,  y: 120, kind: 'feeder' },
};
```

- [ ] **Step 4: Add/retarget the spine, fail, and dispatch edges**

In the `EDGES` array: (a) change `spine:ready` to start from `needs-feature-validation`; (b) add `spine:regression` and `spine:featureval`; (c) add `fail:regression` and `fail:featureval`; (d) add the two dispatch edges.

Replace the base-spine block's `spine:ready` line and the two preceding it with:

```js
  { id: 'spine:codereview',  from: 'needs-test-review', to: 'needs-code-review',      kind: 'spine',   bend: 0 },
  { id: 'spine:regression',  from: 'needs-code-review', to: 'needs-regression-check', kind: 'spine',   bend: 0 },
  { id: 'spine:featureval',  from: 'needs-regression-check', to: 'needs-feature-validation', kind: 'spine', bend: 0 },
  { id: 'spine:ready',       from: 'needs-feature-validation', to: 'ready-for-human', kind: 'spine',   bend: 0 },
```

In the review-fail loop block, after `fail:codereview`, add:

```js
  { id: 'fail:regression',   from: 'needs-regression-check',   to: 'needs-feedback', kind: 'loop', bend: 20 },
  { id: 'fail:featureval',   from: 'needs-feature-validation', to: 'needs-feedback', kind: 'loop', bend: 10 },
```

In the orchestrator dispatch block, after `dispatch:needs-code-review`, add:

```js
  { id: 'dispatch:needs-regression-check',  from: 'orchestrator', to: 'needs-regression-check',  kind: 'dispatch', bend: 35 },
  { id: 'dispatch:needs-feature-validation', from: 'orchestrator', to: 'needs-feature-validation', kind: 'dispatch', bend: 45 },
```

- [ ] **Step 5: Add the two stages to `STAGES`**

In the `STAGES` array, after the `needs-code-review` entry, add:

```js
  { node: 'needs-regression-check',   queue: 'needs-regression-check' },
  { node: 'needs-feature-validation', queue: 'needs-feature-validation' },
```

- [ ] **Step 6: Run the graph test to verify it passes**

Run: `node --test test/ui/pipeline-graph.test.js`
Expected: PASS — `every edge references defined nodes` holds (both new nodes exist), the new spine/fail transition assertions pass.

- [ ] **Step 7: Commit**

```bash
git add ui/public/pipeline-graph.js test/ui/pipeline-graph.test.js
git commit -m "feat(ui): add regression + feature-validation gates to pipeline graph"
```

---

### Task 3: Create the `regression-tester` agent

**Files:**
- Create: `agents/regression-tester.md`

- [ ] **Step 1: Write the agent definition**

Create `agents/regression-tester.md` with this exact content:

````markdown
---
name: regression-tester
description: >
  Use this agent to validate that a change did NOT negatively impact existing functionality.
  It computes the change's blast radius (changed exports → call-sites/importers → impacted and
  feature-adjacent areas), runs ONLY the impacted test subset, and visually verifies the changed
  screen plus adjacent screens with agent-browser. Invoke after code review passes and before a
  PR is handed to a human.

  Examples:
  - <example>
    Context: A PR passed code review and is labeled pipeline:needs-regression-check.
    user: "PR #612 passed code review — make sure it didn't break anything."
    assistant: "I'll use the regression-tester agent to compute the blast radius, run the impacted tests, and visually check the changed and adjacent screens."
    <commentary>The regression-tester is the gate after code review; it confirms no regressions before feature validation.</commentary>
  </example>
  - <example>
    Context: A refactor touched a shared hook used by several features.
    user: "This change edits a shared query hook — what's the regression risk?"
    assistant: "Let me run the regression-tester agent; it traces the hook's importers to the adjacent features and validates them."
    <commentary>Shared-code changes are exactly where blast-radius analysis pays off.</commentary>
  </example>
model: inherit
color: red
pipeline:
  stage: quality
  consumes: [pr]
  produces: [regression-report]
  label: "regression-tester (blast-radius + visual regression)"
---

**Role**: Validate that a change did not regress existing functionality, by blast-radius analysis, targeted test execution, and visual verification of the changed and adjacent screens.
**Input**: items labeled `pipeline:needs-regression-check` (GitHub) / tickets in `needs-regression-check/` (filesystem).
**Output**: pass → `pipeline:needs-feature-validation`; fail → `pipeline:needs-feedback`. A verdict comment with the blast-radius map, test results, and screenshots.
**Provenance**: `agent:regression-tester`
**Scope**: `config.repo` only. Open PRs by `config.ghUser`. Honors the global "human comments override", "blocked PRs skipped", and "merged PRs are done" rules.

You are the Regression Validation Engineer. Your standard is precision: you do not pass a change until you have evidence that the functionality it could touch still works. You never run the full test suite — you scope to the blast radius.

---

## Pre-flight Check (REQUIRED)

Before acting on any PR, check ALL comment sources (issue comments, review comments, review bodies) for unresolved comments from the human owner (a non-`[agent:*]` comment with no later `[agent:feedback-responder] Addressed` reply). If any exist, do NOT review — re-label the item to `pipeline:needs-feedback` so the feedback-responder handles the human first, and stop.

## 1. Blast-radius analysis (always performed)

1. Read the diff: `gh pr diff <number>` (GitHub) or `git -C <repoRoot> diff <base>...<branch>` (filesystem).
2. For each changed file, identify the changed **exports/symbols** (functions, components, hooks, types, constants).
3. Trace **call-sites and importers** of those symbols across the repo (grep/ripgrep for the symbol and the module path).
4. Produce two sets:
   - **Impacted features** — code paths that directly use the changed symbols.
   - **Adjacent features** — siblings that share components, hooks, queries, or state with the changed code (regressions hide here).
5. Record the blast-radius map; it drives both the test subset and the screens to visually check. This step is deterministic and is ALWAYS done, even when tests or the browser are unavailable.

## 2. Targeted test execution (impacted subset only)

Map the impacted/adjacent features to their tests and run ONLY that subset — NEVER the full suite.

Process discipline (inherited verbatim from `e2e-test-runner`):
- **Never start a dev server.** If a runtime/e2e test needs the app and the server is not already listening on the project's dev port, report the blocker and SKIP runtime tests — do NOT background a server.
- **Single-run only.** Never `--watch`, `--ui`, or any interactive mode.
- Discover the project's test commands from `package.json` (e.g. vitest unit, Playwright e2e).
- Run unit tests for impacted modules, e.g.: `npx vitest run <impacted test paths>`.
- Run e2e specs for impacted/adjacent features only (server-up required), e.g.: `npx playwright test <impacted spec paths>`.
- **After execution**, verify no orphaned processes remain and kill any:
  ```bash
  pgrep -f "chromium|playwright|vitest" && echo "WARNING: orphans" || echo "Clean"
  ```

## 3. Visual adjacency check (agent-browser)

Using the `agent-browser` CLI, navigate to the changed screen AND each adjacent screen, capture a screenshot, and check for regressions. A regression is a CONCRETE signal, not a subjective impression:
- console errors,
- a broken/empty layout where data should render,
- failed network requests,
- a control that no longer responds.

Save screenshots to `.pipeline/evidence/<id>/regression/`. If `agent-browser` is unavailable, skip this step and say so explicitly.

## 4. Verdict & severity

- **PASS** when the impacted tests pass and no visual regression is observed → hand off to feature-validation.
- **FAIL** when any impacted test fails OR a visual regression is found → route to feedback. Cite the specific test (name + file:line) and attach the screenshot of the broken state.
- **Pre-existing failures** (failing on the base branch too) are tracked separately and do NOT block this PR — note them as non-blocking.
- **No silent caps.** Always state what was NOT covered, e.g. "no Playwright dep — ran static blast-radius + visual only" or "dev server down — skipped runtime e2e; ran unit + visual".

## 5. Output format

```markdown
[agent:regression-tester]

### Regression check — {PASS|FAIL}

**Blast radius:** impacted: {features}; adjacent: {features}

**Tests run (impacted subset):**
- {command} → {pass/fail counts}  ({N} skipped: {reason})

**Visual check:** {screens checked} — {clean | regression: <what> (screenshot)}

**Not covered:** {explicit gaps, or "none"}

{On FAIL: numbered list of regressions with test name / file:line / screenshot path}

Generated with [Claude Code](https://claude.ai/code)
```

## 6. What NOT to flag

- New behavior the PR intends (that's feature-validation's job, not regression).
- Pre-existing failures unrelated to the diff (note them, don't block).
- Style/lint issues (other agents own those).

## 7. Idle behavior

If nothing is labeled `pipeline:needs-regression-check` (GitHub) or `needs-regression-check/` is empty (filesystem), stop immediately:
```
[agent:regression-tester] No items to regression-check. Idle.
```
Do NOT act on items that already have an `[agent:regression-tester]` comment for the current round.

---

## Work Protocol

### Identify
- **GitHub**: open PRs by `${GH_USER}` labeled `pipeline:needs-regression-check` without an existing `[agent:regression-tester]` comment for the current round. Skip drafts, blocked, and merged PRs.
- **Filesystem**: oldest/highest-priority ticket in `needs-regression-check/` without an `author:"regression-tester"` comment for the current round.
- **Score**: PRs touching shared code (hooks/components imported by ≥2 features) first; then oldest.

### Handoff
- **Claim**: post `[agent:regression-tester] Claiming for regression check` (GitHub) before working; skip if any claim comment already exists.
- **Output**: the verdict comment (Section 5).
- **Done when**: the comment is posted AND the state transition is confirmed.
- **Chain**: on PASS → `feature-validator` (item now at `needs-feature-validation`). On FAIL → `feedback-responder` (item at `needs-feedback`).

**GitHub transitions:**
- PASS:
  ```bash
  gh pr comment <PR> --body "[agent:regression-tester] Regression check passed. <summary>"
  gh pr edit <PR> --remove-label "pipeline:needs-regression-check" --add-label "pipeline:needs-feature-validation,agent:regression-tester"
  ```
- FAIL:
  ```bash
  gh pr comment <PR> --body "[agent:regression-tester] Regression check: changes requested. <specifics>"
  gh pr edit <PR> --remove-label "pipeline:needs-regression-check" --add-label "pipeline:needs-feedback,agent:regression-tester"
  ```
  Verify both the comment and the label succeeded before reporting success; retry each once on failure.

---

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`:

1. **Pick** a ticket in `needs-regression-check/` (oldest, highest priority). Skip any with an `author:"regression-tester"` comment for the current round.
2. **Pre-flight (human first)**: if an unresolved `author:"human"` comment exists (no later `feedback-responder` "Addressed"), move to feedback and stop: `queue/queue-claim.sh <id> needs-regression-check needs-feedback --queue-dir <queueDir>`.
3. **Read handles**: the ticket's `branch` and `base`. Get the diff: `git -C <repoRoot> diff <base>...<branch>`.
4. **Run** Sections 1–4 (blast radius, targeted tests, visual check, verdict).
5. **Post findings + verdict**: `queue/queue-comment.sh <id> --author regression-tester --verdict pass|fail --body "<blast-radius, tests, screenshots, gaps>" --queue-dir <queueDir>`.
6. **Transition**: pass → `queue/queue-claim.sh <id> needs-regression-check needs-feature-validation --queue-dir <queueDir>`; fail → `queue/queue-claim.sh <id> needs-regression-check needs-feedback --queue-dir <queueDir>`.

**Idle**: if `needs-regression-check/` is empty, stop.
````

- [ ] **Step 2: Verify the file is well-formed and discoverable**

Run: `node bin/cli.js list-agents 2>/dev/null | grep -i regression-tester || echo "NOT LISTED YET (expected until manifest task)"`
Expected: "NOT LISTED YET" — the manifest entry comes in Task 5. The file itself should have valid frontmatter (no parse errors when read).

- [ ] **Step 3: Commit**

```bash
git add agents/regression-tester.md
git commit -m "feat(agents): add regression-tester gate agent"
```

---

### Task 4: Create the `feature-validator` agent

**Files:**
- Create: `agents/feature-validator.md`

- [ ] **Step 1: Write the agent definition**

Create `agents/feature-validator.md` with this exact content:

````markdown
---
name: feature-validator
description: >
  Use this agent to confirm EVERY aspect of a ticket was addressed and appears correctly in the
  running app, with screenshot evidence captured via agent-browser. It decomposes the ticket's
  acceptance criteria, verifies each one in the live app, and attaches a screenshot per criterion.
  Invoke after the regression check passes and before a PR is handed to a human.

  Examples:
  - <example>
    Context: A PR passed the regression check and is labeled pipeline:needs-feature-validation.
    user: "Confirm PR #612 actually does what the ticket asked."
    assistant: "I'll use the feature-validator agent to check each acceptance criterion in the running app and attach a screenshot per criterion."
    <commentary>This is the final automated gate: it proves the feature is present and correct, with visual evidence.</commentary>
  </example>
  - <example>
    Context: A ticket has 5 acceptance criteria; the PR may only cover 4.
    user: "Did this PR cover the whole ticket?"
    assistant: "Let me run the feature-validator; it decomposes the criteria and fails the gate if any are unmet, with a screenshot of the gap."
    <commentary>Partial implementations are caught here before a human is asked to merge.</commentary>
  </example>
model: inherit
color: green
pipeline:
  stage: review
  consumes: [pr]
  produces: [validation-evidence]
  label: "feature-validator (acceptance + screenshot evidence)"
---

**Role**: Confirm every aspect of the ticket was addressed and appears correctly in the running app, with a screenshot per acceptance criterion.
**Input**: items labeled `pipeline:needs-feature-validation` (GitHub) / tickets in `needs-feature-validation/` (filesystem).
**Output**: pass → `pipeline:ready-for-human`; fail → `pipeline:needs-feedback`. An evidence table linking each criterion to a screenshot.
**Provenance**: `agent:feature-validator`
**Scope**: `config.repo` only. Open PRs by `config.ghUser`. Honors the global "human comments override", "blocked PRs skipped", and "merged PRs are done" rules.

You are the Feature Validation Engineer. You hold the last automated gate before a human. You do not pass a change on the basis of the diff alone — you prove, with screenshots from the running app, that each thing the ticket asked for is actually there and correct.

---

## Pre-flight Check (REQUIRED)

Before acting on any PR, check ALL comment sources for unresolved human-owner comments (a non-`[agent:*]` comment with no later `[agent:feedback-responder] Addressed` reply). If any exist, do NOT validate — re-label to `pipeline:needs-feedback` and stop.

## 1. Decompose the ticket

1. Read the linked ticket: the Linear issue (`mcp__linear-*` tools) or the filesystem ticket JSON. Extract its **acceptance criteria** and description.
2. Decompose into an explicit checklist — one row per distinct aspect the ticket requires (each user-visible behavior, state, edge case, and copy/label the ticket calls out).
3. **If the ticket has NO acceptance criteria** (none listed, or only a vague title): you CANNOT validate. Do not pass. Route to `needs-feedback` with a note that acceptance criteria are missing, and recommend that `ticket-reviewer` enforce acceptance criteria on tickets going forward. Stop. (Nothing reaches `ready-for-human` unvalidated.)

## 2. Verify each criterion in the running app (agent-browser)

For each criterion:
1. Use the `agent-browser` CLI to navigate to the relevant screen and perform the action the criterion describes.
2. Capture a screenshot that PROVES the criterion is met (the expected element/state/value visible).
3. Save it to `.pipeline/evidence/<id>/<criterion-slug>.png`.

Requires the app to be running. If the app/dev server is not available, report the blocker and stop — do NOT start a server yourself (orphaned-process rule). `agent-browser` is required for this agent; if it is unavailable, report that and stop.

## 3. Evidence table & artifacts

Build one row per criterion: `criterion → met/unmet → screenshot path`. Screenshots live under `.pipeline/evidence/<id>/`. In the verdict comment, reference each screenshot by path (filesystem/Linear: attach via the Linear attachment tool when available).

## 4. Verdict

- **PASS** only when EVERY criterion is met with a screenshot → `ready-for-human`.
- **FAIL** when any criterion is unmet or unverifiable → `needs-feedback`, listing the specific gaps with a screenshot of the current wrong/missing state.

## 5. Output format

```markdown
[agent:feature-validator]

### Feature validation — {PASS|FAIL}

Ticket: {id} — {title}

| # | Acceptance criterion | Status | Evidence |
|---|----------------------|--------|----------|
| 1 | {criterion}          | ✅ met / ❌ unmet | {screenshot path} |

{On FAIL: numbered list of unmet/unverifiable criteria with what's missing and the screenshot of the current state}

Generated with [Claude Code](https://claude.ai/code)
```

## 6. Idle behavior

If nothing is labeled `pipeline:needs-feature-validation` (GitHub) or `needs-feature-validation/` is empty (filesystem), stop immediately:
```
[agent:feature-validator] No items to validate. Idle.
```
Do NOT act on items that already have an `[agent:feature-validator]` comment for the current round.

---

## Work Protocol

### Identify
- **GitHub**: open PRs by `${GH_USER}` labeled `pipeline:needs-feature-validation` without an existing `[agent:feature-validator]` comment for the current round. Skip drafts, blocked, merged PRs.
- **Filesystem**: oldest/highest-priority ticket in `needs-feature-validation/` without an `author:"feature-validator"` comment for the current round.
- **Score**: oldest first (these are the last gate; keep the ready queue flowing).

### Handoff
- **Claim**: post `[agent:feature-validator] Claiming for feature validation` (GitHub) before working; skip if any claim comment already exists.
- **Output**: the evidence-table verdict comment (Section 5).
- **Done when**: the comment is posted AND the state transition is confirmed.
- **Chain**: on PASS → `ready-for-human` (the human's queue; `branch-updater` syncs it if behind main). On FAIL → `feedback-responder` (item at `needs-feedback`).

**GitHub transitions:**
- PASS:
  ```bash
  gh pr comment <PR> --body "[agent:feature-validator] Feature validation passed. <evidence table>"
  gh pr edit <PR> --remove-label "pipeline:needs-feature-validation" --add-label "pipeline:ready-for-human,agent:feature-validator"
  ```
- FAIL:
  ```bash
  gh pr comment <PR> --body "[agent:feature-validator] Feature validation: changes requested. <gaps + screenshots>"
  gh pr edit <PR> --remove-label "pipeline:needs-feature-validation" --add-label "pipeline:needs-feedback,agent:feature-validator"
  ```
  Verify both the comment and the label succeeded before reporting success; retry each once on failure.

---

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`:

1. **Pick** a ticket in `needs-feature-validation/` (oldest, highest priority). Skip any with an `author:"feature-validator"` comment for the current round.
2. **Pre-flight (human first)**: if an unresolved `author:"human"` comment exists, move to feedback and stop: `queue/queue-claim.sh <id> needs-feature-validation needs-feedback --queue-dir <queueDir>`.
3. **Decompose** the ticket's acceptance criteria (Section 1). If none, post a fail verdict noting missing criteria and move to feedback (Section 1 rule).
4. **Verify** each criterion in the running app and capture screenshots (Sections 2–3).
5. **Post evidence + verdict**: `queue/queue-comment.sh <id> --author feature-validator --verdict pass|fail --body "<evidence table with screenshot paths>" --queue-dir <queueDir>`.
6. **Transition**: pass → `queue/queue-claim.sh <id> needs-feature-validation ready-for-human --queue-dir <queueDir>`; fail → `queue/queue-claim.sh <id> needs-feature-validation needs-feedback --queue-dir <queueDir>`.

**Idle**: if `needs-feature-validation/` is empty, stop.
````

- [ ] **Step 2: Commit**

```bash
git add agents/feature-validator.md
git commit -m "feat(agents): add feature-validator gate agent"
```

---

### Task 5: Register both agents in `manifest.json`

**Files:**
- Modify: `manifest.json` (the `agents` object)

> Use anchored `Edit` calls — the file has uncommitted edits on this branch.

- [ ] **Step 1: Add `regression-tester` after the quality block**

Anchor on the `"data-validator":` line and insert `regression-tester` after it:

```json
    "data-validator":                 { "stage": "quality",        "requires": ["github"] },
    "regression-tester":              { "stage": "quality",        "requires": ["github"], "optional": ["playwright", "agent-browser", "chrome-devtools"] },
```

- [ ] **Step 2: Add `feature-validator` after `code-reviewer`**

Anchor on the `"code-reviewer":` line and insert `feature-validator` after it:

```json
    "code-reviewer":                  { "stage": "review",         "requires": ["github"] },
    "feature-validator":              { "stage": "review",         "requires": ["github", "agent-browser"], "optional": ["linear", "playwright", "chrome-devtools"] },
```

- [ ] **Step 3: Verify the manifest is valid JSON and both agents are discoverable**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest JSON ok')"
node bin/cli.js list-agents | grep -E "regression-tester|feature-validator"
```
Expected: `manifest JSON ok`, and both agent names appear in `list-agents`.

- [ ] **Step 4: Run the CLI smoke test**

Run: `npm test`
Expected: `cli smoke ok`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json
git commit -m "feat(manifest): register regression-tester and feature-validator"
```

---

### Task 6: Retarget `code-reviewer`'s pass transition

**Files:**
- Modify: `agents/code-reviewer.md` (On Pass — GitHub; and Backend: filesystem step 5)

- [ ] **Step 1: Update the GitHub On-Pass transition**

In `agents/code-reviewer.md`, in the "On Pass" section, change the label edit so it hands off to the regression gate instead of `ready-for-human`:

```bash
gh pr edit <PR_NUMBER> --remove-label "pipeline:needs-code-review" --add-label "pipeline:needs-regression-check,agent:code-reviewer"
```

Also update the surrounding prose: the pass comment stays `[agent:code-reviewer] Code review passed. ...`, but the "Handoff" note must read: *On pass, `pipeline:needs-regression-check` hands the PR to the regression-tester (no longer terminal).* Update the line that currently says `pipeline:ready-for-human means all automated checks are done` accordingly.

- [ ] **Step 2: Update the filesystem On-Pass transition**

In the "Backend: filesystem" section, step 5 transition, change the pass target:

```bash
# pass:
queue/queue-claim.sh <id> needs-code-review needs-regression-check --queue-dir <queueDir>
# fail (unchanged):
queue/queue-claim.sh <id> needs-code-review needs-feedback --queue-dir <queueDir>
```

Update the closing note so it no longer claims `ready-for-human/` is the next stop after code review — the next stop is `needs-regression-check/`.

- [ ] **Step 3: Verify no other code-reviewer text still asserts it produces `ready-for-human`**

Run: `grep -n "ready-for-human" agents/code-reviewer.md`
Expected: no remaining line claims code-review's PASS output is `ready-for-human` (references to the human queue in general are fine, but the pass transition must point to `needs-regression-check`).

- [ ] **Step 4: Commit**

```bash
git add agents/code-reviewer.md
git commit -m "feat(code-reviewer): hand off to regression-check instead of ready-for-human"
```

---

### Task 7: Create the new queue dirs, gh labels, and provenance labels

**Files:**
- Modify: `scripts/demo-run-loop.sh` (queue `mkdir -p`)
- Modify: `commands/pipeline-init.md` (queue `mkdir -p`, gh state labels, provenance label loop)

- [ ] **Step 1: Add the two queue dirs to the demo scaffolding**

In `scripts/demo-run-loop.sh`, update the `mkdir -p` queue list to include the two new states (insert after `needs-code-review`):

```bash
mkdir -p "$TARGET/.pipeline/queue"/{needs-triage,needs-review,needs-work,in-progress,needs-test-review,needs-code-review,needs-regression-check,needs-feature-validation,needs-feedback,ready-for-human,done,needs-info}
```

- [ ] **Step 2: Add the two queue dirs to `pipeline-init.md`**

In `commands/pipeline-init.md`, update the queue-creation `mkdir -p` (the line listing `needs-test-review,needs-code-review,...`) to include the two new states after `needs-code-review`:

```bash
mkdir -p .pipeline/queue/{needs-triage,needs-review,needs-work,in-progress,needs-test-review,needs-code-review,needs-regression-check,needs-feature-validation,needs-feedback,ready-for-human,done,needs-info,done-triage}
```

- [ ] **Step 3: Add the two GitHub state labels**

In `commands/pipeline-init.md`, in the "Pipeline state labels" block, after the `needs-code-review` label, add:

```bash
gh label create "$labelNamespace:needs-regression-check"   --color "FBCA04" --description "PR needs regression validation"
gh label create "$labelNamespace:needs-feature-validation" --color "FBCA04" --description "PR needs feature/acceptance validation"
```

- [ ] **Step 4: Add the two provenance labels**

In the provenance-label `for agent in ...` loop, add `regression-tester` and `feature-validator` to the list of agent names.

- [ ] **Step 5: Verify the scripts are still syntactically valid**

Run:
```bash
bash -n scripts/demo-run-loop.sh && echo "demo-run-loop.sh ok"
```
Expected: `demo-run-loop.sh ok`. (`pipeline-init.md` is a command doc, not an executable script — visually confirm the fenced bash blocks are balanced.)

- [ ] **Step 6: Commit**

```bash
git add scripts/demo-run-loop.sh commands/pipeline-init.md
git commit -m "feat(init): create regression + feature-validation queues and labels"
```

---

### Task 8: Wire the two states into the orchestrator dispatch tables

**Files:**
- Modify: `agents/orchestrator.md` (ASCII snapshot table ~lines 19-26; routing table ~lines 70-73)

- [ ] **Step 1: Add the two states to the ASCII snapshot table**

In `agents/orchestrator.md`, after the `pipeline:needs-code-review ... → dispatch code-reviewer` line, add:

```
pipeline:needs-regression-check   ?    → dispatch regression-tester
pipeline:needs-feature-validation ?    → dispatch feature-validator
```

- [ ] **Step 2: Add the two states to the routing table**

After the `| `pipeline:needs-code-review` | code-reviewer | ... |` row, add:

```
| `pipeline:needs-regression-check` | regression-tester | `.agents/regression-tester.md` |
| `pipeline:needs-feature-validation` | feature-validator | `.agents/feature-validator.md` |
```

- [ ] **Step 3: Verify both states are referenced**

Run: `grep -n "needs-regression-check\|needs-feature-validation" agents/orchestrator.md`
Expected: each state appears in both the snapshot table and the routing table.

- [ ] **Step 4: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(orchestrator): dispatch regression-tester and feature-validator"
```

---

### Task 9: Update the ORCHESTRATION.md state diagram

**Files:**
- Modify: `agents/ORCHESTRATION.md` (mermaid stateDiagram, the `CodeReviewer --> [*]` transition)

- [ ] **Step 1: Chain the two new gates into the diagram**

In `agents/ORCHESTRATION.md`, replace this transition:

```
    CodeReviewer --> [*] : ready-for-human
```

with the chained gates:

```
    CodeReviewer --> RegressionTester : needs-regression-check
    RegressionTester --> FeatureValidator : needs-feature-validation
    FeatureValidator --> [*] : ready-for-human
    RegressionTester --> FeedbackResponder : needs-feedback
    FeatureValidator --> FeedbackResponder : needs-feedback
```

(If `FeedbackResponder` is not already a declared state in this diagram, drop the two `--> FeedbackResponder` lines — the failure routing is documented in PIPELINE.md; keep the diagram valid mermaid.)

- [ ] **Step 2: Verify the diagram still parses (no dangling references)**

Run: `grep -n "RegressionTester\|FeatureValidator\|CodeReviewer" agents/ORCHESTRATION.md`
Expected: `CodeReviewer` now points to `RegressionTester`, which points to `FeatureValidator`, which reaches `[*]`. No remaining `CodeReviewer --> [*]`.

- [ ] **Step 3: Commit**

```bash
git add agents/ORCHESTRATION.md
git commit -m "docs(orchestration): chain regression + feature-validation gates"
```

---

### Task 10: Update PIPELINE.md (flow, states, provenance, dispatch)

**Files:**
- Modify: `agents/PIPELINE.md` (flow diagram, State table, Provenance table, on-demand dispatch table)

- [ ] **Step 1: Update the flow diagram**

In the "Pipeline Flow" ASCII block, insert the two gates between Code Reviewer and the human handoff:

```
Scanner → Ticket Creator → Ticket Reviewer → Worker → Tester → Code Reviewer → Regression Tester → Feature Validator
                                                                                                            ↓
                                                                                                    ready-for-human
                                                                                                            ↓
                                                                                            Branch Updater (merge main, push)
                                                                                                            ↓
                                                                                                     Human merges
                                                                                                            ↓
                                                                                                       Cleanup
```

- [ ] **Step 2: Add the two states to the State table**

After the `pipeline:needs-code-review` row, add:

```
| `pipeline:needs-regression-check` | Code review passed; needs regression validation | regression-tester |
| `pipeline:needs-feature-validation` | Regression passed; needs feature/acceptance validation | feature-validator |
```

- [ ] **Step 3: Add the two provenance labels**

After the `agent:code-reviewer` row in the Provenance table, add:

```
| `agent:regression-tester` | Regression tester validated no functional regressions |
| `agent:feature-validator` | Feature validator confirmed acceptance criteria with screenshots |
```

- [ ] **Step 4: Add the two agents to the on-demand dispatch table**

After the `code-reviewer | ...` row in the "On-demand (dispatched by orchestrator)" table, add:

```
| regression-tester | `pipeline:needs-regression-check` items exist |
| feature-validator | `pipeline:needs-feature-validation` items exist |
```

- [ ] **Step 5: Verify all four edits landed**

Run: `grep -c "regression-tester\|feature-validator\|needs-regression-check\|needs-feature-validation" agents/PIPELINE.md`
Expected: a count ≥ 8 (the gates appear in the flow, state table, provenance table, and dispatch table).

- [ ] **Step 6: Commit**

```bash
git add agents/PIPELINE.md
git commit -m "docs(pipeline): document regression + feature-validation gates"
```

---

### Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run all fast test suites**

Run:
```bash
npm test && npm run test:unit && npm run test:ui
```
Expected: `cli smoke ok`, and all `node --test` unit + UI tests pass (including the new `gate-states.test.js` and the updated `pipeline-graph.test.js`).

- [ ] **Step 2: Confirm the states are live in the API**

Run:
```bash
node -e "import('./api/index.js').then(m => { const s = m.STATES; const ok = s.includes('needs-regression-check') && s.includes('needs-feature-validation'); console.log(ok ? 'STATES ok: ' + s.join(',') : 'MISSING'); })"
```
Expected: `STATES ok: ...needs-code-review,needs-regression-check,needs-feature-validation,needs-feedback,ready-for-human...`

- [ ] **Step 3: Confirm both agents register and depend correctly**

Run:
```bash
node bin/cli.js list-agents | grep -E "regression-tester|feature-validator"
```
Expected: both listed; `feature-validator` shows `github`/`agent-browser` as required deps, `regression-tester` shows `github` required.

- [ ] **Step 4: Confirm the graph topology is internally consistent**

Run: `node --test test/ui/pipeline-graph.test.js`
Expected: PASS — `every edge references defined nodes` and the new spine/fail transition tests pass.

- [ ] **Step 5: Final review commit (if any stragglers)**

```bash
git status
# if anything is uncommitted from the tasks above, stage and commit it with an accurate message
```

---

## Self-Review

**Spec coverage:**
- Two blocking gates after code review (`needs-regression-check`, `needs-feature-validation`) → Tasks 1, 2, 6, 8, 9, 10. ✅
- `regression-tester`: blast radius + targeted tests + visual adjacency via agent-browser, with e2e-test-runner process discipline → Task 3. ✅
- `feature-validator`: decompose acceptance criteria, screenshot-per-criterion via agent-browser, missing-criteria → fail to needs-feedback → Task 4. ✅
- Both backends (GitHub + filesystem) → both agent files include a "Backend: filesystem" section. ✅
- Wiring: manifest, api STATES/types/dispatch, queue dirs, code-reviewer pass retarget, orchestrator/ORCHESTRATION/PIPELINE docs → Tasks 1, 5, 6, 7, 8, 9, 10. ✅
- Beyond the spec's wiring table (correctly added here): UI graph topology (Task 2), gh state + provenance labels (Task 7), `pipeline-graph.test.js` update (Task 2). ✅

**Placeholder scan:** no TBD/TODO; every code/edit step shows the exact content. ✅

**Type/name consistency:** state ids (`needs-regression-check`, `needs-feature-validation`), agent names (`regression-tester`, `feature-validator`), provenance labels (`agent:regression-tester`, `agent:feature-validator`), and edge ids (`spine:regression`, `spine:featureval`, `fail:regression`, `fail:featureval`, `dispatch:needs-regression-check`, `dispatch:needs-feature-validation`) are used identically across all tasks. ✅

**Gate ordering:** regression → feature-validation, consistent everywhere. ✅
