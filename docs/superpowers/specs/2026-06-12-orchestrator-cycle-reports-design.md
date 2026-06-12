# Design: Orchestrator Cycle Reports

**Date:** 2026-06-12
**Status:** approved (interactive brainstorm with owner; surface/format/scope/mechanism all confirmed)

## Problem

The orchestrator's per-cycle reporting is irregular and unformatted in practice. `agents/orchestrator.md` §4 sketches a wide ASCII table, but:

1. It is GitHub/Linear-label-shaped; the filesystem-backend section (orchestrator.md bottom) never restates a report format, so FS-mode cycles report freeform or not at all.
2. The model freehand-formats the block every cycle — format drifts between cycles and sessions.
3. Nothing machine-readable is emitted: `agent-pipeline events` and the dashboard never see cycle summaries, dispatch decisions, or self-healing notes. The event stream is a derived watcher over queue/runs dirs (`api/index.js createWatcher`) with no append-an-event path.

## Decisions (confirmed with owner)

| Question | Decision |
|---|---|
| Surface | Session text **and** the pipeline event stream |
| Format | Compact dashboard block (counts + deltas + dispatches + awaiting-human + footer) |
| Backends | Both — one format, backend-specific snapshot sources |
| Mechanism | New CLI verb renders the block deterministically; the orchestrator pastes its stdout. No model-side formatting. |

## Architecture

```
orchestrator (prompt)            CLI                              surfaces
──────────────────────────────────────────────────────────────────────────
snapshot counts ───────▶ agent-pipeline cycle report --data '<json>'
dispatch decisions             ├─ cycle# + deltas (vs last line)
                               ├─ append .pipeline/runs/cycles.jsonl ──▶ watcher ──▶ events / UI
                               └─ print formatted block ─────────────────▶ session text
```

The JSONL file is both the history and the delta source: the CLI computes the cycle number and per-state deltas by reading the previous last line. No other state.

## Data model: `.pipeline/runs/cycles.jsonl`

Append-only, one JSON line per orchestrator cycle:

```json
{"v":1,"cycle":14,"at":"2026-06-12T10:42:00Z","backend":"filesystem",
 "counts":{"needs-work":3,"needs-test-review":1,"ready-for-human":4,"done":12},
 "dispatched":[{"agent":"worker","item":"fs-103"},{"agent":"worker","item":"fs-105"},{"agent":"tester","item":"fs-102"}],
 "running":[{"agent":"worker","item":"fs-099","minutes":6}],
 "awaiting":["fs-101","fs-104","fs-107","fs-109"],
 "notes":["self-healing: re-queued stale fs-098"],
 "nextCheckSeconds":270}
```

