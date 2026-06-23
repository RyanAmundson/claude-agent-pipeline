# CAP Stream Dock Plugin

Dispatches [claude-agent-pipeline](https://github.com/RyanAmundson/claude-agent-pipeline) specialist agents from physical LCD keys on a HotSpot Stream Dock device. A touch-strip Project Picker sets the active project that every dispatch key targets by default.

## Prerequisites

- `claude-agent-pipeline` CLI on PATH (`npm install -g claude-agent-pipeline`)
- [VSD Craft](https://www.mirabox.com) (HotSpot Stream Dock software) installed
- At least one pipeline-enabled repo — a directory containing `.pipeline/config.json`

## Install

```bash
cd integrations/streamdock
./install.sh
```

This symlinks `com.cap.streamdock.sdPlugin` into `~/Library/Application Support/HotSpot/StreamDock/plugins/`. Then restart VSD Craft:

```bash
osascript -e 'quit app "VSD Craft"'; sleep 1; open -a 'VSD Craft'
```

The plugin appears as the **CAP** category in the VSD Craft action panel.

## Default key map

Rows 2–4 and page 2 are intentionally free for future orchestrator, queue, and dashboard keys.

| Key (col,row) | Label | CAP dispatch (against active project) |
|---|---|---|
| (0,0) | Scan | `run scanner` |
| (1,0) | Worker | `run worker` |
| (2,0) | Tester | `run tester` |
| (0,1) | Simplify | `run code-simplifier` |
| (1,1) | Dead-code | `run dead-code-remover` |
| (2,1) | CI-triage | `run ci-triage` |
| Touch strip | Project Picker | rotate dial to highlight a pipeline repo, press/tap to select; selected project = default `--target` for every dispatch key |

## Per-key LCD lifecycle

Each dispatch key cycles through four icon states:

1. **Idle** — agent-specific icon (e.g. magnifier for Scanner)
2. **Running** (⏳) — spinner overlay while the agent is active
3. **Done** (✅) or **Failed** (❌) — result state held briefly
4. **Idle** — reverts automatically after a short hold

The Project Picker touch strip displays the active project name and highlights the current selection as you rotate the dial.

## Events used (pending on-device confirmation)

The plugin is authored against Elgato SDK event names. Exact HotSpot/Mirabox event names will be confirmed during on-device setup and reconciled here if they differ.

| Action | Event | Purpose |
|---|---|---|
| Dispatch Agent (key) | `willAppear` | initialise icon and title for that context |
| Dispatch Agent (key) | `keyDown` | trigger agent dispatch |
| Project Picker (touch strip) | `willAppear` | render initial project list on the strip |
| Project Picker (touch strip) | `dialRotate` | scroll through discovered pipeline repos |
| Project Picker (touch strip) | `dialPress` | confirm selection of highlighted repo |
| Project Picker (touch strip) | `touchTap` | alternate confirm (tap the strip LCD) |

The Project Picker action is declared in `manifest.json` with `"Controllers": ["Encoder"]`, which maps it to the dial/touch-strip slot.

## Property inspector settings

Each **Dispatch Agent** key exposes:

| Setting | Description |
|---|---|
| `agent` | Agent name passed to CAP (e.g. `scanner`, `worker`) |
| `prompt` | Optional extra prompt forwarded to the agent |
| `targetOverride` | Override the active project for this key only (blank = use active project) |
| `mode` | `stream` — live status updates on the key LCD; `detach` — fire-and-forget |

The **Project Picker** exposes:

| Setting | Description |
|---|---|
| `roots` | Comma-separated parent directories to search for pipeline repos (default: `~/Code`) |

## Default profile

The default profile is exported from the physical device during on-device setup and saved into `integrations/streamdock/default-profile/` as a `.sdProfile` bundle. To import it once it exists:

1. Open VSD Craft.
2. Open the Profile menu and choose **Import**.
3. Select the `.sdProfile` bundle from `integrations/streamdock/default-profile/`.

## On-device verification checklist

1. Assign the six Dispatch Agent actions to keys (0,0)–(2,1) (or import the default profile once available).
2. Assign the Project Picker action to the touch strip.
3. Rotate the dial to highlight a pipeline repo, then press or tap to select it.
4. Press each agent key and confirm the LCD cycles through the running → done/failed states.
5. Verify a run appeared:
   ```bash
   claude-agent-pipeline runs --target <repo>
   ```

> **Note:** nothing above has been verified on the physical device yet. Event names, icon rendering, and key-map behaviour will be confirmed and corrected during on-device setup.
