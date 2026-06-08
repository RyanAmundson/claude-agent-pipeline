// Tails all <target>/.pipeline/runs/logs/<runId>.events.jsonl files and emits
// each new line as `{ runId, ts, type, activity, raw, ... }` to subscribers.
//
// Two surfaces:
//   - snapshot({ limit }) — returns the last N events across all logs (for client replay)
//   - on('event', cb)     — fires for each new line written after creation
//
// No deps. Uses fs.watch on the logs dir + offset tracking per file.

import { EventEmitter } from 'node:events';
import {
  closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch as fsWatch,
} from 'node:fs';
import { join, resolve } from 'node:path';

export function createLogStream(opts) {
  const target = resolve(opts.target);
  const logsDir = join(target, '.pipeline', 'runs', 'logs');
  const emitter = new EventEmitter();
  const offsets = new Map();       // runId -> byte offset already emitted
  let dirWatcher = null;
  let closed = false;

  function tailFile(filename) {
    if (closed) return;
    if (!filename.endsWith('.events.jsonl')) return;
    const runId = filename.replace(/\.events\.jsonl$/, '');
    const path = join(logsDir, filename);
    let size;
    try { size = statSync(path).size; } catch { return; }
    const offset = offsets.get(runId) || 0;
    if (size <= offset) return;
    let fd;
    try { fd = openSync(path, 'r'); } catch { return; }
    const buf = Buffer.alloc(size - offset);
    try { readSync(fd, buf, 0, buf.length, offset); }
    finally { try { closeSync(fd); } catch {} }
    offsets.set(runId, size);
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      emitter.emit('event', { runId, ...ev });
    }
  }

  function init() {
    if (!existsSync(logsDir)) return; // will be created when first run starts
    // Set baselines for existing files — DO NOT emit historical here; replay
    // is served by snapshot() so subscribers control how much history they see.
    for (const f of readdirSync(logsDir)) {
      if (!f.endsWith('.events.jsonl')) continue;
      try { offsets.set(f.replace(/\.events\.jsonl$/, ''), statSync(join(logsDir, f)).size); }
      catch {}
    }
    try {
      dirWatcher = fsWatch(logsDir, { persistent: false }, (_evt, filename) => {
        if (filename) tailFile(filename);
      });
    } catch {}
  }

  // Lazy init — wait briefly for logsDir to appear if it doesn't yet.
  if (existsSync(logsDir)) {
    init();
  } else {
    const pollId = setInterval(() => {
      if (closed) { clearInterval(pollId); return; }
      if (existsSync(logsDir)) { clearInterval(pollId); init(); }
    }, 500);
    pollId.unref?.();
  }

  return {
    on: (...a) => emitter.on(...a),
    off: (...a) => emitter.off(...a),
    snapshot({ limit = 100 } = {}) {
      if (!existsSync(logsDir)) return [];
      const all = [];
      for (const f of readdirSync(logsDir)) {
        if (!f.endsWith('.events.jsonl')) continue;
        const runId = f.replace(/\.events\.jsonl$/, '');
        const path = join(logsDir, f);
        let raw;
        try { raw = readBytes(path, 0); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try { all.push({ runId, ...JSON.parse(line) }); } catch {}
        }
      }
      // Sort by ts (ISO strings sort lexicographically) and keep last N.
      all.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
      return all.slice(-limit);
    },
    close() {
      closed = true;
      try { dirWatcher?.close(); } catch {}
      emitter.removeAllListeners();
    },
  };
}

function readBytes(path, offset) {
  const size = statSync(path).size;
  if (size <= offset) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8');
  } finally {
    try { closeSync(fd); } catch {}
  }
}
