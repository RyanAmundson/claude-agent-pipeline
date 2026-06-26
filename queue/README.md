# Queue Helpers (filesystem backend)

Shell scripts that implement the filesystem-backed ticket queue. Used when `config.backend = "filesystem"`.

## Concept

Tickets are JSON files. State is encoded by which subdirectory the file lives in:

```
.pipeline/queue/
├── needs-triage/     # scanner findings awaiting ticket creation
├── needs-review/     # tickets awaiting validation
├── needs-work/       # tickets ready to implement
├── in-progress/      # claimed by a worker
├── needs-test-review/  # PR open, awaiting tester
├── needs-code-review/  # tester passed, awaiting code review
├── needs-feedback/   # review feedback to address
├── ready-for-human/  # all automated checks passed
├── done/             # merged and cleaned up
├── needs-info/       # parked, missing detail
└── obsolete/         # retired as no longer relevant (auto-created on first use)
```

State transitions are filesystem moves. `mv` within the same filesystem is atomic — exactly one caller wins.

## Ticket file shape

```json
{
  "id": "TKT-001",
  "title": "fix: silent error in dashboard fetch",
  "description": "...",
  "priority": 2,
  "labels": ["smell", "agent:scanner"],
  "source": {
    "agent": "scanner",
    "category": "silent-error",
    "file": "src/dashboard/Dashboard.tsx",
    "line": 88
  },
  "pr_url": null,
  "branch": "fix/TKT-001",
  "base": "main",
  "worktree": ".worktrees/TKT-001",
  "comments": [
    { "author": "code-reviewer", "verdict": "fail", "body": "layer violation in src/x.ts", "at": "2026-06-07T10:05:00Z" }
  ],
  "stale_count": 0,
  "created_at": "2026-04-30T10:00:00Z",
  "updated_at": "2026-04-30T10:00:00Z"
}
```

For the GitHub-free review loop, `branch`/`base` replace `pr_url` as the review
handle (reviewers run `git diff <base>...<branch>`), and `comments[]` holds the
review/feedback trail. Each comment is `{ author, verdict, body, at }` where
`verdict` is `"pass" | "fail" | null` (`null` = informational / human).

The `id` field is the canonical identifier — also the file's basename (`<id>.json`).

## Helpers

### `queue-list.sh <state>`

List tickets in a state. Output is `<id>\t<priority>\t<title>`, sorted by priority then by oldest mtime.

```bash
queue-list.sh needs-work
queue-list.sh in-progress --queue-dir .pipeline/queue
```

### `queue-claim.sh <id> <from-state> <to-state>`

Atomic claim. Moves the JSON file from one state to another. Exits 0 on success, 1 on race (file already moved by another agent).

```bash
queue-claim.sh TKT-001 needs-work in-progress
```

This is the only safe way to claim — workers MUST use this, not direct `mv`.

### `queue-update.sh <state> <id> <jq-expression>`

Read-modify-write a ticket field, serialized via `flock`. Use for setting `pr_url`, updating `description`, etc.

```bash
queue-update.sh in-progress TKT-001 '.pr_url = "https://github.com/o/r/pull/42"'
```

### `queue-comment.sh <id> --author <name> --body "<text>" [--verdict pass|fail]`

Append a comment to a ticket's `comments[]` (flock-serialized, atomic). Locates
the ticket across state dirs (or pass `--state`). Reviewers use this with
`--verdict`; humans use the `agent-pipeline comment` CLI verb (author `human`).

```bash
queue-comment.sh TKT-001 --author tester --verdict pass --body "regression test present"
```

### `queue-stale.sh [--max-age-hours N]`

Find stale tickets in `in-progress/` and move them back. Default age threshold is 2 hours.

```bash
queue-stale.sh
queue-stale.sh --max-age-hours 4 --dry-run
```

The cleanup agent runs this periodically.

### `queue-relevance-eligible.sh [--ticket-stale-hours N] [--pr-stale-hours N] [--json]`

List queue items the relevance-checker should judge — stale (past the per-state
mtime threshold), not yet judged (`relevance_checked_at` absent or itself stale),
not already flagged (`relevance_review`), and not referenced by a recent commit.
Output is `<id>\t<state>` lines, or a JSON array with `--json`.

