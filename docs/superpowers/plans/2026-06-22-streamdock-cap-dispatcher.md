# Stream Dock → CAP Agent Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node-backed `com.cap.streamdock.sdPlugin` so the VSD N1 Stream Dock's keys dispatch CAP agents with live pass/fail status on each LCD, and its touch strip selects the active target project.

**Architecture:** A self-contained Stream Dock plugin (Elgato SDKv1 dialect) whose Node 20 backend opens the device websocket, and on `keyDown` spawns `claude-agent-pipeline run <agent> --target <activeProject> --json`, parses the streamed JSONL, and paints state images/titles back onto the key. A touch-strip "Project Picker" action writes the active project to a shared state file that every dispatch key reads. Pure logic (websocket frame codec, run-JSONL parser, state/project discovery) is unit-tested with `node --test`; device glue is exercised through a mock websocket server plus a manual on-device checklist.

**Tech Stack:** Plain ESM JavaScript, Node 20 (provided by Stream Dock runtime), **zero runtime dependencies** (raw `node:net` websocket client — no `ws`), Node built-in test runner.

## Global Constraints

- Language: **ESM JavaScript only** (no TypeScript). Every plugin dir is an ESM package (`"type": "module"`). Copy this verbatim into each `package.json`.
- **Zero runtime npm dependencies.** The websocket client is implemented over `node:net`. No build/bundle step.
- Tests use **Node's built-in runner**: `node --test`. Unit tests live under `test/unit/streamdock/` so the repo's existing `npm run test:unit` (`node --test "test/unit/**/*.test.js"`) runs them.
- Plugin identity: directory `com.cap.streamdock.sdPlugin`; manifest `SDKVersion: 1`, `CodePathMac: "plugin/index.js"`, `Nodejs: { "Version": "20" }`, `Category: "CAP"`.
- Install path (symlink, dev mode): `~/Library/Application Support/HotSpot/StreamDock/plugins/`.
- CAP CLI binary name: `claude-agent-pipeline` (resolved on `PATH`).
- Active-project state file: `~/.cap/streamdock-state.json`.
- Stream Dock launch contract: backend is started with argv `-port <n> -pluginUUID <uuid> -registerEvent <evt> -info <json>`; connect to `ws://127.0.0.1:<port>`; first message sent is `{ "event": <registerEvent>, "uuid": <pluginUUID> }`.
- Source of repo conventions: zero-dep ESM, `node --test`, see `package.json` scripts.

---

## File Structure

```
integrations/streamdock/
  com.cap.streamdock.sdPlugin/
    manifest.json                 # plugin manifest (SDKv1, Node 20, CAP category)
    package.json                  # { "type": "module" } — ESM
    plugin/
      index.js                    # entry: parse argv, connect, route events to actions
      ws-frame.js                 # pure RFC6455 client frame encode/decode
      ws-client.js                # net.connect + handshake + frame plumbing
      sd.js                       # Stream Dock API (register, setImage/setTitle/setState)
      cap.js                      # CAP CLI wrapper + run-JSONL parser + project discovery
      state.js                    # active-project state file read/write
      icons.js                    # load PNG state icons → base64 data URIs (cached)
      actions/
        dispatch.js               # "Dispatch Agent" key action handler
        picker.js                 # "Project Picker" touch-strip action handler
    property-inspector/
      dispatch.html               # PI: agent / prompt / target-override / mode
      picker.html                 # PI: project source
    icons/                        # idle.png running.png pass.png fail.png warn.png + category/action icons
  default-profile/
    CAP.sdProfile/                # shippable profile matching the default key map
  install.sh                      # symlink plugin into StreamDock plugins dir
  README.md                       # install + usage + on-device verification checklist
test/unit/streamdock/
  ws-frame.test.js
  cap-parse.test.js
  cap-discover.test.js
  state.test.js
  sd.test.js                      # uses a mock net server
```

---

### Task 1: Plugin scaffold + zero-dep websocket client + device event capture

