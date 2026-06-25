# Change Splitter for CAP

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Branch:** `feat/change-splitter`
**Related:** Consumes the `needs-split` label raised by `agents/worker.md` /
`agents/ticket-creator.md`; reuses the child auto-merge substrate in
`agents/FEATURE-PIPELINE.md` (§Child Auto-Merge).

## Goal

An agent that takes **one completed change that is too large** and physically splits it into
two or more smaller, independent changes — each placed into the **same pipeline state the
original was in** — then retires the original. Smaller changes are safer to review and merge
(and, where they are epic children, agent-mergeable via the existing auto-merge path).

This closes a real dead-end. When a change is too big, `worker`/`ticket-creator` raise the
`needs-split` label today, which **stops for human guidance**. The change-splitter consumes
that exact signal and performs the split automatically.

## Background / current state

- **`needs-split` is a human punt today.** `worker.md` ("split the work into multiple
  sequential tickets … or label the ticket `needs-split` and stop for human guidance") and
  `ticket-creator.md` ("if a finding is genuinely too large … add the `needs-split` label
  for human attention") both raise it and stop. No agent consumes it.
- **`feature-decomposer` splits a *design*, not a *diff*.** It breaks an epic's design into
  child tickets **before any code exists** (spec-level). The change-splitter is the post-code
  counterpart: it splits a finished diff.
- **Agent-merge of small slices already exists.** The orchestrator auto-merges epic children
  (child tickets carrying an `epic` field) into the integration branch once they pass the
  gates (`FEATURE-PIPELINE.md` §Child Auto-Merge; `orchestrator.md`). Independent slices that
  are epic children can ride this path; standalone slices still terminate at `ready-for-human`
  (smaller, so safer for the human).
- **Dependency + conflict primitives exist.** `blocked-by:#NNN` parks a PR behind another;
  `conflict-resolver` handles merge conflicts against a PR's base. The size ceiling
  `config.maxAutoFixDiffLines` (~150, from the detector spec) is the property that defines
  "too large."
- **Worktree discipline is mandatory** (`agent-work-protocol.md`): all branch work happens in
  an isolated worktree, never on `main`.

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Action | **Actually perform the split** — produce ≥2 separate changes, not just a recommendation/plan. |
| State preservation | Each resulting change is placed into the **same pipeline state** the original was in; the original is then **retired** (closed/superseded with links to the children). |
| Trigger | **Consumes the `needs-split` label** (the existing human-punt signal). |
| Dependencies | Independent slices → parallel (each `base` = the original's base). Dependent slices → chained via `base`/`blocked-by:#NNN`, ordered prerequisite-first. |
| Safety | **Never ship a broken slice.** If the diff can't be cleanly split (every hunk interdependent), don't force it — escalate to a human. |
| Granularity | Target each slice ≤ `config.maxAutoFixDiffLines`; one coherent concern per slice; minimum 2 slices (else it wasn't splittable → escalate). |

## Architecture

### Components

**1. Agent definition — `agents/change-splitter.md`**

`pipeline.stage: implementation`, `consumes: needs-split`, `produces: pr` (×N). Worktree-first
(like `code-simplifier`). Provenance `agent:change-splitter`. Backend-aware (GitHub vs
filesystem).

**2. Split algorithm**

1. **Read the original** — its diff/commits, `base`, current pipeline state `S`, and labels.
2. **Group into slices** — partition the diff into independent coherent units, respecting
   import/build dependencies so each slice compiles on its own (or is chained to the slice it
   needs). Grouping favors one concern / feature-folder per slice and the size cap.
3. **Order** — topologically sort slices by dependency: independent first (parallel),
   dependents chained.
4. **Materialize each slice** — in a worktree, branch off the appropriate base (original's
   base for independent slices; the prerequisite slice's branch for dependents), apply that
   slice's hunks (cherry-pick / partial patch), and open the change carrying the **same labels
   and pipeline state `S`** as the original. Dependents also get `blocked-by:#<prereq>`.
5. **Retire the original** — close the PR / move the ticket to `obsolete` (or a superseded
   state) with a comment linking the children; remove `needs-split`.

**3. State-preservation rule**

A child re-enters at `S`, so it re-runs the remaining gates from where the parent was (e.g.
`S = needs-code-review` → each child is code-reviewed independently). This is what makes the
split *safe*: every piece is re-validated at its own size.

**4. Backend parity**

- **GitHub:** `gh pr create` per slice with the original's labels; `blocked-by` for
  dependents; `gh pr close` the original with the linking comment.
- **Filesystem:** write per-slice tickets into `.pipeline/queue/<S>/` with `base`/`branch`/
  `blocked_by`, branches created locally (never pushed); move the original to `obsolete/`.

**5. Dispatch — `orchestrator.md`**

On-demand: `needs-split` items exist → dispatch `change-splitter` (one item per cycle), added
to the on-demand dispatch table. Not a linear-chain stage — it can fire on an item in any
state `S`.

### Pipeline placement

```
any item at state S labeled needs-split
  → change-splitter (worktree)
      ├─ slice 1 → new change at state S (base = original base)
      ├─ slice 2 → new change at state S (base = original base)         [independent → parallel]
      └─ slice 3 → new change at state S (base = slice 1, blocked-by:#1) [dependent → chained]
  → original retired (closed/obsolete, links to children, needs-split removed)
  → children flow the remaining gates independently; merge via the existing path
      (ready-for-human for the human, or child-auto-merge for epic children)
```

## Config additions — `config.schema.json`

```json
"changeSplitter": {
  "enabled": true,
  "maxSliceDiffLines": 150,
  "maxSlices": 6
}
```

`maxSliceDiffLines` defaults to `maxAutoFixDiffLines`. `enabled: false` leaves `needs-split`
as a human punt (current behavior — a clean regression guard).

## Error handling

- **Not safely splittable** (every hunk interdependent, or it would exceed `maxSlices`) →
  create no children; comment why and re-label for a human (`needs-split-human`), leaving the
  original intact. Fail safe — never produce a half-split.
- **A slice won't build on its own** → fold its dependent hunks into one slice, or chain via
  `blocked-by`; never open a non-building slice.
- **Original already merged/closed** → skip (merged PRs are done).
- **Conflict applying a slice** → route that slice to `conflict-resolver` against its base, or
  rebuild it; the other slices proceed.
- **Human-comment override / blocked / draft** → skip (global rules).
- **Partial failure mid-split** (some children created, then an error) → the run is
  idempotent-keyed by original id; re-dispatch resumes/cleans up rather than duplicating
  children.

## Testing

- **Slice grouping (unit):** a multi-concern diff (pure function over hunks/files) → expected
  slices with their dependency edges; an entangled diff → "unsplittable" signal, zero slices.
- **State preservation (unit):** original at state `S` → every child created at `S`; original
  marked retired.
- **Dependency wiring (unit):** dependent slices get `base`/`blocked-by` to their prerequisite;
  independents get `base` = the original's base.
- **Size (unit):** each slice ≤ `maxSliceDiffLines` where achievable; > `maxSlices` needed →
  escalate.
- **Backend parity:** GitHub path opens N PRs + closes the original; filesystem path writes N
  tickets into `queue/<S>/` + moves the original to `obsolete/`.
- **Idempotency:** re-dispatching on the same original does not create duplicate children.
- Pure logic uses injected git/dispatch seams (no real network), like the gate runners.

## Migration

1. Land the slice-grouping logic + `agents/change-splitter.md` + the `config.changeSplitter`
   block (default `enabled: false` — `needs-split` still punts to a human).
2. Wire the on-demand dispatch + provenance label + manifest registration (stage
   `implementation`, requires `github`).
3. Validate on a few oversized PRs behind the flag, then default on.

Reverting restores the human-punt behavior with one flag.

## Out of scope (this spec)

- **The merge decision** — children merge via the existing paths (`ready-for-human` for the
  human, or epic child-auto-merge). This spec only produces the smaller, same-state changes.
- **Deciding *when* a change is too large** — that's the size cap / `needs-split` trigger,
  owned by `worker`/`ticket-creator` and `config.maxAutoFixDiffLines`.
- **Splitting a *design*** — that's `feature-decomposer` (pre-code).
- **The runtime-QA gate, SDLC view, and over-engineering reviewer** — separate specs.
