# Runtime-QA Fan-Out Gate for CAP

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Branch:** `feat/runtime-qa-gate`
**Related:** `2026-06-15-cap-detector-decomposition-design.md` (the detector fan-out gate this spec is modeled on — same `computeGate()`, same `.pipeline/reviews/<pr>/` verdict store, same fail-closed semantics).

## Goal

Decompose runtime quality assurance into a single **fan-out gate** that drives the
running app and proves, per-PR, that a change behaves correctly at runtime — not just
that its diff looks right. One new pipeline state (`pipeline:needs-runtime-qa`) and one
runner (`runner/runtime-qa-gate.js`) dispatch a fleet of single-purpose **member agents**
in parallel against the live app via `agent-browser`, persist a per-member verdict, and
compute one deterministic gate.

The gate sits between the regression check and feature validation. Each member owns exactly
one runtime concern, so a failure points at one dimension (a dead button, a misaligned
element, a missing loading state, a request storm) rather than a vague "it's broken."

## Background / current state

- **Runtime QA today is split loosely across two agents.** `regression-tester` computes a
  change's blast radius, runs the impacted test subset, *and* does ad-hoc "visual
  verification of changed + adjacent screens" via `agent-browser`. `feature-validator`
  drives the running app and captures a screenshot per acceptance criterion. Neither
  systematically checks interactions, layout, async states, network behavior, responsive
  breakpoints, or runtime a11y/perf — those are incidental, not gated.
- **`data-validator` already exists** (`agents/data-validator.md`): it traces each displayed
  metric DB → API → service → hook → component and flags where the value drifts. It runs on
  a cron sweep + on-demand when dashboards change. It is **not** a per-PR gate today.
- **Static detectors cover the diff, not the runtime.** `a11y-detector` and `perf-detector`
  are static/diff sweepers. Runtime a11y (axe + keyboard driving) and runtime perf
  (INP/CLS/long-tasks while interacting) are different signals neither produces.
- **There is a proven fan-out gate to mirror.** `runner/detector-gate.js` fans out matched
  detectors in parallel, persists `.pipeline/reviews/<pr>/detector-<id>.json`, and applies a
  pure, runner-owned `computeGate()` (any `veto`/`major` → `needs-feedback`; crashed run →
  fail-closed veto). This spec reuses that machinery wholesale.
- **`agent-browser` is the runtime driver** already declared in `manifest.json` deps; it
  reads the DOM, drives interactions, captures screenshots, and exposes network requests.

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Topology | **One fan-out gate** (not sequential per-agent gates, not loose cron checkers). A runner dispatches all members in parallel and aggregates one verdict — the detector-gate pattern. |
| Placement | **New stage `pipeline:needs-runtime-qa`** after `regression-tester`, before `feature-validator`. |
| Overlap | **Trim** — narrow `regression-tester` (drop its ad-hoc visual verification) and `feature-validator` (acceptance-criteria only); the new members own generic runtime correctness. |
| Member set | **8 members** — interaction · visual · state · network · data-validator (existing) · responsive · a11y · perf. |
| `data-validator` | **Runs every PR** as a gate member (self-limits its DB trace to metrics on changed pages); keeps its independent cron sweep. |
| Other members | **Path-gated** — each runs only when its surface changed (the `matchMembers` pre-filter), so a util-only PR spins up nothing. |
| Console errors | **Cross-cutting, not a 9th agent** — the harness collects console errors (uncaught exceptions, React/hydration warnings) from *every* member's browser session and folds them into the gate. |
| Static a11y/perf | **Kept** — the runtime `a11y`/`perf` members complement, not replace, the static `a11y-detector`/`perf-detector`. |
| Gate semantics | **Severity-tiered, reused verbatim** — `blocker`/`major` (or any `veto`) → `needs-feedback`; `minor`/`nit` comment but don't block; crash → fail-closed veto. |

## Architecture

### Components

**1. Gate runner — `runner/runtime-qa-gate.js` (modeled on `detector-gate.js`)**

Given a PR labeled `pipeline:needs-runtime-qa`:

1. **Pre-flight** — the global rules (human-comment override, skip blocked/merged/draft).
2. **Liveness** — confirm the dev server + `agent-browser` are available. If not, post a
   blocker comment and **stop** — never start a server (the orphaned-process rule
   `feature-validator` already follows). The PR stays in `needs-runtime-qa` for retry.
3. **Blast radius** — compute the PR's changed screens/routes (reuse `regression-tester`'s
   changed-exports → importers → routes logic) so members focus on what changed.
4. **Match** — `runner/runtime-qa-match.js` intersects the changed files with each member's
   `match` predicate → the **active member set**. `data-validator` is always in the set.