**Files:**
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/package.json`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/manifest.json`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-client.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/index.js`
- Test: `test/unit/streamdock/ws-frame.test.js`

**Interfaces:**
- Produces:
  - `ws-frame.js`: `encodeTextFrame(text: string): Buffer` (client frame, masked), `class FrameDecoder { push(chunk: Buffer): string[] }` (returns any complete text messages decoded so far).
  - `ws-client.js`: `connect({ port: number, onOpen: () => void, onMessage: (text: string) => void, onClose?: () => void }): { send(text: string): void, close(): void }`.
  - `index.js`: an executable backend that parses Stream Dock argv and connects; in this task it only registers and appends every received event to `~/.cap/streamdock-events.log` (capture harness).

- [ ] **Step 1: Create the ESM package marker**

`integrations/streamdock/com.cap.streamdock.sdPlugin/package.json`:

```json
{
  "name": "com.cap.streamdock.sdplugin",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Write the failing frame-codec test**

`test/unit/streamdock/ws-frame.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTextFrame, FrameDecoder } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

test('client text frame sets FIN+text opcode and mask bit', () => {
  const buf = encodeTextFrame('hi');
  assert.equal(buf[0], 0x81);            // FIN + opcode 0x1 (text)
  assert.equal(buf[1] & 0x80, 0x80);     // MASK bit set
  assert.equal(buf[1] & 0x7f, 2);        // payload length 2
  assert.equal(buf.length, 2 + 4 + 2);   // header + mask key + payload
});

test('decoder reassembles an unmasked server text frame', () => {
  // Server frame: FIN+text, len 5, no mask, payload "hello"
  const server = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const dec = new FrameDecoder();
  assert.deepEqual(dec.push(server), ['hello']);
});

test('decoder handles a 16-bit extended length and split chunks', () => {
  const payload = 'x'.repeat(200);
  const header = Buffer.from([0x81, 126, 0x00, 0xc8]); // 126 => 16-bit, 0x00c8 = 200
  const full = Buffer.concat([header, Buffer.from(payload)]);
  const dec = new FrameDecoder();
  assert.deepEqual(dec.push(full.subarray(0, 50)), []);          // partial: nothing yet
  assert.deepEqual(dec.push(full.subarray(50)), [payload]);      // rest completes it
});
```

- [ ] **Step 3: Run it to verify failure**

Run: `node --test test/unit/streamdock/ws-frame.test.js`
Expected: FAIL — `Cannot find module '.../ws-frame.js'`.

- [ ] **Step 4: Implement `ws-frame.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js`:

```js
import { randomBytes } from 'node:crypto';

// Encode a single final text frame from client → server (RFC6455 requires masking).
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Incrementally decode server → client frames. Server frames are unmasked.
// Handles fragmentation across chunks; returns completed text messages.
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(this.buf.readBigUInt64BE(2)); offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) break;
      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
        payload = copy;
      }
      this.buf = this.buf.subarray(offset + maskLen + len);
      if (opcode === 0x1) out.push(payload.toString('utf8')); // text
      // opcode 0x8 (close) / 0x9 (ping) / 0xA (pong) ignored for our local use
    }
    return out;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/unit/streamdock/ws-frame.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Implement the websocket client `ws-client.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-client.js`:

```js
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { encodeTextFrame, FrameDecoder } from './ws-frame.js';

export function connect({ port, onOpen, onMessage, onClose }) {
  const key = randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  const decoder = new FrameDecoder();
  let upgraded = false;

  sock.on('connect', () => {
    sock.write(
      `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
    );
  });

  sock.on('data', (chunk) => {
    if (!upgraded) {
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      upgraded = true;
      onOpen && onOpen();
      const rest = chunk.subarray(headerEnd + 4);
      if (rest.length) for (const m of decoder.push(rest)) onMessage(m);
      return;
    }
    for (const m of decoder.push(chunk)) onMessage(m);
  });

  sock.on('close', () => onClose && onClose());
  sock.on('error', () => onClose && onClose());

  return {
    send(text) { sock.write(encodeTextFrame(text)); },
    close() { sock.end(); },
  };
}
```

- [ ] **Step 7: Write the manifest**

`integrations/streamdock/com.cap.streamdock.sdPlugin/manifest.json`:

```json
{
  "SDKVersion": 1,
  "Author": "CAP",
  "Name": "CAP",
  "Description": "Dispatch claude-agent-pipeline agents from your Stream Dock.",
  "Category": "CAP",
  "CategoryIcon": "icons/category",
  "Icon": "icons/category",
  "Version": "0.1.0",
  "CodePathMac": "plugin/index.js",
  "CodePathWin": "plugin/index.js",
  "OS": [{ "Platform": "mac", "MinimumVersion": "10.15" }],
  "Software": { "MinimumVersion": "3.10.188.226" },
  "Nodejs": { "Version": "20" },
  "Actions": [
    {
      "Name": "Dispatch Agent",
      "UUID": "com.cap.streamdock.dispatch",
      "Icon": "icons/idle",
      "Tooltip": "Dispatch a CAP agent against the active project.",
      "PropertyInspectorPath": "property-inspector/dispatch.html",
      "SupportedInMultiActions": false,
      "States": [
        { "Image": "icons/idle" },
        { "Image": "icons/running" }
      ]
    },
    {
      "Name": "Project Picker",
      "UUID": "com.cap.streamdock.picker",
      "Icon": "icons/category",
      "Tooltip": "Select the active CAP project.",
      "PropertyInspectorPath": "property-inspector/picker.html",
      "SupportedInMultiActions": false,
      "States": [{ "Image": "icons/category" }]
    }
  ]
}
```

> NOTE: the touch-strip/dial controller declaration for `Project Picker` (Elgato uses `"Controllers": ["Encoder"]` + an `"Encoder"` block; the HotSpot SDKv1 dialect may differ) is finalized in Step 9 after observing real device events. Leave it as a key-style action for now so the plugin loads.

- [ ] **Step 8: Write the capture-harness `index.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/index.js`:

```js
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from './ws-client.js';

// Stream Dock launches us with: -port N -pluginUUID U -registerEvent E -info JSON
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^-+/, '')] = argv[i + 1];
  return a;
}

const args = parseArgs(process.argv.slice(2));
const logPath = join(homedir(), '.cap', 'streamdock-events.log');

const ws = connect({
  port: Number(args.port),
  onOpen() {
    ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
    appendFileSync(logPath, `[open] registered ${args.pluginUUID}\n`);
  },
  onMessage(text) {
    appendFileSync(logPath, text + '\n');   // capture every event verbatim
  },
});
```

- [ ] **Step 9: Manual — load on device and capture real events**

```bash
mkdir -p ~/.cap
ln -sfn "$PWD/integrations/streamdock/com.cap.streamdock.sdPlugin" \
  "$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.cap.streamdock.sdPlugin"
: > ~/.cap/streamdock-events.log
osascript -e 'quit app "VSD Craft"'; sleep 1; open -a "VSD Craft"
```

In VSD Craft: drag **CAP → Dispatch Agent** onto a key and **Project Picker** onto the touch strip, then press the key, tap the strip, and rotate the dial.
Run: `cat ~/.cap/streamdock-events.log`
Expected: lines for `willAppear`, `keyDown`/`keyUp`, and the strip/dial events (`dialRotate`/`dialPress`/`touchTap` or the HotSpot equivalent). **Record the exact event names + payload shape in `integrations/streamdock/README.md` under "Observed events"** — Tasks 4 and 5 code against these names, and Step 7's manifest `Controllers` block is finalized from what makes the strip deliver events.

- [ ] **Step 10: Commit**

```bash
git add integrations/streamdock test/unit/streamdock/ws-frame.test.js
git commit -m "feat(streamdock): plugin scaffold + zero-dep websocket client + event capture"
```

---

### Task 2: CAP CLI wrapper + run-JSONL parser

**Files:**
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js`
- Test: `test/unit/streamdock/cap-parse.test.js`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `parseRunLine(line: string): { kind: 'running' | 'activity' | 'done' | 'ignore', activity?: string, ok?: boolean }` — pure mapping of one JSONL line to a UI intent.
  - `dispatch({ agent, prompt, target, mode }): { events: EventEmitter, kill(): void, done: Promise<{ ok: boolean }> }` — spawns the CLI; `events` emits `'state'` with the `parseRunLine` result objects.

- [ ] **Step 1: Write the failing parser test**

`test/unit/streamdock/cap-parse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunLine } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js';

test('run.start → running', () => {
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'run.start' })), { kind: 'running' });
});

