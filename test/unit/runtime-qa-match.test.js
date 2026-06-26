import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS } from '../../runner/runtime-qa-members.js';
import { matchMembers } from '../../runner/runtime-qa-match.js';

const ids = (members) => members.map(m => m.id);

test('data member runs on every PR, even with no UI changes', () => {
  const active = matchMembers(MEMBERS, [{ path: 'README.md' }]);
  assert.deepEqual(ids(active), ['data']);
});

test('a changed .tsx screen activates the screen members (+ data)', () => {
  const active = matchMembers(MEMBERS, [{ path: 'src/features/x/[components]/Foo/Foo.tsx' }]);
  assert.deepEqual(
    ids(active).sort(),
    ['a11y', 'data', 'interaction', 'network', 'perf', 'responsive', 'state', 'visual'].sort(),
  );
});

test('an [apis] change activates network + data but not the screen-only members', () => {
  const active = matchMembers(MEMBERS, [{ path: 'src/features/x/[apis]/foo/foo.api.ts' }]);
  assert.deepEqual(ids(active).sort(), ['data', 'network'].sort());
});

test('every member declares an agent and is either path-gated or always-on', () => {
  for (const m of MEMBERS) {
    assert.ok(m.id && m.agent, `member ${JSON.stringify(m)} missing id/agent`);
    assert.ok(m.always === true || (Array.isArray(m.globs) && m.globs.length), `member ${m.id} needs globs or always`);
  }
});
