import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const store = path.resolve('node_modules/.pnpm');
const require = createRequire(import.meta.url);
const legacySourceHashes = {
  '3.1.5': '746849f267c4868a53729225bd85c7dccd387712136fb305fcc0a3eadd4a3d9d',
  '5.1.9': '1339bca8b70e33847860daa8fc3ccfa62487e143670da01a3b718d40d5fd424f',
};
for (const version of ['3.1.5', '5.1.9']) {
  test(`minimatch ${version} has no preprocessing methods`, () => {
    const modulePath = path.join(store, `minimatch@${version}`, 'node_modules/minimatch');
    const source = fs.readFileSync(path.join(modulePath, 'minimatch.js'));
    assert.equal(createHash('sha256').update(source).digest('hex'), legacySourceHashes[version]);
    assert.doesNotMatch(
      source.toString(),
      /firstPhasePreProcess|secondPhasePreProcess|optimizationLevel/,
    );
    const { Minimatch } = require(modulePath);
    assert.equal(Minimatch.prototype.firstPhasePreProcess, undefined);
    assert.equal(Minimatch.prototype.secondPhasePreProcess, undefined);
    assert.equal(new Minimatch('src/**/*.ts').match('src/core/example.ts'), true);
    assert.equal(
      new Minimatch(Array(30).fill('**/../a/b').join('/'), { optimizationLevel: 2 }).set.length,
      1,
    );
  });
}

test('modern minimatch consumers resolve patched installations', () => {
  const seen = new Set();
  for (const entry of fs.readdirSync(store)) {
    const link = path.join(store, entry, 'node_modules/minimatch');
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
    if (!['9.0.9', '10.2.5', '10.2.6'].includes(version)) continue;
    assert.match(resolved, /minimatch@(?:9\.0\.9|10\.2\.5|10\.2\.6)_patch_hash=/);
    seen.add(version);
  }
  assert.deepEqual([...seen].sort(), ['10.2.5', '10.2.6', '9.0.9']);
});

for (const version of ['9.0.9', '10.2.5', '10.2.6']) {
  for (const format of ['commonjs', 'esm']) {
    test(`minimatch ${version} ${format} bounds pattern amplification`, async () => {
      const entries = fs
        .readdirSync(store)
        .filter((entry) => entry.startsWith(`minimatch@${version}_patch_hash=`));
      assert.equal(entries.length, 1);
      const file = path.join(store, entries[0], 'node_modules/minimatch/dist', format, 'index.js');
      const { Minimatch } = await import(pathToFileURL(file).href);
      const pattern = Array(30).fill('**/../a/b').join('/');
      const bounded = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 64 });
      assert.equal(bounded.set.length, 64);
      const simple = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
      assert.equal(simple.set.length, 4);
      assert.equal(simple.match('../a/b/../c/d'), true);
      assert.equal(simple.match('x/a/b/y/c/d'), true);
      const large = new Minimatch('{x,*}/{0..999}', { optimizationLevel: 2 });
      assert.equal(large.set.length, 2000);
      assert.equal(large.match('y/999'), true);
      assert.equal(large.match('.y/5'), false);
    });
  }
}
