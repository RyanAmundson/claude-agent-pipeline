import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importSources, planIsComplete, planSlug, safeBasename, beadToTicket, planToTicket,
  defaultScanPlans,
} from '../../runner/import-sources.js';

function tmpTarget() {
  return mkdtempSync(join(tmpdir(), 'cap-import-'));
}

test('projects bd-ready beads into needs-work with priority/labels/source', () => {
  const target = tmpTarget();
  const queueDir = join(target, '.pipeline', 'queue');
  const res = importSources({
    target, queueDir, sources: { beads: true },
    readBeads: () => [{ id: 'cm-1', title: 'T1', description: 'd', priority: 1, issue_type: 'bug' }],
    scanPlans: () => [],
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(res.created, ['bead:cm-1']);
  const file = join(queueDir, 'needs-work', 'bead_cm-1.json');
  assert.ok(existsSync(file), 'ticket file written under sanitized basename');
  const t = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(t.id, 'bead:cm-1', 'JSON id is canonical (matches CM join key)');
  assert.equal(t.title, 'T1');
  assert.equal(t.priority, 1);
  assert.deepEqual(t.labels, ['source:beads']);
  assert.equal(t.source.type, 'beads');
  assert.equal(t.source.beadId, 'cm-1');
  assert.equal(t.created_at, '2026-01-01T00:00:00.000Z');
  rmSync(target, { recursive: true, force: true });
});

test('projects an incomplete plan and skips a complete one', () => {
  const target = tmpTarget();
  const queueDir = join(target, '.pipeline', 'queue');
  const res = importSources({
    target, queueDir, sources: { plans: ['.plans'] },
    readBeads: () => [],
    scanPlans: () => [
      { relativePath: '.plans/open.md', path: '/abs/open.md', title: 'Open', complete: false },
      { relativePath: '.plans/done.md', path: '/abs/done.md', title: 'Done', complete: true },
    ],
    now: () => 'now',
  });
  assert.deepEqual(res.created, ['plan:.plans/open.md']);
  assert.ok(existsSync(join(queueDir, 'needs-work', 'plan_.plans_open.md.json')), 'incomplete plan projected');
  assert.ok(!existsSync(join(queueDir, 'needs-work', 'plan_.plans_done.md.json')), 'complete plan skipped');
  const t = JSON.parse(readFileSync(join(queueDir, 'needs-work', 'plan_.plans_open.md.json'), 'utf8'));
  assert.equal(t.id, 'plan:.plans/open.md', 'plan JSON id is plan:<relativePath> verbatim');
  assert.deepEqual(t.labels, ['source:plans']);
  rmSync(target, { recursive: true, force: true });
});

test('is idempotent: an id already present in any state is skipped (not resurrected)', () => {
  const target = tmpTarget();
  const queueDir = join(target, '.pipeline', 'queue');
  mkdirSync(join(queueDir, 'in-progress'), { recursive: true });
  writeFileSync(join(queueDir, 'in-progress', 'bead_cm-1.json'), JSON.stringify({ id: 'bead:cm-1' }));
  const res = importSources({
    target, queueDir, sources: { beads: true },
    readBeads: () => [{ id: 'cm-1', title: 'T', priority: 2 }],
    scanPlans: () => [],
  });
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.skipped, ['bead:cm-1']);
  assert.ok(!existsSync(join(queueDir, 'needs-work', 'bead_cm-1.json')), 'not re-created in needs-work');
  rmSync(target, { recursive: true, force: true });
});

test('--only projects just the named id', () => {
  const target = tmpTarget();
  const queueDir = join(target, '.pipeline', 'queue');
  const res = importSources({
    target, queueDir, sources: { beads: true }, only: 'bead:b',
    readBeads: () => [{ id: 'a', title: 'A', priority: 2 }, { id: 'b', title: 'B', priority: 2 }],
    scanPlans: () => [],
  });
  assert.deepEqual(res.created, ['bead:b']);
  assert.ok(existsSync(join(queueDir, 'needs-work', 'bead_b.json')));
  assert.ok(!existsSync(join(queueDir, 'needs-work', 'bead_a.json')));
  rmSync(target, { recursive: true, force: true });
});

test('planIsComplete: all-checked is complete; any-unchecked or no-boxes is incomplete', () => {
  assert.equal(planIsComplete('- [ ] a\n- [x] b'), false);
  assert.equal(planIsComplete('- [x] a\n- [X] b'), true);
  assert.equal(planIsComplete('# Plan\n\nNo checkboxes here, just prose.'), false);
});

test('safeBasename flattens path separators and colons; planSlug is stable+safe', () => {
  assert.equal(safeBasename('bead:cm-1'), 'bead_cm-1');
  assert.equal(safeBasename('plan:.plans/foo.md'), 'plan_.plans_foo.md');
  // planSlug is a filesystem-safe display slug (not the join id) — stable across calls.
  assert.equal(planSlug('.plans/2026-Foo Bar.md'), planSlug('.plans/2026-Foo Bar.md'));
  assert.match(planSlug('.plans/2026-Foo Bar.md'), /^[a-z0-9-]+$/);
});

test('defaultScanPlans produces CM-matching relativePath, title, and completeness over a real dir', () => {
  const target = tmpTarget();
  mkdirSync(join(target, '.plans'), { recursive: true });
  writeFileSync(join(target, '.plans', 'open.md'), '# Open Plan\n\n- [ ] todo\n');
  writeFileSync(join(target, '.plans', 'done.md'), '# Done Plan\n\n- [x] finished\n');
  writeFileSync(join(target, '.plans', 'notes.txt'), 'ignored — not markdown');

  const plans = defaultScanPlans(['.plans'], target).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  assert.equal(plans.length, 2, 'only .md files scanned');
  const open = plans.find((p) => p.relativePath === '.plans/open.md');
  // relativePath is the load-bearing join key — must be `${dirRel}/${filename}` verbatim.
  assert.ok(open, 'relativePath uses the configured dir string verbatim');
  assert.equal(open.title, 'Open Plan', 'title from first heading');
  assert.equal(open.complete, false);
  assert.equal(planToTicket(open, 'NOW').id, 'plan:.plans/open.md', 'feeds the canonical CM join id');
  const done = plans.find((p) => p.relativePath === '.plans/done.md');
  assert.equal(done.complete, true, 'all-checked plan is complete (→ skipped by importSources)');
  rmSync(target, { recursive: true, force: true });
});

test('beadToTicket/planToTicket build the documented shape', () => {
  const bt = beadToTicket({ id: 'x', title: 'X', description: 'dd', priority: 0, issue_type: 'feature' }, 'NOW');
  assert.equal(bt.id, 'bead:x');
  assert.equal(bt.priority, 0);
  assert.equal(bt.source.issueType, 'feature');
  const pt = planToTicket({ relativePath: 'a/b.md', path: '/p/a/b.md', title: 'AB' }, 'NOW');
  assert.equal(pt.id, 'plan:a/b.md');
  assert.equal(pt.source.type, 'plans');
  assert.equal(pt.updated_at, 'NOW');
});
