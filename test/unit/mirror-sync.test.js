import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapIssueToTicket } from '../../runner/mirror-sync.js';

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
