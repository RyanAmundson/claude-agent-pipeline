# Over-Engineering Reviewer for CAP

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Branch:** `feat/over-engineering-reviewer`
**Related:** Runs beside `agents/code-reviewer.md` at the code-review gate; routes concrete
simplifications toward `agents/code-simplifier.md`.

## Goal

A per-PR **review** check that judges whether *this change* is over-engineered — more
complex than the problem in front of it warrants — and flags it before merge. It reads the
diff, comments on the PR with concrete simpler alternatives, and routes blocking findings to
`needs-feedback`. It is **identify-and-route**, not a fixer: it never edits code.

It fills a real gap. `code-simplifier` already finds and *fixes* over-complexity, but only as
a background loop on `main` — it never looks at an open PR. `code-reviewer` checks
correctness and general quality, not "is this the simplest design for the requirement." This
check reviews the **altitude** of a change, per-PR — as one more reviewer at the same gate
where code review already happens.

## Background / current state

- **`code-reviewer`** (`agents/code-reviewer.md`, sonnet) is the diff-review gate at
  `pipeline:needs-code-review` → advances on pass. It targets correctness and quality, not
  over-engineering specifically.
- **`code-simplifier`** (`agents/code-simplifier.md`) is loop-based (`consumes: loop-tick`):
  it scans `main`, pins behavior under a characterization test, simplifies, and opens a
  `refactor:` PR. It is a fixer, and it **never reviews open PRs**.
- **`declarative-refactor-specialist`** migrates to blessed declarative patterns;
  **`dead-code-remover`** deletes proven-dead code. Neither judges over-engineering on a PR.
- **The detector-gate** runs mechanical one-pattern checks on a diff. Over-engineering is
  holistic ("this whole abstraction is unnecessary for one call-site") and does not fit the
  one-rule detector mold — the user chose a reviewer, not a detector entry.
- **Review is a category, not a single pass.** Code review is the main one, but there are
  several review concerns. The user's call: add new concerns as **additional reviewers at the
  code-review gate**, not as a new pipeline state each — otherwise you'd end up clumping them
  into one reviewer anyway.

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Shape | **A PR reviewer**, like `code-reviewer` — not a `detectors.registry.json` entry, not an extension of `code-simplifier`. |
| Placement | **An additional reviewer at the `pipeline:needs-code-review` stage**, run alongside `code-reviewer` — **not its own state**. The stage advances only when every reviewer passes. Code review is the main pass; this is one more concern at the same gate. |
| Action | **Identify + comment + route only.** It never edits code. Concrete, mechanical simplifications are noted for `code-simplifier` to pick up on `main`; nothing is auto-applied. |
| Routing | Reuse the severity vocabulary — any reviewer's `blocker`/`major` → `pipeline:needs-feedback` (existing `feedback-responder`); `minor`/`nit` → non-blocking comment, advance. |
| Bias | **Lean pass on subjective calls** — only flag complexity that is clearly unjustified for the requirement; never block on taste. |
| Model | **sonnet** (semantic judgment); same tier as `code-reviewer`. |

## What it flags (diff-introduced over-engineering)

It judges **what the diff adds**, not pre-existing complexity:

