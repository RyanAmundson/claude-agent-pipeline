import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.js');

test('feature command creates an epic in needs-spec', () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-feat-'));
  const out = execFileSync('node', [CLI, 'feature', 'Add dark mode toggle to settings', '--target', target], { encoding: 'utf8' });
  assert.match(out, /EPIC-001/);
  const path = join(target, '.pipeline', 'epics', 'needs-spec', 'EPIC-001.json');
  assert.ok(existsSync(path), 'epic file written');
  const epic = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(epic.id, 'EPIC-001');
  assert.equal(epic.intent, 'Add dark mode toggle to settings');
  assert.equal(epic.title, 'Add dark mode toggle to settings');
  assert.deepEqual(epic.children, []);
  rmSync(target, { recursive: true, force: true });
});

test('a second feature increments the id', () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-feat-'));
  execFileSync('node', [CLI, 'feature', 'first', '--target', target]);
  const out = execFileSync('node', [CLI, 'feature', 'second', '--target', target], { encoding: 'utf8' });
  assert.match(out, /EPIC-002/);
  rmSync(target, { recursive: true, force: true });
});
