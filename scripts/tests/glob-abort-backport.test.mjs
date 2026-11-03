import assert from 'node:assert/strict';
import { installedPackagePath } from '../installed-dependency-paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('glob consumers resolve the active patched versions', () => {
  for (const version of ['10.5.0', '13.0.6'])
    assert.match(installedPackagePath('glob', version), /_patch_hash=/);
});

for (const version of ['10.5.0', '13.0.6']) {
  for (const format of ['commonjs', 'esm']) {
    test(`glob ${version} ${format} stops aborted walks`, async () => {
      const file = path.join(installedPackagePath('glob', version), 'dist', format, 'walker.js');
      const { GlobUtil } = await import(pathToFileURL(file).href);
      const controller = new AbortController();
      controller.abort();
      const walker = new GlobUtil([], {}, { signal: controller.signal });
      let calls = 0;
      const done = () => calls++;
      const processor = { processPatterns: () => assert.fail('walk continued after abort') };
      walker.walkCB({}, [], done);
      walker.walkCB2({}, [], processor, done);
      walker.walkCBSync({}, [], done);
      walker.walkCB2Sync({}, [], processor, done);
      assert.equal(calls, 4, 'each aborted walk completes exactly once');
      let resumed = false;
      walker.onResume(() => (resumed = true));
      assert.equal(resumed, true, 'completion callbacks remain runnable after abort');
    });

    test(`glob ${version} ${format} still finds matching files`, async () => {
      const file = path.join(installedPackagePath('glob', version), 'dist', format, 'index.js');
      const { glob } = await import(pathToFileURL(file).href);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-glob-'));
      try {
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(path.join(dir, 'nested', 'record.txt'), 'fixture');
        fs.writeFileSync(path.join(dir, 'nested', 'other.log'), 'fixture');
        assert.deepEqual(await glob('**/*.txt', { cwd: dir }), ['nested/record.txt']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
