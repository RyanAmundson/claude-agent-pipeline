import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EPIC_STATES, epicsDir, readEpics, getEpic, nextEpicId,
  indexEpics, diffEpicIndexes,
} from '../../api/epics.js';

function tmpTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-epics-'));
  return dir;
}
function writeEpic(target, state, epic) {
  const dir = join(epicsDir(target), state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${epic.id}.json`), JSON.stringify(epic));
}

test('EPIC_STATES is the ordered feature state machine', () => {
  assert.equal(EPIC_STATES[0], 'needs-spec');
  assert.ok(EPIC_STATES.includes('building'));
  assert.ok(EPIC_STATES.includes('ready-for-human'));
  assert.ok(Object.isFrozen(EPIC_STATES));
});

test('readEpics groups epics by state and counts them', () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  writeEpic(target, 'building', { id: 'EPIC-002', title: 'b' });
  const { byState, count } = readEpics({ target });
  assert.equal(count, 2);
  assert.equal(byState['needs-spec'][0].id, 'EPIC-001');
  assert.equal(byState['building'][0].id, 'EPIC-002');
  assert.deepEqual(byState['done'], []);
  rmSync(target, { recursive: true, force: true });
});

test('getEpic finds an epic across states and tags its state', () => {
  const target = tmpTarget();
  writeEpic(target, 'building', { id: 'EPIC-007', title: 'x' });
  const e = getEpic({ target }, 'EPIC-007');
  assert.equal(e.id, 'EPIC-007');
  assert.equal(e.state, 'building');
  assert.equal(getEpic({ target }, 'EPIC-404'), null);
  rmSync(target, { recursive: true, force: true });
});

test('nextEpicId increments past the highest existing id, zero-padded', () => {
  const target = tmpTarget();
  assert.equal(nextEpicId(target), 'EPIC-001');
  writeEpic(target, 'needs-spec', { id: 'EPIC-001' });
  writeEpic(target, 'done', { id: 'EPIC-005' });
  assert.equal(nextEpicId(target), 'EPIC-006');
  rmSync(target, { recursive: true, force: true });
});

test('diffEpicIndexes detects upsert, move, and remove', () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  const a = indexEpics(target);
  // move EPIC-001 to needs-design by re-writing under a new state dir + removing old
  rmSync(join(epicsDir(target), 'needs-spec', 'EPIC-001.json'));
  writeEpic(target, 'needs-design', { id: 'EPIC-001', title: 'a' });
  const b = indexEpics(target);
  const evs = diffEpicIndexes(a, b);
  assert.equal(evs[0].type, 'epic.move');
  assert.equal(evs[0].from, 'needs-spec');
  assert.equal(evs[0].to, 'needs-design');
  rmSync(target, { recursive: true, force: true });
});

test('diffEpicIndexes includes top-level id in epic.upsert for new epic', () => {
  const target = tmpTarget();
  const prev = indexEpics(target);
  // create a new epic
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'new epic' });
  const next = indexEpics(target);
  const evs = diffEpicIndexes(prev, next);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'epic.upsert');
  assert.equal(evs[0].id, 'EPIC-001');
  assert.equal(evs[0].state, 'needs-spec');
  rmSync(target, { recursive: true, force: true });
});

test('diffEpicIndexes detects epic.remove with correct id and state', () => {
  const target = tmpTarget();
  writeEpic(target, 'building', { id: 'EPIC-002', title: 'removable' });
  const prev = indexEpics(target);
  // remove the epic file
  rmSync(join(epicsDir(target), 'building', 'EPIC-002.json'));
  const next = indexEpics(target);
  const evs = diffEpicIndexes(prev, next);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'epic.remove');
  assert.equal(evs[0].id, 'EPIC-002');
  assert.equal(evs[0].state, 'building');
  rmSync(target, { recursive: true, force: true });
});

import { readSnapshot } from '../../api/index.js';
import { createWatcher } from '../../api/index.js';

test('readSnapshot includes an epics block', () => {
  const target = tmpTarget();
  writeEpic(target, 'building', { id: 'EPIC-001', title: 'darkmode' });
  const snap = readSnapshot({ target });
  assert.equal(snap.epics.count, 1);
  assert.equal(snap.epics.byState['building'][0].id, 'EPIC-001');
  assert.ok(Array.isArray(snap.epicStates));
  assert.equal(snap.epicStates[0], 'needs-spec');
  rmSync(target, { recursive: true, force: true });
});

test('createWatcher emits epic.move when an epic changes state', async () => {
  const target = tmpTarget();
  writeEpic(target, 'needs-spec', { id: 'EPIC-001', title: 'a' });
  const w = createWatcher({ target, reconcileMs: 50, debounceMs: 10 });
  const seen = [];
  w.on('event', ev => { if (ev.type?.startsWith('epic.')) seen.push(ev); });
  await new Promise(r => setTimeout(r, 30));
  // move the epic
  const { renameSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(epicsDir(target), 'needs-design'), { recursive: true });
  renameSync(join(epicsDir(target), 'needs-spec', 'EPIC-001.json'),
             join(epicsDir(target), 'needs-design', 'EPIC-001.json'));
  await new Promise(r => setTimeout(r, 150));
  w.close();
  const move = seen.find(e => e.type === 'epic.move');
  assert.ok(move, 'epic.move emitted');
  assert.equal(move.to, 'needs-design');
  rmSync(target, { recursive: true, force: true });
});
