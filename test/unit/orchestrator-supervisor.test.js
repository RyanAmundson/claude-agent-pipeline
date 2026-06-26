import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisorIteration } from '../../runner/orchestrator-supervisor.js';
import { writeOrchestratorState, readOrchestratorState } from '../../api/orchestrator.js';

function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'ap-sup-'));
  mkdirSync(join(d, '.pipeline', 'runs'), { recursive: true });
  return d;
}
function seedCycle(target, entry) {
  appendFileSync(join(target, '.pipeline', 'runs', 'cycles.jsonl'), JSON.stringify(entry) + '\n');
}

test('iteration exits when state is stopped', async () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'stopped' });
    let dispatched = 0;
    const r = await supervisorIteration({ target: d, dispatchCycle: async () => { dispatched++; }, now: () => 0, sleep: async () => {} });
    assert.equal(r, 'exit');
    assert.equal(dispatched, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('iteration sleeps (no dispatch) when paused', async () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'paused' });
    let dispatched = 0, slept = 0;
    const r = await supervisorIteration({ target: d, dispatchCycle: async () => { dispatched++; }, now: () => 0, sleep: async () => { slept++; } });
    assert.equal(r, 'continue');
    assert.equal(dispatched, 0);
    assert.equal(slept, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('iteration dispatches a cycle when running+due and records cadence from the cycle report', async () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', nextFireAt: null });
    const r = await supervisorIteration({
      target: d,
      // The real cycle appends to cycles.jsonl; the fake does the same.
      dispatchCycle: async (target) => seedCycle(target, { v: 1, cycle: 7, at: '2026-06-13T20:00:00Z', counts: {}, nextCheckSeconds: 1800 }),
      importSources: async () => {},
      now: () => 0,
      sleep: async () => {},
    });
    assert.equal(r, 'continue');
    const st = readOrchestratorState(d);
    assert.equal(st.lastCycleNumber, 7);
    assert.equal(st.lastCycleAt, '2026-06-13T20:00:00Z');
    assert.equal(st.cadence, 'idle');                       // 1800s -> idle tier
    assert.equal(st.nextFireAt, new Date(1_800_000).toISOString()); // now(0) + 1800s
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('iteration imports sources BEFORE dispatching the cycle', async () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', nextFireAt: null });
    const order = [];
    await supervisorIteration({
      target: d,
      importSources: async () => { order.push('import'); },
      dispatchCycle: async (target) => { order.push('dispatch'); seedCycle(target, { v: 1, cycle: 1, at: 'x', counts: {}, nextCheckSeconds: 1800 }); },
      now: () => 0,
      sleep: async () => {},
    });
    assert.deepEqual(order, ['import', 'dispatch']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a failing import-sources does not prevent the cycle (best-effort)', async () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', nextFireAt: null });
    let dispatched = 0;
    const r = await supervisorIteration({
      target: d,
      importSources: async () => { throw new Error('bd exploded'); },
      dispatchCycle: async (target) => { dispatched++; seedCycle(target, { v: 1, cycle: 2, at: 'y', counts: {}, nextCheckSeconds: 1800 }); },
      now: () => 0,
      sleep: async () => {},
    });
    assert.equal(r, 'continue');
    assert.equal(dispatched, 1, 'cycle still dispatched despite import failure');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