test('run.update with activity → activity text', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'run.update', activity: 'editing file' })),
    { kind: 'activity', activity: 'editing file' }
  );
});

test('end with completed status → done ok:true', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'end', run: { status: 'completed', exitCode: 0 } })),
    { kind: 'done', ok: true }
  );
});

test('end with failed status → done ok:false', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'end', run: { status: 'failed', exitCode: 1 } })),
    { kind: 'done', ok: false }
  );
});

test('run.fail → done ok:false', () => {
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'run.fail' })), { kind: 'done', ok: false });
});

test('non-JSON / unknown → ignore', () => {
  assert.deepEqual(parseRunLine('not json'), { kind: 'ignore' });
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'whatever' })), { kind: 'ignore' });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test test/unit/streamdock/cap-parse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cap.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js`:

```js
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const CLI = 'claude-agent-pipeline';

// Pure: map one JSONL line from `run --json` to a UI intent.
export function parseRunLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return { kind: 'ignore' }; }
  switch (ev.type) {
    case 'run.start':  return { kind: 'running' };
    case 'run.update': return ev.activity ? { kind: 'activity', activity: ev.activity } : { kind: 'ignore' };
    case 'run.complete': return { kind: 'done', ok: true };
    case 'run.fail':
    case 'run.kill':   return { kind: 'done', ok: false };
    case 'end':        return { kind: 'done', ok: ev.run?.status === 'completed' };
    default:           return { kind: 'ignore' };
  }
}

