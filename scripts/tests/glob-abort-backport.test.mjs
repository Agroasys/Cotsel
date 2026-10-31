import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const store = path.resolve('node_modules/.pnpm');
test('glob consumers resolve the patched versions', () => {
  const seen = new Set();
  for (const entry of fs.readdirSync(store)) {
    const link = path.join(store, entry, 'node_modules/glob');
    let stat;
    try {
      stat = fs.lstatSync(link);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    const resolved = fs.realpathSync(link);
    const version = JSON.parse(
      fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'),
    ).version;
    if (version !== '10.5.0' && version !== '13.0.6') continue;
    assert.match(resolved, /glob@(?:10\.5\.0|13\.0\.6)_patch_hash=/);
    seen.add(version);
  }
  assert.deepEqual([...seen].sort(), ['10.5.0', '13.0.6']);
});

for (const version of ['10.5.0', '13.0.6']) {
  for (const format of ['commonjs', 'esm']) {
    test(`glob ${version} ${format} stops aborted walks`, async () => {
      const matches = fs
        .readdirSync(store)
        .filter((entry) => entry.startsWith(`glob@${version}_patch_hash=`));
      assert.equal(matches.length, 1, 'expected exactly one patched glob installation');
      const file = path.join(store, matches[0], 'node_modules/glob/dist', format, 'walker.js');
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
      const [entry] = fs
        .readdirSync(store)
        .filter((item) => item.startsWith(`glob@${version}_patch_hash=`));
      assert.ok(entry);
      const file = path.join(store, entry, 'node_modules/glob/dist', format, 'index.js');
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
