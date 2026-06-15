# API Reference

Programmatic interfaces for dispatching agents and observing the pipeline from a host tool. All surfaces share the same filesystem-backed state under `<target>/.pipeline/`, so any combination of CLI, Node API, and HTTP consumers can subscribe to the same project simultaneously.

There are three consumer modes:

| Mode | When to use | Transport |
|------|-------------|-----------|
| **CLI (JSONL)** | Shell scripts, language-agnostic hosts | stdout, line-delimited JSON |
| **Node API** | Node/Electron/TS hosts | in-process EventEmitter + async-iterable |
| **HTTP / SSE** | Remote tools, browsers, non-Node hosts | `http://127.0.0.1:<port>` |

All event payloads conform to the `WatcherEvent` discriminated union in [`api/index.d.ts`](../api/index.d.ts).

---

## CLI

Full reference for the dispatch and observability subcommands. Run `agent-pipeline --help` for the complete subcommand list.

### `run <agent> --prompt "..."` — dispatch an agent

```bash
agent-pipeline run scanner \
  --prompt "Scan src/ for silent error handlers" \
  --target ~/Code/my-app \
  --max-budget-usd 0.30 \
  --detach --json
```

| Flag | Meaning |
|------|---------|
| `--prompt "..."` | Required. The user message sent to the agent. |
| `--target <p>` | Project to operate on. Defaults to CWD. |
| `--detach` | Spawn a supervisor process and return immediately. Pairs with `--json` to capture `runId`. |
| `--wait` | Block until the run finishes; print the final `Run` JSON. |
| `--stream` | (Default when neither `--wait` nor `--detach` is set.) Stream JSONL events on stdout. |
| `--follow` / `-f` | After dispatch, live-tail events until completion. |
| `--json` | Machine-readable output. |
| `--max-budget-usd <n>` | Cap the OAuth/API spend on this run. |
| `--allowed-tools "..."` | Space-separated allowlist passed to `claude -p`. |
| `--disallowed-tools "..."` | Space-separated denylist. |
| `--model <id>` | Override model selection. |

**`--detach --json` returns synchronously:**

```json
{ "runId": "20260523181128-66d539a3", "status": "started", "supervisorPid": 86252 }
```

The supervisor keeps running after the CLI exits and writes lifecycle state to `<target>/.pipeline/runs/`.

### `runs` — list runs

```bash
agent-pipeline runs --target ~/Code/my-app [--json]
```

Lists active runs and the 10 most recent completed runs. `--json` returns `{ active: Run[], completed: Run[] }`.

### `runs <runId>` — inspect one run

```bash
agent-pipeline runs 20260523181128-66d539a3 --target ~/Code/my-app [--json]
```

Returns a `Run` (see types). Add `--follow` to live-tail until completion or `--wait` to block until completion and print the final state.

### `runs <runId> events` — captured event log

```bash
agent-pipeline runs 20260523181128-66d539a3 events --target ~/Code/my-app [--json]
```

Dumps `<target>/.pipeline/runs/logs/<runId>.events.jsonl`. Each line is a normalized `RunEvent`. Pipe-safe (`| head`, `| jq` etc. work without EPIPE).

### `runs <runId> --follow` — live tail

Streams the run's normalized events as they are written, then exits when the run
completes. `--json` emits one JSON `RunLogLine` per line; otherwise a compact
`<ts> <type> <activity>` form. Backed by the `streamRunLog` Node API.

### `runs kill <runId>` — terminate a running supervisor

```bash
agent-pipeline runs kill 20260523181128-66d539a3 --target ~/Code/my-app
```

Sends SIGTERM to the recorded pid. The supervisor's close handler moves the run to `completed/` with `status: 'killed'`.

### `runs events` — live event stream (runs-only)

```bash
agent-pipeline runs events --target ~/Code/my-app [--json]
```

Blocks until SIGINT. Emits `run.start | run.update | run.complete | run.fail | run.kill | run.remove` events as JSONL.

### `events` — live event stream (full pipeline)

```bash
agent-pipeline events --target ~/Code/my-app [--json]
```

Like `runs events`, but also includes ticket-state-machine events (`ticket.upsert | ticket.move | ticket.remove`) and orchestrator cycle summaries (`cycle.report`, one per `agent-pipeline cycle report` append).

### `status` — queue snapshot

```bash
agent-pipeline status [--target ~/Code/my-app] [--json] [--state <name>]
```

Prints per-state ticket counts and the list of agents with active in-progress tickets. `--state <name>` filters to one queue state. `--json` returns the full `Snapshot` (or the filtered ticket array when `--state` is set).

### `ticket <id>` — inspect a ticket

