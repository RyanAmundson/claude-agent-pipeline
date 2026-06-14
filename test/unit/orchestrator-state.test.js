import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  orchestratorStatePath, readOrchestratorState, writeOrchestratorState, defaultOrchestratorState,
} from '../../api/orchestrator.js';

function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'ap-orch-'));
  mkdirSync(join(d, '.pipeline', 'runs'), { recursive: true });
  return d;
}

test('orchestratorStatePath points at .pipeline/runs/orchestrator.state.json', () => {
  assert.equal(
    orchestratorStatePath('/tmp/x'),
    join('/tmp/x', '.pipeline', 'runs', 'orchestrator.state.json'),
  );
});

test('readOrchestratorState returns null when the file is missing', () => {
  const d = workdir();
  try { assert.equal(readOrchestratorState(d), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('writeOrchestratorState merges a patch, stamps changedAt, and is read back', () => {
  const d = workdir();
  try {
    const written = writeOrchestratorState(d, { state: 'running', supervisorPid: process.pid, cadence: 'initial' });
    assert.equal(written.state, 'running');
    assert.equal(written.supervisorPid, process.pid);
    assert.equal(written.cadence, 'initial');
    assert.match(written.changedAt, /^\d{4}-\d{2}-\d{2}T/);
    // A second patch preserves prior fields it doesn't mention.
    const merged = writeOrchestratorState(d, { state: 'paused' });
    assert.equal(merged.state, 'paused');
    assert.equal(merged.supervisorPid, process.pid, 'supervisorPid preserved across a state-only patch');
    assert.deepEqual(readOrchestratorState(d), merged);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readOrchestratorState reconciles a dead supervisor pid to stopped', () => {
  const d = workdir();
  try {
    // A pid that is essentially never alive.
    writeFileSync(orchestratorStatePath(d), JSON.stringify({
      ...defaultOrchestratorState(), state: 'running', supervisorPid: 2147483646, changedAt: new Date().toISOString(),
    }));
    const st = readOrchestratorState(d);
    assert.equal(st.state, 'stopped', 'running + dead pid reconciles to stopped');
    assert.equal(st.supervisorPid, null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('writeOrchestratorState writes atomically (no .tmp left behind)', () => {
  const d = workdir();
  try {
    writeOrchestratorState(d, { state: 'running' });
    assert.equal(existsSync(orchestratorStatePath(d) + '.tmp'), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
