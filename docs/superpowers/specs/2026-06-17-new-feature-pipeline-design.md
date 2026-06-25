# New-Feature Pipeline — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Author:** brainstormed with Ryan

## Problem

CAP's current pipeline is **work-type agnostic and bug-fix shaped**. It begins *after* a problem is already specified: `scanner` finds an issue, `ticket-creator` writes a ticket, and the ticket flows through 13 states to `pipeline:ready-for-human`. This works for bug fixes and one-off changes, which arrive well-specified and small.

New features are different. They:

1. Originate from **human intent**, not machine scanning.
2. Start as a **rough idea**, not a specified ticket — they need elaboration (spec) and a technical design before any code is written.
3. Are **large**: a single feature naturally decomposes into many sub-tasks with dependencies, which should be built in parallel.

The current pipeline has no concept of intent elaboration, technical design, decomposition, or assembly. This spec defines a parallel **feature pipeline** that adds a thin autonomous *front* (spec → design → decompose) and *back* (integrate → accept) around CAP's existing, unchanged build/review machinery.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Feature entry | **Rough intent → pipeline elaborates it.** Human drops a one-liner; a spec agent expands it into a spec/PRD. |
| Core structure | **Fan-out.** A feature is a parent *epic* decomposed into child tickets that build in parallel, then reassemble. |
| Build-half agents | **Reuse existing.** worker / tester / code-reviewer / regression-tester / feature-validator / feedback-responder handle children unchanged. New agents only for the front and back. |
| Human gates | **At the end only.** Fully autonomous until a single review of the assembled feature. |

## Architecture — two layers

**Epic layer (new):** a feature moves through `feature:*` states, fully autonomous until the end.

**Ticket layer (existing, unchanged):** child tickets the epic spawns flow through the existing 13-state pipeline — but branched off a per-feature integration branch and tagged to the epic.

### The integration-branch mechanism (core idea)

Because gating is "at the end only" **and** features fan out into many children, child PRs cannot each wait for a human (that would be many gates). Instead:

1. `feature-architect` creates a long-lived integration branch `feature/EPIC-<id>` off `main`.
2. Each child ticket branches off the integration branch (`base = feature/EPIC-<id>`).
3. As a child passes all automated review, it **auto-merges into the integration branch** — no per-child human gate.
4. When all children have landed and the feature is integrated + validated, **one** PR (`feature/EPIC-<id>` → `main`) opens as `feature:ready-for-human`.
5. A human reviews the assembled feature once and merges.

This reuses CAP's entire build/review machinery for children and isolates incomplete feature work from `main` until it is whole.

**Alternatives rejected:**
- **(B)** Children PR straight to `main` and auto-merge individually — pollutes `main` with half-features and makes "the end" ambiguous.
- **(C)** Children remain as stacked, un-merged PRs reviewed together at the end — produces a brutal single review and fragile rebase chains.

## Epic state machine (new `feature:*` states)

```
[intent]
  → feature:needs-spec           (feature-spec-writer)
  → feature:needs-design          (feature-architect)            ← creates feature/EPIC-<id>
  → feature:needs-decomposition   (feature-decomposer)           ← spawns child tickets
  → feature:building              (orchestrator rules: dispatch children as deps clear,
                                    auto-merge each passing child into the integration branch)
  → feature:needs-integration     (feature-integrator)           ← reconcile + full verify + open epic PR
  → feature:needs-acceptance      (feature-acceptance-validator) ← validate assembled feature vs spec criteria
  → feature:ready-for-human        (terminal — single human gate; merge integration → main)
```

