import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchDetectors } from '../../runner/detector-match.js';

test('globToRegExp handles **, *, {a,b}, and ?', () => {
  assert.match('src/a/b/c.ts', globToRegExp('src/**/*.ts'));
  assert.match('src/x.tsx', globToRegExp('src/**/*.{ts,tsx}'));
  assert.doesNotMatch('src/x.js', globToRegExp('src/**/*.{ts,tsx}'));
  assert.match('src/x.test.ts', globToRegExp('src/**/*.{test,spec}.{ts,tsx}'));
  assert.doesNotMatch('docs/x.ts', globToRegExp('src/**/*.ts'));
});

const registry = [
  { id: 'unjustified-any', glob: 'src/**/*.{ts,tsx}', prefilterPattern: ':\\s*any\\b', mode: 'both' },
  { id: 'skipped-test', glob: 'src/**/*.{test,spec}.{ts,tsx}', prefilterPattern: '\\.only\\b', mode: 'both' },
  { id: 'unused-export', glob: 'src/**/*.{ts,tsx}', prefilterPattern: 'export\\b', mode: 'sweep' },
];

test('matchDetectors fires only on glob hit AND prefilter hit', () => {
  const files = [
    { path: 'src/foo.ts', content: 'const x: any = 1;' },        // matches unjustified-any
    { path: 'src/foo.test.ts', content: 'it.only("x", () => {})' }, // matches skipped-test (+ glob of any, but no `: any`)
  ];
  const ids = matchDetectors(registry, files).map(d => d.id).sort();
  assert.deepEqual(ids, ['skipped-test', 'unjustified-any']);
});

test('matchDetectors can filter by mode', () => {
  const files = [{ path: 'src/foo.ts', content: 'export const y = 1;' }];
  assert.deepEqual(matchDetectors(registry, files, { mode: 'diff' }).map(d => d.id), []); // unused-export is sweep-only
  assert.deepEqual(matchDetectors(registry, files, { mode: 'sweep' }).map(d => d.id), ['unused-export']);
});
