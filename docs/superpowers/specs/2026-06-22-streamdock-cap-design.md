# Stream Dock → CAP agent dispatcher — Design

**Date:** 2026-06-22
**Status:** Approved (design), pending implementation plan
**Owner:** Ryan

## Goal

Make the physical keys on Ryan's **VSD N1 Stream Dock** dispatch CAP
(`claude-agent-pipeline`) specialist agents, with **live run status painted back
onto each key's LCD** (idle → running → pass/fail). The device's **touch strip**
acts as a **project picker**: it lists the pipeline-enabled repos, and the
selected project becomes the default `--target` for every dispatch key.

## Hardware & platform facts (verified)

- **Device:** VSD N1 (`VSD N1_1628`, serial `0841DA781628`), USB
  `5548:1002`, manufacturer `HOTSPOTEKUSB`. Driven by **VSD Craft.app**
  (bundle `com.mirabox.streamdock`) — HotSpot Stream Dock software.
- **Controls:** 2 push buttons + 1 rotary dial (top), 1 **programmable touch
  LCD strip**, and a **3-column × 5-row grid of 15 LCD keys**, plus multiple
  profile pages. The right-hand action panel has a **Key / Knob** toggle;
  custom plugins appear there as their own category and their actions are
  dragged onto keys, the knob, or the touch strip.
- **Plugin model:** Elgato-compatible `.sdPlugin` architecture, **SDKVersion 1**.
  Plugins may ship a **Node.js backend** — verified by the installed
  `com.mirabox.streamdock.PR.sdPlugin`, which uses
  `CodePathMac: plugin/index.js` with `Nodejs: { Version: 20 }`. This is the
  mechanism we use (Node backend can `child_process.spawn` the CAP CLI and push
  `setImage`/`setTitle`/`setState` over the device websocket). No compiled
  binary required.
- **Config / install location:**
  `~/Library/Application Support/HotSpot/StreamDock/plugins/`.
  Profiles live under `…/StreamDock/profiles/<uuid>.sdProfile/manifest.json`.

## CAP dispatch surface (CLI v0.3.0)

- `claude-agent-pipeline run <agent> --prompt "…" --target <repo> [--wait|--detach] [--json]`
  — default (no flag) streams JSONL events to stdout; `--json` for machine output.
- `claude-agent-pipeline list-agents [--target <p>] [--json]` — 62 agents.
- `claude-agent-pipeline events [--target <p>] [--json]` — live pipeline event stream (JSONL).
- `claude-agent-pipeline runs <id> [--follow|--wait] [--json]` — per-run status/tail.
- Pipeline-enabled repos are those with `.pipeline/config.json`. Detected on this
  machine: `~/Code/TRQ_Berry`, `~/Code/TRQ_Berry-pipeline`, `~/Code/context-manager`.

## Default key map (v1)

```
TOUCH STRIP   →  Project picker: lists pipeline repos, highlights active one,
                 tap a segment to select; dial scrolls when there are more than fit.
                 Selected project = default --target for all dispatch keys.

KEY (col,row)    Action          CAP dispatch (against active project)
(0,0) Scan       Dispatch Agent  run scanner
(1,0) Worker     Dispatch Agent  run worker
(2,0) Tester     Dispatch Agent  run tester
(0,1) Simplify   Dispatch Agent  run code-simplifier
(1,1) Dead-code  Dispatch Agent  run dead-code-remover
(2,1) CI-triage  Dispatch Agent  run ci-triage

rows 2–4, dial-press, page 2  →  intentionally free (future: orchestrator
                                 toggle, queue-status key, dashboard key).
```

Each dispatch key's `{agent, prompt, target-override, mode}` is configurable in
the property inspector; the table above is just the shipped default profile.
Per-key LCD lifecycle: **idle icon → ⏳ running → ✅ pass / ❌ fail → revert to
idle** after a short hold.

## Architecture

A single plugin, `com.cap.streamdock.sdPlugin`, with a Node 20 backend.

```
~/Code/claude-agent-pipeline/integrations/streamdock/
  com.cap.streamdock.sdPlugin/
    manifest.json            # CodePathMac: plugin/index.js, Nodejs v20, SDKVersion 1
    plugin/
      index.js               # backend entry: websocket register + event loop
      cap.js                 # CAP CLI wrapper: dispatch + JSONL parsing
      state.js               # active-project state file read/write
      render.js              # key/strip image + title rendering helpers
    property-inspector/
      dispatch.html          # PI for Dispatch Agent (agent/prompt/target/mode)
      picker.html            # PI for Project Picker (project source/list)
    icons/                   # idle / running / pass / fail / warn art
    <localization>.json
  default-profile/           # shippable .sdProfile matching the key map above
  install.sh                 # symlink plugin into StreamDock plugins dir (dev)
```

Symlinked into `…/StreamDock/plugins/` for live development; VSD Craft is
restarted to load it. It then appears as the **CAP** category in the action
panel.

### Actions