```bash
agent-pipeline ticket <id> [--target ~/Code/my-app] [--json]
```

Prints the ticket's state, priority, title, metadata, and comments. `--json` returns the raw `Ticket` object.

### `ticket create` — create a ticket

```bash
agent-pipeline ticket create --title <t> [--description <d>] [--priority <n>] [--labels a,b,c] [--state <state>] [--id <id>] [--json] [--target <p>]
```

Creates a new ticket. `--state` defaults to `needs-triage`; pass any of the 11 valid states (see below). `--labels` is comma-split (trimmed) into an array, same as `ticket update`. `--id` is auto-generated when omitted. With `--json`, prints `{ ok, ticket }` where `ticket` is the newly created record. Errors if the id already exists or `--state` is not one of the 11 valid states.

Valid states: `needs-triage`, `needs-review`, `needs-work`, `in-progress`, `needs-test-review`, `needs-code-review`, `needs-feedback`, `ready-for-human`, `done`, `needs-info`, `obsolete`.

### `ticket move <id> --to <state>` — move a ticket

```bash
agent-pipeline ticket move <id> --to <state> [--json] [--target <p>]
```

Moves a ticket to another queue state (atomic rename). With `--json`, prints `{ ok, id, from, to }`. Errors if the ticket is missing or `--to` is not one of the 11 valid states listed above.

### `ticket update <id>` — patch ticket fields

```bash
agent-pipeline ticket update <id> [--title <t>] [--description <d>] [--priority <n>] [--labels a,b,c] [--json] [--target <p>]
```

Patches only the provided fields (all others are left untouched) and bumps `updated_at`. With `--json`, prints `{ ok, ticket }` where `ticket` is the updated record. Errors if the ticket is missing or no fields are provided.

### `comment <id>` — append a human comment

```bash
agent-pipeline comment <id> --body "..." [--verdict pass|fail] [--json] [--target <p>]
```

Appends a human comment (and optional verdict) to a ticket. `--author` defaults to `"human"`. With `--json`, prints `{ ok, id, verdict, ticket }` where `ticket` is the updated record and `verdict` is `null` when omitted.

### `cycle report` — record an orchestrator cycle

```bash
agent-pipeline cycle report --data '<json>' [--target ~/Code/my-app]
agent-pipeline cycle report --data -          # payload JSON on stdin
```

Appends one line to `<target>/.pipeline/runs/cycles.jsonl` and prints the canonical formatted status block (the orchestrator pastes this verbatim each cycle). The CLI stamps `cycle` (previous + 1) and `at`, and computes per-state deltas against the previous line. Payload fields (all optional unless noted): `counts` (object of `<queue-state>: <int>` — **required** on non-filesystem backends, auto-snapshotted from the queue on filesystem), `dispatched` (array of `{agent, item?}`), `running` (array of `{agent, item?, minutes?}`), `awaiting` (string ids), `notes` (strings), `nextCheckSeconds` (positive int). Fail-open: a corrupt-tailed file emits a stderr warning and restarts numbering; a missing file (first run) starts at cycle 1 silently.

No `--json` flag: the JSONL file (`cycles.jsonl`) is the machine-readable form; this verb's stdout is the human-readable render the orchestrator pastes verbatim.

Each appended line becomes a `cycle.report` watcher event. Distinct from the queue audit log (`queue/events.jsonl`): that is filesystem-backend ticket-mutation audit; `cycles.jsonl` is backend-neutral orchestrator telemetry.

### `orchestrator` — supervisor lifecycle

The orchestrator supervisor is a **detached, long-running process** that keeps the pipeline cycling autonomously — even after the tool or shell session that started it has exited. It owns the loop cadence (initial: 270 s; idle: 1800 s) and fires `cycle report` runs on each tick. CM (or any other host tool) drives it exclusively through these subcommands; there is no need to also run `/loop orchestrator` against the same target — `start` refuses if a live supervisor already exists, protecting against two concurrent drivers.

All subcommands accept `--target <path>` (defaults to CWD) and `--json`.

### `orchestrator status`

```bash
agent-pipeline orchestrator status --target ~/Code/my-app [--json]
```

Reads `.pipeline/runs/orchestrator.state.json`, reconciles supervisor-pid liveness (a recorded pid that is no longer alive is reported as `stopped`, not a phantom `running`), and prints the current state. `--json` emits the full `OrchestratorStatus` object:

```json
{
  "state": "running",
  "supervisorPid": 12345,
  "cadence": "initial",
  "lastCycleAt": "2026-06-13T20:01:00.000Z",
  "lastCycleNumber": 42,
  "nextFireAt": "2026-06-13T20:05:30.000Z",
  "changedAt": "2026-06-13T20:01:05.000Z"
}
```

