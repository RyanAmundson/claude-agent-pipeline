# Regression Tester & Feature Validator Agents — Design

**Date:** 2026-06-15
**Status:** Approved design (pending user review of this spec)
**Branch context:** authored alongside `feat/cap-adversarial-review`

## Summary

Add two new **blocking gate agents** to the pipeline, inserted between code review and
`ready-for-human`:

1. **`regression-tester`** — extremely precise validation that a change did not negatively
   impact existing functionality. Computes the change's blast radius, runs the *impacted*
   test subset (never the full suite), and visually verifies the changed screen plus
   **feature-adjacent** screens for regressions.
2. **`feature-validator`** — ensures every aspect of the ticket was addressed and that it
   appears correctly in the running app, with **screenshot evidence** (via `agent-browser`)
   for each acceptance criterion.

Both are gates: on pass they hand off to the next stage; on fail they route the item to
`pipeline:needs-feedback`. Both support the GitHub-PR backend and the filesystem-queue
backend, consistent with every existing agent.

## Motivation

Today the pipeline's terminal automated gate is `code-reviewer`
(`needs-code-review` → `ready-for-human` on pass). Code review checks *code quality and
architecture*, but nothing in the pipeline empirically confirms that:

- the change didn't break adjacent, already-working functionality (regression), or
- the change actually delivers what the ticket asked for, verified in the live app.

These two agents close that gap before a human is asked to merge.

## Pipeline flow change

Before:

```
worker → tester → code-reviewer → ready-for-human
```

After:

```
worker → tester → code-reviewer → regression-tester → feature-validator → ready-for-human
                                   (needs-regression-   (needs-feature-
                                    check)               validation)
         any gate fails ↘ needs-feedback → feedback-responder
```

Two new states are introduced:

| State Label | Meaning | Owned By |
|---|---|---|
| `pipeline:needs-regression-check` | Code review passed; needs regression validation | `regression-tester` |
| `pipeline:needs-feature-validation` | Regression passed; needs feature/acceptance validation | `feature-validator` |

`code-reviewer`'s **On Pass** transition changes from `ready-for-human` to
`needs-regression-check` (both the GitHub and filesystem backend sections). All other
existing transitions are unchanged.

Ordering rationale: regression runs first (cheaper, protects what already works), then
feature-validation confirms the new intent. Either gate failing sends the item to
`needs-feedback`, where the feedback-responder addresses it and the item re-enters the
normal flow.

## Agent 1 — `regression-tester`

- **Stage (manifest):** `quality`
- **Input:** items labeled `pipeline:needs-regression-check` (GitHub) / tickets in
  `needs-regression-check/` (filesystem).
- **Output:** pass → `pipeline:needs-feature-validation`; fail → `pipeline:needs-feedback`.
- **Provenance:** `agent:regression-tester`
- **Scope:** `config.repo` only; only open PRs by `config.ghUser`; honors the global
  "human comments override" and "blocked/merged PRs are skipped" rules.

### Method (precise and bounded)

1. **Blast-radius analysis.** From the diff, identify changed exports/symbols, then trace
   their call-sites and importers to produce a set of **impacted features** plus
   **adjacent features** (siblings that share components, hooks, queries, or state with the
   changed code). This is always performed — it is the deterministic core.
2. **Targeted test execution.** Map impacted/adjacent features to their tests (vitest unit +
   Playwright e2e) and run **only that subset** — never the full suite. Inherits the
   `e2e-test-runner` process discipline verbatim:
   - Never start a dev server. If the server (default port per project) is not already
     running, report the blocker and stop — do not background a server.
   - Single-run only; never `--watch`, `--ui`, or interactive modes.
   - After execution, verify no orphaned Chromium/Playwright processes remain; kill any.
3. **Visual adjacency check.** Using **`agent-browser`**, navigate to the changed screen
   *and* each adjacent screen, capture screenshots, and check for regressions: console
   errors, broken layout, missing/empty data, failed network calls.
