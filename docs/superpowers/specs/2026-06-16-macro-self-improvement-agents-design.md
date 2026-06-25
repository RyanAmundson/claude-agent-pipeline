# Macro self-improvement agent pair — design

**Date:** 2026-06-16
**Status:** approved (design phase)

## Goal

Add a **system-altitude** self-improvement loop on top of the existing per-transcript one.
Today CAP improves itself reactively, one anomaly at a time. Nothing reads the *whole
corpus at once*, nothing checks whether *past fixes actually held*, and nothing can
*create a new agent or change topology*. This pair closes those three gaps while keeping
CAP's read-only-diagnoser vs. implementer separation and its human-merge gate intact.

## Why now

CAP's self-improvement is already a three-layer stack, all bottom-up and instance-driven:

1. **Orchestrator §3.5 self-audit** — every cycle, ~60s, shallow: small 1–3 line rule
   additions; flags big overhauls for the owner.
2. **`transcript-reviewer`** (`improvement` stage) — every ~10 runs
   (`transcriptReview.cadence`) or on human intervention: per-transcript diagnosis →
   compounding lessons (`config.lessonsDir`, fingerprint `improvement:<class>:<agent>`,
   with `occurrences`/`first-seen`/`last-seen`) + `improvement-finding`s.
3. **`agent-improver`** (`implementation` stage) — one finding → one focused
   agent-def/rule/doc PR → human merge. **Explicitly edits existing agents only; never
   creates new agents and never changes topology.**

The data to evaluate the system as a whole already exists and is unused as an aggregate
signal: `.pipeline/runs/completed/*.json` + `logs/<runId>.events.jsonl` (cost, tool
calls), `.pipeline/runs/cycles.jsonl` (dispatch history), the lessons corpus, the
`.pipeline/findings/` dir, and the git history of merged `chore:` improvement PRs (which
cite the lesson fingerprint they fixed).

## Shape — a second read/act pair, one altitude up

Mirrors `transcript-reviewer` → `agent-improver`, but operates on the corpus instead of a
single transcript, and the actor can make *structural* changes.

```
 runs / cycles / lessons / findings / merged-improvement-PR history
        │  (read-only, volume-triggered)
        ▼
 ┌─────────────────────┐  improvement-regression ──────▶ agent-improver  (re-fix / escalate)
 │  pipeline-evaluator │  capability-gap ──────────────▶ agent-architect (new agent / topology)
 │  → scorecard.jsonl  │  strategy-finding ────────────▶ human triage    (informational)
 └─────────────────────┘
                                                              │
                          agent-architect: worktree → PR → code-reviewer → HUMAN MERGE
                          + ledger.jsonl + per-PR change digest   (log & present)
```

### `pipeline-evaluator` (stage `improvement`, read-only)

Provenance `agent:pipeline-evaluator`. Strictly read-only — diagnoses, never edits
(same contract as `transcript-reviewer`). Three jobs, matching the "combination" scope:

- **Aggregate evaluation.** Computes a **scorecard** from existing artifacts:
  human-intervention rate, PR rework/bounce rate (items returning to `needs-feedback`),
  cycle yield (runs producing a PR/finding vs. empty), cost/tokens per shipped ticket, and
  findings-per-agent. Reports the **trend** vs. the previous scorecard, not just a snapshot.
- **Effectiveness verification.** For each lesson whose fix merged at time *T* (the
  `agent-improver` `chore:` PR that cites the fingerprint), check whether the class
  **recurred after *T*** — i.e. `transcript-reviewer` advanced that fingerprint's
  `last-seen` to a runId dated after the merge. Recurrence ⇒ the fix didn't hold ⇒ file an
  `improvement-regression`. Computable from `lessonsDir` + git log of merged `chore:` PRs +
  run timestamps; **no new instrumentation required to start.**
- **Capability-gap detection.** Patterns no existing agent owns — repeated failures in an
  area with no responsible specialist, or a stage that is chronically a bottleneck — ⇒ file
  a `capability-gap` proposing a new agent, retiring a dead one, or rerouting.

