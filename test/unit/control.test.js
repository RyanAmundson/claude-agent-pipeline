import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRun } from '../../api/runs.js';
import { readOrchestratorState, writeOrchestratorState } from '../../api/orchestrator.js';
import {
  startOrchestrator, stopOrchestrator, killAllRuns, hardReset,
} from '../../api/control.js';

function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'ap-control-'));
  mkdirSync(join(d, '.pipeline', 'runs'), { recursive: true });
  return d;
}

function seedRun(target, runId, { pid, agent = 'implementer' } = {}) {
  writeRun(target, {
    runId, agent, pid, status: 'active', startedAt: new Date().toISOString(),
  });
}

// Note: readOrchestratorState reconciles a dead supervisor pid to 'stopped'
// using the real isProcessAlive — so anywhere a supervisor must read back as
// live we use process.pid (the test runner itself, guaranteed alive). Injected
// kill spies prevent it from actually receiving a signal.

test('startOrchestrator detaches a supervisor and records its pid when none is alive', () => {
  const d = workdir();
  try {
    const calls = [];
    const r = startOrchestrator(d, {
      detach: (t) => { calls.push(t); return process.pid; },
      isAlive: () => false,
      now: () => '2026-06-26T00:00:00.000Z',
    });
    assert.equal(r.started, true);
    assert.equal(r.alreadyRunning, false);
    assert.equal(r.supervisorPid, process.pid);
    assert.deepEqual(calls, [d], 'detach called once with the target');
    const st = readOrchestratorState(d);
    assert.equal(st.state, 'running');
    assert.equal(st.supervisorPid, process.pid);
    assert.equal(st.cadence, 'initial');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('startOrchestrator is a no-op when a supervisor is already alive', () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', supervisorPid: process.pid });
    let detached = false;
    const r = startOrchestrator(d, { detach: () => { detached = true; return 1; }, isAlive: () => true });
    assert.equal(r.started, false);
    assert.equal(r.alreadyRunning, true);
    assert.equal(r.supervisorPid, process.pid);
    assert.equal(detached, false, 'detach not called when already running');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('killAllRuns SIGTERMs every active run with a pid and skips those without', () => {
  const d = workdir();
  try {
    seedRun(d, 'run-a', { pid: 1001 });
    seedRun(d, 'run-b', { pid: 1002 });
    seedRun(d, 'run-c', {}); // no pid → skipped
    const signaled = [];
    const r = killAllRuns(d, { kill: (pid, sig) => signaled.push([pid, sig]) });
    assert.deepEqual(signaled.map(([p]) => p).sort(), [1001, 1002]);
    assert.ok(signaled.every(([, sig]) => sig === 'SIGTERM'));
    assert.equal(r.killed.length, 2);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].runId, 'run-c');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('killAllRuns records a failure when kill throws', () => {
  const d = workdir();
  try {
    seedRun(d, 'run-x', { pid: 2001 });
    const r = killAllRuns(d, { kill: () => { throw new Error('ESRCH'); } });
    assert.equal(r.killed.length, 0);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].runId, 'run-x');
    assert.match(r.failed[0].error, /ESRCH/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('stopOrchestrator marks stopped and SIGTERMs the live supervisor', () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', supervisorPid: process.pid, nextFireAt: '2026-06-26T00:00:00.000Z' });
    const signaled = [];
    const r = stopOrchestrator(d, { kill: (pid, sig) => signaled.push([pid, sig]), isAlive: () => true });
    assert.equal(r.supervisorKilled, true);
    assert.deepEqual(signaled, [[process.pid, 'SIGTERM']]);
    const st = readOrchestratorState(d);
    assert.equal(st.state, 'stopped');
    assert.equal(st.supervisorPid, null);
    assert.equal(st.nextFireAt, null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('hardReset stops the orchestrator and kills every active run', () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running', supervisorPid: process.pid });
    seedRun(d, 'run-1', { pid: 3001 });
    seedRun(d, 'run-2', { pid: 3002 });
    const signaled = [];
    const r = hardReset(d, { kill: (pid, sig) => signaled.push(pid), isAlive: () => true });
    assert.equal(r.orchestrator.supervisorKilled, true);
    assert.equal(r.runs.killed.length, 2);
    // Supervisor + both runs all received a signal.
    assert.deepEqual(signaled.sort((a, b) => a - b), [3001, 3002, process.pid].sort((a, b) => a - b));
    assert.equal(readOrchestratorState(d).state, 'stopped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
