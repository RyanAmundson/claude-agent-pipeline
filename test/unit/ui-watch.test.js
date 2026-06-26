import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRestart, WATCH_DIRS } from '../../ui/watch.js';

test('WATCH_DIRS covers the code the UI server loads', () => {
  assert.ok(WATCH_DIRS.includes('api'));
  assert.ok(WATCH_DIRS.includes('ui'));
});

test('shouldRestart fires for server + client source under watched dirs', () => {
  assert.equal(shouldRestart('api/index.js'), true);
  assert.equal(shouldRestart('ui/server.js'), true);
  assert.equal(shouldRestart('ui/public/app.js'), true);
  assert.equal(shouldRestart('ui/public/style.css'), true);
  assert.equal(shouldRestart('ui/public/index.html'), true);
});

test('shouldRestart ignores paths outside watched dirs', () => {
  assert.equal(shouldRestart('README.md'), false);
  assert.equal(shouldRestart('test/unit/x.test.js'), false);
  assert.equal(shouldRestart('agents/foo.md'), false);
  assert.equal(shouldRestart('package.json'), false);
});

test('shouldRestart ignores non-source and editor scratch files', () => {
  assert.equal(shouldRestart('ui/public/README.md'), false);
  assert.equal(shouldRestart('ui/public/.app.js.swp'), false);
  assert.equal(shouldRestart('api/.#index.js'), false);
  assert.equal(shouldRestart('ui/public/app.js~'), false);
});

test('shouldRestart is robust to empty input and backslash separators', () => {
  assert.equal(shouldRestart(''), false);
  assert.equal(shouldRestart(undefined), false);
  assert.equal(shouldRestart('ui\\public\\app.js'), true);
});