4. **Verdict.**
   - **Pass** when impacted tests pass and no visual regression is observed.
   - **Fail** when any impacted test fails or a visual regression is found; the comment
     lists specifics (test name, file:line, screenshot of the broken state).
   - **Pre-existing failures** (failing on the base branch too) are tracked separately and
     do **not** block, per the pipeline's self-healing rule.
   - **No silent caps:** the agent explicitly logs what it could *not* cover (e.g. "no
     Playwright dep — ran static blast-radius + visual only", "dev server down — skipped
     runtime tests").

### Dependencies (manifest)

- **requires:** `github`
- **optional:** `playwright`, `agent-browser`, `chrome-devtools`
- **Graceful degradation:** with no test runner → static blast-radius + visual only; with no
  browser tool → tests + static only. Always reports coverage gaps rather than silently
  narrowing scope.

## Agent 2 — `feature-validator`

- **Stage (manifest):** `review`
- **Input:** items labeled `pipeline:needs-feature-validation` (GitHub) / tickets in
  `needs-feature-validation/` (filesystem).
- **Output:** pass → `pipeline:ready-for-human`; fail → `pipeline:needs-feedback`.
- **Provenance:** `agent:feature-validator`
- **Scope:** same scope/skip rules as other PR-stage agents.

### Method

1. **Decompose the ticket.** Read the linked ticket (Linear issue or filesystem ticket JSON)
   and extract its **acceptance criteria** plus description into a checklist covering *every*
   aspect of the request.
2. **Verify each criterion in the running app.** Using **`agent-browser`**, navigate to the
   relevant screen, perform the action the criterion describes, and capture a screenshot
   proving the criterion is satisfied.
3. **Build an evidence table** — one row per criterion: `criterion → met/unmet → screenshot`.
   Screenshots are saved to an artifact directory and linked from the verdict comment
   (GitHub PR comment) or attached to the ticket (filesystem / Linear).
4. **Verdict.**
   - **Pass** only when *all* criteria are met with screenshot evidence → `ready-for-human`.
   - **Fail** when any criterion is unmet or unverifiable → `needs-feedback`, listing the
     specific gaps with screenshots of the current wrong/missing state.

### Missing acceptance criteria

If the ticket has **no acceptance criteria** to validate against, the agent **cannot**
validate and routes the item to `needs-feedback` with a note that criteria are missing, and
recommends that `ticket-reviewer` enforce acceptance criteria on tickets going forward.
Nothing reaches `ready-for-human` unvalidated.

### Dependencies (manifest)

- **requires:** `github`, `agent-browser` (screenshot evidence is the core deliverable)
- **optional:** `linear`, `playwright`, `chrome-devtools`

## Wiring changes (so the new states are real, not just documented)

State is encoded in several places; all must be updated for the new states to function:

| File | Change |
|---|---|
| `agents/regression-tester.md` | **New** agent definition (frontmatter + Work Protocol + filesystem section). |
| `agents/feature-validator.md` | **New** agent definition (frontmatter + Work Protocol + filesystem section). |
| `manifest.json` | Register both agents under `agents` with stage + requires/optional. |
| `agents/code-reviewer.md` | On Pass → `needs-regression-check` (GitHub **and** filesystem sections). |
| `api/index.js` | Add both states to the `STATES` array (ordered after `needs-code-review`). |
| `api/index.d.ts` | Add both states to the state union type. |
| `api/cycles.js` | Add `regression-tester → needs-regression-check` and `feature-validator → needs-feature-validation` to the agent→state map. |
| `scripts/demo-run-loop.sh` | Add `needs-regression-check` + `needs-feature-validation` to the `mkdir -p` queue list. |
| install / `commands/pipeline-init.md` | Create the two new queue subdirs for the filesystem backend. |
| `agents/orchestrator.md` | Add both states to the dispatch tables (lines ~19–26 and the routing table ~70–73). |
| `agents/ORCHESTRATION.md` | Update the state diagram (the `CodeReviewer --> [*] : ready-for-human` transition now chains through the two new gates). |
| `agents/PIPELINE.md` | Update the flow diagram, the State table, the Provenance label table, and the on-demand dispatch table. |

New provenance labels: `agent:regression-tester`, `agent:feature-validator`.

## Agent definition conventions (followed by both new files)

Both agent files mirror the existing house style (see `tester.md`, `code-reviewer.md`,
`e2e-test-runner.md`):

- YAML frontmatter: `name`, `description` (with `<example>` blocks), `model`, `color`, and a
  `pipeline:` block (`stage`, `consumes`, `produces`, `label`).
- Body header: **Role / Input / Output / Provenance / Scope** lines.
- Numbered workflow sections.
- A **Work Protocol** section with **Identify** (sources + filter + score) and **Handoff**
  (Claim / Output / Done when / Notify / Chain).
- A **Backend: filesystem (GitHub-free)** section using `queue/queue-claim.sh`,
  `queue/queue-comment.sh` with `--verdict pass|fail`, mirroring `code-reviewer.md`.

## Out of scope (YAGNI)

- No new config keys beyond what exists (`verify`, deps detection already cover the needs).
- No change to the worker, scanner, or detectors.
- No full-suite test execution — explicitly avoided to honor the orphaned-process rule.
- No new CI integration; `ci-triage` continues to own CI.

## Risks & mitigations

- **Orphaned browser/test processes.** Mitigated by inheriting `e2e-test-runner`'s strict
  "never start a server / single-run / kill orphans" discipline.
- **Longer time-to-`ready-for-human`.** Two added gates increase latency. Mitigated by
  blast-radius scoping (only impacted tests/screens) and by both gates being skippable-down
  via graceful degradation when deps are absent.
- **`manifest.json` already has uncommitted edits on this branch.** The implementation must
  merge the new agent entries with the in-progress changes rather than overwrite them.
- **Flaky visual checks.** Visual regression judgments must key on concrete signals (console
  errors, missing elements, failed requests), not subjective "looks off," to avoid false
  fails.

## Open questions

None blocking. Gate ordering (regression → feature-validation) is settled; it can be flipped
later by swapping the two transition targets if desired.
