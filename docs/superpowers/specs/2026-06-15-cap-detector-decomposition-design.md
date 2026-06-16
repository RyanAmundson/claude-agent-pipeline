# Per-Rule Detector Decomposition for CAP

**Date:** 2026-06-15
**Status:** Approved design, pre-implementation
**Branch:** `feat/cap-detector-decomposition`
**Related:** `2026-06-15-cap-multi-llm-adversarial-review-design.md` (the adversarial panel this spec's verdict store mirrors and that the merge-decider — Spec B — will sit beside).

## Goal

Dissolve the monolithic `scanner` agent into **many single-purpose LLM detector
agents**, one per rule, each scoped so tightly that a single finding maps to a single
tiny, independently-revertible change. Each detector is **dual-mode**: it sweeps the
codebase (→ files a ticket, as today) *and* gates a PR diff pre-merge (→ pass or veto).

This is **Spec A** of a two-spec effort. Spec B (a separate design) is the
**autonomous-merge decider** that sits in the pipeline where the human sits today
(the `ready-for-human` terminal slot) and decides merge/no-merge. Spec B only
*aggregates* the per-PR detector verdicts this spec produces; it is explicitly out of
scope here.

> **Why "many detectors" and not "many findings from few detectors":** Tiny,
> revertible PRs come from **per-finding 1:1 ticketing**, not from detector count —
> a broad detector emitting 5 findings (each → its own one-fix PR) yields tiny PRs too.
> What many *single-rule* detectors actually buy is **detection accuracy and focus**
> (a one-rule prompt is far more reliable than a 12-rule prompt), **per-rule
> provenance**, and **independent tunability**. Both levers are used: many detectors
> *and* strict per-finding ticketing.

## Background / current state

- **The scanner is a catch-all monolith.** `agents/scanner.md` owns ~6 categories:
  structural/naming violations, data-pipeline violations, code smells (`@ts-nocheck`,
  `any`, `eslint-disable`, `TODO`/`FIXME`), deprecated patterns (manual
  `useState`+`useEffect` for server data), silent error handling, and dead code. The
  orchestrator dispatches it "once per ~5 cycles … ONLY for things the specialized
  detectors don't cover," explicitly telling it to skip what the detectors own.
- **Seven single-purpose detectors already exist** (`security`, `perf`, `a11y`,
  `justification`, `mock-contract`, `pipeline-violation`, `density-system`). They are
  **mostly codebase sweepers** that write findings to `.pipeline/findings/<type>-<id>.md`
  → `ticket-creator`. Most fire post-merge or on a round-robin slot; only
  `justification-detector` runs in a real PR-diff mode today. The data-pipeline category
  in the scanner is already owned by `pipeline-violation-detector` — so it is **excluded**
  from this decomposition.
- **Dispatch is round-robin, one detector per cycle** (`agents/orchestrator.md`): the six
  non-security detectors rotate `a11y → perf → pipeline-violation → mock-contract →
  density-system → justification → a11y`. This does not scale to a large fleet — 40
  detectors on round-robin means each issue class is scanned only every ~40 cycles
  (~3 hours when active), and running them all every cycle is 40 full Claude sessions per
  tick.
- **The diff-review gate today is single-model** (`agents/code-reviewer.md`, sonnet) →
  `ready-for-human`, optionally followed by the opt-in adversarial panel. The terminal
  state is `pipeline:ready-for-human`; a **hard rule** states only the human merges.
- **There is a verdict-store pattern to mirror.** The adversarial panel persists
  `.pipeline/reviews/<pr>/<provider>.json` and applies a deterministic, runner-owned gate.
  This spec reuses that pattern for detector diff-verdicts.

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Detector unit | **Many literal single-purpose LLM agent files** in `agents/detectors/`, one per rule (not a deterministic check-registry, not a single registry-driven host). |
| Dispatch | **Event-triggered per file-glob** replaces round-robin. A cheap pattern pre-filter is the "event": a detector's LLM only spawns when changed files match its glob *and* its trigger pattern appears. |
| Mode | **Dual-mode** — every detector can run as a codebase sweeper (→ ticket) and as a pre-merge diff-gate (→ pass/veto). |
| Catalog scope | **Decompose the scanner monolith now**; leave the existing 7 broad detectors intact and **re-split them lazily** only when a detector's findings prove too coarse to map to a tiny PR. |
| Diff-gate placement | **New stage** `pipeline:needs-detector-gate` after code-review (not folded into the code-review stage); runner-owned fan-out modeled on `review-panel.js`. |
| Gate semantics | **Severity-tiered** — `blocker`/`major` veto (→ `needs-feedback`); `minor`/`nit` comment but don't block. |
| Small-PR lever | **1 finding = 1 ticket = 1 PR**, hard diff-size cap (`config.maxAutoFixDiffLines`, default ~150), per-rule provenance on every PR. |
| Scanner fate | **Shrink to a "frontier scanner"** that only spots issue classes no detector covers yet and proposes a *new detector* (→ `agent-improver`). Known categories migrate to per-rule detectors. |
| Cost control | Mechanical detectors run on **haiku**, semantic ones on **sonnet**; opus stays reserved for the adversarial gate. |

## The cost model that makes 40+ LLM detectors affordable

Each detector is **a cheap pattern pre-filter + an LLM judgment**:

1. **Pre-filter (no LLM):** `git diff --name-only` (diff-mode) or the changed-files cursor
   (sweep-mode) is intersected with the detector's `glob`; then a `prefilterPattern`
   (regex / grep) is run over the candidate files.
2. **LLM judgment (only on a hit):** only if the pattern matches does the per-rule LLM
   session spawn, to judge the candidates (is this `any` justified? does this catch truly
   swallow user-facing failure? is this `useEffect` actually fetching *server* data?).

So on a typical cycle **most detectors never spawn** — the grep is the event. This is what
the "event-triggered per file-glob" model buys: a large fleet, but only the 2–3 detectors
relevant to a given change wake up. The pre-filter lives in the registry; the `.md` agent
owns only the judgment.

## Architecture

### Components

**1. Detector registry — `detectors.registry.json` (single source of truth)**

One entry per detector:

```json
{
  "id": "unjustified-any",
  "glob": "src/**/*.{ts,tsx}",
  "prefilterPattern": "\\bas any\\b|:\\s*any\\b",
  "model": "haiku",
  "mode": "both",
  "severity": "major",
  "routesTo": "ticket-creator"
}
```

`mode` ∈ `sweep` | `diff` | `both`. `routesTo` lets dead-code detectors target
`dead-code-remover` and `terminology-drift` target `glossary-maintainer`, matching the
existing finding-routing.

**2. Detector agents — `agents/detectors/<id>.md` (generated from the registry)**

Each is single-responsibility. The body holds: the one rule, its trigger, the sweep-mode
output contract (a finding file), and the diff-mode output contract (a verdict JSON as the
final message — the same fenced-```json``` convention the adversarial reviewer uses, so a
read-only sandbox could run it and the **runner** owns all writes).

**3. Detector generator — `scripts/gen-detector.js` (anti-drift)**

Generates / validates the 40+ `.md` files from the registry plus a shared
`agents/detectors/_template.md` (terminology preamble, scope boilerplate, output formats).
Shared boilerplate cannot drift across files because it has exactly one source. A CI/check
verifies every registry entry has a matching `.md` and vice-versa.

**4. Diff-gate runner — `runner/detector-gate.js` (modeled on `review-panel.js`)**

Given a PR:
1. `git diff --name-only` for the PR → intersect with each detector's `glob` +
   `prefilterPattern` → the **matched set**.
2. Fan out one diff-mode dispatch per matched detector, in parallel.
3. Extract each verdict from its final message; persist
   `.pipeline/reviews/<pr>/detector-<id>.json`. Missing/unparseable → synthetic veto
   (fail-closed), mirroring the panel.
4. Compute the deterministic severity-tiered gate (below).
5. Apply the resulting label and post one consolidated `[agent:detector-gate]` comment.

**5. Sweep dispatch — `agents/orchestrator.md` (replaces round-robin)**

The orchestrator keeps a `lastScan` git cursor. Each cycle:
`git diff --name-only <lastScan>..main` → intersect with detector globs + pre-filters →
dispatch only the matched detectors in sweep-mode against the changed files. A **periodic
full-sweep** (every N cycles) runs the whole fleet against `src/` to catch anything the
cursor missed (e.g., detectors added since the last full sweep). The round-robin table and
the catch-all scanner slot are removed; the existing 7 broad detectors keep their current
triggers until lazily re-split.

**6. Frontier scanner — `agents/scanner.md` (shrunk)**

Loses every category now owned by a detector. Its sole remaining job: spot issue classes
**no detector covers yet** and file a `domain:pipeline-improvement` finding proposing a new
detector (registry entry + `.md`), consumed by `agent-improver`. The fleet grows itself.

### The catalog (scanner → ~14 per-rule detectors)

Data-pipeline is excluded (owned by `pipeline-violation-detector`).

| Detector | Rule | Mode | Model | Routes to |
|---|---|---|---|---|
| `ts-suppression` | `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error` without adjacent justification | both | haiku | ticket-creator |
| `unjustified-any` | `as any` / `: any` without justification | both | haiku | ticket-creator |
| `unjustified-eslint-disable` | `eslint-disable[-next-line]` without justification | both | haiku | ticket-creator |
| `todo-without-ticket` | `TODO`/`FIXME`/`HACK` without a ticket reference | both | haiku | ticket-creator |
| `catch-only-console` | catch whose only effect is `console.*` (no user feedback, no rethrow) | both | sonnet | ticket-creator |
| `server-data-manual-effect` | `useState`+`useEffect`(+`useCallback`) for server data instead of React Query | both | sonnet | ticket-creator |
| `naming-convention` | file/folder naming violations per `.claude/rules/naming-conventions.md` | both | haiku | ticket-creator |
| `test-without-assertion` | test body with no `expect`/assert | both | haiku | ticket-creator |
| `skipped-test-without-ticket` | `.skip`/`.only`/`xit`/`xdescribe` without a ref (`.only` always fires) | both | haiku | ticket-creator |
| `unused-export` | exported symbol with zero imports across `src/` | sweep | sonnet | dead-code-remover |
| `orphaned-module` | component/hook/service imported only within its own folder, or not at all | sweep | sonnet | dead-code-remover |
| `commented-out-block` | commented-out code block > 10 lines (threshold configurable) | both | haiku | dead-code-remover |
| `unreachable-code` | unreachable branch / dead conditional | both | sonnet | dead-code-remover |
| `terminology-drift` | term usage absent from or conflicting with the glossary | sweep | sonnet | glossary-maintainer |

Dead-code detectors are **sweep-primary** (a freshly-added export isn't dead yet); in
diff-mode they fire only when the diff *introduces* obviously-dead code (a commented-out
block added, an unreachable branch added).

## Gate semantics (severity-tiered)

Detectors emit findings with `severity` ∈ `blocker` | `major` | `minor` | `nit`
(reusing the adversarial reviewer's vocabulary). The runner's deterministic gate:

- **any `blocker` or `major` → veto** → route PR to `pipeline:needs-feedback`
  (consumed by the existing `feedback-responder` — no new wiring).
- **only `minor`/`nit` → pass** → advance, with the findings posted as a non-blocking
  comment.
- **missing/unparseable verdict → synthetic veto** (fail-closed).

The aggregated result is written alongside the per-detector files in
`.pipeline/reviews/<pr>/`, so Spec B's merge-decider reads the identical store.

## Small-PR discipline (the revertibility lever)

- **1 finding = 1 ticket = 1 PR.** `ticket-creator` never bundles findings; each ticket
  carries its `detector:<id>` provenance and a single `file:line`.
- **Hard diff-size cap** — `config.maxAutoFixDiffLines` (default ~150). A worker PR over
  the cap is flagged for split, keeping every agent PR revertible with one `git revert`.
- **Per-rule provenance** on every PR (`detector:<id>` label/stamp) → reverting one
  rule's fix is one PR, traceable to one detector.

## Pipeline placement

```
worker opens PR
  → tester (pass) → pipeline:needs-code-review
  → code-reviewer (pass) → pipeline:needs-detector-gate          [new stage]
  → orchestrator dispatches runner/detector-gate.js
      ├─ matched detector A @ diff-mode → detector-A.json
      ├─ matched detector B @ diff-mode → detector-B.json         (parallel, glob-matched only)
      └─ …
  → runner persists .pipeline/reviews/<pr>/detector-*.json
  → runner computes severity-tiered gate
      all pass (no blocker/major) → pipeline:ready-for-human
      any blocker/major           → pipeline:needs-feedback → feedback-responder
```

When the adversarial panel is also enabled, the detector-gate runs **before** the panel
(cheap, glob-scoped, mechanical checks first; deep adversarial review last). Ordering is a
config detail, not a hard dependency.

## Config additions — `config.schema.json`

```json
"detectors": {
  "registryPath": "detectors.registry.json",
  "fullSweepEveryNCycles": 20,
  "diffGate": { "enabled": true }
},
"maxAutoFixDiffLines": 150
```

`diffGate.enabled: false` makes detectors sweep-only (no new gate stage) — a clean
regression guard and a gradual-rollout switch.

## Error handling

- **Pre-filter matches but LLM finds nothing** → detector emits `verdict: pass`, no finding
  (the common case; cheap).
- **Detector LLM crash / non-zero exit** (diff-mode) → synthetic veto (fail-closed),
  named in the `[agent:detector-gate]` comment.
- **Registry/`.md` drift** → `gen-detector.js` validation fails CI; the gate refuses to run
  a detector with no registry entry.
- **Cursor gap** (detectors added since last sweep, history rewritten) → the periodic
  full-sweep is the backstop; the cursor is an optimization, not the source of truth.
- **Glob matches nothing in a PR** → that detector simply isn't in the matched set; not an
  error.

## Testing

- **Pre-filter:** unit table — `(glob, prefilterPattern, changed-files)` → expected matched
  set. The pre-filter must never spawn an LLM on a non-match.
- **Generator:** registry → `.md` round-trips; a registry entry with no `.md` (and vice
  versa) fails validation; shared boilerplate is identical across generated files.
- **Verdict extraction:** parses a fenced ```json``` block from a messy final message;
  missing/malformed → synthetic veto (fail-closed). (Shared with the panel's extractor.)
- **Gate logic:** unit table — any `blocker`/`major` → `needs-feedback`; only `minor`/`nit`
  → `ready-for-human`.
- **Sweep dispatch:** changed-files cursor → matched detector set; full-sweep every N
  cycles regardless of cursor.
- **Disabled diff-gate:** `diffGate.enabled: false` → no `needs-detector-gate` stage is
  reachable; `code-reviewer` still emits `ready-for-human` (regression guard).
- **Per-finding ticketing:** N findings from one sweep → N tickets, never bundled; each
  carries `detector:<id>` + one `file:line`.

## Migration

1. Land the registry + generator + the ~14 detector `.md` files (no behavior change yet —
   detectors exist but the orchestrator still round-robins).
2. Switch sweep dispatch to the glob-matched model; remove the catch-all scanner slot;
   shrink `scanner.md` to the frontier scanner.
3. Add the `needs-detector-gate` stage + `detector-gate.js` behind `diffGate.enabled`
   (default off), validate on a few PRs, then default on.
4. Enforce the small-PR discipline (1:1 ticketing + size cap) in `ticket-creator` /
   `worker` / a guard.

Each step is independently revertible — the same discipline the spec is about.

## Out of scope (this spec)

- **The autonomous-merge decision (Spec B).** This spec stops at producing per-PR detector
  verdicts and keeping `ready-for-human` as the human-owned terminal state.
- **Re-splitting the existing 7 broad detectors** — lazy, only when their findings prove
  too coarse.
- **Deterministic-only checks** — the user chose LLM agents; the pre-filter is the cheap
  deterministic part, but the *judgment* stays in an LLM per rule.
- **Replacing the adversarial panel** — the detector-gate runs alongside it, not instead.

## Spec B handoff (the autonomous-merge decider)

Spec B is designed separately. What this spec guarantees it:
- A stable per-PR verdict store at `.pipeline/reviews/<pr>/detector-*.json` plus the
  aggregated gate result, in the same shape the adversarial panel writes.
- A `detector:<id>` provenance trail on every agent PR.
- A hard, configurable diff-size ceiling so "small + revertible" is an enforced property,
  not an aspiration — the safety net Spec B's merge-without-human decision leans on.