// Spawn a streaming dispatch. `mode: 'detach'` fires and forgets.
export function dispatch({ agent, prompt, target, mode = 'stream' }) {
  const events = new EventEmitter();
  if (mode === 'detach') {
    const child = spawn(CLI, ['run', agent, '--prompt', prompt, '--target', target, '--detach'],
      { stdio: 'ignore' });
    const done = new Promise((res) => child.on('close', (code) => res({ ok: code === 0 })));
    return { events, kill: () => child.kill('SIGTERM'), done };
  }
  const child = spawn(CLI, ['run', agent, '--prompt', prompt, '--target', target, '--json']);
  const rl = createInterface({ input: child.stdout });
  let ok = false;
  rl.on('line', (line) => {
    const intent = parseRunLine(line);
    if (intent.kind === 'done') ok = intent.ok;
    if (intent.kind !== 'ignore') events.emit('state', intent);
  });
  const done = new Promise((res) => {
    child.on('close', (code) => {
      // Trust an explicit terminal event; otherwise fall back to exit code.
      res({ ok: ok || code === 0 });
    });
  });
  return { events, kill: () => child.kill('SIGTERM'), done };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/streamdock/cap-parse.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js test/unit/streamdock/cap-parse.test.js
git commit -m "feat(streamdock): CAP dispatch wrapper + run-JSONL parser"
```

---

### Task 3: Active-project state + pipeline-project discovery

**Files:**
- Modify: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js` (add `discoverProjects`)
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/state.js`
- Test: `test/unit/streamdock/cap-discover.test.js`
- Test: `test/unit/streamdock/state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `state.js`: `readState(): { activeProject: string|null }`, `setActiveProject(path: string): void`, `getStatePath(): string`. State file: `~/.cap/streamdock-state.json`.
  - `cap.js`: `discoverProjects(roots: string[]): { path: string, name: string }[]` — directories under each root containing `.pipeline/config.json`.

- [ ] **Step 1: Write the failing discovery test**

`test/unit/streamdock/cap-discover.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js';

test('discoverProjects finds dirs with .pipeline/config.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-disc-'));
  mkdirSync(join(root, 'alpha', '.pipeline'), { recursive: true });
  writeFileSync(join(root, 'alpha', '.pipeline', 'config.json'), '{}');
  mkdirSync(join(root, 'beta'), { recursive: true });            // no pipeline
  const found = discoverProjects([root]);
  assert.deepEqual(found.map((p) => p.name), ['alpha']);
  assert.equal(found[0].path, join(root, 'alpha'));
});
```

- [ ] **Step 2: Write the failing state test**

`test/unit/streamdock/state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, setActiveProject } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/state.js';

test('state round-trips active project via CAP_STATE_DIR override', () => {
  process.env.CAP_STATE_DIR = mkdtempSync(join(tmpdir(), 'cap-state-'));
  assert.equal(readState().activeProject, null);
  setActiveProject('/Users/ryan/Code/TRQ_Berry');
  assert.equal(readState().activeProject, '/Users/ryan/Code/TRQ_Berry');
  delete process.env.CAP_STATE_DIR;
});
```

- [ ] **Step 3: Run both to verify failure**

Run: `node --test test/unit/streamdock/cap-discover.test.js test/unit/streamdock/state.test.js`
Expected: FAIL — `discoverProjects`/`state.js` not found.

- [ ] **Step 4: Implement `state.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/state.js`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// CAP_STATE_DIR override exists so tests can use a temp dir.
function stateDir() { return process.env.CAP_STATE_DIR || join(homedir(), '.cap'); }
export function getStatePath() { return join(stateDir(), 'streamdock-state.json'); }

export function readState() {
  try { return JSON.parse(readFileSync(getStatePath(), 'utf8')); }
  catch { return { activeProject: null }; }
}

export function setActiveProject(path) {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  const next = { ...readState(), activeProject: path };
  writeFileSync(p, JSON.stringify(next, null, 2));
}
```

- [ ] **Step 5: Add `discoverProjects` to `cap.js`**

Append to `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js`:

```js
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// Directories directly under each root that contain .pipeline/config.json.
export function discoverProjects(roots) {
  const out = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(root, e.name);
      if (existsSync(join(p, '.pipeline', 'config.json'))) out.push({ path: p, name: basename(p) });
    }
  }
  return out;
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node --test test/unit/streamdock/cap-discover.test.js test/unit/streamdock/state.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/state.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js \
  test/unit/streamdock/cap-discover.test.js test/unit/streamdock/state.test.js
git commit -m "feat(streamdock): active-project state + pipeline-project discovery"
```

---

### Task 4: Stream Dock API + icons, with a mock-server test

**Files:**
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/icons.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/icons/` (idle.png, running.png, pass.png, fail.png, warn.png, category.png)
- Test: `test/unit/streamdock/sd.test.js`

**Interfaces:**
- Consumes: `ws-client.js` (`connect`).
- Produces:
  - `sd.js`: `class StreamDock { constructor({ port, uuid, registerEvent }); onConnected(cb); on(eventName, cb); setImage(context, dataUri, state?); setTitle(context, title); setState(context, state); connect(); }`. `on` registers a handler keyed by Stream Dock event name (e.g. `'keyDown'`).
  - `icons.js`: `iconDataUri(name: 'idle'|'running'|'pass'|'fail'|'warn'|'category'): string` — cached `data:image/png;base64,…` read from `icons/<name>.png`.

