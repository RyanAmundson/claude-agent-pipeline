# Pipeline Flow Visual (Dashboard) — Design

- **Date:** 2026-06-12
- **Status:** Implemented 2026-06-13 (see Implementation notes)
- **Repo:** `claude-agent-pipeline`
- **Author:** Ryan Amundson (with Claude)

## Implementation notes (2026-06-13)

Built per `docs/superpowers/plans/2026-06-12-pipeline-flow-visual.md`, with two
deviations from the non-goals below:

1. **One server change was required.** `ui/server.js` served static files from a
   fixed allowlist (`/app.js`, `/style.css`, `/favicon.ico`), so the new
   `pipeline.js` / `pipeline-graph.js` modules 404'd — which would have broken
   the whole dashboard (`app.js` imports `pipeline.js`). The static route was
   generalized to serve any single-segment root asset with a known extension
   (path traversal still guarded; `/api/` routes never shadowed). No new
   endpoints or API-behavior changes.
2. **Linear/GitHub backends are driven by `cycle.report`, not `ticket.move`.**
   The "consume `ticket.move`/`upsert`/`remove`" assumption only holds on the
   filesystem backend; non-filesystem backends have no queue to watch, so
   `snapshot.tickets.byState` and the `ticket.*` stream are empty. A pure,
   tested seam (`countsFromCycle` / `runningAgentsFromCycle` /
   `countSourceForCycle`, keyed on the cycle report's stamped `backend`) lets
   the graph seed counts + running pulses from `snapshot.cycle` and update them
   live on `cycle.report` events. The graph is wired to both signal sources.

## Problem

The UI dashboard (`ui/`) has two tabs: a **live log** (per-event stream) and an
**agents** tab (cards grouped by manifest `stage`). Neither shows *where each
agent falls in the pipeline* as a flow — you can't glance at the dashboard and see
work moving scan → ticket → implement → review → human, nor see when a ticket
**leaves** the automated loop (handed to the human, parked, merged, retired) and
**re-enters** it (a human comment reopens it, a parked ticket resumes, a failed
review loops back, a merge triggers a re-scan).

The pipeline is a **lifecycle with loops**, not a straight line. The current tabs
render state as lists; the *shape* of the flow — and the moments work crosses the
in/out boundary — is invisible.

## Goal

Add a **pipeline** tab: an animated graph of the whole work lifecycle. Nodes are
the queue states (plus the human, entry, and exit nodes); edges are every
transition including the loop-backs, exits, and re-entries; and **tickets render
as tokens that animate along edges** as they actually move, so you see both
*where* work can leave/re-enter (static topology) and *when* it does (live tokens).

## Decisions (locked in brainstorm)

1. **Layout — work-flow spine with satellites.** A horizontal spine of the queue
   states; off-path nodes (`needs-feedback`, `needs-info`, `human`, `obsolete`) sit
   above/below; the orchestrator is a driving banner; detectors + utility are a
   feeder cluster into intake.
2. **Edges — all four lifecycle bundles**, not just the happy path: review-fail
   loop, human handoff ↔ re-entry, park ↔ resume (`needs-info`), and stale
   re-queue + post-merge re-scan.
3. **Live behavior — animated tokens flowing.** Tickets are tokens that visibly
   travel along edges (including out to the human and back), driven by the existing
   `ticket.move` event stream. Static topology is always drawn; a move animates a
   token along the relevant edge.
4. **`obsolete` node included** as a reserved exit — forward-wired for the
   relevance-checker agent (see `2026-06-12-relevance-agent-design.md`). Drawn now;
   lights up once tickets start moving to `obsolete/`.
5. **`pipeline` is the default landing tab** (replaces `live log` as the tab shown
   on load). The other tabs remain one click away.

## Non-goals (v1)

- **No server/API changes.** The feature is pure `ui/public/`. The snapshot and
  `/api/v1/events` already provide counts, agent run-state, and `ticket.move /
  upsert / remove` — everything the animation consumes.
- **No graph auto-layout.** Node positions are hand-authored in a layout config;
  the topology is fixed and small.
- **No new runtime dependencies.** Vanilla JS + SVG + CSS, consistent with the
  dashboard's "Node stdlib only / no framework" stance.
- **No physics / force simulation.** Tokens glide along fixed edge paths at a
  constant rate; no spring dynamics.
- **Deep ticket interaction is minimal.** v1: hover a node for a tooltip; clicking
  a node/token can deep-link later (Future Work).

## Why no backend work

Confirmed against `api/index.js` + `ui/server.js`:

| Need | Already provided by |
|---|---|
| Per-node live count | `snapshot.tickets.byState[state].length` |
| Which agent is running (⚡) | `snapshot.agents[].activity.runs` |
| A ticket moved A→B | `/api/v1/events` → `{type:'ticket.move', id, from, to}` |
| New work entering | `ticket.upsert` with a new id in `needs-triage` |
| Work exiting | `ticket.remove` / `ticket.move` to `done`/`obsolete` |

A `ticket.move` **is** a token traversal. Exits and re-entries are moves to/from
the boundary nodes. Nothing new needs to be emitted.

## Architecture

A new `ui/public/pipeline.js` module (app.js is a focused ~375 lines; a separate
module keeps each unit bounded and independently testable). It:

1. Builds the SVG graph once from a static **layout config** (nodes + edges with
   hand-authored coordinates and bezier control points).
2. Opens its own `EventSource('/api/v1/events')`, seeds per-node counts from the
   initial `snapshot` frame, and on each `ticket.*` event spawns/updates tokens.
3. Runs one `requestAnimationFrame` loop driving all active tokens.

`index.html` gains the tab button + `<section data-panel="pipeline">` containing
the `<svg>`. `app.js`'s `selectTab` already switches `data-view`; the default view
flips from `log` to `pipeline` (the `<body data-view>` and the initial
`aria-selected` move to the pipeline tab).

### Rendering choice

**SVG + `requestAnimationFrame` token animator.** Nodes are `<g>` (rect + label +
count); edges are `<path>` beziers; a token is a small `<circle>`/`<g>` whose
position each frame is `path.getPointAtLength(t · totalLength)`.

- *Rejected:* CSS `offset-path`/`offset-distance` animations — less JS, but awkward
  to spawn tokens dynamically, queue concurrent traversals, and fire on-arrival
  count updates. rAF gives explicit control over a pool of event-driven tokens.
- *Rejected:* Canvas 2D — reinvents labels/hit-testing/tooltips that SVG gives free.

### Node + edge model

**Nodes**

- Spine (left→right): `scanner` (entry) · `needs-triage` · `needs-review` ·
  `needs-work` · `in-progress` · `needs-test-review` · `needs-code-review` ·
  `ready-for-human` · `done` (exit).
- Satellites: `needs-feedback` (loop hub, below spine), `needs-info` (park, below),
  `human` (off-pipeline actor, above `ready-for-human`), `obsolete` (exit, below;
  reserved for the relevance-checker).
- Chrome: `orchestrator` driving banner (pulses while an orchestrator run is
  active); `detectors ⟳` + `utility ⛭` feeder cluster wired into `needs-triage`.

**Edges** (drawn statically; a token animates one when its move fires)

| # | Edge | Trigger | Bundle |
|---|---|---|---|
| 1 | triage → review → work → in-progress → test → code-review → ready | happy-path `ticket.move` | base |
| 2 | scanner / detectors / utility → triage | new id in `needs-triage` | base (entry) |
| 3 | test → needs-feedback; code-review → needs-feedback | FAIL-verdict move | review-fail loop |
| 4 | needs-feedback → code-review (re-review) | move after fix | review-fail loop |
| 5 | code-review → ready → human | pass + handoff | human ↔ |
| 6 | ready → done | merge | human ↔ (exit) |
| 7 | ready → needs-feedback | human comment | human ↔ (re-entry) |
| 8 | review → needs-info | thin ticket parks | park ↔ |
| 9 | needs-info → review | updated, resume | park ↔ (re-entry) |
| 10 | in-progress → needs-work | stale re-queue | stale + re-scan |
| 11 | done → scanner (faint "regenerates") | post-merge new triage upserts | stale + re-scan |
| 12 | needs-work / ready → obsolete | relevance-checker high-confidence | exit (reserved) |

Edge classification is a **pure function** `edgeForMove({from, to, ticket})`:
`from`+`to` alone resolves nearly every edge (the `needs-feedback` destination is
itself the fail/feedback signal; `ready → needs-feedback` is the human re-entry).
The `ticket` payload rides on the move event (`api/index.js` sets
`ticket: cur.ticket`), so its latest `comments[].verdict` is available as a
tiebreaker in the rare case `from`+`to` is ambiguous. A move with no matching
authored edge falls back to a generic arc drawn on demand (so unforeseen
transitions still animate rather than silently dropping).

### Animation behavior

- **Token pool** + single rAF loop; many tokens animate concurrently. Each token:
  `{ edgeId, t, startTs, color, ticketId }`; `t` advances by `dt / EDGE_MS`
  (constant rate, ~700 ms/edge), clamped to 1, then retired.
- **Spawn:** `ticket.move{from,to}` → token at `from`, glide to `to`; on arrival,
  `count[from]--`, `count[to]++`. New id in `needs-triage` → token enters at
  `scanner`. `ticket.remove` at a terminal → token exits / count decrements.
- **Color:** by source agent, reusing the existing `colorForAgent` palette so the
  pipeline and log views are visually consistent.
- **Idle state:** with no live moves, the static graph + current counts are shown;
  nodes with a running agent pulse (⚡), matching the agents tab's running badge.
- **Reduced motion:** honor `prefers-reduced-motion` — skip token glide, just
  update counts and briefly highlight the destination node.

### Schematic (rendered as SVG; ASCII here for intent)

```
        ORCHESTRATOR ⚡  (dispatches all)
 detectors⟳ utility⛭ ─┐
 scanner ───────────┐ │
 (entry / re-scan)  ▼ ▼
   triage ▸ review ▸ work ▸ in-prog ▸ test ▸ code-review ▸ ready ─▸ 👤 human
              │ ▲              │stale    │fail    │fail   ▲pass  │merge   │comment
         park ▼ │resume   re-queue│   loop▼   loop▼      │      ▼        ▼
           needs-info        needs-work   needs-feedback─┘     done   needs-feedback
              ▲                                                 │(exit)  (re-entry)
              └──────── re-scan after merge ◄───────────────────┘
   needs-work / ready ─▸ obsolete   (reserved: relevance-checker)
```

## Files touched

| File | Change |
|---|---|
| `ui/public/pipeline.js` | **new** — layout config, SVG builder, `edgeForMove`, count reducer, rAF token animator, event wiring |
| `ui/public/index.html` | add `pipeline` tab + `<section data-panel="pipeline">` with `<svg>`; flip default `data-view`/`aria-selected` to pipeline |
| `ui/public/style.css` | graph/node/edge/token/tooltip styles; reduced-motion rules |
| `ui/public/app.js` | minor: ensure `selectTab('pipeline')` initializes the graph; default-tab wiring |
| `test/` | unit tests for the pure seams (`edgeForMove`, count reducer) |
| `README.md` / dashboard docs | one-line mention of the new tab |

## Testing

- **`edgeForMove`** (pure): every row in the edge table — e.g. `{from:'needs-code-review',
  to:'needs-feedback', verdict:'fail'}` → `edge:code-review-fail`;
  `{from:'ready-for-human', to:'needs-feedback'}` → `edge:human-reentry`;
  `{from:'in-progress', to:'needs-work'}` → `edge:stale-requeue`; unknown pair →
  `null` (generic-arc fallback).
- **Count reducer** (pure): seed from a snapshot, apply a sequence of
  move/upsert/remove events, assert per-node counts; conservation (no negative
  counts; entry/exit balance).
- **Render smoke:** the rAF/DOM layer is exercised by running the dashboard against
  a seeded `.pipeline/queue/` and driving moves (browser skill) — not unit-tested,
  consistent with the rest of the UI.

## Future Work

- **Deep-link tokens/nodes** to the ticket detail (`/api/v1/ticket/:id`) on click.
- **Edge throughput heat** — thicken or recolor an edge by how many tokens crossed
  it recently (spot the hot loop, e.g. churning feedback).
- **Time-scrub** — replay the last N minutes of `events.jsonl` as token motion.
- **Collapse satellites** on narrow viewports into a compact spine.
