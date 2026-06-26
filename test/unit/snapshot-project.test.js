import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { readSnapshot } from '../../api/index.js';

function tmpTarget() {
  return mkdtempSync(join(tmpdir(), 'cap-proj-'));
}
function writeConfig(target, cfg) {
  mkdirSync(join(target, '.pipeline'), { recursive: true });
  writeFileSync(join(target, '.pipeline', 'config.json'), JSON.stringify(cfg));
}

test('snapshot.project carries the dir name, the configured repo, and the resolved path', () => {
  const target = tmpTarget();
  writeConfig(target, { repo: 'acme/storefront', backend: 'github' });
  const snap = readSnapshot({ target });
  assert.equal(snap.project.name, basename(target));
  assert.equal(snap.project.repo, 'acme/storefront');
  assert.equal(snap.project.path, resolve(target));
  rmSync(target, { recursive: true, force: true });
});

test('snapshot.project.repo is null when no config / no repo set (name still present)', () => {
  const target = tmpTarget();
  const snap = readSnapshot({ target });
  assert.equal(snap.project.repo, null);
  assert.equal(snap.project.name, basename(target));
  rmSync(target, { recursive: true, force: true });
});

test('snapshot.project.repo falls back to null when config.json is malformed', () => {
  const target = tmpTarget();
  mkdirSync(join(target, '.pipeline'), { recursive: true });
  writeFileSync(join(target, '.pipeline', 'config.json'), '{ not valid json');
  const snap = readSnapshot({ target });
  assert.equal(snap.project.repo, null);
  assert.equal(snap.project.name, basename(target));
  rmSync(target, { recursive: true, force: true });
});