- [ ] **Step 1: Write the failing mock-server test**

`test/unit/streamdock/sd.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { StreamDock } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js';
import { FrameDecoder, encodeTextFrame } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/ws-frame.js';

function startMockServer(onClientText) {
  const server = net.createServer((sock) => {
    const dec = new FrameDecoder();
    let up = false;
    sock.on('data', (chunk) => {
      if (!up) {
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString())[1].trim();
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        up = true; server.emit('ready', sock);
        return;
      }
      for (const m of dec.push(chunk)) onClientText(m, sock);
    });
  });
  return server;
}

test('registers on connect and parses an inbound keyDown', async () => {
  const received = [];
  const server = startMockServer((text) => received.push(JSON.parse(text)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sd = new StreamDock({ port, uuid: 'PLUGIN-UUID', registerEvent: 'registerPlugin' });
  const keyDowns = [];
  sd.on('keyDown', (ev) => keyDowns.push(ev));
  sd.connect();

  // Server pushes a keyDown frame once a client socket is ready.
  const sock = await new Promise((r) => server.once('ready', r));
  sock.write(encodeTextFrame(JSON.stringify({
    event: 'keyDown', action: 'com.cap.streamdock.dispatch', context: 'CTX1', payload: {},
  })));

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received[0], { event: 'registerPlugin', uuid: 'PLUGIN-UUID' });
  assert.equal(keyDowns.length, 1);
  assert.equal(keyDowns[0].context, 'CTX1');
  server.close();
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test test/unit/streamdock/sd.test.js`
Expected: FAIL — `sd.js` not found.

- [ ] **Step 3: Implement `sd.js`**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js`:

```js
import { connect } from './ws-client.js';

export class StreamDock {
  constructor({ port, uuid, registerEvent }) {
    this.port = port; this.uuid = uuid; this.registerEvent = registerEvent;
    this.handlers = new Map();   // eventName → cb
    this.ws = null;
  }
  on(eventName, cb) { this.handlers.set(eventName, cb); }
  onConnected(cb) { this._connectedCb = cb; }

  connect() {
    this.ws = connect({
      port: this.port,
      onOpen: () => {
        this._send({ event: this.registerEvent, uuid: this.uuid });
        this._connectedCb && this._connectedCb();
      },
      onMessage: (text) => {
        let ev; try { ev = JSON.parse(text); } catch { return; }
        const cb = this.handlers.get(ev.event);
        if (cb) cb(ev);
      },
    });
  }
  _send(obj) { this.ws.send(JSON.stringify(obj)); }