```bash
queue-relevance-eligible.sh --ticket-stale-hours 24 --pr-stale-hours 48 --json
```

### `queue-relevance-resolve.sh <id> --verdict relevant|obsolete --confidence high|medium|low`

Route a recorded relevance verdict: `relevant` → keep (stamp only); `obsolete` at
or above `--auto-resolve-confidence` (default `high`) → move to `obsolete/`;
`obsolete` below it → set `relevance_review=true` and leave in place. Always stamps
`relevance_checked_at` for idempotence. Composes `queue-update.sh` + `queue-claim.sh`.

```bash
queue-relevance-resolve.sh TKT-001 --verdict obsolete --confidence high
```

### `queue-event.sh <id> <event-type> [--by <agent>] [key=value ...]`

Append one audit event to `<queue-dir>/events.jsonl` (append-only). Called
internally by the mutating helpers after a successful change, and usable directly.
A single-line `>>` append is atomic under `PIPE_BUF` (4 KB), so concurrent emits
do not interleave — no lock needed for the log.

```bash
queue-event.sh TKT-001 transition --by worker from=needs-work to=in-progress
```

### `queue-history.sh <id> [--json]`

Fold the event log into a ticket's timeline — human-readable lines, or `--json`
for the raw matching JSONL.

```bash
queue-history.sh TKT-001
# 2026-06-10T10:05Z  transition   needs-work → in-progress   (worker)
# 2026-06-10T10:22Z  field        .pr_url="…"                (worker)
# 2026-06-10T10:48Z  comment      [fail] code-reviewer: layer violation
```

### `queue-molecule.sh <create|next|advance|status|list> [<id>] [...]`

Durable workflow (**molecule**) instances. A molecule is a per-ticket plan —
an ordered list of agent steps plus a cursor, instantiated from a named template
in `workflows.json`. It makes the advisory `chain:` handoff crash-safe: the plan
is on disk, so a crashed step resumes from the cursor.

```bash
queue-molecule.sh create  TKT-001 bugfix        # instantiate from a template
queue-molecule.sh next    TKT-001                # → the current step's agent
queue-molecule.sh advance TKT-001 --by worker --run <runId>   # step done, cursor++
queue-molecule.sh advance TKT-001 --status skipped            # when-guard false: skip step, cursor++
queue-molecule.sh advance TKT-001 --status failed             # hold cursor for retry
queue-molecule.sh status  TKT-001 [--json]
queue-molecule.sh list    [--json]               # every incomplete molecule + its next step
```

`list` is the orchestrator's **dispatch source**: it returns each incomplete
molecule with `next.{agent,status}` plus any `next.when` / `next.loop`, so the
orchestrator can dispatch `next.agent`, skip a step whose `when` guard is false
(`advance --status skipped`), and recognize the `until-approved` feedback loop.
`list` is the one subcommand that takes no `<id>`.

Step transitions are mirrored into `events.jsonl` as `molecule` events.

## Source projection (`import-sources`)

`agent-pipeline import-sources` projects the host project's **real work sources**
into this queue as `needs-work` tickets, so the orchestrator routes them like any
other ticket. It is **not** a new `backend` — the filesystem queue is the universal
ingestion seam, and the projector just drops ticket files into `needs-work/`.

- **Sources** (opt-in via `.pipeline/config.json` `sources`):
  - `beads: true` → each `bd ready` bead becomes a ticket id `bead:<beadId>`.
  - `plans: [dirs]` → each **incomplete** `*.md` plan (no checkboxes, or any `- [ ]`
    unchecked) becomes one ticket id `plan:<dir>/<file>.md`. Fully-checked plans are skipped.
- **Idempotent:** a ticket is created only if its id is absent from **every** state,
  so an item already `in-progress` / `done` is never resurrected or duplicated.
- **One-way:** never writes back to beads or plans.
- **Cadence:** the orchestrator supervisor runs it before each dispatch cycle
  (best-effort — a failed import never breaks the cycle). `--only <id>` projects a
  single named item on demand.

```json
{ "sources": { "beads": true, "plans": [".plans", ".claude"] } }
```

The ticket's JSON `id` is canonical (`bead:<id>` / `plan:<relativePath>`); the file
basename sanitizes `/` and `:` to `_` for flat storage, so `id` ≠ basename for
nested plans. Host observers (e.g. context-manager) join on the JSON `id`.