1. **Dispatch Agent** (`com.cap.streamdock.dispatch`, key action)
   - Settings: `agent` (dropdown from `list-agents`), `prompt` (text, default per
     agent), `targetOverride` (optional; blank = use active project), `mode`
     (`stream` default = spawn `run --json`, parse the JSONL, paint live status;
     `detach` = fire-and-forget via `run --detach`, key just flashes
     "dispatched" with no live verdict).
   - `keyDown`: resolve target (override ?? active project); if none → "pick
     project" state. Otherwise spawn the dispatch, set key to ⏳, and track the
     child process for this key context.
2. **Project Picker** (`com.cap.streamdock.picker`, touch-strip action)
   - Settings: project source (`auto` = scan `~/Code` for `.pipeline/config.json`,
     or an explicit list).
   - Renders the project list with the active one highlighted; updates the shared
     state on selection. Tap selects a segment; dial rotate scrolls; dial press
     selects (fallback path — see Open questions).

### Active-project state

A small JSON file (e.g. `~/.cap/streamdock-state.json`):

```json
{ "activeProject": "/Users/ryan/Code/TRQ_Berry",
  "projects": ["/Users/ryan/Code/TRQ_Berry", "/Users/ryan/Code/context-manager"] }
```

The picker writes `activeProject`; every Dispatch Agent action reads it at
`keyDown` and on `willAppear` (to render the current target in its title).

### Dispatch + live status (Approach A, chosen)

On `keyDown`:

1. Read settings + resolve target.
2. `setState`/`setImage` → ⏳ running; disable re-trigger for that key while busy.
3. `spawn('claude-agent-pipeline', ['run', agent, '--prompt', prompt,
   '--target', target, '--json'])`.
4. Parse stdout JSONL incrementally; on the terminal event derive pass/fail and
   `setImage` ✅/❌ + a short `setTitle` (e.g. verdict or runId).
5. After a short hold, revert to idle.

**Evolution path (Approach C):** when a queue-status key is added, subscribe once
to `agent-pipeline events --json` and fan out status to all keys, rather than
relying solely on per-press CLI parsing. The backend is structured so this is an
additive change (a shared event subscriber feeding the same render layer).

## Error handling

- **CAP CLI not found / not on PATH** → key shows ⚠️ + title "no CAP".
- **Target not pipeline-enabled** (no `.pipeline/config.json`) → ⚠️ + "no pipeline".
- **No active project selected** → dispatch keys render "pick project".
- **Dispatch fails to start / non-zero exit before terminal event** → red error
  state; re-press allowed.
- **Run never terminates within a timeout** → leave last-known state; re-press
  allowed. (Long-press → `runs kill <id>` is a future enhancement.)
- **Picker with zero discovered projects** → strip shows "no pipeline repos".

## Testing strategy

- **Unit:** JSONL → key-state mapping, using fixtures captured from a real
  `run --json` (success and failure runs). Target resolution
  (override ?? active ?? none). Project discovery from `.pipeline/config.json`.
- **Integration (no device):** a mock websocket harness that performs the Stream
  Dock register handshake and emits `willAppear` / `keyDown` / `touchTap` /
  `dialRotate`, asserting the backend's outgoing `setImage`/`setTitle`/`setState`
  messages.
- **Manual on-device:** load the plugin in VSD Craft, drop the default profile,
  pick a project on the strip, press each agent key, and confirm the LCD
  lifecycle and that a CAP run actually appears in `agent-pipeline runs`.

## Packaging / install

- Develop in the CAP repo; `install.sh` creates the symlink into the StreamDock
  plugins dir and prints the "restart VSD Craft" reminder.
- Ship a `default-profile/*.sdProfile` matching the key map so the user gets the
  layout without hand-wiring 6 keys.
- (Future) fold this into a `claude-agent-pipeline streamdock install` subcommand.

## Open questions / assumptions

1. **Touch-strip tap granularity.** The strip is one programmable slot. Assumption:
   the SDK delivers a `touchTap` with an x-coordinate, letting us map a tap to one
   of N rendered project segments. If it only delivers a single undifferentiated
   tap, the **fallback** is dial-rotate to move the highlight + dial-press to
   select. Either way the picker is usable; confirm during implementation against
   the actual `com.hotspot.streamdock` SDK events.
2. **Default prompts per agent.** Some agents (e.g. `worker`) normally act on a
   queued ticket. v1 default prompts will be generic ("pick up the top ready
   ticket and implement it"); refine per agent as we test real dispatches.
3. **Backend dialect.** Confirm the exact register/event message shapes used by
   the HotSpot/Mirabox build (it mirrors Elgato SDKVersion 1; verify against the
   installed `…streamdock.PR` plugin's `index.js` as a reference).

## Out of scope (v1)

- Orchestrator start/stop toggle, queue-status keys, dashboard/open keys
  (designed-for, not built — rows 2–4 reserved).
- Linear ticket backend specifics.
- A polished installer subcommand (manual symlink + doc is fine for v1).