  setImage(context, image, state) {
    this._send({ event: 'setImage', context, payload: state == null ? { image } : { image, state } });
  }
  setTitle(context, title) {
    this._send({ event: 'setTitle', context, payload: { title: String(title) } });
  }
  setState(context, state) {
    this._send({ event: 'setState', context, payload: { state } });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/streamdock/sd.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Implement `icons.js` and add placeholder PNGs**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/icons.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const cache = new Map();

export function iconDataUri(name) {
  if (cache.has(name)) return cache.get(name);
  const b64 = readFileSync(join(ICON_DIR, `${name}.png`)).toString('base64');
  const uri = `data:image/png;base64,${b64}`;
  cache.set(name, uri);
  return uri;
}
```

Generate the six 72×72 PNGs (solid-color placeholders now; real art later) — run once:

```bash
ICONS=integrations/streamdock/com.cap.streamdock.sdPlugin/icons
mkdir -p "$ICONS"
python3 - "$ICONS" <<'PY'
import sys, struct, zlib
def png(path, rgb):
    w=h=72; raw=bytearray()
    for _ in range(h):
        raw.append(0)
        raw += bytes(rgb)*w
    def chunk(t,d):
        return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    ihdr=struct.pack('>IIBBBBB',w,h,8,2,0,0,0)
    with open(path,'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',ihdr)+chunk(b'IDAT',zlib.compress(bytes(raw)))+chunk(b'IEND',b''))
d=sys.argv[1]
for name,rgb in {'idle':(40,40,46),'running':(38,90,160),'pass':(40,140,70),
                 'fail':(170,50,50),'warn':(180,140,40),'category':(70,70,80)}.items():
    png(f"{d}/{name}.png", rgb)
print("icons written")
PY
```

- [ ] **Step 6: Commit**

```bash
git add integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/sd.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/icons.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/icons test/unit/streamdock/sd.test.js
git commit -m "feat(streamdock): Stream Dock API + state icons (mock-server tested)"
```

---

### Task 5: Dispatch Agent action + wire the backend entry

**Files:**
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/dispatch.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/dispatch.html`
- Rewrite: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/index.js` (replace Task 1 capture-harness with the real router)

**Interfaces:**
- Consumes: `StreamDock` (sd.js), `dispatch` (cap.js — its `events 'state'` emitter carries the `parseRunLine` intents), `readState` (state.js), `iconDataUri` (icons.js).
- Produces: `registerDispatchAction(sd: StreamDock)` — attaches `willAppear` + `keyDown` handlers for `com.cap.streamdock.dispatch`.

- [ ] **Step 1: Implement the Dispatch Agent action handler**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/dispatch.js`:

```js
import { dispatch } from '../cap.js';
import { readState } from '../state.js';
import { iconDataUri } from '../icons.js';

const UUID = 'com.cap.streamdock.dispatch';
const busy = new Set();   // contexts with an in-flight run

function resolveTarget(settings) {
  if (settings.targetOverride) return settings.targetOverride;
  return readState().activeProject;
}

export function registerDispatchAction(sd) {
  sd.on('willAppear', (ev) => {
    if (ev.action !== UUID) return;
    sd.setImage(ev.context, iconDataUri('idle'), 0);
    sd.setTitle(ev.context, ev.payload?.settings?.agent || 'Dispatch');
  });

  sd.on('keyDown', (ev) => {
    if (ev.action !== UUID) return;
    const ctx = ev.context;
    if (busy.has(ctx)) return;                      // ignore re-press while running
    const settings = ev.payload?.settings || {};
    const agent = settings.agent || 'scanner';
    const prompt = settings.prompt || 'Pick up the top ready ticket and proceed.';
    const target = resolveTarget(settings);
    if (!target) { sd.setImage(ctx, iconDataUri('warn'), 0); sd.setTitle(ctx, 'pick project'); return; }

    busy.add(ctx);
    sd.setImage(ctx, iconDataUri('running'), 1);
    sd.setTitle(ctx, agent);

    const run = dispatch({ agent, prompt, target, mode: settings.mode || 'stream' });
    run.events.on('state', (intent) => {
      if (intent.kind === 'activity') sd.setTitle(ctx, intent.activity.slice(0, 12));
    });
    run.done.then(({ ok }) => {
      busy.delete(ctx);
      sd.setImage(ctx, iconDataUri(ok ? 'pass' : 'fail'), 0);
      sd.setTitle(ctx, ok ? 'done' : 'failed');
      setTimeout(() => { sd.setImage(ctx, iconDataUri('idle'), 0); sd.setTitle(ctx, agent); }, 4000);
    });
  });
}
```

- [ ] **Step 2: Write the property inspector**

`integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/dispatch.html`:

```html
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dispatch Agent</title></head>
<body>
  <label>Agent <input id="agent" placeholder="scanner"></label><br>
  <label>Prompt <input id="prompt" placeholder="Pick up the top ready ticket and proceed."></label><br>
  <label>Target override <input id="targetOverride" placeholder="(blank = active project)"></label><br>
  <label>Mode
    <select id="mode"><option value="stream">stream (live status)</option>
      <option value="detach">detach (fire-and-forget)</option></select></label>
  <script>
    let ws, ctx, settings = {};
    function connectElgatoStreamDeckSocket(port, uuid, event, info, settingsJson) {
      ctx = uuid; ws = new WebSocket('ws://127.0.0.1:' + port);
      ws.onopen = () => ws.send(JSON.stringify({ event, uuid }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.event === 'didReceiveSettings') { settings = m.payload.settings || {}; fill(); }
      };
    }
    function fill() {
      for (const id of ['agent','prompt','targetOverride','mode'])
        if (settings[id] != null) document.getElementById(id).value = settings[id];
    }
    function save() {
      for (const id of ['agent','prompt','targetOverride','mode'])
        settings[id] = document.getElementById(id).value;
      ws.send(JSON.stringify({ event: 'setSettings', context: ctx, payload: settings }));
    }
    document.addEventListener('input', save);
  </script>
</body></html>
```

- [ ] **Step 3: Rewrite `index.js` as the real router**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/index.js`:

```js
import { StreamDock } from './sd.js';
import { registerDispatchAction } from './actions/dispatch.js';
import { registerPickerAction } from './actions/picker.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^-+/, '')] = argv[i + 1];
  return a;
}

const args = parseArgs(process.argv.slice(2));
const sd = new StreamDock({
  port: Number(args.port), uuid: args.pluginUUID, registerEvent: args.registerEvent,
});
registerDispatchAction(sd);
registerPickerAction(sd);
sd.connect();
```

> Picker is imported now but implemented in Task 6. To keep the backend loadable between tasks, create a one-line stub `actions/picker.js` exporting `export function registerPickerAction() {}` and flesh it out in Task 6.

- [ ] **Step 4: Create the picker stub so the backend loads**

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/picker.js`:

```js
export function registerPickerAction() {}
```

- [ ] **Step 5: Smoke-load on device**

