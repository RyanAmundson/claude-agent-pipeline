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