| Pattern | Simpler alternative it suggests |
|---|---|
| Premature/single-use abstraction (factory/strategy/wrapper for one call-site) | Inline it |
| Speculative generality (params/options/config for cases that don't exist) | Reduce to the one case in use |
| Needless indirection (pass-through layer that adds nothing) | Call the underlying thing directly |
| Reinvented utility (hand-rolls something the codebase/stdlib already provides) | Use the existing util |
| Gratuitous pattern (event bus, DI, generics where a function would do) | The plain form |
| New deep nesting / tangled conditionals introduced by the diff | Early returns / guard clauses |

**Explicitly NOT a finding:** justified complexity with a nearby `// intentional:`/`// keep:`
note, performance-motivated complexity with a measurement, complexity the ticket explicitly
asked for, and any pre-existing complexity the diff merely touches.

## Architecture

### Components

**1. Agent definition — `agents/over-engineering-reviewer.md`**

Frontmatter like `code-reviewer.md`: `pipeline.stage: review`, `consumes: pr` at
`needs-code-review`, `produces: review-verdict`. Body: the rubric above (flag-list +
NOT-a-finding list), the diff-only scope, the comment format (inline concrete alternative per
finding), and the no-edit rule. Provenance `agent:over-engineering-reviewer`.

**2. Verdict persistence — `.pipeline/reviews/<pr>/overeng.json`**

Same verdict store the detector-gate/panel use (`{verdict, findings:[{severity,…}]}`), so a
future merge-decider reads it in the identical shape. Each reviewer posts its comment and
writes its verdict; the **stage gate** is the existing severity rule applied across the
reviewers at that stage.

**3. Code-review stage becomes a small review panel — `orchestrator.md`, `PIPELINE.md`, `pipeline-init.md`, `manifest.json`**

**No new state.** At `pipeline:needs-code-review` the orchestrator dispatches **both**
`code-reviewer` and `over-engineering-reviewer`; the stage advances only when **all**
reviewers pass (any reviewer's `blocker`/`major` → `needs-feedback`). Add the
`agent:over-engineering-reviewer` provenance label, the install-loop entry, and manifest
registration under stage `review` (requires `github`). This establishes the pattern: a new
review concern is **another reviewer at this gate**, not another state.

### Pipeline placement

```
worker → tester → pipeline:needs-code-review
  → code-reviewer             ┐ both run at the same gate (review panel)
  → over-engineering-reviewer ┘ stage advances only when BOTH pass
      all pass (no blocker/major) → pipeline:needs-detector-gate (or next enabled stage)
      any blocker/major           → pipeline:needs-feedback → feedback-responder
```

`config.review.overEngineering.enabled: false` drops it from the code-review gate;
`code-reviewer` alone gates the stage (current behavior — a clean regression guard /
gradual-rollout switch).

## Config additions — `config.schema.json`

```json
"review": {
  "overEngineering": { "enabled": true, "model": "sonnet" }
}
```

## Error handling

- **Human-comment override** → if an unresolved human comment exists, re-label to
  `needs-feedback` and skip (the global rule every reviewer follows).
- **Trivial/empty diff** (docs, config, generated) → `verdict: pass`, no finding.
- **Subjective/ambiguous** → lean pass with at most a `nit` comment; never block.
- **Blocked/merged/draft PR** → skipped (global rules).
- **Disabled** (`overEngineering.enabled: false`) → not dispatched; `code-reviewer` alone
  gates `needs-code-review`.
- **Reviewer crash** → the stage is not advanced until a verdict exists; re-dispatch on the
  next cycle (the gate never advances on a missing reviewer verdict — fail-closed).

## Testing

- **Stage gate (unit):** `needs-code-review` advances only when **both** reviewers pass; any
  reviewer's `blocker`/`major` → `needs-feedback`; only `minor`/`nit` across both → advance.
  Reuse the shared severity gate.
- **Disabled (unit):** `enabled: false` → over-engineering reviewer not dispatched;
  `code-reviewer` alone advances `needs-code-review` (regression guard).
- **Rubric fixtures:** diff fixtures with expected verdicts — a single-use factory introduced
  by the diff → `major`; a justified-with-comment abstraction → pass; a pure docs diff →
  pass. (Agent-prose behavior validated against fixtures, like other reviewers.)
- **Provenance/store:** the reviewer writes `.pipeline/reviews/<pr>/overeng.json` in the
  shared verdict shape.

## Migration

1. Land `agents/over-engineering-reviewer.md` + the `config.review.overEngineering` block
   (default `enabled: false`).
2. Wire it as a **second reviewer at `needs-code-review`** (the stage advances only when both
   pass) + provenance label + manifest registration.
3. Validate on a few PRs behind the flag, then default on.

Reverting is a one-line flag flip; the reviewer simply stops being dispatched at the gate.

## Out of scope (this spec)

- **Fixing the over-engineering** — that stays `code-simplifier`'s job (on `main`, behavior-
  pinned). This check only identifies and routes.
- **Whole-codebase over-engineering sweeps** — it reviews the diff in front of it.
- **Auto-applying suggested simplifications** — never; suggestions are comments.
- **A generalized multi-reviewer panel framework** — this spec adds one reviewer at the gate
  and notes the pattern; building a formal panel host is a later step if more concerns land.
- **The runtime-QA gate, SDLC view, and change-splitter** — separate specs.
