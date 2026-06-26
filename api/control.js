// Control plane: actions that change pipeline runtime state (start the
// orchestrator supervisor, kill in-flight agent runs, hard-reset everything).
// Extracted here so the CLI and the UI server drive identical behavior — the
// CLI's `orchestrator start/stop` and the dashboard's buttons call the same
// functions. Process spawning and signaling are injectable so this is unit
// testable without spawning claude or signaling real pids.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readOrchestratorState, writeOrchestratorState } from './orchestrator.js';
import { listRuns, isProcessAlive } from './runs.js';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

/**
 * Spawn a detached orchestrator supervisor that outlives this process. Mirrors
 * the CLI's detach: it re-enters bin/cli.js with the internal supervise verb.
 * @returns {number} the supervisor pid
 */
export function detachOrchestratorSupervisor(target) {
  const t = resolve(target);
  const child = spawn(
    process.execPath,
    [CLI_PATH, '_orchestrate-supervise', '--target', t],
    { detached: true, stdio: 'ignore', cwd: t, env: process.env },
  );
  child.unref();
  return child.pid;
}

/**
 * Start the orchestrator supervisor if one isn't already alive. Marks state
 * running + due-now before detaching so the first tick dispatches immediately.
 * @returns {{ started: boolean, alreadyRunning: boolean, supervisorPid: number|null }}
 */
export function startOrchestrator(target, {
  detach = detachOrchestratorSupervisor,
  isAlive = isProcessAlive,
  now = () => new Date().toISOString(),
} = {}) {
  const cur = readOrchestratorState(target);
  if (cur?.supervisorPid && isAlive(cur.supervisorPid)) {
    return { started: false, alreadyRunning: true, supervisorPid: cur.supervisorPid };
  }
  writeOrchestratorState(target, { state: 'running', cadence: 'initial', nextFireAt: now() });
  const pid = detach(target);
  writeOrchestratorState(target, { supervisorPid: pid });
  return { started: true, alreadyRunning: false, supervisorPid: pid };
}

/**
 * Stop the orchestrator supervisor: mark stopped and SIGTERM its pid so it does
 * not dispatch new cycles. Leaves already-dispatched agent runs alone — see
 * killAllRuns for those.
 * @returns {{ supervisorPid: number|null, supervisorKilled: boolean }}
 */
export function stopOrchestrator(target, {
  kill = (pid, sig) => process.kill(pid, sig),
  isAlive = isProcessAlive,
} = {}) {
  const cur = readOrchestratorState(target);
  writeOrchestratorState(target, { state: 'stopped', nextFireAt: null, supervisorPid: null });
  let supervisorKilled = false;
  if (cur?.supervisorPid && isAlive(cur.supervisorPid)) {
    try { kill(cur.supervisorPid, 'SIGTERM'); supervisorKilled = true; } catch {}
  }
  return { supervisorPid: cur?.supervisorPid ?? null, supervisorKilled };
}

/**
 * SIGTERM every active agent run that has a recorded pid. Does not touch the
 * orchestrator supervisor. Runs without a pid (mid-spawn) are skipped — they get
 * reaped once their parent dies.
 * @returns {{ killed: Array, failed: Array, skipped: Array }}
 */
export function killAllRuns(target, {
  kill = (pid, sig) => process.kill(pid, sig),
  signal = 'SIGTERM',
} = {}) {
  const killed = [];
  const failed = [];
  const skipped = [];
  for (const r of listRuns({ target }).active) {
    if (!r.pid) { skipped.push({ runId: r.runId, reason: 'no pid' }); continue; }
    try {
      kill(r.pid, signal);
      killed.push({ runId: r.runId, pid: r.pid, agent: r.agent });
    } catch (err) {
      failed.push({ runId: r.runId, pid: r.pid, error: String(err?.message || err) });
    }
  }
  return { killed, failed, skipped };
}

/**
 * Hard reset: stop the orchestrator (so nothing re-dispatches) and kill every
 * in-flight agent run. The order matters — stop the supervisor first so it can't
 * spawn a replacement run between the kill sweep and your next look.
 */
export function hardReset(target, deps = {}) {
  const orchestrator = stopOrchestrator(target, deps);
  const runs = killAllRuns(target, deps);
  return { orchestrator, runs };
}
