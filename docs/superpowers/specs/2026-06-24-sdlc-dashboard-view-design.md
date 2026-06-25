# SDLC Dashboard View for CAP

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Branch:** `feat/sdlc-dashboard-view`
**Related:** This view surfaces the agents added by `2026-06-24-runtime-qa-fanout-gate-design.md`, `2026-06-24-over-engineering-reviewer-design.md`, and `2026-06-24-change-splitter-design.md` in their lifecycle phases.

## Goal

A new `SDLC` dashboard tab — a **live state board** that lays out the **full agent roster**
under the software development lifecycle (**Analyze → Plan → Design → Implement → Test →
Deploy → Maintain**, a header stripe with a column of agents beneath each phase) and **lights
up each agent with its current state**: who is actively working (and on what) versus who is
idle. Clicking a running agent drills into exactly what it is working on — its ticket/PR,
current step, a live activity feed, and jump-out links.

Every agent has a home phase, so the full roster is always present; the **live state** is the
visual focus — the board answers "what state is each agent in right now." The handful of
genuinely cross-lifecycle or very-custom agents that don't fit collect in an **"Other"** area
rather than being force-fit into a phase.

It is a **pure presentation layer**: the only new data is a one-line `stage → SDLC-phase`
map; the only new backend is a per-run event-tail endpoint that powers the drill feed.
Nothing about pipeline execution changes.

## Background / current state

- **The dashboard is tabbed** (`ui/public/index.html`): pipeline · live log · agents ·
  features · feature pipeline. Each tab is a `<section data-panel>` driven by the same
  `/api/v1/snapshot` + `/api/v1/events` SSE stream.
- **The agents tab already groups by stage and shows live status.** `renderAgents()`
  buckets agents by `stage` in `STAGE_ORDER` (`meta, intake, routing, implementation,
  quality, review, detector, utility`); `agentCard()` builds the card; `updateAgentStatuses()`
  stamps a `running` class + `● running` badge + `shortId · elapsed · lastActivity` from
  `snapshot.agents[].activity.runs[]` (or `snapshot.cycle.running[]` for in-session
  subagents). `statusEls` maps agent → its DOM nodes.
- **The features tab already has a drill pattern.** `features.js` `toggleDrill()` populates
  `#feature-drill` with child-ticket chips on click — the exact shape the SDLC drill mirrors.
- **Run events already exist on disk.** `dispatch.js` appends parsed events to
  `.pipeline/runs/logs/<runId>.events.jsonl`; `getRunEvents()` (`api/runs.js`) reads them;
  the live-log tab streams them (`ui/log-stream.js`). The snapshot carries only a single
  `lastActivity` line per run, not the history.
- **`manifest.json` is the agent→stage source of truth.** There is no SDLC-phase grouping
  anywhere today.

## Decisions (locked with the user)

| Fork | Decision |
|------|----------|
| Phases | **7, in this order:** Analyze · Plan · Design · Implement · Test · Deploy · Maintain. |
| Display model | **Live state board, full roster.** Every agent always shows in its home phase; the **live state is the focus** — active agents lit (with their current item), idle agents dimmed. The board's purpose is "what state is each agent in right now," not a static org chart. |
| Layout | **Header stripe + columns** — phase → section → agent chips (3-level). "Section" ≈ the existing pipeline `stage`. |
| Unmapped agents | Almost every agent has a home phase. The few that genuinely don't fit (very-custom / cross-lifecycle) go to an **"Other"** area at the end of the stripe — **never force-defaulted into a phase** (e.g. not dumped into Maintain). |
| Surface | **A new `SDLC` tab**, not a grouping toggle on the agents tab (keeps the stage-ordered agents view intact). |
| Data model | **Presentation only** — agent→`stage` from `manifest.json` + a one-line `stage → SDLC-phase` constant (mirrors `STAGE_ORDER`). Multi-phase agents get one **primary** phase. |
| Live state | **Reuse** the agents-tab signal — running chips pulse + show elapsed via the same `activity.runs` / `cycle.running` logic. |
| Drill-in | **Click a running agent → panel** (mirror `toggleDrill`/`#feature-drill`) showing ticket/PR, current step, a live activity feed, and links. Idle agents → show their definition (role/bounds/last run). |
| Drill feed | **One new endpoint** — `/api/v1/runs/:runId/events?tail=N` backed by `getRunEvents`, streamed like the live-log tab. Degrade to "current step + links" where no run-events log exists. |

## Phase mapping

`stage → SDLC-phase` (primary phase per agent; sections are the stage-level sub-groups):

| Phase | Sections → agents |
|---|---|
| **Analyze** | Discovery: `scanner` · Relevance & context: `relevance-checker`, `context-mapper`, `glossary-maintainer` |
| **Plan** | Ticketing: `ticket-creator`, `ticket-reviewer` · Spec: `feature-spec-writer` · Routing: `flex-worker`, `linear-issue-orchestrator` |
| **Design** | Architecture: `feature-architect`, `feature-decomposer` · Structure & patterns: `folder-structure-enforcer`, `declarative-refactor-specialist` |
| **Implement** | Build: `worker` · Refactor & cleanup: `dead-code-remover`, `code-simplifier` · Docs: `technical-docs-manager` |
| **Test** | Test/QA: `tester`, `regression-tester`, `e2e-test-runner`, `e2e-test-quality`, `ci-triage`, `data-validator` · Runtime-QA gate: the 7 `*-validator` members · Detectors: the `detector`-stage agents · Review: `code-reviewer`, `over-engineering-reviewer`, `feature-validator`, `feedback-responder` |
| **Deploy** | Integration: `change-splitter`, `feature-integrator`, `conflict-resolver`, `branch-updater` · Release: `cleanup` |
| **Maintain** | Orchestration: `orchestrator` · Self-improvement: `pipeline-evaluator`, `transcript-reviewer`, `agent-improver`, `agent-architect` · Workspace: `git-worktree-manager` |
| **Other** | (rendered only when non-empty) any agent with no phase mapping — expected to be a small handful of very-custom agents. |

