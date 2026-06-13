# Transcript-review agent pair — design

**Date:** 2026-06-12
**Status:** approved (design phase)

## Goal

Operationalize the pipeline's existing-but-unbuilt **Continuous Improvement** paradigm
(PIPELINE.md §"Continuous Improvement", `config.lessonsDir`): review what the agents
*actually did* in completed runs and in the human's own sessions, and turn that into
concrete improvements to the agent definitions — without a human having to notice and
file each one.

## Why now

`runner/dispatch.js` already writes a full stream-json transcript of every agent
dispatch to `.pipeline/runs/logs/<runId>.events.jsonl` (assistant text, tool calls,
results, cost). Raw Claude Code session transcripts live at
`~/.claude/projects/<repo>/*.jsonl`. Both are unused as a learning signal today.

## Shape — a read/act pair (mirrors detector → ticket-creator → worker)

### `transcript-reviewer` (new stage `improvement`, read-only)

- **Reads:** completed runs (`.pipeline/runs/completed/*.json` + their
  `logs/<runId>.events.jsonl`), raw CC session transcripts (`config.transcriptsDir`,
  default the CC projects dir for this repo), and human interventions (PR/Linear
  comments by `config.humanReviewer`).
- **Detects:** paradigm violations *in observed behavior* (dev server started, identity
  tag skipped, filter broadened when it should have gone idle, tests run by a specialist,
  worktree skipped), wasted/high-cost low-yield cycles, repeated failures, and every
  human intervention (the training signal).
- **Emits two things:**
  1. compounding **lessons** appended to `config.lessonsDir`, each with a stable
     fingerprint `improvement:<pattern-class>:<agent>` — a recurrence updates the
     existing lesson instead of duplicating;
  2. a `pipeline:needs-triage` **`improvement-finding`** tagged
     `domain:pipeline-improvement`.
- **Privacy guardrail (raw CC transcripts are in scope):** never copies raw transcript
  text into any externally visible artifact (ticket/PR/Linear) — only de-identified
  summaries citing `runId`/`sessionId`. Keeps secrets/PII out of tickets.

### `agent-improver` (stage `implementation`, produces `pr`)

- **Consumes** the `improvement-finding` (orchestrator routes
  `domain:pipeline-improvement` tickets here instead of the generic `worker`).
- **Edits ONLY** `.claude/agents/*.md`, `.claude/rules/*.md`, and pipeline docs —
  never product code. One focused change per cycle, in an isolated worktree, opens a PR,
  **never merges**, hands off to `code-reviewer` so agent-definition changes still pass
  the human gate.
- **Guardrails:** the fix must be *compounding* (kills the class, not the instance) and
  logged; it may **not weaken a guardrail** (e.g. relax the no-test rule) without written
  justification (ties into `justify-non-standard-additions` + `justification-detector`);
  it **flags for human** rather than silently editing the orchestrator or its own
  definition.

## Invariants preserved

- **Role-overlap:** reviewer produces the *new* artifact `improvement-finding` (scanner
  keeps sole ownership of `finding`); improver is its single consumer. No producer
  collision.
- **Both metadata halves:** each new agent carries YAML `name:`/`description:` *and* the
  prose `**Role/Input/Output/Provenance/Scope**` block, so they are Agent-tool
  dispatchable *and* render in the dashboard agents tab. (Also the reference template for
  the metadata-split fix applied to the existing 12 frontmatter-only agents.)
- **Process management / idle / scope-from-config / identity tags / backend-aware:** both
  follow the standard agent-work-protocol.

## Wiring

- **Orchestrator:** new low-cadence dispatch row — run `transcript-reviewer` when ≥N
  completed runs accumulate since its cursor, or after a human intervention; also manually
  invokable. Route `domain:pipeline-improvement` tickets → `agent-improver`.
- **Manifest:** `transcript-reviewer` `requires: []` (optional github/linear for
  interventions); `agent-improver` `requires: [github]`, optional linear. New stage
  `improvement`.
- **Config (`config.schema.json`):** add `transcriptsDir` and optional
  `transcriptReview.cadence` (completed-runs threshold).
- **Docs:** README agent count/stages, ORCHESTRATION.md stage + loop invariant,
  PIPELINE.md dispatch table + provenance labels (`agent:transcript-reviewer`,
  `agent:agent-improver`).