5. **Fan out** — one dispatch per active member, in parallel, against the running app. Each
   member's final message is a fenced ` ```json ` verdict (the detector convention), so the
   **runner owns all writes**. Persist `.pipeline/reviews/<pr>/runtime-qa-<member>.json`;
   screenshots to `.pipeline/evidence/<pr>/runtime-qa/<member>/`.
6. **Console fold-in** — each member's session also reports captured console errors; the
   runner converts them to findings (see Console capture) and merges them into that member's
   verdict before gating.
7. **Gate** — reuse `computeGate()` over all verdicts. Persist `runtime-qa-gate.json`.
8. **Transition** — pass → `pipeline:needs-feature-validation`; veto → `pipeline:needs-feedback`
   (consumed by the existing `feedback-responder` — no new wiring). Post one consolidated
   `[agent:runtime-qa]` comment with a per-member table.

**2. Member matcher — `runner/runtime-qa-match.js`**

Pure function: `(members, changedFiles) → activeMembers`. UI-screen members
(`interaction`, `visual`, `state`, `responsive`, `a11y`, `perf`) match
`src/**/[components]|[pages]|*.tsx`; `network` matches those plus `[apis]`/`[services]`;
`data` always matches. Mirrors `detector-match.js`; unit-tested with no LLM spawn on a
non-match.

**3. Member agents — `agents/<member>-validator.md` (7 new files)**

`interaction-validator`, `visual-validator`, `state-validator`, `network-validator`,
`responsive-validator`, `a11y-validator`, `perf-validator`. `data-validator` already exists
and gains a diff-mode/gate contract. Each is single-responsibility, frontmatter-style like
`feature-validator.md` (`pipeline.stage: quality`, `consumes: pr`, `produces:
runtime-qa-verdict`), and emits the shared verdict contract:

```json
{ "verdict": "pass|veto",
  "findings": [ { "severity": "blocker|major|minor|nit",
                  "title": "...", "screen": "/endpoints", "detail": "...",
                  "evidence": ".pipeline/evidence/<pr>/runtime-qa/<member>/<slug>.png" } ] }
```

**4. Console-error capture (cross-cutting harness check)**

Every member drives a browser; the harness subscribes to that session's console and
collects uncaught exceptions, unhandled rejections, and React/hydration warnings. The runner
turns each into a finding on the owning member's verdict (`failOn` configures severity:
`uncaught`/`hydration` → `major` → veto; React warnings → `minor` by default). No separate
dispatch — it rides the sessions the members already open.

**5. Evidence + verdict store — `.pipeline/reviews/<pr>/` and `.pipeline/evidence/<pr>/`**

Same store the detector-gate and adversarial panel write, so a future autonomous-merge
decider reads runtime-QA verdicts in the identical shape.

### The members

| Member | Owns (one job) | Vetoes when | Trigger |
|---|---|---|---|
| `interaction-validator` | Buttons, filters, toggles, dropdowns, hovers/tooltips respond correctly | A control is dead, throws, no-ops, or does the wrong thing; a hover/tooltip never appears | screen change |
| `visual-validator` | Rendered text correctness, positioning, alignment | Wrong/truncated text, overlap, misalignment, broken wrapping | screen change |
| `state-validator` | Loading / empty / error states exist, sequence correctly, fire only when appropriate | A required state is missing, states render out of order (empty during load), or an error state shows/hides at the wrong time | screen change |
| `network-validator` | Request volume, destinations, errors, graceful handling | Duplicate/refetch-storm calls, calls to non-allowlisted hosts, unhandled 4xx/5xx/timeout, infinite spinner/retry | screen or data change |
| `data-validator` (existing) | Displayed values vs dev DB (DB→API→service→hook→component) | Value drift beyond tolerance | every PR |
| `responsive-validator` | Layout holds across breakpoints | Breakage/overflow/hidden-unreachable controls at a configured width | screen change |
| `a11y-validator` | Runtime a11y — axe + keyboard nav, focus order/traps, ARIA, contrast | Critical axe violation, keyboard trap, unreachable control, failing contrast on changed screens | screen change |
| `perf-validator` | Runtime perf — INP/CLS/LCP, long tasks, jank while interacting | A metric exceeds its configured budget on a changed screen | screen change |

## Overlap trim (the "one job each" edits)

- **`regression-tester`** — remove the "visually verify changed + adjacent screens with
  `agent-browser`" duty; narrow to blast-radius computation + running the impacted test
  subset. It hands the screen to the runtime-QA gate, which owns visual/interaction proof.
- **`feature-validator`** — narrow to *ticket-specific* acceptance-criteria proof (decompose
  criteria, screenshot each). It no longer does generic runtime poking; the gate has already
  proven generic runtime correctness by the time a PR reaches it.

## Pipeline placement