- `v` — schema version, `1`.
- `cycle` — computed by the CLI (previous last line's `cycle` + 1; `1` if the file is missing/empty).
- `counts` — keyed by the normalized queue-state names (`api/index.js STATES`) in **both** backends. GitHub mode maps labels at snapshot time (`pipeline:needs-work` → `needs-work`); items are PR refs (`#123`) instead of ticket ids. States absent from `counts` are treated as 0.
- `dispatched` / `running` / `awaiting` / `notes` — supplied by the orchestrator; all optional (default empty). `notes` carries self-audit and self-healing lines.
- `nextCheckSeconds` — the orchestrator's chosen ScheduleWakeup delay, so the block can set expectations.

### Relationship to the Phase 0 audit log

`queue/events.jsonl` (molecules+audit Phase 0) is the **ticket-mutation audit** for the filesystem backend: it lives under `queueDir` (absent in Linear/GitHub mode) and Phase 3 wants it replayable into ticket state. Cycle reports are **backend-neutral orchestrator telemetry** — they live under the runs root, which exists in both modes. Deliberately two streams; cycle lines never land in the queue audit log, and replay never has to filter telemetry out.

## CLI verb: `agent-pipeline cycle report`

```
agent-pipeline cycle report --data '<json>' [--target <p>]
agent-pipeline cycle report --data - [--target <p>]        # read payload JSON from stdin
```

Behavior, in order:

1. Parse and validate the payload (everything except `v`/`cycle`/`at`, which the CLI stamps). Invalid JSON or wrong shapes → usage error naming the field and showing a minimal valid example (v0.4 error-message contract: problem + cause + exact fix).
2. **FS-mode auto-counts:** when `config.backend == "filesystem"` and the payload omits `counts`, fill them from `readSnapshot()` (`tickets.byState` lengths). GitHub/Linear mode requires `counts` (only the orchestrator sees labels) — omitting them is a usage error saying so.
3. Read the previous last line of `.pipeline/runs/cycles.jsonl` for `cycle` and deltas. **Fail-open:** missing file/dir → create and treat as first cycle; corrupt last line → warn on stderr, treat as first cycle (no deltas). Never block the report.
4. Append the completed line (single `appendFileSync` with `O_APPEND` — same atomic-append reasoning as `queue-event.sh`; single-writer regardless, since two orchestrators per target is already forbidden).
5. Print the rendered block to stdout.

No other subcommands (`cycle last` etc.) — `tail -1 .pipeline/runs/cycles.jsonl | jq` covers ad-hoc inspection. YAGNI.

## Rendering (deterministic, in the CLI)

```
[orchestrator] cycle 14 · 2026-06-12 10:42 · backend: filesystem

  needs-work        3  (+1)   → dispatched 2 workers
  needs-test-review 1  (=)    → dispatched 1 tester
  needs-code-review 0  (-2)
  ready-for-human   4  (+2)   ⚠ awaiting you: fs-101, fs-104, fs-107, fs-109
  done              12 (+2)

  agents: 3 dispatched, 1 running (worker on fs-099, 6m)
  next check in 270s
```

Rules:

- A state line renders iff count ≠ 0 **or** delta ≠ 0. Zero/zero states are omitted.
- Deltas: `(+n)` / `(-n)` / `(=)`. First cycle: counts only, no delta column.
- Dispatch annotations aggregate per agent role on the matching state line (`needs-work` row shows workers, `needs-test-review` shows testers, etc.); dispatches with no matching state line render in the footer.
- `ready-for-human` line appends `⚠ awaiting you: <items>` (up to 6 items, then `+N more`).
- Footer: `agents: N dispatched, M running (<agent> on <item>, <minutes>m …)` and `next check in <nextCheckSeconds>s`. Omit either footer half when empty/absent.
- One `notes` line each, rendered as `  ✓ <note>` after the footer.
- Idle cycle (no dispatches, no deltas): block still prints — header, any non-zero states, footer. Regularity is the point.

## Event stream

- `api/index.js createWatcher` additionally watches `.pipeline/runs/cycles.jsonl` (fs.watch on the runs root already exists for `active`/`completed` subdirs; add a watch covering the file, tolerating its absence until first write).
- Watcher keeps a per-file index (line count); on change, each **new** line emits `{type:'cycle.report', cycle:<parsed line>}`. Unparseable lines are skipped silently. Reconcile ticks cover dropped fs events, same as tickets/runs.
- `bin/cli.js renderEvent` gains a case: `CYCLE  #14  dispatched=3 ready-for-human=4` (one line, non-JSON mode); `--json` passes the full object through.
- **Out of scope:** dashboard UI rendering. `ui/` has uncommitted in-flight changes (see TODOS.md "Dashboard offline/local parity"); SSE subscribers receive `cycle.report` for free when that work lands.

## Prompt changes: `agents/orchestrator.md`

- §4 "Report" rewritten: every cycle — including idle ones — after dispatch decisions, build the payload (counts per backend source, dispatched/running/awaiting/notes/nextCheckSeconds), run `agent-pipeline cycle report --data '<json>'`, and paste its stdout **verbatim** as the cycle update in the session. The old hand-drawn table is deleted. Self-audit (§3.5) and self-healing output feed `notes` instead of their own freeform blocks (their detailed instructions stay; only the reporting surface changes).
- GitHub mode: counts come from the label snapshot (§1), normalized to queue-state names; items are `#<pr>`.
- Filesystem-backend section: one line — same rule, `counts` may be omitted (CLI auto-snapshots).

## Docs

Per the A7 doc-parity contract: `docs/API.md`, the `HELP` string in `bin/cli.js`, and the README CLI table all gain `cycle report`. `docs/API.md` documents the `cycle.report` event type and the `cycles.jsonl` schema.

## Tests (smoke tier — no model spend)

1. First cycle: missing file → `cycle: 1`, no deltas, file created.
2. Delta math: second report with changed counts → correct `(+/-/=)` and cycle 2.
3. Malformed `--data` → exit non-zero, usage error names the problem.
4. FS auto-counts: payload without `counts` against a seeded queue → counts match the queue dirs.
5. GitHub-mode counts required: `backend: linear` config + no `counts` → usage error.
6. Corrupt tail: garbage last line → warns, still appends a valid cycle-1-style line.
7. Watcher: append a line → `cycle.report` event observed (and not re-emitted on reconcile).
8. Rendering: zero/zero states omitted; awaiting list truncates at 6; idle cycle still renders.

## Out of scope

- Dashboard/UI rendering of cycle reports (TODOS.md item; event is emitted for it).
- Emitting cycle markers into the queue audit log (`queue/events.jsonl`) — revisit if molecules Phase 2 wants orchestrator decisions in the replayable audit.
- Retention/rotation of `cycles.jsonl` (append-only; revisit if size becomes real).
