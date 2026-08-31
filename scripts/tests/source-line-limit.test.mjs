// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  countSourceLines,
  evaluateTrackedSources,
  existingTrackedFiles,
  isExcluded,
} from '../source-line-limit.mjs';

function createFixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cotsel-source-line-limit-'));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function config(overrides = {}) {
  return {
    version: 1,
    maxLines: 3,
    extensions: ['.ts'],
    excludedPaths: [],
    excludedPrefixes: ['generated/'],
    legacyBaseline: {},
    ...overrides,
  };
}

test('counts a final unterminated line', () => {
  assert.equal(countSourceLines('one\ntwo'), 2);
  assert.equal(countSourceLines('one\ntwo\n'), 2);
  assert.equal(countSourceLines(''), 0);
});

test('ignores deleted working-tree paths during an in-progress refactor', () => {
  const root = createFixture({ 'src/present.ts': '1\n' });
  assert.deepEqual(existingTrackedFiles(root, ['src/present.ts', 'src/deleted.ts']), [
    'src/present.ts',
  ]);
});

test('rejects a new oversized source file', () => {
  const root = createFixture({ 'src/new.ts': '1\n2\n3\n4\n' });
  const result = evaluateTrackedSources({
    root,
    config: config(),
    trackedFiles: ['src/new.ts'],
  });

  assert.deepEqual(result.violations, ['src/new.ts: 4 lines exceeds the 3-line limit']);
});

test('allows legacy debt only at or below its frozen baseline', () => {
  const root = createFixture({ 'src/legacy.ts': '1\n2\n3\n4\n' });
  const result = evaluateTrackedSources({
    root,
    config: config({ legacyBaseline: { 'src/legacy.ts': 4 } }),
    trackedFiles: ['src/legacy.ts'],
  });

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.legacyFiles, [{ file: 'src/legacy.ts', lines: 4, legacyLimit: 4 }]);
});

test('rejects growth beyond a legacy baseline', () => {
  const root = createFixture({ 'src/legacy.ts': '1\n2\n3\n4\n5\n' });
  const result = evaluateTrackedSources({
    root,
    config: config({ legacyBaseline: { 'src/legacy.ts': 4 } }),
    trackedFiles: ['src/legacy.ts'],
  });

  assert.deepEqual(result.violations, ['src/legacy.ts: grew from the 4-line baseline to 5 lines']);
});

test('requires stale baseline entries to be removed after refactoring', () => {
  const root = createFixture({ 'src/legacy.ts': '1\n2\n3\n' });
  const result = evaluateTrackedSources({
    root,
    config: config({ legacyBaseline: { 'src/legacy.ts': 4 } }),
    trackedFiles: ['src/legacy.ts'],
  });

  assert.deepEqual(result.violations, [
    'src/legacy.ts: now 3 lines; remove its stale legacy baseline',
  ]);
});

test('ignores generated prefixes and rejects stale missing baselines', () => {
  const root = createFixture({ 'generated/client.ts': '1\n2\n3\n4\n' });
  const currentConfig = config({ legacyBaseline: { 'src/deleted.ts': 4 } });
  const result = evaluateTrackedSources({
    root,
    config: currentConfig,
    trackedFiles: ['generated/client.ts'],
  });

  assert.equal(isExcluded('generated/client.ts', currentConfig), true);
  assert.deepEqual(result.violations, [
    'src/deleted.ts: no longer tracked; remove its stale legacy baseline',
  ]);
});
