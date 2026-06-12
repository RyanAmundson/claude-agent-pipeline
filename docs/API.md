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

### `cycle report` — record an orchestrator cycle

```bash
agent-pipeline cycle report --data '<json>' [--target ~/Code/my-app]
agent-pipeline cycle report --data -          # payload JSON on stdin
```

Appends one line to `<target>/.pipeline/runs/cycles.jsonl` and prints the canonical formatted status block (the orchestrator pastes this verbatim each cycle). The CLI stamps `cycle` (previous + 1) and `at`, and computes per-state deltas against the previous line. Payload fields (all optional unless noted): `counts` (object of `<queue-state>: <int>` — **required** on non-filesystem backends, auto-snapshotted from the queue on filesystem), `dispatched` (array of `{agent, item?}`), `running` (array of `{agent, item?, minutes?}`), `awaiting` (string ids), `notes` (strings), `nextCheckSeconds` (positive int). Fail-open: a corrupt-tailed file emits a stderr warning and restarts numbering; a missing file (first run) starts at cycle 1 silently.

No `--json` flag: the JSONL file (`cycles.jsonl`) is the machine-readable form; this verb's stdout is the human-readable render the orchestrator pastes verbatim.

Each appended line becomes a `cycle.report` watcher event. Distinct from the queue audit log (`queue/events.jsonl`): that is filesystem-backend ticket-mutation audit; `cycles.jsonl` is backend-neutral orchestrator telemetry.

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

---

## Versioning

The Node API exports `API_VERSION` (currently `1`). Breaking changes to the public surface (function signatures, event shapes, HTTP routes) bump this number. Additive changes (new event types, new optional fields) do not.
