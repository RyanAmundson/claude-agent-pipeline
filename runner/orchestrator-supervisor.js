// Orchestrator supervisor loop. Owns the cadence the /loop session used to:
// each tick it reads the persisted state, dispatches one orchestrator cycle
// when running-and-due, and honors pause/stop. Cycle dispatch + clock + sleep
// are injected so the loop is unit-testable without spawning claude.
import { readCycleTail } from '../api/cycles.js';
import {
  readOrchestratorState, writeOrchestratorState, nextSupervisorStep,
  cadenceForSeconds, nextFireAtFrom, ORCHESTRATOR_CYCLE_PROMPT,
} from '../api/orchestrator.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Default cycle dispatcher: run one orchestrator agent cycle and wait for it.
 * The orchestrator agent appends its own line to cycles.jsonl near the end of
 * its run, so awaiting completion is sufficient — we read the tail afterward.
 * Test seam: AP_ORCHESTRATOR_CYCLE_FAKE=1 appends a synthetic cycle instead of
 * spawning claude, so e2e can exercise the real spawn/state/watcher lifecycle
 * deterministically (mirrors how 08-cycle-report.sh stays claude-free).
 */
async function defaultDispatchCycle(target) {
  if (process.env.AP_ORCHESTRATOR_CYCLE_FAKE) {
    const { appendCycle, buildCycleEntry, readCycleTail: tail } = await import('../api/cycles.js');
    const prev = tail(target, 1).entries[0] ?? null;
    appendCycle(target, buildCycleEntry(
      { nextCheckSeconds: Number(process.env.AP_ORCHESTRATOR_CYCLE_FAKE) || 1800, notes: ['fake cycle'] },
      prev, { backend: 'filesystem' },
    ));
    return;
  }
  const { dispatch } = await import('./dispatch.js');
  const handle = dispatch({ agent: 'orchestrator', prompt: ORCHESTRATOR_CYCLE_PROMPT, target });
  handle.events.on('event', () => {});
  handle.events.on('error', () => {});
  await handle.result;
}

/**
 * Default pre-cycle source import: project bd-ready beads + incomplete plans into
 * the queue (opt-in via config) so newly-ready work is routed this cycle. Any
 * throw propagates to supervisorIteration, which guards it best-effort so the
 * cycle still runs.
 */
async function defaultImportSources(target) {
  const { importSourcesFromConfig } = await import('./import-sources.js');
  importSourcesFromConfig(target);
}

/**
 * One supervisor tick. All deps are required (no defaults at this layer —
 * runOrchestratorSupervisor supplies them).
 * @param {{ target: string, dispatchCycle: (target:string)=>Promise<void>, now: ()=>number, sleep: (ms:number)=>Promise<void> }} deps
 * @returns {Promise<'continue'|'exit'>}
 */
export async function supervisorIteration({ target, dispatchCycle, importSources, now, sleep }) {
  const state = readOrchestratorState(target);
  const step = nextSupervisorStep(state, now());
  if (step.action === 'exit') return 'exit';
  if (step.action === 'sleep') { await sleep(step.delayMs); return 'continue'; }
  // Sync the queue from external sources (beads/plans) before dispatch, so work
  // that just became ready is routed this cycle. Best-effort: a failure here must
  // never break the cycle — the orchestrator can still run on the existing queue.
  try {
    await importSources(target);
  } catch (err) {
    console.warn(`orchestrator: pre-cycle import-sources failed (${err.message}); continuing with the existing queue`);
  }
  // dispatch
  await dispatchCycle(target);
  const latest = readCycleTail(target, 1).entries[0] ?? null;
  const secs = latest?.nextCheckSeconds;
  writeOrchestratorState(target, {
    cadence: cadenceForSeconds(secs),
    lastCycleAt: latest?.at ?? null,
    lastCycleNumber: Number.isInteger(latest?.cycle) ? latest.cycle : null,
    nextFireAt: nextFireAtFrom(secs, now()),
  });
  return 'continue';
}

/** Loop supervisorIteration until it exits. Records this process as the supervisor pid. */
export async function runOrchestratorSupervisor({
  target, dispatchCycle = defaultDispatchCycle, importSources = defaultImportSources,
  now = () => Date.now(), sleep = realSleep,
} = {}) {
  writeOrchestratorState(target, { supervisorPid: process.pid });
  let stop = false;
  // Graceful: stop is checked at the tick boundary, so a SIGTERM during an
  // in-flight cycle takes effect after that cycle finishes (avoids orphaning a
  // running claude). Killing a specific in-flight run is a separate concern (runs kill / dispatch.kill).
  process.on('SIGTERM', () => { stop = true; });
  // Crash-only: a thrown cycle (e.g. ENOSPC on appendCycle) lets the supervisor
  // die; the dead pid is reconciled to 'stopped' by readOrchestratorState. A
  // merely *failed* claude run does NOT throw (dispatch resolves failed), so the loop continues.
  while (!stop) {
    const r = await supervisorIteration({ target, dispatchCycle, importSources, now, sleep });
    if (r === 'exit') break;
  }
  process.exit(0);
}