## Audit log (`events.jsonl`)

`<queue-dir>/events.jsonl` is the append-only history of every state transition,
field edit, comment, stale re-queue, and molecule step. It is the zero-dependency
analog of a versioned work store: full history without a database. `field` events
record the raw jq `expr` (replayable). Emission is **best-effort** — a failed
append never fails the underlying mutation.

## Molecules (`.pipeline/molecules/<id>.json`)

Workflow templates live in `.pipeline/workflows.json`. A ready-to-copy starter set
(bugfix / feature / docs / refactor, with a `default`) ships as
[`workflows.example.json`](./workflows.example.json):

```json
{ "default": "bugfix", "workflows": {
  "bugfix": { "steps": [
    { "agent": "worker" },
    { "agent": "tester", "when": "hasCodeChanges" },
    { "agent": "code-reviewer" },
    { "agent": "feedback-responder", "loop": "until-approved" }
  ]},
  "docs": { "steps": [ { "agent": "technical-docs-manager" }, { "agent": "code-reviewer" } ] }
}}
```

The top-level `default` names the template used when intake doesn't pick one.
Per-step `when` / `loop` are carried onto each molecule step as metadata and acted
on by the orchestrator (Phase 2): `when` is a guard it skips when false; `loop`
(`until-approved`) keeps re-dispatching `feedback-responder` until the human
approves. `queue-molecule.sh` itself advances linearly — the orchestrator drives
the conditional routing via `list`. See
[`docs/DESIGN-molecules-audit.md`](../docs/DESIGN-molecules-audit.md) for the full design.

## Concurrency model

| Operation | Mechanism | Safety |
|---|---|---|
| Claim a ticket | `mv` between state dirs | Atomic. First caller wins, others get ENOENT |
| Update a field | `flock` + `jq` + `mv` | Serialized. Last writer wins |
| Transition states | `mv` | Atomic |
| List a state | `find` | No locking; results may be slightly stale, that's fine |
| Append an audit event | `>>` (O_APPEND) | Atomic under `PIPE_BUF` (4 KB); concurrent emits don't interleave |
| Advance a molecule | `jq` + atomic rename | Per-ticket single-writer in practice (one active step) |

This works on a single filesystem. It does NOT work across hosts (NFS atomicity is unreliable). If you need multi-host, switch to the Linear backend.

## Feature epics (`.pipeline/epics/`)

The feature pipeline stores **epics** with the exact same layout as tickets —
`<id>.json` files in state subdirectories — but under `.pipeline/epics/` and
using the `feature:*` state set (`needs-spec`, `needs-design`,
`needs-decomposition`, `building`, `needs-integration`, `needs-acceptance`,
`ready-for-human`, `blocked`, `needs-feedback`, `done`). Because the layout is
identical, the same helpers operate on epics by passing `--queue-dir`:

```bash
queue/queue-claim.sh EPIC-001 needs-spec needs-design --queue-dir .pipeline/epics
queue/queue-update.sh needs-design EPIC-001 '.design = "..."' --queue-dir .pipeline/epics
```

Epic file shape:

```json
{
  "id": "EPIC-001",
  "title": "Dark mode",
  "intent": "rough one-liner from the human",
  "spec": "...",
  "design": "...",
  "acceptance": ["criterion 1", "criterion 2"],
  "integration_branch": "feature/EPIC-001",
  "children": ["TKT-001-1", "TKT-001-2"],
  "pr_url": null,
  "created_at": "2026-06-17T10:00:00Z",
  "updated_at": "2026-06-17T10:00:00Z"
}
```

### Child ticket fields

A feature's child tickets are ordinary tickets in `.pipeline/queue/` with two
optional fields and a non-default `base`:

- `epic` — the parent epic id (e.g. `"EPIC-001"`).
- `depends_on` — array of sibling child ids that must merge into the integration
  branch before this child may start.
- `base` — set to the epic's `integration_branch` (e.g. `"feature/EPIC-001"`)
  instead of `"main"`.

Tickets with no `epic` field behave exactly as today. Dependency gating is owned
by the orchestrator (see `agents/FEATURE-PIPELINE.md`): dependency-free children
start in `needs-work`; dependency-blocked children are parked in `needs-info` and
promoted to `needs-work` once their `depends_on` siblings reach `done`.