The map is the single place these assignments live. The **"Other"** area is the explicit home
for the few agents that don't fit the lifecycle — they stay visible but are never misfiled
into a real phase.

## Architecture

### Components

**1. Phase map — `ui/public/sdlc-map.js`**

Exports `SDLC_PHASES` (ordered phase list) and `STAGE_TO_PHASE` (stage → phase) plus a
`phaseOf(agent)` helper that returns the agent's phase or **`"Other"`** when unmapped. Pure
data + a lookup; imported by the renderer and unit-tested (every `STAGE_ORDER` stage maps to a
phase; anything else → `"Other"`).

**2. Tab + panel — `index.html`**

A `<button class="tab" data-tab="sdlc">` and a `<section id="sdlc" data-panel="sdlc">`
containing the board container and a `<div id="sdlc-drill" hidden>`.

**3. Board renderer — `ui/public/sdlc.js`**

On the same snapshot/SSE feed as the other tabs: group `snapshot.agents` by `phaseOf` (with
an **`"Other"`** bucket for unmapped agents), then by section (stage), and render the header
stripe + chip columns — including a trailing **"Other"** column only when that bucket is
non-empty. **Live state is the focus:** it reuses the running-state derivation by extracting
the idle/running/×N logic from `updateAgentStatuses` into a shared
`agentRunState(agent, cycleRunning)` helper, so the agents tab and the SDLC board apply
identical state (no logic fork). Active chips are lit/pulsing with their current item; idle
chips are dimmed but **still shown** (full roster).

**4. Drill panel — `ui/public/sdlc.js` (mirrors `toggleDrill`)**

Clicking a chip opens `#sdlc-drill`. For a **running** agent it renders: agent name + role,
"Working on" (`activity.runs[0].item` / ticket/PR), "Current step" (`lastActivity`), a live
**activity feed**, and links (run log, PR, ticket; screenshot for runtime-QA members). For an
**idle** agent it renders the agent's definition (role, bounds, last completed run). Only one
drill open at a time; re-clicking toggles.

**5. Run-event-tail endpoint — `api/index.js` + `api/runs.js`**

`GET /api/v1/runs/:runId/events?tail=N` returns the last `N` normalized events for a run
(backed by `getRunEvents`), and an SSE variant streams new events for an open drill — the
same mechanism `ui/log-stream.js` already uses, scoped to one `runId`. The drill subscribes
on open, unsubscribes on close/switch.

### Data flow

```
/api/v1/snapshot ──► group by phaseOf (+ "Other") → section → chips (header stripe + columns)
/api/v1/events (SSE) ──► agentRunState → chip lit(active)/dim(idle) (shared with agents tab)
click running chip ──► GET /runs/:runId/events?tail=N + SSE ──► drill activity feed
```

## Error handling

- **Unknown/absent stage** → the **"Other"** area (never dropped, never force-mapped into a
  real phase).
- **Clicked agent has no active run** (race: it just finished) → drill falls back to the
  idle view (definition + last run) instead of an empty feed.
- **Backend without run-events logs** (Linear/GitHub in-session subagents) → the endpoint
  returns empty; the drill degrades to "current step + links" using `cycle.running`
  (`item` + `minutes`).
- **Invalid/unknown `runId`** → endpoint `404`; drill shows "run log unavailable".
- **Huge events log** → `tail=N` (default e.g. 50) caps the read; SSE only streams new lines.

## Testing

- **Phase map (unit):** every `STAGE_ORDER` stage maps to exactly one phase; `phaseOf` is
  total (unmapped → `"Other"`); no agent appears in two phases.
- **Grouping (unit):** a snapshot's agents partition into phase columns + sections (+ an
  `"Other"` bucket) with none dropped or duplicated; the `"Other"` column renders only when
  non-empty; counts match the agent total.
- **Shared run-state (unit):** `agentRunState` returns identical idle/running/×N for the same
  input the agents tab uses (guards against logic fork); idle agents still render (dimmed).
- **Drill (DOM):** clicking a running chip renders item/step/feed/links; clicking an idle
  chip renders the definition; switching drills unsubscribes the prior run's SSE.
- **Endpoint:** `tail=N` returns the last N events; unknown `runId` → 404; empty-log backend
  → degrade payload.
- UI tests follow the existing `test/ui/*.test.js` node:test style (e.g.
  `test/ui/sdlc-board.test.js`).

## Migration

1. Land `sdlc-map.js` + the shared `agentRunState` extraction + the `SDLC` tab/section +
   `sdlc.js` board renderer (full roster, state-lit, `"Other"` bucket). Drill shows **current
   step + links only** (no new backend yet) — already useful, zero risk.
2. Add the `/api/v1/runs/:runId/events` endpoint + SSE; wire the drill's live activity feed.
3. Polish: idle-agent drill (definition + last run), backend degrade path, runtime-QA
   screenshot links.

Each step ships independently; step 1 is a self-contained read-only view.

## Out of scope (this spec)

- **Any change to pipeline execution** — this is a view; it reads existing state.
- **Per-pipeline-state coloring / a state-machine view** — the SDLC grouping is conceptual,
  distinct from the existing pipeline-graph tab.
- **Editing agent→phase from the UI** — the map is code-owned.
- **The runtime-QA gate, over-engineering reviewer, and change-splitter agents** — separate
  specs; this view merely displays them.
