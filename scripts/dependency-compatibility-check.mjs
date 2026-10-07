#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pbkdf2Sync as nativePbkdf2Sync } from 'node:crypto';

const require = createRequire(import.meta.url);
const virtualStore = path.resolve('node_modules/.pnpm');
const minimatchVersions = ['3.1.5', '5.1.9', '9.0.9', '10.2.5'];

function packagePath(name, version) {
  const prefix = `${name}@${version}`;
  const matches = fs
    .readdirSync(virtualStore)
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`));

  assert.equal(
    matches.length,
    1,
    `Expected one installed ${name}@${version}, found ${matches.length}`,
  );
  return path.join(virtualStore, matches[0], 'node_modules', name);
}

const pbkdf2Path = packagePath('pbkdf2', '3.1.7');
const pbkdf2 = require(pbkdf2Path);
const browserPbkdf2Sync = require(path.join(pbkdf2Path, 'lib', 'sync.js'));
for (const password of ['wallet-password', 'long-password-'.repeat(1024)]) {
  for (const digest of ['sha1', 'sha256', 'sha512']) {
    const expected = nativePbkdf2Sync(password, 'compatibility-salt', 100, 32, digest);
    assert.deepEqual(pbkdf2.pbkdf2Sync(password, 'compatibility-salt', 100, 32, digest), expected);
    assert.deepEqual(browserPbkdf2Sync(password, 'compatibility-salt', 100, 32, digest), expected);
  }
}

const braceTargets = new Set();
for (const version of minimatchVersions) {
  const minimatchPath = packagePath('minimatch', version);
  const bracePath = fs.realpathSync(path.join(path.dirname(minimatchPath), 'brace-expansion'));
  braceTargets.add(bracePath);

  const minimatchModule = require(minimatchPath);
  const minimatch =
    typeof minimatchModule === 'function' ? minimatchModule : minimatchModule.minimatch;
  assert.equal(typeof minimatch, 'function', `minimatch@${version} must expose a callable API`);
  assert.equal(minimatch('src/routes/trade.ts', 'src/**/*.ts'), true);
}

assert.equal(
  braceTargets.size,
  1,
  'All minimatch versions must resolve one patched brace-expansion',
);
const [bracePath] = braceTargets;
assert.match(bracePath, /brace-expansion@5\.0\.12_patch_hash=/);

const braceExpansion = require(bracePath);
assert.equal(
  typeof braceExpansion,
  'function',
  'Legacy CommonJS consumers require a callable export',
);
assert.equal(
  braceExpansion.expand,
  braceExpansion,
  'The named and callable APIs must use the same function',
);
assert.deepEqual(braceExpansion('file-{a,b}.txt'), ['file-a.txt', 'file-b.txt']);
assert.equal(braceExpansion('{1..200000}').length, braceExpansion.EXPANSION_MAX);

const lengthCapped = braceExpansion('{a,b}'.repeat(1500), { maxLength: 100 });
assert.ok(lengthCapped.reduce((total, value) => total + value.length, 0) <= 100);

const bracesTargets = new Set();
for (const [consumer, version] of [
  ['micromatch', '4.0.8'],
  ['chokidar', '3.6.0'],
]) {
  const consumerPath = packagePath(consumer, version);
  bracesTargets.add(fs.realpathSync(path.join(path.dirname(consumerPath), 'braces')));
}
assert.equal(bracesTargets.size, 1, 'Glob consumers must share the depth-patched braces');
const [bracesPath] = bracesTargets;
assert.match(bracesPath, /braces@3\.0\.3_patch_hash=/);
const braces = require(bracesPath);
assert.deepEqual(braces.expand('src/{routes,core}/*.{ts,js}'), [
  'src/routes/*.ts',
  'src/routes/*.js',
  'src/core/*.ts',
  'src/core/*.js',
]);
assert.equal(braces.compile('file-{1..3}.ts'), 'file-([1-3]).ts');
assert.equal(braces.stringify(braces.parse('file-{a,b}.ts')), 'file-{a,b}.ts');
const depthError = (error) =>
  error instanceof RangeError && error.message === 'braces: nesting depth exceeds 128';
for (const pattern of [
  '{'.repeat(4000) + 'a' + '}'.repeat(4000),
  '('.repeat(4000) + 'a' + ')'.repeat(4000),
  '{'.repeat(4000) + 'a',
]) {
  for (const operation of ['parse', 'compile', 'expand', 'stringify']) {
    assert.throws(() => braces[operation](pattern), depthError, `${operation} must bound nesting`);
  }
}
// Walkers also accept caller-provided ASTs, which bypass the parser's guard.
for (const operation of ['compile', 'expand', 'stringify']) {
  const ast = { type: 'root', nodes: [] };
  let cursor = ast;
  for (let depth = 0; depth < 1000; depth++) {
    const child = { type: 'root', nodes: [], parent: cursor };
    cursor.nodes.push(child);
    cursor = child;
  }
  cursor.nodes.push({ type: 'text', value: 'a' });
  assert.throws(() => braces[operation](ast), depthError, `${operation} must bound AST depth`);
}
// Escaped and quoted braces are text, not nesting.
assert.doesNotThrow(() => braces.parse('\\{'.repeat(1000)));
assert.doesNotThrow(() => braces.parse('"' + '{'.repeat(1000) + '"'));

const jaysonPath = packagePath('jayson', '4.3.0');
const streamJsonPath = fs.realpathSync(path.join(path.dirname(jaysonPath), 'stream-json'));
assert.match(
  streamJsonPath,
  /stream-json@1\.9\.1_patch_hash=/,
  'jayson must resolve the security-patched legacy stream-json release',
);

const jaysonUtils = require(path.join(jaysonPath, 'lib', 'utils.js'));
const nestedRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'health',
  params: { payload: Array.from({ length: 250 }, (_, index) => ({ index })) },
};
const parsedRequest = await new Promise((resolve, reject) => {
  jaysonUtils.parseStream(Readable.from([JSON.stringify(nestedRequest)]), {}, (error, request) => {
    if (error) reject(error);
    else resolve(request);
  });
});
assert.deepEqual(parsedRequest, nestedRequest);

const Pick = require(path.join(streamJsonPath, 'filters', 'Pick.js'));
const Assembler = require(path.join(streamJsonPath, 'Assembler.js'));
for (const options of [undefined, { reviver: (_key, value) => value }]) {
  const assembler = new Assembler(options);
  assembler.startObject();
  assembler.keyValue('__proto__');
  assembler.startObject();
  assembler.keyValue('isAdmin');
  assembler.trueValue();
  assembler.endObject();
  assembler.endObject();
  assert.equal(Object.getPrototypeOf(assembler.current), Object.prototype);
  assert.equal(Object.hasOwn(assembler.current, '__proto__'), true);
  assert.deepEqual(assembler.current, JSON.parse('{"__proto__":{"isAdmin":true}}'));
  assert.equal({}.isAdmin, undefined);
}
await new Promise((resolve, reject) => {
  const depth = 50;
  const input = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  const source = Readable.from([input]);
  const pipeline = source.pipe(Pick.withParser({ filter: 'missing', maxDepth: 10 }));
  source.on('error', reject);
  pipeline.on('data', () => {});
  pipeline.on('error', (error) => {
    if (error instanceof RangeError) resolve();
    else reject(error);
  });
  pipeline.on('end', () => reject(new Error('Expected an over-depth JSON error')));
});

const graphqlServerRequire = createRequire(
  path.join(fs.realpathSync('indexer/node_modules/@subsquid/graphql-server'), 'package.json'),
);
const { makeExecutableSchema, mergeSchemas } = graphqlServerRequire('@graphql-tools/schema');
const { graphqlSync } = graphqlServerRequire('graphql');
const left = makeExecutableSchema({
  typeDefs: 'type Query { left: String }',
  resolvers: { Query: { left: () => 'left' } },
});
const right = makeExecutableSchema({
  typeDefs: 'type Query { right: String }',
  resolvers: { Query: { right: () => 'right' } },
});
const merged = mergeSchemas({ schemas: [left, right] });
const result = graphqlSync({ schema: merged, source: '{ left right }' });
assert.equal(result.errors, undefined);
assert.deepEqual({ ...result.data }, { left: 'left', right: 'right' });

console.log(
  `Dependency compatibility check passed: minimatch ${minimatchVersions.join(', ')} -> patched brace-expansion 5.0.12; glob consumers -> depth-patched braces 3.0.3; jayson 4.3.0 -> security-patched stream-json 1.9.1; Subsquid GraphQL schema merge`,
);
