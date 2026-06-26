# Agent Read Model — a source of truth agents query

**Date:** 2026-06-26
**Status:** Design approved; spec scoped to **Slice 1 (`work_item`)** only.

## Problem

Every dispatched agent makes **live queries** to the work-item backend (Linear /
GitHub), the PR/review surface, run files, and the codebase — each dispatch,
frequently only to discover there is nothing there worth acting on. Three costs
follow:

1. **Redundant / empty queries.** N short-lived agents each re-poll the same
   external systems per dispatch; most polls return nothing.
2. **Race surface.** Independent agents read the same live state and can act on
   it concurrently (e.g. two agents claim the same ticket).
3. **Backend coupling.** Each agent embeds knowledge of *how* to talk to Linear
   vs. GitHub vs. the run files. Data access is smeared across the whole agent
   fleet, so every new agent re-implements it and every backend change ripples
   everywhere.

## Goal

Stand up a **read model (CQRS)**: one process keeps a local, materialized mirror
of the external systems, and dispatched agents **read from a single typed
interface** instead of each hitting the live backends. The durable win is not
the cache — it is **decoupling agents from the backends behind one query
interface**. New agents get data access for free; existing agents shed their
per-backend query logic. Eliminating empty polls is the immediate, measurable
benefit.

**Non-goals.** This is a *read* model. It is **not** a system of record — the
external systems remain authoritative. Agents never write *through* the store;
state changes go live to the provider (see the contract). RxDB / browser-side
replication is explicitly out — the dashboard is a live view of one always-on
server, not an offline replica.

## Architecture

Three actors with clean boundaries:

```
   Linear  ┐                          ┌─────────────── your infra ───────────────┐
   GitHub  ┼─ webhooks ──▶  RELAY  ◀── SSE/WS outbound ── ORCHESTRATOR LOOP        │
           ┘  (push)     (public,      (local; the only   │  ├─ sync engine        │
                          buffers)      persistent proc)   │  │   apply events →    │
                                                           │  │   READ STORE  ◀──┐  │
        backfill + reconciliation poll ───────────────────┘  │   (SQLite)       │  │
        (slow backstop, direct to provider APIs)              │   HTTP/SSE API ──┘  │
                                                              └────────┬──────────┘ │
                                                                       │            │
                          dispatched agents ── read ──▶ /api/v1/store/* (local)     │
                          (short-lived procs)  └─ confirm-live before any write ──▶ provider
                                                              dashboard ── subscribe ▶ same store
```

### Relay (hosted, tiny — slice-1 deliverable)

A dumb, durable pipe. Public endpoint hostable on the user's Proxmox (a small
container) or a Cloudflare Worker.

- Receives provider webhooks; **validates provider signatures** (Linear/GitHub
  HMAC) and rejects anything unsigned/invalid.
- **Buffers per pipeline instance** with a monotonic cursor, so events survive
  while the pipeline is offline.
- Forwards events over a connection the **pipeline opens outbound** (SSE or
  WebSocket) — no inbound reachability, works behind NAT.
- Authenticates the draining pipeline (per-instance token) so only the owner
  drains its events.
- On reconnect, **replays buffered events since the pipeline's last-acked
  cursor**.
- Knows nothing about pipeline semantics — it never parses business meaning.

### Sync engine (inside the orchestrator loop)

Keeps the store a faithful mirror. **Three producers, one apply path:**

```
backfill (once at boot) ─┐
webhook events (relay)  ─┼──▶ normalize → applyToStore(entity, _source) → store
reconciliation (slow)   ─┘                  (idempotent upsert by externalId)
```

- **`applyToStore`** is the single idempotent write path. Keyed by
  `externalId`; last-writer-wins on `_syncedAt`. All three producers funnel
  through it so they cannot corrupt one another.
- **Backfill** seeds the empty store once on boot (full fetch of the active
  working set; rows marked `_source: 'backfill'`).
- **Reconciliation** runs on a slow cadence (default every few minutes), diffs
  provider-vs-store **for the active working set only** (not the whole history),
  and repairs drift. This is the backstop that makes "push" trustworthy when
  webhooks are dropped, delivered out of order, or missed during downtime.
- **Relay reconnect** asks for replay since the last-acked cursor; any gap is
  swept by reconciliation.

### Read store (SQLite, behind the existing HTTP API)

- Single embedded SQLite file (`better-sqlite3`) owned by the orchestrator
  process. Nobody writes through it except `applyToStore`.
- Exposed only via the **typed read API** (below). Agents and the dashboard read
  it; agents never open the DB file directly (they are separate processes).