Privacy guardrail (inherits `transcript-reviewer`'s): never copy raw transcript text into
externally visible artifacts; cite `runId`/`sessionId` and de-identified summaries only.

### `agent-architect` (stage `implementation`, produces `pr`)

Provenance `agent:agent-architect`. Consumes the **structural** findings. The riskiest
actor in CAP — it can **author new `agents/*.md`, retire agents, and rewire
routing/topology** (`manifest.json`, `agents/ORCHESTRATION.md`, `agents/PIPELINE.md`).
One structural change per cycle, in an isolated worktree, opens a PR, **never merges**,
hands off to `code-reviewer`.

**Autonomy with mandatory transparency (the operator's requirement):** it does *not* need
a pre-approval concept gate — it builds structural findings directly — but it **must log
and present every change it makes**:

- **`ledger.jsonl`** — one entry per structural change: what file/agent/route changed, the
  finding + evidence (`runId`s, fingerprints), the PR ref, provenance. The durable audit
  trail.
- **Per-PR change digest** — every PR body leads with a `[agent:agent-architect]` digest:
  *"Added agent X / rerouted Y→Z; because <evidence>; affects <these stages>."* Plus a PR
  comment. A human sees the structural change at a glance before merging — the merge gate
  is the safety, the digest+ledger make it reviewable.

**Retiring** an agent means: move its `.md` to `agents/retired/`, remove it from
`manifest.json`'s `agents` array, and update `ORCHESTRATION.md`/`PIPELINE.md` to note
the removal — all in the same PR, never merged unilaterally.

New agents the architect authors **must conform** to `agent-work-protocol.md` (both
metadata halves, identity tags, idle behavior, worktree-first, backend-aware sections) and
update `ORCHESTRATION.md`/`PIPELINE.md`/`README.md` in the same PR, or the PR is incomplete.

## Finding contracts (preserves single-producer / single-consumer)

The evaluator gets its **own** finding types so it never collides with
`transcript-reviewer`'s `improvement-finding`. All tagged `domain:pipeline-improvement`,
so existing routing/labels apply.

| Finding type | Producer | Consumer |
|---|---|---|
| `improvement-finding` | transcript-reviewer | agent-improver *(unchanged)* |
| `improvement-regression` | pipeline-evaluator | agent-improver *(consumes-additionally: "your last fix didn't hold")* |
| `capability-gap` | pipeline-evaluator | **agent-architect** |
| `strategy-finding` | pipeline-evaluator | human triage *(informational; promotable to one of the above)* |

`agent-improver`'s `consumes` is extended to include `improvement-regression`; everything
else about it is unchanged.

## "Log & present" artifacts — `.pipeline/improvement/`

- **`scorecard.jsonl`** — one `pipeline-evaluator` entry per cycle (metrics + trend
  deltas). Feeds `agent-pipeline events` / the dashboard like `cycles.jsonl` does.
- **`ledger.jsonl`** — one `agent-architect` entry per structural change (above).
- Per-cycle human-readable assessment is the evaluator's console summary +
  `strategy-finding` bodies; the structural digest lives in the PR.

## Guardrails (an agent that writes agents + topology)

- **Loop-critical files stay flag-for-human, even for the architect.**
  `agents/orchestrator.md` (the agent definition), `agents/agent-work-protocol.md`, and
  the **evaluator's & architect's own definitions** are never silently rewritten — the
  architect opens the PR with a prominent `needs-human-decision` note and stops short of
  self-modifying the loop that dispatches it. **`agents/ORCHESTRATION.md`** (the
  documentation file, not the agent def) is NOT loop-critical — the architect authors it
  freely, e.g. adding a routing row for a new agent it just created. Everything else it
  authors freely (logged + presented).
- **Never weaken a guardrail to improve a metric** (inherits `agent-improver`'s rule) —
  e.g. it cannot delete the no-tests / no-dev-server / worktree-first rules to raise "cycle
  yield." Ties into `justify-non-standard-additions` + `justification-detector`.
- **One structural change per cycle**, small reviewable diffs, **compounding-only** (must
  name the class it prevents, or it goes back as a question).
- **Evaluator is strictly read-only.** It diagnoses; it never edits.

## Invariants preserved

- **Role-overlap:** evaluator produces *new* artifacts (`improvement-regression`,
  `capability-gap`, `strategy-finding`); `transcript-reviewer` keeps sole ownership of
  `improvement-finding`. `capability-gap` has a single consumer (`agent-architect`). No
  producer collision.
- **Both metadata halves:** each new agent carries YAML `name:`/`description:`/`pipeline:`
  *and* the prose `**Role/Input/Output/Provenance/Scope**` block — Agent-tool dispatchable
  *and* renders in the dashboard agents tab.
- **Process management / idle / scope-from-config / identity tags / backend-aware:** both
  follow the standard `agent-work-protocol`. Evaluator validates without running product
  tooling, exactly like `agent-improver`.

## Wiring

- **Orchestrator:** new low-cadence dispatch row — run `pipeline-evaluator` when any
  `pipelineEvaluation` threshold trips (runs / new lessons / improver merges since its
  cursor); also manually invokable. The evaluator maintains a
  **`.pipeline/improvement/cursor.json`** (last-evaluated runId + lesson count +
  improver-merge SHA) — same cursor-advance pattern as `transcript-reviewer`. Route `capability-gap` tickets → `agent-architect`;
  `improvement-regression` → `agent-improver`; `strategy-finding` stays in triage for the
  human. Both new agents respect the existing `readyQueueSaturation` backoff.
- **Manifest:** `pipeline-evaluator` `requires: []` (optional github/linear for
  intervention/PR-history signals); `agent-architect` `requires: [github]`, optional
  linear. Reuse the existing `improvement` and `implementation` stages.
- **Config (`config.schema.json`):** add an **opt-in** `pipelineEvaluation` block
  (absent ⇒ feature off, like `relevance`): `enabled` (default `false`), `cadence`
  (completed runs since last eval, default `50`), `minNewLessons` (default `5`),
  `minImproverMerges` (default `1`). Any threshold being met triggers a dispatch; all
  three default to low values so the first real cycle fires after modest pipeline
  activity.
- **Docs:** README agent count/stages; `ORCHESTRATION.md` new dispatch row + finding
  routing + the three-layer→five-layer self-improvement note; `PIPELINE.md` provenance
  labels (`agent:pipeline-evaluator`, `agent:agent-architect`) + finding-type table.

## Testing

Filesystem-backend e2e, claude-free (pattern of `12-orchestrator.sh` /
`AP_ORCHESTRATOR_CYCLE_FAKE`):

- Seed fake `completed/*.json` runs, a lessons corpus, and a merged-fix history. Assert the
  evaluator writes a `scorecard.jsonl` entry, emits an `improvement-regression` for a class
  that recurred after its fix merged, and emits a `capability-gap` for an unowned repeated
  failure. Assert it idles out when no threshold trips.
- Assert `agent-architect` scaffolds a **parseable** new agent
  (`agent-pipeline agent <name>` renders Role/Input/Output), writes a `ledger.jsonl` entry
  + PR digest, and **stops-with-flag** when a finding would touch a loop-critical file.
- `agent-pipeline list-agents` / `agent pipeline agent <name>` parse checks for both new
  defs.

## Integration with the new-feature pipeline (landed on main 2026-06-17)

The new-feature pipeline (epics, fan-out, `feature:*` states) and the `conflict-resolver`
agent merged to `main` concurrently with this work; this branch was rebased onto them. The
two efforts are additive (no textual conflicts), but the macro loop is made **aware** of the
feature pipeline so it evaluates the whole system, not just the bug-fix path:

- **`pipeline-evaluator`** scores feature-pipeline health **when `.pipeline/epics/` exists** —
  epic state dwell, fan-out yield, epic rework, and conflict-resolution recurrence (a PR
  re-flagged `pipeline:needs-conflict-resolution` after `conflict-resolver` already fixed it).
  These appear as an optional `featurePipeline` block in `scorecard.jsonl`. **When the feature
  pipeline is not in use, the block is omitted entirely** — never synthesized, consistent with
  the "never invent findings / never lower the bar" discipline.
- **`agent-architect`** treats feature-pipeline *topology* (epic dispatch, `feature:*`
  transitions, conflict routing) as **orchestrator-owned and loop-critical** — a capability-gap
  needing it rerouted goes in the `needs-human-decision` note. It may still author new
  feature-pipeline agents, which must conform to the contracts in
  `docs/superpowers/specs/2026-06-17-new-feature-pipeline-design.md`.
- **Forward-compatible by design.** The feature pipeline is currently **spec-only** (the
  inferred `feature-*` agents are not implemented on disk; only `conflict-resolver` is). The
  extension therefore references only artifacts/contracts that exist (`feature:*` states,
  `.pipeline/epics/`, `conflict-task`, `agent:conflict-resolver`) and guards every read on the
  epics directory being present — so it activates automatically if/when the pipeline ships,
  and stays silent until then.
- **Invariants intact.** No new finding types were added here; `conflict-task`
  (branch-updater → conflict-resolver) does not collide with the evaluator's three types. The
  single-producer / single-consumer contract is unchanged.

## Decisions locked (operator-confirmed)

- Scope = combination: aggregate evaluation **+** effectiveness verification **+** new-agent
  proposals.
- Topology = **parallel pair one altitude up** (read-only `pipeline-evaluator` +
  implementer `agent-architect`), not a single combined agent.
- Trigger = **volume-triggered** (idles out otherwise).
- Architect gate = **autonomous but must log & present** every change; CAP's human-merge
  gate remains the final safety.
- Both agents **off by default** (opt-in `pipelineEvaluation.enabled`); effectiveness
  measured from existing lesson fingerprints + merged-PR history (no new instrumentation to
  start).
