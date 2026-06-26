// claude-agent-pipeline — `ui --watch`: live-reload supervisor.
//
// Runs the UI server as a child process and restarts it when watched source
// changes. The browser auto-reloads via the per-process bootId the server
// advertises on /api/v1/events (see ui/server.js + ui/public/app.js), so a
// restart transparently re-serves fresh assets. Zero runtime dependencies —
// Node stdlib only.

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

// The directories the UI server actually loads at runtime: the public api/
// surface it imports and its own ui/ tree (server + static assets). Changes
// elsewhere (agents, rules, docs, tests) don't affect a running dashboard.
export const WATCH_DIRS = ['api', 'ui'];

const SOURCE_RE = /\.(js|html|css|json|svg)$/;

/**
 * Pure: should a changed path (relative to the package root) restart the server?
 * @param {string} relPath
 * @returns {boolean}
 */
export function shouldRestart(relPath) {
  if (!relPath) return false;
  const p = String(relPath).replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  // Editor scratch + dotfiles never count.
  if (base.startsWith('.')) return false;
  if (base.endsWith('~')) return false;
  if (!WATCH_DIRS.some(d => p === d || p.startsWith(d + '/'))) return false;
  return SOURCE_RE.test(base);
}

/**
 * Start the UI server under a restart-on-change supervisor.
 *
 * @param {{ root: string, entry: string, env: Record<string,string>,
 *           debounceMs?: number, onRestart?: (paths: string[]) => void,
 *           log?: (msg: string) => void }} opts
 * @returns {{ close: () => void }}
 */
export function startWatchServer(opts) {
  const { root, entry, env, debounceMs = 120, onRestart, log = () => {} } = opts;

  let child = null;
  let restarting = false;   // a kill is in flight; spawn again on exit
  let stopped = false;
  let timer = null;
  let pending = new Set();

  const spawnChild = () => {
    if (stopped) return;
    child = spawn(process.execPath, [entry], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', () => {
      child = null;
      // If we asked it to die for a restart, bring the next one up now that the
      // port is released. Otherwise the server crashed/exited on its own.
      if (restarting && !stopped) {
        restarting = false;
        spawnChild();
      }
    });
  };

  const restart = () => {
    const paths = [...pending];
    pending = new Set();
    onRestart?.(paths);
    if (child && !restarting) {
      restarting = true;
      child.kill('SIGTERM');   // exit handler respawns once the port frees
    } else if (!child && !restarting) {
      spawnChild();
    }
  };

  const onChange = (relPath) => {
    if (!shouldRestart(relPath)) return;
    pending.add(relPath);
    clearTimeout(timer);
    timer = setTimeout(restart, debounceMs);
  };

  const watchers = WATCH_DIRS.map(dir => {
    try {
      const w = watch(join(root, dir), { recursive: true }, (_event, filename) => {
        if (filename) onChange(join(dir, filename));
      });
      w.on('error', err => log(`watch error in ${dir}/: ${err.message}`));
      return w;
    } catch (err) {
      log(`could not watch ${dir}/: ${err.message}`);
      return null;
    }
  }).filter(Boolean);

  spawnChild();

  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      for (const w of watchers) { try { w.close(); } catch {} }
      if (child) { try { child.kill('SIGTERM'); } catch {} }
    },
  };
}
