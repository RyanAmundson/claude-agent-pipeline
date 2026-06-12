# Design: Durable Molecules + Versioned Audit (Option C)

**Status:** Phase 0 implemented; Phases 1–3 designed, not yet built.
**Scope:** filesystem backend only (`config.backend = "filesystem"`).
**Provenance:** investigation into adopting Gas City SDK concepts (see below) into the
existing pipeline.

## Why

A deep-research investigation into the [Gas City SDK](https://github.com/gastownhall/gascity)
(Gas Town Hall's orchestration-builder SDK — a Go `gc` CLI + Dolt + tmux runtime)
concluded that Gas City and this pipeline are conceptual twins on opposite stacks.
Adopting the binary would force away three of this project's load-bearing virtues
(npm/zero-dep distribution, one-shot RAM-safe subprocesses, atomic-`mv` simplicity).

So instead of adopting Gas City, we **borrow its two genuinely-better ideas** and
reimplement them JS/shell-native, with no new runtime dependencies:

1. **Durable Molecules** — make the advisory agent `chain:` field crash-safe by
   promoting the in-flight workflow to a persisted, step-tracked instance.
2. **Versioned audit trail** — Gas City uses Dolt for git-like history of all work
   state; we get the useful 90% from an append-only event log, no Dolt.

The insight that makes this cheap: we are already ~80% there.

| We already have | Gas City calls it | What was missing |
|---|---|---|
| `comments[]` on each ticket (append-only `{author,verdict,body,at}`) | a per-bead event trail | it only logged *comments*, not transitions/field edits |
| the stage graph in `agents/ORCHESTRATION.md` (`consumes`/`produces`) | a Formula / workflow definition | it was *implicit* — emergent from handoff logic + the orchestrator's hardcoded dispatch table |
| `.pipeline/runs/logs/*.events.jsonl` + `agent-pipeline events` (SSE) | the Event Bus | it tracked *agent runs*, not *work-item state changes* |

## Design principles (do not break)

- **Zero runtime deps** — no SQLite, no Dolt, no new npm packages.
- **State is a file you can `cat`/`mv`** — atomic-`mv` claim stays the concurrency primitive.
- **Append-only is the audit mechanism** — single-line `>>` appends are atomic under
  `PIPE_BUF` (4 KB) with `O_APPEND`; no lock needed for the log itself.
- **Additive & reversible** — each phase ships value alone; stopping early leaves a
  working system. Audit emission is *best-effort* and never fails a mutation.
- **Filesystem backend only** — the Linear/GitHub backend already gets history from Linear.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Audit storage | Global append-only `.pipeline/queue/events.jsonl`, reusing the existing event-log pattern. (Not per-ticket files, not Dolt, not git-tracking — git-tracking is an optional Phase 3 add.) |
| 2 | Molecule state location | Separate `.pipeline/molecules/<id>.json` — keeps the ticket JSON shape stable and avoids contention between molecule-advance and field edits. |
| 3 | Routing authority | The molecule cursor decides "what runs next"; the queue state dirs remain the atomic-claim primitive; the event log is the audit. |
| 4 | Dispatch table | Phased replace — molecules supersede the orchestrator's hardcoded routing table; the table stays as a fallback during transition, then is trimmed. |
| 5 | Scope | Filesystem backend only first; Linear backend has native history. |

---

## The layered data model

Molecules and audit slot **on top of** the atomic-`mv` model; they do not replace it.

| Layer | Object | Role | Gas City analog |
|---|---|---|---|
| Identity + live state | `queue/<state>/<id>.json` | current snapshot (as today) | a bead row (materialized) |
| **Plan** | `molecules/<id>.json` | what's next, per-step status | Molecule / Formula |
| **History** | `queue/events.jsonl` | append-only audit + recovery | Beads store / Dolt history |
| Concurrency | the `<state>/` dirs + `mv` | atomic claim (unchanged) | Hook / GUPP claim |

---

## Phase 0 — Versioned audit (IMPLEMENTED)

**Borrowed from:** Beads' versioned store + Dolt's audit history, minus Dolt.

Every queue mutation appends one event to `.pipeline/queue/events.jsonl`:

```jsonl
{"ts":"2026-06-10T10:00:00Z","ticket":"TKT-001","event":"transition","from":"needs-work","to":"in-progress","by":"worker"}
{"ts":"2026-06-10T10:22:40Z","ticket":"TKT-001","event":"field","expr":".pr_url=\"https://…/42\"","state":"in-progress","by":"worker"}
{"ts":"2026-06-10T10:48:02Z","ticket":"TKT-001","event":"comment","author":"code-reviewer","verdict":"fail","body":"layer violation"}
```

Event types in Phase 0:
- `transition` — any state move (`queue-claim.sh`, `queue-stale.sh`). Carries `from`/`to`
  (+ `reason` for stale re-queues).
- `field` — a `queue-update.sh` edit. Carries the raw jq `expr` (which is what makes
  replay possible in Phase 3 — re-applying the expr reproduces the state) and `state`.
- `comment` — a `queue-comment.sh` append. Carries `author`/`verdict`/`body`.

Recording the jq `expr` rather than a resolved path/value is deliberate: it is both
honest (it's exactly what was applied) and replayable.

### Surfaces added
- `queue/queue-event.sh` — append one audit event. Generic: positional `k=v` tokens
  become string fields, plus `--by <agent>`. Callable standalone or from sibling helpers.
- `queue/queue-history.sh <id>` — fold the log into a per-ticket timeline (human or `--json`).
- `--by <agent>` added (optional, backward-compatible) to `queue-claim.sh` /
  `queue-update.sh` / `queue-comment.sh` so the acting agent is recorded.
- Emission wired into `queue-claim.sh`, `queue-update.sh`, `queue-comment.sh`,
  `queue-stale.sh`. Each emit is `|| true` — best-effort; a failed append never fails
  the mutation.

### Not in Phase 0
- `create` events: no ticket-creation helper exists yet (tickets are dropped as JSON by
  the scanner or a human). `create` emission lands with the Phase 1 intake helper, or the
  scanner can call `queue-event.sh` directly.
- `queue-replay.sh` (rebuild ticket from events): Phase 3.

---

## Phase 1 — Molecule data model (designed)

**Borrowed from:** Gas City Molecules (durable chained Bead workflows) + Formulas.

**Workflow templates** — declarative, data not prose, in a new `.pipeline/workflows.json`:

```json
{
  "workflows": {
    "bugfix": { "steps": [
      { "agent": "worker" },
      { "agent": "tester", "when": "hasCodeChanges" },
      { "agent": "code-reviewer" },
      { "agent": "feedback-responder", "loop": "until-approved" }
    ]},
    "docs": { "steps": [ { "agent": "technical-docs-manager" }, { "agent": "code-reviewer" } ] }
  }
}
```

**Molecule instance** — one per ticket, `.pipeline/molecules/<id>.json`:

```json
{
  "ticket": "TKT-001",
  "template": "bugfix",
  "cursor": 1,
  "steps": [
    { "agent": "worker",        "status": "done",    "run": "…a1b2", "at": "…" },
    { "agent": "tester",        "status": "running", "run": "…c3d4" },
    { "agent": "code-reviewer", "status": "pending" },
    { "agent": "feedback-responder", "status": "pending" }
  ]
}
```

- New `queue/queue-molecule.sh` — create (instantiate template), advance (move cursor on
  step completion), status. Step transitions emit `molecule` events into the Phase 0 log.
- `scanner` / `ticket-creator` instantiate a molecule at intake.
- Crash-safety: the plan is on disk; a crashed step is detected as stale (reuse
  `queue-stale.sh` logic) and retried from the cursor.

## Phase 2 — Orchestrator drives molecules (designed)

- Refactor `agents/orchestrator.md` dispatch to read molecule cursors instead of (or
  alongside) the hardcoded dispatch table.
- The "PR merged touching X → dispatch Y" detector rules become workflow triggers/hooks.
- Keep the hardcoded table as a fallback during the transition, then trim the parts
  molecules now cover.

## Phase 3 — Optional (designed)

- `queue/queue-replay.sh <id>` — rebuild a ticket's JSON by folding its events
  (consistency check + recovery).
- Optional dedicated git dir tracking `.pipeline/queue/` for human-browsable
  `git log`/`git blame` on work state (closest to Dolt's diff UX) — opt-in, off by default.

---

## Mapping back to Gas City (what each idea descends from)

| This design | Gas City concept |
|---|---|
| `queue/events.jsonl` | Beads versioned store / Dolt audit history |
| `molecules/<id>.json` | Molecule (durable chained workflow) |
| `workflows.json` templates | Formula |
| atomic-`mv` claim retained | Hook / GUPP claim semantics |
| materialized ticket JSON | a bead row |
