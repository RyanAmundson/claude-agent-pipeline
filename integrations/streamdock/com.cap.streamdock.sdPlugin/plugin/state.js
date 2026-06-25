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