```bash
osascript -e 'quit app "VSD Craft"'; sleep 1; open -a "VSD Craft"
```

Assign **Dispatch Agent** to a key, set Agent = `scanner`, set a known pipeline repo as Target override (e.g. `/Users/ryan/Code/TRQ_Berry`), press the key.
Expected: key shows running, then ✅/❌; `claude-agent-pipeline runs --target /Users/ryan/Code/TRQ_Berry` lists the run.

- [ ] **Step 6: Commit**

```bash
git add integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/dispatch.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/picker.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/index.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/dispatch.html
git commit -m "feat(streamdock): Dispatch Agent action + backend router"
```

---

### Task 6: Project Picker action (touch strip) + property inspector

**Files:**
- Rewrite: `integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/picker.js`
- Create: `integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/picker.html`
- Modify: `integrations/streamdock/com.cap.streamdock.sdPlugin/manifest.json` (finalize the strip controller per Task 1 Step 9 observation)

**Interfaces:**
- Consumes: `discoverProjects` (cap.js), `readState`/`setActiveProject` (state.js), `iconDataUri` (icons.js), `StreamDock`.
- Produces: `registerPickerAction(sd: StreamDock)` — attaches `willAppear` + the observed selection events (`dialRotate`/`dialPress`/`touchTap` or HotSpot equivalent) for `com.cap.streamdock.picker`.

- [ ] **Step 1: Implement the picker handler**

Use the **exact event names recorded in Task 1 Step 9**. The code below uses the Elgato-style names; rename to the observed HotSpot names if they differ. Default project roots = `~/Code` (override via PI).

`integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/picker.js`:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../cap.js';
import { readState, setActiveProject } from '../state.js';
import { iconDataUri } from '../icons.js';

const UUID = 'com.cap.streamdock.picker';

export function registerPickerAction(sd) {
  let projects = [];
  let index = 0;
  let ctx = null;

  function roots(settings) {
    return (settings?.roots || join(homedir(), 'Code')).split(',').map((s) => s.trim());
  }
  function render() {
    if (!ctx) return;
    const cur = projects[index];
    sd.setImage(ctx, iconDataUri('category'));
    sd.setTitle(ctx, cur ? cur.name : 'no pipeline');
  }
  function syncIndexToActive() {
    const active = readState().activeProject;
    const i = projects.findIndex((p) => p.path === active);
    if (i >= 0) index = i;
  }

  sd.on('willAppear', (ev) => {
    if (ev.action !== UUID) return;
    ctx = ev.context;
    projects = discoverProjects(roots(ev.payload?.settings));
    syncIndexToActive();
    if (projects[index] && !readState().activeProject) setActiveProject(projects[index].path);
    render();
  });

  // Rotate the dial to move the highlight.
  sd.on('dialRotate', (ev) => {
    if (ev.action !== UUID || !projects.length) return;
    const ticks = ev.payload?.ticks ?? 1;
    index = (index + ticks % projects.length + projects.length) % projects.length;
    render();
  });

  // Press dial OR tap the strip to commit the highlighted project.
  const commit = (ev) => {
    if (ev.action !== UUID || !projects[index]) return;
    setActiveProject(projects[index].path);
    sd.setTitle(ctx, '→ ' + projects[index].name);
    setTimeout(render, 1200);
  };
  sd.on('dialPress', commit);
  sd.on('touchTap', commit);
}
```

- [ ] **Step 2: Write the picker property inspector**

`integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/picker.html`:

```html
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Project Picker</title></head>
<body>
  <label>Project roots (comma-separated)
    <input id="roots" placeholder="~/Code"></label>
  <script>
    let ws, ctx, settings = {};
    function connectElgatoStreamDeckSocket(port, uuid, event) {
      ctx = uuid; ws = new WebSocket('ws://127.0.0.1:' + port);
      ws.onopen = () => ws.send(JSON.stringify({ event, uuid }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.event === 'didReceiveSettings') {
          settings = m.payload.settings || {};
          if (settings.roots) document.getElementById('roots').value = settings.roots;
        }
      };
    }
    document.addEventListener('input', () => {
      settings.roots = document.getElementById('roots').value;
      ws.send(JSON.stringify({ event: 'setSettings', context: ctx, payload: settings }));
    });
  </script>
