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

// --- git-derived fallback identity (no .pipeline/config.json) ---

// Build a minimal main checkout: <base>/<repoName>/.git/ with a config that
// declares an origin remote. Returns the checkout dir.
function fakeRepo(base, repoName, originUrl) {
  const root = join(base, repoName);
  const gitDir = join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  const cfg = originUrl
    ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : `[core]\n\trepositoryformatversion = 0\n`;
  writeFileSync(join(gitDir, 'config'), cfg);
  return root;
}

test('project.repo is derived from the git origin remote when no config is present', () => {
  const base = tmpTarget();
  const root = fakeRepo(base, 'storefront', 'https://github.com/acme/storefront.git');
  const snap = readSnapshot({ target: root });
  assert.equal(snap.project.repo, 'acme/storefront');
  assert.equal(snap.project.name, 'storefront');
  rmSync(base, { recursive: true, force: true });
});

test('project.repo derivation handles scp-style git@ origin URLs', () => {
  const base = tmpTarget();
  const root = fakeRepo(base, 'storefront', 'git@github.com:acme/storefront.git');
  const snap = readSnapshot({ target: root });
  assert.equal(snap.project.repo, 'acme/storefront');
  rmSync(base, { recursive: true, force: true });
});

test('an explicit config.repo still wins over the git-derived slug', () => {
  const base = tmpTarget();
  const root = fakeRepo(base, 'storefront', 'https://github.com/acme/storefront.git');
  writeConfig(root, { repo: 'acme/override', backend: 'github' });
  const snap = readSnapshot({ target: root });
  assert.equal(snap.project.repo, 'acme/override');
  rmSync(base, { recursive: true, force: true });
});

test('a git worktree resolves project.name to the main repo, not the worktree dir', () => {
  const base = tmpTarget();
  const root = fakeRepo(base, 'storefront', 'https://github.com/acme/storefront.git');
  // Simulate `git worktree add`: a per-worktree gitdir under the main .git, with
  // a `commondir` pointer back to the shared .git, and a checkout whose `.git`
  // is a file pointing at that per-worktree gitdir.
  const wtGitDir = join(root, '.git', 'worktrees', 'feature-x');
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, 'commondir'), '../..\n');
  const checkout = join(base, 'random-worktree-hash');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, '.git'), `gitdir: ${wtGitDir}\n`);
  const snap = readSnapshot({ target: checkout });
  assert.equal(snap.project.name, 'storefront');
  assert.equal(snap.project.repo, 'acme/storefront');
  rmSync(base, { recursive: true, force: true });
});

test('project.name falls back to the dir basename outside any git repo', () => {
  const target = tmpTarget();
  const snap = readSnapshot({ target });
  assert.equal(snap.project.name, basename(target));
  assert.equal(snap.project.repo, null);
  rmSync(target, { recursive: true, force: true });
});
