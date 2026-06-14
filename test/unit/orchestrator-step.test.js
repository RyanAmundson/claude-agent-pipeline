import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSupervisorStep, cadenceForSeconds, nextFireAtFrom, SUPERVISOR_TICK_MS, INITIAL_CADENCE_SECONDS, IDLE_CADENCE_SECONDS,
} from '../../api/orchestrator.js';

const NOW = 1_000_000_000_000; // fixed clock

test('stopped (or null) state exits the loop', () => {
  assert.deepEqual(nextSupervisorStep(null, NOW), { action: 'exit' });
  assert.deepEqual(nextSupervisorStep({ state: 'stopped' }, NOW), { action: 'exit' });
});

test('paused state sleeps one tick', () => {
  assert.deepEqual(nextSupervisorStep({ state: 'paused' }, NOW), { action: 'sleep', delayMs: SUPERVISOR_TICK_MS });
});

test('running with no nextFireAt dispatches immediately', () => {
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: null }, NOW), { action: 'dispatch' });
});

test('running past nextFireAt dispatches', () => {
  const past = new Date(NOW - 1000).toISOString();
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: past }, NOW), { action: 'dispatch' });
});

test('running before nextFireAt sleeps until the sooner of tick or fire time', () => {
  const soon = new Date(NOW + 5000).toISOString();       // 5s out, < tick
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: soon }, NOW), { action: 'sleep', delayMs: 5000 });
  const far = new Date(NOW + 9_000_000).toISOString();   // far out, > tick
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: far }, NOW), { action: 'sleep', delayMs: SUPERVISOR_TICK_MS });
});

test('running dispatches at exactly fire time and on an unparseable nextFireAt', () => {
  const exact = new Date(NOW).toISOString();
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: exact }, NOW), { action: 'dispatch' });
  assert.deepEqual(nextSupervisorStep({ state: 'running', nextFireAt: 'not-a-date' }, NOW), { action: 'dispatch' });
});

test('cadenceForSeconds tiers initial vs idle', () => {
  assert.equal(cadenceForSeconds(INITIAL_CADENCE_SECONDS), 'initial');
  assert.equal(cadenceForSeconds(IDLE_CADENCE_SECONDS), 'idle');
  assert.equal(cadenceForSeconds(undefined), 'initial');
});

test('nextFireAtFrom adds seconds to now as ISO', () => {
  assert.equal(nextFireAtFrom(600, NOW), new Date(NOW + 600_000).toISOString());
  assert.equal(nextFireAtFrom(undefined, NOW), new Date(NOW + INITIAL_CADENCE_SECONDS * 1000).toISOString());
});