**`OrchestratorStatus` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `state` | `"running" \| "paused" \| "stopped"` | Lifecycle state of the supervisor loop. |
| `supervisorPid` | `number \| null` | PID of the live supervisor process, or `null` when stopped. |
| `cadence` | `"initial" \| "idle" \| null` | Last applied timing tier (`null` when stopped). |
| `lastCycleAt` | ISO string \| `null` | When the most recent cycle completed. |
| `lastCycleNumber` | `number \| null` | Monotonically-increasing cycle counter. |
| `nextFireAt` | ISO string \| `null` | When the next cycle is due; `null` when paused or stopped. |
| `changedAt` | ISO string | Timestamp of the last write to the state file. |

State is persisted at `<target>/.pipeline/runs/orchestrator.state.json` and exposed via the library's `readSnapshot().orchestrator` field. Every write fires an `orchestrator.changed` watcher event.

### `orchestrator start`

```bash
agent-pipeline orchestrator start --target ~/Code/my-app [--json]
```

Launches a detached supervisor process, sets state to `running` at the initial cadence (270 s), and fires one cycle immediately. **Refuses** if a live supervisor already exists — use `restart` to force a fresh cycle.

```json
{ "started": true, "supervisorPid": 12345 }
```

### `orchestrator pause`

```bash
agent-pipeline orchestrator pause --target ~/Code/my-app [--json]
```

Sets state to `paused` and clears `nextFireAt`. The supervisor process stays alive but dispatches no new cycles. Any agent runs already in flight finish normally — `pause` never kills running work. Use `runs kill <runId>` to stop a specific agent run.

```json
{ "state": "paused" }
```

### `orchestrator resume`

```bash
agent-pipeline orchestrator resume --target ~/Code/my-app [--json]
```

Sets state back to `running`. The supervisor's next tick will dispatch a cycle.

```json
{ "state": "running" }
```

### `orchestrator restart`

```bash
agent-pipeline orchestrator restart --target ~/Code/my-app [--json]
```

Kills any in-flight orchestrator-cycle run (leaves all other agent runs alone), resets to the initial cadence, fires a cycle immediately, and ensures a live supervisor is running (starts one if the previous supervisor died).

```json
{ "restarted": true, "supervisorPid": 12345 }
```

### `orchestrator stop`

```bash
agent-pipeline orchestrator stop --target ~/Code/my-app [--json]
```

Sets state to `stopped`, sends SIGTERM to the supervisor process (the current tick finishes; no orphaned cycles), and clears `supervisorPid`. No agent runs are killed — only the supervisor loop terminates.

```json
{ "stopped": true }
```

---

### `watch` — live terminal dashboard

```bash
agent-pipeline watch [--target ~/Code/my-app]
```

