// Orchestrator lifecycle state — the durable source of truth for the supervisor.
// Leaf module (mirrors api/cycles.js): zero deps beyond node builtins + api/runs.js.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isProcessAlive } from './runs.js';

export const INITIAL_CADENCE_SECONDS = 270;
export const IDLE_CADENCE_SECONDS = 1800;
export const SUPERVISOR_TICK_MS = 15000;
export const ORCHESTRATOR_CYCLE_PROMPT =
  'Run one orchestrator cycle: scan the pipeline, dispatch agents as needed, then call `agent-pipeline cycle report`.';

export function orchestratorStatePath(target) {
  return join(resolve(target), '.pipeline', 'runs', 'orchestrator.state.json');
}

export function defaultOrchestratorState() {
  return {
    state: 'stopped',
    supervisorPid: null,
    cadence: null,
    lastCycleAt: null,
    lastCycleNumber: null,
    nextFireAt: null,
  };
}

function readRaw(target) {
  try { return JSON.parse(readFileSync(orchestratorStatePath(target), 'utf8')); }
  catch { return null; }
}

/**
 * Current orchestrator status, or null if never started. A non-stopped state
 * whose supervisor pid is dead is reconciled to `stopped` (the supervisor
 * crashed) — read-only; the next write persists the correction.
 */
export function readOrchestratorState(target) {
  const raw = readRaw(target);
  if (!raw) return null;
  if (raw.state !== 'stopped' && raw.supervisorPid && !isProcessAlive(raw.supervisorPid)) {
    return { ...raw, state: 'stopped', supervisorPid: null };
  }
  return raw;
}

/** Read-modify-write merge with an atomic tmp+rename; stamps changedAt. */
export function writeOrchestratorState(target, patch) {
  // Last-write-wins: read→merge→rename is not globally atomic (no file lock).
  // Patches are field-scoped, so a concurrent writer's disjoint fields can be clobbered.
  const dir = join(resolve(target), '.pipeline', 'runs');
  mkdirSync(dir, { recursive: true });
  const current = readRaw(target) || defaultOrchestratorState();
  const next = { ...current, ...patch, changedAt: new Date().toISOString() };
  const final = orchestratorStatePath(target);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, final);
  return next;
}