- Live changes pushed to the **dashboard over the existing SSE channel**.

## The read/write contract

- Agents **read** `/api/v1/store/*` freely for discovery and context. This is
  what eliminates the empty polls.
- Before any **state change** (claim a ticket, transition a label, open a PR),
  the agent does a **targeted live re-check of just that entity**, then writes
  **live to the provider**. The store is never the source of truth for a
  decision to mutate.
- The write's webhook **echoes back** through relay → sync → `applyToStore`, so
  the mirror converges within seconds **without the agent updating the store
  itself**. The store self-heals after every write.

## Store schema

Each entity is a typed collection. Every row carries sync metadata so the
contract and reconciliation work:

```
work_item    { id, backend, externalId, title, state, labels[], claim,
               url, raw, _syncedAt, _rev, _source: 'webhook'|'backfill'|'reconcile' }
pull_request { id, number, state, reviewState, ciStatus, mergeable, threads[], _syncedAt, ... }   # slice 2
run          { runId, agent, status, startedAt, events[]|eventsRef, _syncedAt, ... }              # slice 3
finding      { id, detector, paths[], severity, status, producedByRun, _syncedAt, ... }           # slice 4
```

- `_syncedAt` powers the reconciliation diff and lets an agent observe
  staleness.
- `_source` distinguishes a confirmed webhook update from a backfilled/reconciled
  guess.

## Read API (the product)

A typed, backend-agnostic surface. Indicative shape (finalize in the plan):

```
GET  /api/v1/store/work-items?state=&label=&claim=&backend=    → WorkItem[]
GET  /api/v1/store/work-items/:externalId                      → WorkItem
GET  /api/v1/store/stream                                      → SSE: row changes (dashboard + future reactive agents)
GET  /api/v1/store/health                                      → { lastWebhookAt, lastReconcileAt, relayConnected, rowCounts }
```

The API normalizes Linear and GitHub into one `WorkItem` shape so callers never
branch on backend. `confirm-live` stays a provider call (not a store route) —
the store deliberately does not offer a write path.

## Sequencing

Slice 1 is the real project (it stands up the entire spine on one entity);
slices 2–4 are largely repetition of an established pattern and each get their
own plan.

| Order | Collection     | Source                     | Notes |
|-------|----------------|----------------------------|-------|
| **1** | `work_item`    | Linear/GitHub webhooks     | Worst empty-poll offender. Ships relay + sync engine + store + read API + contract end-to-end. **This spec.** |
| 2     | `pull_request` | GitHub webhooks            | Adds review/CI shape; reuses spine. |
| 3     | `run`          | internal events            | Read-path **unification** — data already owned; fold behind the same API. No relay. |
| 4     | `finding`      | internal (detector agents) | **Derived** — agents *write* these as produced. Different mechanic; do last. |

## Error handling & edge cases

- **Relay unreachable at boot:** pipeline runs on backfill + reconciliation poll
  alone (degrades to centralized polling, still far better than per-agent
  polling); retries the outbound connection with backoff.
- **Webhook signature invalid:** relay drops it; reconciliation will still catch
  the underlying change.
- **Store empty / cold (pre-backfill):** read API reports `health` with low row
  counts and `lastWebhookAt: null`; agents fall back to live queries until
  backfill completes (no hard dependency on a warm store).
- **Duplicate / out-of-order events:** absorbed by idempotent `applyToStore` +
  last-writer-wins on `_syncedAt`.
- **Provider rate limits during backfill/reconcile:** the single sync engine is
  the only thing polling, so limits are centrally controllable (vs. N agents
  today).

## Testing

- **Unit:** `applyToStore` idempotency (replay same event → no change), ordering
  (older `_syncedAt` does not clobber newer), normalize Linear/GitHub → one
  `WorkItem`.
- **Sync engine:** backfill seeds expected rows; reconciliation repairs an
  injected drift; relay-replay-after-gap converges.
- **Contract:** agent read path returns mirror; confirm-live still issues a
  provider call before a simulated write.
- **API:** filter routes, `health` shape, SSE emits on row change.
- **Relay:** signature validation, per-instance buffering, replay-since-cursor,
  auth on drain.

## Open items deferred to the plan

- Relay transport: SSE vs WebSocket (both satisfy outbound-only; pick in plan).
- Relay hosting target: Proxmox container vs Cloudflare Worker.
- Exact `WorkItem` normalized field set across Linear/GitHub.
- Reconciliation cadence + "active working set" definition (which rows are
  in-scope for the diff).