</body></html>
```

- [ ] **Step 3: Finalize the manifest strip controller**

Edit `manifest.json` — set the `Project Picker` action's controller per the Task 1 observation. If the HotSpot build uses Elgato-style encoders, add to that action:

```json
"Controllers": ["Encoder"],
"Encoder": { "TriggerDescription": { "Rotate": "Switch project", "Push": "Select project" } }
```

If the observation showed the strip only emits a plain key/`touchTap` (no encoder), leave the action key-style and rely on `touchTap` + an adjacent dial key. Record the final choice in `README.md`.

- [ ] **Step 4: Manual — verify the picker on device**

```bash
osascript -e 'quit app "VSD Craft"'; sleep 1; open -a "VSD Craft"
```

Assign **Project Picker** to the touch strip. Rotate the dial → title cycles through your pipeline repos (TRQ_Berry, TRQ_Berry-pipeline, context-manager). Press/tap → `cat ~/.cap/streamdock-state.json` shows the chosen `activeProject`. Then press a Dispatch key with no target override and confirm it dispatches against the selected project.

- [ ] **Step 5: Commit**

```bash
git add integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/actions/picker.js \
  integrations/streamdock/com.cap.streamdock.sdPlugin/property-inspector/picker.html \
  integrations/streamdock/com.cap.streamdock.sdPlugin/manifest.json
git commit -m "feat(streamdock): Project Picker touch-strip action"
```

---

### Task 7: Default profile, installer, docs, and full test run

**Files:**
- Create: `integrations/streamdock/install.sh`
- Create: `integrations/streamdock/README.md`
- Create: `integrations/streamdock/default-profile/` (exported `.sdProfile` from the configured device)

**Interfaces:**
- Consumes: everything above.
- Produces: a one-command dev install and a documented default key map.

- [ ] **Step 1: Write the installer**

`integrations/streamdock/install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")/com.cap.streamdock.sdPlugin" && pwd)"
DST="$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.cap.streamdock.sdPlugin"
mkdir -p "$(dirname "$DST")" "$HOME/.cap"
ln -sfn "$SRC" "$DST"
echo "Linked $DST -> $SRC"
echo "Restart VSD Craft to load the CAP plugin:"
echo "  osascript -e 'quit app \"VSD Craft\"'; sleep 1; open -a 'VSD Craft'"
```

```bash
chmod +x integrations/streamdock/install.sh
```

- [ ] **Step 2: Write the README**

`integrations/streamdock/README.md` must document: prerequisites (`claude-agent-pipeline` on PATH, VSD Craft, a pipeline-enabled repo), `./install.sh`, the default key map (Scan/Worker/Tester/Simplify/Dead-code/CI-triage + touch-strip picker), the **Observed events** table from Task 1 Step 9, and the on-device verification checklist (assign actions, pick a project, press each key, confirm `agent-pipeline runs`).

- [ ] **Step 3: Export the default profile**

After wiring the 6 dispatch keys + picker once in VSD Craft, export the profile (VSD Craft → profile menu → Export) and save the resulting `.sdProfile` bundle into `integrations/streamdock/default-profile/`. Document the import step in the README.

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS — includes `test/unit/streamdock/` (ws-frame, cap-parse, cap-discover, state, sd). Confirm no regressions in pre-existing unit tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/streamdock/install.sh integrations/streamdock/README.md \
  integrations/streamdock/default-profile
git commit -m "feat(streamdock): default profile, installer, and docs"
```

---

## Self-Review

**Spec coverage:**
- Hardware-aware layout (6 agent keys + touch-strip picker) → Tasks 5, 6, 7 (default profile).
- Node 20 `.sdPlugin` backend → Tasks 1, 5 (manifest + index.js).
- Touch strip = project picker, active project = default target → Tasks 3 (state), 6 (picker), 5 (resolveTarget).
- Dispatch via `run --json` + live status (Approach A) → Tasks 2 (wrapper/parser), 5 (rendering).
- Active-project shared state → Task 3.
- Error handling (CLI missing, no pipeline, no project, dispatch fail) → Task 5 (`warn` icon, `pick project`), Task 2 (exit-code fallback). *Gap closed:* "CLI missing" surfaces as a failed run (spawn error → non-zero close → `fail`); README notes PATH requirement.
- Testing (JSONL→state, discovery, mock websocket) → Tasks 1, 2, 3, 4.
- Packaging/install → Task 7.
- Open assumption: touch-strip event names/controller → de-risked by Task 1 Step 9 capture, finalized in Task 6 Step 3.

**Placeholder scan:** No "TBD"/"handle edge cases" left; every code step has complete content. The only deferred specifics (strip controller event names) are explicitly resolved by the Task 1 capture step before they're needed.

**Type consistency:** `parseRunLine` returns `{kind, activity?, ok?}` (Task 2) and is consumed in Task 5 via the `dispatch().events 'state'` emitter. `StreamDock.setImage(context, image, state?)`/`setTitle`/`setState` (Task 4) match all call sites in Tasks 5–6. `discoverProjects(roots)` → `{path, name}[]` (Task 3) matches picker usage (Task 6). `readState()/setActiveProject()` (Task 3) match Tasks 5–6.

## Out of Scope (per spec)

Orchestrator toggle, queue-status keys, dashboard/open keys, Linear backend specifics, and a `claude-agent-pipeline streamdock install` subcommand — rows 2–4 of the grid and page 2 are intentionally left free for these.