**Side states:**
- `feature:blocked` — a child or stage is stuck and needs a human (e.g., a child exhausts feedback loops, or decomposition can't proceed).
- `feature:needs-feedback` — a human left comments on the epic PR; routes back to the relevant stage (or to `feedback-responder` for child-level fixes), then returns to `feature:needs-acceptance`.

State labels follow the existing namespace convention. The default namespace is `feature` (parallel to the existing `pipeline` namespace), configurable via the existing `labelNamespace` mechanism.

## Agents

### New agents (5)

**Front half**

1. **feature-spec-writer** — `feature:needs-spec → feature:needs-design`
   Takes the rough intent plus codebase/context exploration and produces a structured spec: problem, goals, non-goals, **acceptance criteria**, and UX notes. This is the autonomous embodiment of the brainstorming step. Writes the spec into the epic artifact (and/or a spec doc).

2. **feature-architect** — `feature:needs-design → feature:needs-decomposition`
   Turns the spec into a technical design: affected modules, approach, data flow, risks, and test strategy. Creates the integration branch `feature/EPIC-<id>`.

3. **feature-decomposer** — `feature:needs-decomposition → feature:building`
   Breaks the design into **ordered child tickets** with dependencies. Files each child into the existing queue with `base = feature/EPIC-<id>`, `epic = EPIC-<id>`, and `depends_on = [...]`. Advances the epic to `building`.

**Back half**

4. **feature-integrator** — `feature:needs-integration → feature:needs-acceptance`
   Triggered once all children have landed on the integration branch. Reconciles cross-cutting concerns, runs the full verify suite on the integration branch, and opens the epic PR (`feature/EPIC-<id>` → `main`).

5. **feature-acceptance-validator** — `feature:needs-acceptance → feature:ready-for-human` (or `feature:needs-feedback`)
   Validates the assembled feature against the original spec's acceptance criteria (screenshots / E2E at feature scope). Mirrors `feature-validator` but operates at epic scope against the spec rather than at single-ticket scope.

### Reused agents (unchanged)

`worker`, `tester`, `code-reviewer`, `regression-tester`, `feature-validator`, `feedback-responder`, `conflict-resolver`, `cleanup` — handle child tickets exactly as they do today.

### New orchestrator responsibilities (rules, not new agents)

For epics in `feature:building`, the orchestrator:
- Dispatches children to the standard pipeline as their `depends_on` are satisfied (a dependency is satisfied when the depended-on child has merged into the integration branch).
- **Auto-merges** each child that reaches its terminal automated state into the integration branch (the per-child equivalent of `ready-for-human`, but unattended because the human reviews the whole feature).
- Advances the epic to `feature:needs-integration` once all children have merged.
- Surfaces stuck epics as `feature:blocked`.

> **Open implementation note:** child auto-merge is described here as an orchestrator rule for leanness. If isolation/testability is preferred, it can be extracted into a tiny `feature-child-merger` agent. To be decided in the implementation plan.

### Agent frontmatter

New agents follow the existing frontmatter schema (`name`, `description`, `pipeline.stage`, `consumes`, `produces`, `dispatchable`, `requires`, `optional`) and are registered in `manifest.json`. A new `pipeline.stage` value (e.g. `feature`) groups them in the Agents view, or they reuse existing stage buckets (`intake`/`implementation`/`review`) — to be decided in the plan.

## Data model

### Epic artifact (filesystem backend)

`.pipeline/epics/<state>/EPIC-<id>.json`:

```json
{
  "id": "EPIC-001",
  "title": "Dark mode",
  "intent": "rough one-liner from the human",
  "spec": "...",
  "design": "...",
  "acceptance": ["..."],
  "integration_branch": "feature/EPIC-001",
  "children": ["TKT-101", "TKT-102"],
  "pr_url": null,
  "state": "building",
  "created_at": "2026-06-17T10:00:00Z",
  "updated_at": "2026-06-17T10:00:00Z"
}
```

Epics live in a parallel queue (`.pipeline/epics/<state>/`) with the same atomic-move semantics as the ticket queue. New queue helpers mirror the existing `queue-*.sh` scripts (or are generalized to operate on either queue).

### Child ticket changes

Child tickets use the **existing** ticket schema plus two optional fields:
- `epic` — the parent epic id (e.g. `"EPIC-001"`).
- `depends_on` — array of sibling child ids that must merge first.

And `base` is set to the integration branch instead of `main`. Tickets without an `epic` field behave exactly as today, so the bug-fix pipeline is unaffected.

### Backend mapping

Backend-agnostic, like the existing pipeline:
- **Filesystem:** epics as `.pipeline/epics/<state>/*.json`; `feature:*` state = subdirectory.
- **Linear:** epic → Linear project (or a parent issue with sub-issues); `feature:*` labels = epic state; children = issues linked to the project/parent.
- **GitHub:** `feature:*` labels on a tracking issue; children = PRs labeled with the epic id.

### Entry point

`agent-pipeline feature "<rough intent>"` (and a `/feature` Claude Code command) files a new EPIC in `feature:needs-spec`. This is the only human-initiated entry to the feature pipeline.

## UI — new "features" tab

A new tab in the existing dashboard, same dependency-free vanilla-JS / SVG / SSE / dark-theme architecture and `:root` design tokens. New files mirror the existing split:
- `ui/public/feature-pipeline.js` — controller.
- `ui/public/feature-pipeline-graph.js` — pure topology (`NODES`/`EDGES`, reducers), mirroring `pipeline-graph.js`.

Wired into `index.html` (new tab + panel), `app.js` (`selectTab`), and `style.css` (view toggling) exactly like the existing tabs.

### Two-level view

```
┌─ features ──────────────────────────────────────────────────────────┐
│  spec → design → decompose →  [ BUILDING ]  → integrate → accept → ✅ │
│   (1)     (0)       (1)          (2)            (0)        (0)    human│
│                                   │                                   │
│   EPIC-003 "dark mode"   building ▸ children 5/8 ready                │
│     ●●●●● ready  ●● in-review  ● in-progress    (chips by ticket state)│
│   EPIC-001 "billing"     needs-acceptance ▸ epic PR #142             │
└──────────────────────────────────────────────────────────────────────┘
```

- **Top:** epic flow diagram — a node/edge graph of the `feature:*` states with per-state epic counts, matching the existing pipeline visual's look and motion (token animations, back-pressure halos where applicable).
- **Building drill-in:** the `building` node expands to the epic's child tickets as a swarm of chips, each colored by which standard-pipeline state it currently occupies (reusing `colors.js` and the existing state palette), with a progress ring (e.g. "5/8 ready").
- **Epic detail:** clicking an epic shows its spec, design, acceptance criteria, and child list with links.

### Data source

The existing `/api/v1/snapshot` is extended with an `epics` array, and new `feature.*` SSE events are emitted on epic state changes (filesystem watcher on `.pipeline/epics/`, or cycle-report-driven for Linear/GitHub backends). No new server architecture — the same SSE/watch model the dashboard already uses.

## Phasing (for the implementation plan)

1. **Epic substrate** — epic data model, `feature:*` states, entry command, filesystem queue helpers; child-ticket `epic`/`depends_on`/`base` fields (no behavior change for non-epic tickets).
2. **Front agents** — feature-spec-writer, feature-architect, feature-decomposer; orchestrator building-monitor + child auto-merge.
3. **Back agents** — feature-integrator, feature-acceptance-validator; epic PR; `feature:needs-feedback` loop.
4. **UI** — features tab (graph + drill-in), snapshot/SSE extension.

## Scope boundaries (YAGNI)

Explicitly **not** in this design:
- Mid-flow human approval gates (spec/design/decomposition sign-off) — gating is end-only by decision.
- A dedicated research/exploration agent — folded into feature-spec-writer / feature-architect.
- Separate feature-specific build agents — existing build agents are reused.
- Per-child human review — children auto-merge into the integration branch.
- Any change to the existing bug-fix pipeline behavior — the feature pipeline is additive.
