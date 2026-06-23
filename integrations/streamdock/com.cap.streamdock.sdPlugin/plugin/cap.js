import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';

const CLI = 'claude-agent-pipeline';

// Pure: a terminal run event wins; with none, fall back to the process exit code.
export function resolveDone(sawTerminal, terminalOk, exitCode) {
  return { ok: sawTerminal ? terminalOk : exitCode === 0 };
}

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
  let sawTerminal = false;
  rl.on('line', (line) => {
    const intent = parseRunLine(line);
    if (intent.kind === 'done') { ok = intent.ok; sawTerminal = true; }
    if (intent.kind !== 'ignore') events.emit('state', intent);
  });
  const done = new Promise((res) => {
    child.on('close', (code) => res(resolveDone(sawTerminal, ok, code)));
  });
  return { events, kill: () => child.kill('SIGTERM'), done };
}

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
