# Over-Engineering Reviewer for CAP

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Branch:** `feat/over-engineering-reviewer`
**Related:** Sits beside `agents/code-reviewer.md` in the Review phase; routes concrete
simplifications toward `agents/code-simplifier.md`.

## Goal

A per-PR **review** agent that judges whether *this change* is over-engineered — more
complex than the problem in front of it warrants — and flags it before merge. It reads the
diff, comments on the PR with concrete simpler alternatives, and routes blocking findings to
`needs-feedback`. It is **identify-and-route**, not a fixer: it never edits code.

It fills a real gap. `code-simplifier` already finds and *fixes* over-complexity, but only as
a background loop on `main` — it never looks at an open PR. `code-reviewer` checks
correctness and general quality, not "is this the simplest design for the requirement." This
agent reviews the **altitude** of a change, per-PR.

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

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Shape | **A PR reviewer**, like `code-reviewer` — not a `detectors.registry.json` entry, not an extension of `code-simplifier`. |
| Placement | **Its own state `pipeline:needs-overeng-review`**, immediately after `needs-code-review` (Review phase), before the detector-gate. |
| Action | **Identify + comment + route only.** It never edits code. Concrete, mechanical simplifications are noted for `code-simplifier` to pick up on `main`; nothing is auto-applied. |
| Routing | Reuse the severity vocabulary — `blocker`/`major` → `pipeline:needs-feedback` (existing `feedback-responder`); `minor`/`nit` → non-blocking comment, advance. |
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
`needs-overeng-review`, `produces: review-verdict`. Body: the rubric above (flag-list +
NOT-a-finding list), the diff-only scope, the comment format (inline concrete alternative per
finding), and the transition rules. Provenance `agent:over-engineering-reviewer`.

**2. Verdict persistence — `.pipeline/reviews/<pr>/overeng.json`**

Same verdict store the detector-gate/panel use (`{verdict, findings:[{severity,…}]}`), so a
future merge-decider reads it in the identical shape. The reviewer posts its comment and
applies the label; the gate decision is the same severity rule the rest of the pipeline uses.

**3. Pipeline wiring — `orchestrator.md`, `PIPELINE.md`, `pipeline-init.md`, `manifest.json`**

New state row + on-demand dispatch (`needs-overeng-review` items exist → dispatch), the
`agent:over-engineering-reviewer` provenance label, the install-loop/label-create entries,
and manifest registration under stage `review` (requires `github`).

### Pipeline placement

```
worker → tester → code-reviewer (pass) → pipeline:needs-overeng-review     [new stage]
  → over-engineering-reviewer
      no blocker/major → pipeline:needs-detector-gate (or next enabled stage)
      any blocker/major → pipeline:needs-feedback → feedback-responder
```

`config.review.overEngineering.enabled: false` makes `code-reviewer` advance straight past
this stage (regression guard / gradual rollout), exactly like the detector-gate flag.

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
- **Disabled** (`overEngineering.enabled: false`) → stage unreachable; `code-reviewer` emits
  the next state directly.

## Testing

- **Transition logic (unit):** any `blocker`/`major` → `needs-feedback`; only `minor`/`nit`
  → advance to the next enabled stage; reuse the shared severity gate.
- **Disabled (unit):** `enabled: false` → `needs-overeng-review` is unreachable;
  `code-reviewer` advances to the next stage (regression guard).
- **Rubric fixtures:** a small set of diff fixtures with expected verdicts — a single-use
  factory introduced by the diff → `major`; a justified-with-comment abstraction → pass; a
  pure docs diff → pass. (Agent-prose behavior validated against fixtures, like other
  reviewers.)
- **Provenance/store:** the reviewer writes `.pipeline/reviews/<pr>/overeng.json` in the
  shared verdict shape.

## Migration

1. Land `agents/over-engineering-reviewer.md` + the `config.review.overEngineering` block
   (default `enabled: false`).
2. Add the `needs-overeng-review` stage wiring + provenance label + manifest registration.
3. Validate on a few PRs behind the flag, then default on.

Reverting is a one-line flag flip; the stage simply disappears from the chain.

## Out of scope (this spec)

- **Fixing the over-engineering** — that stays `code-simplifier`'s job (on `main`, behavior-
  pinned). This agent only identifies and routes.
- **Whole-codebase over-engineering sweeps** — it reviews the diff in front of it.
- **Auto-applying suggested simplifications** — never; suggestions are comments.
- **The runtime-QA gate, SDLC view, and change-splitter** — separate specs.
