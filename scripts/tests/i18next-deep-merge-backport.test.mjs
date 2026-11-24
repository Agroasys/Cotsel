import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { installedPackagePath } from '../installed-dependency-paths.mjs';

// Public API reproduction of GHSA-6jcc-5g8w-32mx. Each format gets an isolated
// process so a vulnerable build cannot corrupt this test runner's built-ins.
const formats = [
  'dist/cjs/i18next.js',
  'dist/esm/i18next.js',
  'dist/esm/i18next.bundled.js',
  'dist/umd/i18next.js',
  'dist/umd/i18next.min.js',
  'i18next.js',
  'i18next.min.js',
];
for (const file of formats) {
  test(`i18next ${file} merges own data without corrupting inherited built-ins`, () => {
    const target = pathToFileURL(path.join(installedPackagePath('i18next', '25.8.12'), file)).href;
    const code = `
      import assert from 'node:assert/strict';
      const loaded = await import(${JSON.stringify(target)});
      const instance = (loaded.default ?? loaded).createInstance();
      await instance.init({ lng: 'en', initImmediate: false, showSupportNotice: false,
        resources: { en: { translation: { nested: { value: 'before' } } } } });
      instance.addResourceBundle('en', 'translation', {
        hasOwnProperty: { call: 'corrupted' }, toString: { call: 'corrupted' },
        valueOf: { call: 'corrupted' }, nested: { value: 'after' }
      }, true, true);
      assert.equal(typeof Object.prototype.hasOwnProperty.call, 'function');
      assert.equal(typeof Object.prototype.toString.call, 'function');
      assert.equal(typeof Object.prototype.valueOf.call, 'function');
      assert.equal(instance.t('nested.value'), 'after');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
  });
}
