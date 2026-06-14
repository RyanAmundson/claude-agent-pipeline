# Relevance Agent — Design

- **Date:** 2026-06-12
- **Status:** Approved (brainstorm) — pending spec review
- **Repo:** `claude-agent-pipeline`
- **Author:** Ryan Amundson (with Claude)

## Problem

CAP's pipeline assumes that once a unit of work enters the queue, it stays worth
doing until it ships. That assumption decays over time. `main` keeps moving while
work waits:

- A **ticket** the scanner filed days ago may already be moot — the flagged file
  was deleted, the code smell was refactored away, or the exact fix landed in
  someone else's merge. A worker that picks it up burns a full implement → test →
  review cycle producing a no-op or a confusing diff.
- An **open PR** that sat in `ready-for-human/` while `main` advanced may no
  longer be relevant — not just textually conflicting (the `branch-updater`
  already handles rebasing), but *semantically* moot: the code it modifies was
  removed, or its goal was already achieved another way.

Today nothing in the pipeline asks **"is this change still relevant?"** before
spending effort or a human's review attention on it. The `branch-updater` keeps
branches mergeable; the detectors find *new* issues. No agent retires *existing*
work that the world moved past.

## Goal

Add a **`relevance-checker`** agent that, for staleness-gated tickets and PRs,
judges whether the change is still relevant against current `main`, emits a
confidence-scored verdict, and lets the orchestrator route high-confidence
obsolescence to automatic resolution and ambiguous cases to a human.

It is structurally the **inverse of a detector**: detectors scan `src/` for *new*
issues to file; the relevance-checker scans the *existing queue* for work that has
gone stale-in-meaning.

## Non-goals (v1)

- **Code edits.** The agent is read-only against the codebase. It never fixes,
  rebases, or merges — it only judges and records a verdict.
- **Re-scoping a still-relevant ticket.** If the underlying issue moved (e.g. the
  smell migrated to a renamed file), v1 flags it for human attention rather than
  rewriting the ticket's `source`. (See Future Work.)
- **Replacing `queue-stale.sh`.** The existing stale-sweep (re-queue abandoned
  `in-progress/` tickets) stays as-is. Relevance is a different question asked of
  a different set (un-worked `needs-work/` tickets and `ready-for-human/` PRs).
- **A new orchestrator loop.** Relevance is dispatched on-demand by the existing
  orchestrator, like every other non-orchestrator agent.

## Decisions (locked in brainstorm)

1. **Target — both lifecycle points.** One agent, two trigger conditions:
   `needs-work/` tickets *before* the worker picks them up, and
   `ready-for-human/` PRs *before* the human reviews them.
2. **Disposition — confidence-tiered.** The agent emits a confidence level; the
   orchestrator routes on a configurable threshold. High-confidence obsolescence
   auto-resolves; medium/low flags a human. The agent itself never makes the final
   state move — it reports, the orchestrator routes.
3. **Trigger — staleness-gated.** Only items aged past a threshold are eligible.
   Fresh items are presumed relevant. This targets exactly the drift window where
   relevance decays and keeps dispatch cost bounded (each check is a Claude run).
4. **PR auto-resolve — auto-close at high confidence.** A high-confidence-obsolete
   PR is closed automatically (`gh pr close`) with a reasoning comment, symmetric
   with ticket auto-obsoletion. PR closes are reversible (reopenable); full history
   is retained in `events.jsonl` and the close comment. Tunable off via
   `relevance.autoClosePRs`.

## Architecture

A standalone agent dispatched by the orchestrator, matching CAP's
one-agent-per-concern pattern (the same shape as the detectors and reviewers).
**Rejected alternative:** embedding relevance checks inside the `worker` (pre-work)
and `branch-updater` (pre-human). That would duplicate the logic across two agents,
mix concerns into agents whose job is something else, and remove the clean
enable/disable + isolated-test seam every other CAP agent has.

### Component: `agents/relevance-checker.md`

- **Input:** exactly one queue item the orchestrator has staleness-gated — a
  ticket in `needs-work/` *or* a PR/branch in `ready-for-human/`. The orchestrator
  passes the id (and PR ref in GitHub mode) in the dispatch prompt.
- **Scope:** `config.repo` only. Read-only against the codebase. No worktree
  needed — it reads `main` and the ticket/diff, it does not build.
