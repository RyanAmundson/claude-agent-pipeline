import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.js');

function setupTarget({ sources }) {
  const target = mkdtempSync(join(tmpdir(), 'cap-import-cli-'));
  mkdirSync(join(target, '.pipeline'), { recursive: true });
  writeFileSync(join(target, '.pipeline', 'config.json'), JSON.stringify({
    repo: 'o/r', ghUser: 'u', backend: 'filesystem',
    filesystem: { queueDir: '.pipeline/queue' }, sources,
  }));
  return target;
}

test('import-sources projects an incomplete plan into needs-work (end-to-end)', () => {
  const target = setupTarget({ sources: { plans: ['.plans'] } });
  mkdirSync(join(target, '.plans'), { recursive: true });
  writeFileSync(join(target, '.plans', 'foo.md'), '# Foo plan\n\n- [ ] do the thing\n');

  const out = execFileSync('node', [CLI, 'import-sources', '--target', target], { encoding: 'utf8' });
  assert.match(out, /created 1, skipped 0/);
  assert.match(out, /\+ plan:\.plans\/foo\.md/);
  const file = join(target, '.pipeline', 'queue', 'needs-work', 'plan_.plans_foo.md.json');
  assert.ok(existsSync(file), 'ticket file written');
  const t = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(t.id, 'plan:.plans/foo.md');
  assert.equal(t.title, 'Foo plan');

  // Second run is idempotent.
  const out2 = execFileSync('node', [CLI, 'import-sources', '--target', target], { encoding: 'utf8' });
  assert.match(out2, /created 0, skipped 1/);
  rmSync(target, { recursive: true, force: true });
});

test('import-sources is a no-op with a hint when no sources are configured', () => {
  const target = setupTarget({ sources: undefined });
  const out = execFileSync('node', [CLI, 'import-sources', '--target', target], { encoding: 'utf8' });
  assert.match(out, /no sources configured/);
  assert.ok(!existsSync(join(target, '.pipeline', 'queue', 'needs-work')), 'no tickets written');
  rmSync(target, { recursive: true, force: true });
});

test('import-sources --json emits the result object', () => {
  const target = setupTarget({ sources: { plans: ['.plans'] } });
  mkdirSync(join(target, '.plans'), { recursive: true });
  writeFileSync(join(target, '.plans', 'bar.md'), '# Bar\n\n- [ ] x\n');
  const out = execFileSync('node', [CLI, 'import-sources', '--target', target, '--json'], { encoding: 'utf8' });
  const res = JSON.parse(out);
  assert.deepEqual(res.created, ['plan:.plans/bar.md']);
  assert.deepEqual(res.skipped, []);
  rmSync(target, { recursive: true, force: true });
});