```
worker → tester → code-reviewer → [detector-gate] → regression-tester (pass)
  → pipeline:needs-runtime-qa                                   [new stage]
  → orchestrator dispatches runner/runtime-qa-gate.js
      ├─ matched member: interaction-validator → runtime-qa-interaction.json
      ├─ matched member: visual-validator      → runtime-qa-visual.json      (parallel,
      ├─ data-validator (always)               → runtime-qa-data.json         match-gated)
      └─ …                                                       + console findings folded in
  → runner persists .pipeline/reviews/<pr>/runtime-qa-*.json + runtime-qa-gate.json
  → runner computes severity-tiered gate
      all pass (no blocker/major) → pipeline:needs-feature-validation
      any blocker/major/veto      → pipeline:needs-feedback → feedback-responder
```

`config.runtimeQa.enabled: false` makes `regression-tester` advance straight to
`needs-feature-validation`, exactly as `code-reviewer` skips a disabled detector-gate.

## Config additions — `config.schema.json`

```json
"runtimeQa": {
  "enabled": true,
  "members": {
    "interaction": { "enabled": true },
    "visual":      { "enabled": true },
    "state":       { "enabled": true },
    "network":     { "enabled": true, "allowedHosts": [] },
    "data":        { "enabled": true, "everyPr": true },
    "responsive":  { "enabled": true, "breakpoints": [375, 768, 1280] },
    "a11y":        { "enabled": true },
    "perf":        { "enabled": true, "budgets": { "inpMs": 200, "cls": 0.1 } }
  },
  "consoleErrors": { "enabled": true, "failOn": ["uncaught", "hydration"] }
}
```

`allowedHosts` defaults to deriving expected hosts from the app's API base URL/env when
empty. Per-member `enabled: false` drops that member from every fan-out.

## Error handling

- **App / `agent-browser` unavailable** → blocker comment, PR stays in `needs-runtime-qa`,
  no server is started (orphaned-process rule). Not a veto — a retry condition.
- **Member LLM crash / non-zero exit** → synthetic veto (fail-closed), named in the
  `[agent:runtime-qa]` comment — identical to the detector-gate.
- **Member match set empty** (util-only PR, every member path-gated out, `data` finds no
  changed metrics) → empty verdict set → `computeGate([])` passes → advance. Not an error.
- **Console capture unsupported** on a backend → console findings are skipped, members still
  gate on their own verdicts (graceful degrade).
- **Member produces a finding without a screenshot** → finding still counts; the evidence
  cell reads "no screenshot" (proof is best-effort, the verdict is authoritative).

## Testing

- **Matcher:** unit table — `(members, changedFiles)` → expected active set; never spawns on
  a non-match; `data` always present.
- **Gate logic:** reuse/extend the `computeGate` table — any `blocker`/`major`/`veto` →
  `needs-feedback`; only `minor`/`nit` → `needs-feature-validation`; `[]` → pass.
- **Fail-closed:** a crashed member run → synthetic veto → gate vetoes (mirror
  `runDetectorGate`'s crash test).
- **Console fold-in:** an injected `uncaught` console event on a passing member → that
  member's verdict gains a `major` finding → gate vetoes.
- **Verdict extraction:** shared fenced-```json``` extractor; malformed → fail-closed veto.
- **Disabled gate:** `runtimeQa.enabled: false` → `needs-runtime-qa` is unreachable;
  `regression-tester` emits `needs-feature-validation` (regression guard).
- **Liveness:** app-down → blocker comment, no transition, no spawned server.
- All pure logic (`matchMembers`, `computeGate`, console-fold) is unit-tested with injected
  `dispatch` — no real browser, exactly like `detector-gate.test.js`.

## Migration

1. Land `runtime-qa-match.js` + the 7 member `.md` files + `data-validator`'s gate contract
   + the `config.runtimeQa` block (no behavior change — `enabled: false` default).
2. Land `runtime-qa-gate.js` + the `needs-runtime-qa` stage wiring in `orchestrator.md` +
   `PIPELINE.md` state row + 7 `agent:*-validator` provenance labels + `pipeline-init.md`
   label/install-loop entries + `manifest.json` registration.
3. Apply the overlap trims to `regression-tester.md` and `feature-validator.md`.
4. Validate on a few PRs behind `enabled: false`, then default on.

Each step is independently revertible; turning the gate off restores the prior chain exactly.

## Out of scope (this spec)

- **The autonomous-merge decision** — this gate produces per-PR runtime verdicts and keeps
  `ready-for-human` human-owned; a merge-decider that consumes them is separate.
- **Cross-browser** — `agent-browser` is Chromium-only.
- **A standalone console-error agent** — console capture is deliberately a harness check, not
  a member.
- **Re-splitting `data-validator`** — it stays one agent; it gains a gate contract, not a
  decomposition.
- **The SDLC dashboard view, over-engineering reviewer, and change-splitter** — separate
  specs.
