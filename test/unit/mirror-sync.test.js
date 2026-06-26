import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapIssueToTicket, applyMirror, reconcile } from '../../runner/mirror-sync.js';

const NOW = '2026-06-26T00:00:00.000Z';

test('mapIssueToTicket: extracts state from the pipeline:<state> label', () => {
  const issue = {
    identifier: 'CER-123',
    title: 'fix: silent error in dashboard fetch',
    description: 'details',
    priority: 2,
    url: 'https://linear.app/team/issue/CER-123',
    assignee: { displayName: 'agent:worker' },
    labels: { nodes: [{ name: 'pipeline:needs-work' }, { name: 'smell' }] },
    updatedAt: '2026-06-25T12:00:00.000Z',
  };
  const out = mapIssueToTicket(issue, { namespace: 'pipeline', now: NOW });
  assert.equal(out.state, 'needs-work');
  assert.equal(out.ticket.id, 'CER-123');
  assert.equal(out.ticket.title, 'fix: silent error in dashboard fetch');
  assert.deepEqual(out.ticket.labels, ['pipeline:needs-work', 'smell']);
  assert.equal(out.ticket.claim, 'agent:worker');
  assert.equal(out.ticket.url, 'https://linear.app/team/issue/CER-123');
  assert.equal(out.ticket._syncedAt, NOW);
  assert.equal(out.ticket._source, 'reconcile');
  assert.equal(out.ticket._rev, '2026-06-25T12:00:00.000Z');
});

test('mapIssueToTicket: returns null when no pipeline state label present', () => {
  const issue = { identifier: 'CER-9', title: 'x', labels: { nodes: [{ name: 'smell' }] } };
  assert.equal(mapIssueToTicket(issue, { namespace: 'pipeline', now: NOW }), null);
});

function tmpTarget() { return mkdtempSync(join(tmpdir(), 'mirror-')); }
function qpath(t, state, id) { return join(t, '.pipeline', 'queue', state, `${id}.json`); }

test('applyMirror: creates a ticket file in the right state dir', () => {
  const t = tmpTarget();
  try {
    const entry = { ticket: { id: 'CER-1', title: 'a', _syncedAt: NOW }, state: 'needs-work' };
    const res = applyMirror(t, [entry], { now: NOW });
    assert.equal(res.created, 1);
    assert.ok(existsSync(qpath(t, 'needs-work', 'CER-1')));
    assert.equal(JSON.parse(readFileSync(qpath(t, 'needs-work', 'CER-1'), 'utf8')).id, 'CER-1');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('applyMirror: re-applying identical entry is unchanged (idempotent)', () => {
  const t = tmpTarget();
  try {
    const entry = { ticket: { id: 'CER-1', title: 'a', _syncedAt: NOW }, state: 'needs-work' };
    applyMirror(t, [entry], { now: NOW });
    const res = applyMirror(t, [entry], { now: NOW });
    assert.equal(res.unchanged, 1);
    assert.equal(res.created, 0);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('applyMirror: moves a ticket when its state changed', () => {
  const t = tmpTarget();
  try {
    applyMirror(t, [{ ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' }], { now: NOW });
    const res = applyMirror(t, [{ ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'in-progress' }], { now: NOW });
    assert.equal(res.moved, 1);
    assert.ok(!existsSync(qpath(t, 'needs-work', 'CER-1')));
    assert.ok(existsSync(qpath(t, 'in-progress', 'CER-1')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('reconcile: retires a mirror ticket absent from the fetched set', () => {
  const t = tmpTarget();
  try {
    // seed two tickets via a first reconcile
    reconcile(t, [
      { ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' },
      { ticket: { id: 'CER-2', _syncedAt: NOW }, state: 'in-progress' },
    ], { now: NOW });
    // second fetch only contains CER-1 → CER-2 must be retired
    const res = reconcile(t, [
      { ticket: { id: 'CER-1', _syncedAt: NOW }, state: 'needs-work' },
    ], { now: NOW });
    assert.equal(res.retired, 1);
    assert.ok(existsSync(qpath(t, 'obsolete', 'CER-2')));
    assert.ok(!existsSync(qpath(t, 'in-progress', 'CER-2')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('reconcile: does not touch tickets already in terminal states', () => {
  const t = tmpTarget();
  try {
    mkdirSync(join(t, '.pipeline', 'queue', 'done'), { recursive: true });
    writeFileSync(qpath(t, 'done', 'CER-9'), JSON.stringify({ id: 'CER-9' }, null, 2));
    const res = reconcile(t, [], { now: NOW });
    assert.equal(res.retired, 0);
    assert.ok(existsSync(qpath(t, 'done', 'CER-9')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