Full-screen zero-dependency TUI: stage counts with deltas, active runs with elapsed time, tickets awaiting human review, and a scrolling event tail. Re-renders on every watcher event plus a 1s tick (countdown to the orchestrator's next check). `q` or Ctrl-C exits. Requires an interactive terminal — for pipeable output use `agent-pipeline events --json`. In non-filesystem backends the queue panels degrade to the latest cycle report's data (the watcher cannot see Linear/GitHub label state).

---

## Node API

```js
import {
  readSnapshot,
  getRun,
  listRuns,
  getRunEvents,
  createWatcher,
  reapOrphanedRuns,
  API_VERSION,
} from 'claude-agent-pipeline/api';
```

All types are in [`api/index.d.ts`](../api/index.d.ts). Zero runtime dependencies.

### Point-in-time reads

```js
const snap = readSnapshot({ target: '/path/to/project' });
//   { apiVersion: 1, agents, tickets, runs, ... }

const { active, completed } = listRuns({ target });
const run    = getRun({ target }, runId);     // Run | null
const events = getRunEvents({ target }, runId); // RunEvent[] (parses the .jsonl)

const stream = streamRunLog({ target }, runId);  // RunLogStream: live tail of the run's events
stream.on('line', (line) => …);                  // RunLogLine = RunEvent & { seq }
stream.on('end', () => …);                       // run completed (or stream.close() called)
for await (const line of stream) { … }           // also async-iterable
```

`streamRunLog` replays existing lines (each tagged with `seq`, the 0-based ordinal position in the run's events log, so re-reads are idempotent for consumers keyed on `seq`), then live-tails newly-appended lines, and ends when the run completes. Call `stream.close()` to stop early.

```js
```

### Subscription via `createWatcher`

The watcher has a dual interface — use whichever fits your code style. Both forms emit the same `WatcherEvent` union.

**As an EventEmitter:**

```js
const w = createWatcher({ target });

w.on('snapshot',     snap => { /* initial + reconciliation snapshots */ });
w.on('run.start',    ev   => { /* ev.run is a Run */ });
w.on('run.update',   ev   => { /* lastActivity / cost changed */ });
w.on('run.complete', ev   => { /* moved to completed/ with status: 'completed' */ });
w.on('run.fail',     ev   => { /* status: 'failed' */ });
w.on('run.kill',     ev   => { /* status: 'killed' */ });
w.on('ticket.move',  ev   => { /* { id, from, to, ticket } */ });

// Always close to release fs.watch handles + reconciliation interval.
process.on('SIGINT', () => { w.close(); process.exit(0); });
```

**As an async-iterable:**

```js
const w = createWatcher({ target });
try {
  for await (const ev of w) {
    if (ev.type === 'run.complete') break;
  }
} finally {
  w.close();
}
```

**Implementation notes:**
- Backed by `fs.watch` with a 50ms debounce, plus a 60s reconciliation tick that re-indexes the queue and runs directories (catches dropped events on NFS / SMB / network FS).
- Emits one `snapshot` event immediately on creation so subscribers start from a known state without polling.
- `WatcherOptions.debounceMs` and `reconcileMs` are tunable; defaults are sane.

### Self-healing orphan reaper

If a supervisor process dies without finalizing its run (kernel OOM, hard kill, etc.), the active run JSON would otherwise sit forever. `reapOrphanedRuns` probes each active run's recorded pid with `kill(pid, 0)`; dead pids get their runs moved to `completed/` with `status: 'orphaned'`.

```js
import { reapOrphanedRuns } from 'claude-agent-pipeline/api';
const reaped = reapOrphanedRuns(target, { minAgeMs: 2000 }); // returns runIds
```

`listRuns` calls this opportunistically on every invocation, so external consumers usually don't need to call it directly. The watcher also runs it on each reconciliation tick.

---

## HTTP / SSE

Start the dashboard server (it doubles as the HTTP API host):

```bash
agent-pipeline ui --target ~/Code/my-app --port 7733
```

Bound to `127.0.0.1` only. Port auto-increments if the requested port is taken — the actual port is printed on startup.

### Endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/v1/snapshot` | `application/json` — `Snapshot` |
| `GET` | `/api/v1/ticket/:id` | `application/json` — `Ticket & { state }` or 404 |
| `GET` | `/api/v1/agent/:name` | `application/json` — `Agent` or 404 |
| `GET` | `/api/v1/events` | `text/event-stream` — SSE stream of `WatcherEvent` |
| `GET` | `/` | HTML — the bundled dashboard UI |

### SSE format

Each event is a standard SSE frame:

```
data: {"type":"run.start","runId":"...","state":"active","run":{...}}

data: {"type":"run.complete","runId":"...","from":"active","to":"completed","run":{...}}
```

Heartbeats every 25 seconds as comment lines (`: ping`) to keep proxies from closing idle connections.

**Reconnect behavior:** the server replays the current `Snapshot` as the first event on every new connection. Clients that lose the connection can reconnect and resync without tracking event IDs.

### Browser example

```js
const es = new EventSource('http://127.0.0.1:7733/api/v1/events');
es.onmessage = ({ data }) => {
  const ev = JSON.parse(data);
  if (ev.type === 'snapshot') return hydrate(ev.data);
  if (ev.type.startsWith('run.')) updateRunUI(ev);
};
```

---

## Filesystem state (for debugging)

If you need to inspect raw state:

```
<target>/.pipeline/
  config.json                       # pipeline config
  queue/<state>/<ticketId>.json     # ticket state machine
  runs/
    active/<runId>.json             # running agent invocations
    completed/<runId>.json          # finished (success | failed | killed | orphaned)
    logs/<runId>.stdout             # raw claude -p stdout (stream-json)
    logs/<runId>.stderr             # raw claude -p stderr
    logs/<runId>.events.jsonl       # parsed/normalized events
    cycles.jsonl                    # orchestrator cycle reports (one JSON line per cycle)
```

State transitions are atomic `rename(2)` calls — first agent wins; second gets `ENOENT`. No locks needed.

The terminal `queue/obsolete/` state holds work the **relevance-checker** retired as no longer relevant against `main` (distinct from `done/` = merged). It is created on first use and is gated by `config.relevance` — see [`config.schema.json`](../config.schema.json) and the README Configuration section.

---

## Versioning

The Node API exports `API_VERSION` (currently `1`). Breaking changes to the public surface (function signatures, event shapes, HTTP routes) bump this number. Additive changes (new event types, new optional fields) do not.