- **Output:** a structured verdict recorded as
  - a ticket comment via `queue-comment.sh --author relevance-checker` (filesystem)
    or a PR/Linear comment (GitHub/Linear),
  - an `events.jsonl` `relevance` event,
  - a `pipeline:relevance-*` label in GitHub/Linear mode.
  The agent does **not** move the item between states — that is the orchestrator's
  job, based on the verdict (keeps the agent side-effect-light and testable).

### Verdict schema

Recorded in the comment body as a fenced block the orchestrator parses:

```json
{
  "verdict": "relevant" | "obsolete",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-paragraph human-readable justification",
  "evidence": [
    "source.file src/x/Old.tsx no longer exists on main (git cat-file -e HEAD:... → missing)",
    "exact pattern from finding not present at any path (rg returned 0 hits)"
  ]
}
```

`verdict: relevant` is the common case and always routes to "leave in place" — the
item proceeds normally. Only `verdict: obsolete` triggers routing on confidence.

### Relevance signals

**For a ticket** (judged against current `main`):

- Does `source.file` still exist on `main`?
- Is the flagged symbol / pattern / line still present (e.g. `rg` the smell at the
  recorded location and codebase-wide)?
- Was the exact fix already merged? (`git log --oneline -- <path>` since the
  ticket's `created_at`, plus a read of the current code.)
- Is there a duplicate ticket already in `done/` or `in-progress/` covering it?
- For a rule-based scanner finding: does the rule that generated it still exist
  (`config.rulesDir`)?

**For a PR/branch** (judged against current `main`):

- Does the code the diff touches still exist on `main`, or was it deleted /
  refactored away?
- Was the PR's goal already achieved by another merge — does the problem it solves
  still reproduce on `main`?
- Was the targeted feature / flag removed from `main`?
- (Mechanical conflict alone is **not** an obsolescence signal — that's the
  `branch-updater`'s job. Relevance is about meaning, not merge-ability.)

### Confidence rubric

| Confidence | Criteria (any one suffices) | Routing |
|---|---|---|
| **high** | `source.file` deleted; flagged pattern provably gone from the exact recorded location AND the ticket was location-bound; the ticket's described fix is literally present in a merged commit; PR's target symbol no longer exists on `main` | **auto-resolve** |
| **medium** | Area was refactored/renamed but the concern *might* still apply; partial overlap with a merge; PR target moved but still present | **flag human** |
| **low** | Conceptual / cross-cutting issue not bound to one location; weak or indirect evidence | **flag human** |

When evidence is mixed, the agent picks the **lowest** matching confidence (bias
toward keeping work, since auto-resolve discards it).

## State-machine changes

- **New terminal state `obsolete/`** (filesystem queue dir) and a
  `pipeline:obsolete` label (GitHub/Linear). Kept distinct from `done/` — `done`
  means *merged & shipped*, `obsolete` means *retired as no longer relevant*, so
  the two never conflate in metrics or history.
- **New non-terminal flag `relevance-review`** for medium/low-confidence flags.
  The item stays in its current state; the flag signals the human that an
  obsolescence question is open. A human (or a future re-check) clears it.
  Represented as the `pipeline:relevance-review` label in GitHub/Linear mode, and
  as a `relevance_review: true` ticket field in filesystem mode (which has no label
  namespace — state and flags live in the JSON).
- Reversibility: `obsolete/` is just a directory; the full verdict + evidence live
  in the comment and `events.jsonl`. A closed PR is reopenable. Nothing is
  destroyed.

## Orchestrator wiring (`agents/orchestrator.md`)

1. **Staleness gate.** Reusing `queue-stale.sh`'s mtime + `git log --grep`
   technique, the orchestrator computes eligibility each cycle:
   - `needs-work/` tickets with mtime older than `relevance.ticketStaleHours` and
     not referenced by a recent commit;
   - `ready-for-human/` PRs open longer than `relevance.prStaleHours`.
   Already-judged items (carrying a recent `relevance` event or
   `pipeline:relevance-review` label) are skipped until they age again, to avoid
   re-checking on every cycle.
2. **Dispatch.** A new dispatch-table row → `relevance-checker`, one item per run,
   subject to the **same saturation backoff** the detectors use (skip when
   `ready-for-human/` ≥ `readyQueueSaturation` — the human is the bottleneck; don't
   spend dispatches retiring work nobody is reviewing). Honors `enabled: false`.
3. **Routing on the verdict** (orchestrator reads the recorded verdict):
   - `obsolete` + `high` →
     - ticket: move to `obsolete/` (filesystem) / set `pipeline:obsolete`
       (GitHub/Linear);
     - PR: if `relevance.autoClosePRs` → `gh pr close` with the reasoning comment +
       move ticket to `obsolete/`; else mark `pipeline:obsolete`, pull from the
       ready queue, leave the close to a human.
   - `obsolete` + `medium`/`low` → set the `relevance-review` flag (label or ticket
     field per backend), leave in place.
   - `relevant` → no-op; item proceeds.
4. **Self-healing note.** Add an anomaly-table row: an item carrying the
   `relevance-review` flag with no human action for more than 3 cycles is surfaced
   in the cycle report (not auto-resolved — that's the human's call).
5. **Cycle report.** Relevance dispatches and auto-resolutions appear in the
   existing canonical `agent-pipeline cycle report` block (`dispatched` +
   `notes`), so the work is visible without a new reporting surface.

## Config (`config.schema.json`)

New optional `relevance` object (absent ⇒ feature off, so existing installs are
unaffected):

```jsonc
"relevance": {
  "enabled": true,
  "ticketStaleHours": 24,          // needs-work age before a ticket is eligible
  "prStaleHours": 48,              // ready-for-human age before a PR is eligible
  "autoResolveConfidence": "high", // threshold the orchestrator auto-resolves at
  "autoClosePRs": true             // gh pr close on high-confidence-obsolete PRs
}
```

## Backends

- **filesystem:** verdict via `queue-comment.sh`; auto-resolve via a `mv` to
  `obsolete/` (mirrors the `done/` transition); event via `queue-event.sh`.
- **GitHub:** verdict + reasoning as a PR/issue comment; `pipeline:obsolete` /
  `pipeline:relevance-review` labels; `gh pr close` on auto-resolve when
  `autoClosePRs`.
- **Linear:** verdict as an issue comment; `pipeline:obsolete` label; transition
  the issue to a Cancelled/Done state per the team's workflow.

## Files touched

| File | Change |
|---|---|
| `agents/relevance-checker.md` | **new** — agent definition |
| `manifest.json` | register `relevance-checker` (stage `routing`, `requires: []`, `optional: ["github","linear"]`) |
| `config.schema.json` | add `relevance` object |
| `agents/orchestrator.md` | staleness gate, dispatch row, verdict routing, anomaly row |
| `agents/PIPELINE.md` | state table + flow diagram: add `obsolete` + relevance gate |
| `queue/README.md` | document the `obsolete/` state |
| `test/` | unit test for staleness gate + verdict routing (see Testing) |
| `README.md`, `docs/API.md` | short mention of the agent + config block |

## Testing

- **Staleness gate** (shell, mirrors `queue-stale.sh` tests): a fixture queue with
  a fresh `needs-work` ticket and an aged one ⇒ only the aged one is eligible; an
  aged ticket referenced by a recent commit is excluded.
- **Verdict routing** (the highest-value seam): given a recorded verdict JSON,
  assert the orchestrator's mapping — `obsolete`+`high` ticket ⇒ `mv` to
  `obsolete/` + event; `obsolete`+`medium` ⇒ `relevance-review` label + no move;
  `relevant` ⇒ no-op; `autoClosePRs:false` ⇒ no `gh pr close`.
- **Idempotence:** a just-judged item is not re-dispatched next cycle.
- Agent-prompt behavior (the actual relevance judgement) is validated by example
  in the agent file, consistent with how the other agents are specified — not unit
  tested.

## Future Work

- **Re-scope instead of retire.** When a still-relevant issue has merely moved
  (renamed file), update the ticket's `source` and re-queue rather than flag.
- **On-merge trigger.** Add the "re-check in-flight items when `main` advances"
  trigger (the hybrid option) if the staleness gate proves too slow to catch
  fast-moving obsolescence.
- **Confidence as a number.** Promote `confidence` from an enum to a 0–1 score if
  the threshold needs finer tuning than high/medium/low.
