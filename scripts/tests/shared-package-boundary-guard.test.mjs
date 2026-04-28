#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const guardPath = path.join(repoRoot, 'scripts/shared-package-boundary-guard.mjs');

function runGuard(root) {
  return spawnSync(process.execPath, [guardPath, '--root', root], {
    encoding: 'utf8',
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-shared-boundary-'));
try {
  for (const dir of ['shared-auth', 'shared-db', 'shared-edge', 'shared-http', 'shared-risk']) {
    fs.mkdirSync(path.join(tmpRoot, dir), { recursive: true });
  }

  fs.writeFileSync(
    path.join(tmpRoot, 'shared-http/index.js'),
    "'use strict';\nmodule.exports = require('./response');\n",
  );
  let result = runGuard(tmpRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Shared package boundary guard: pass/);

  fs.writeFileSync(
    path.join(tmpRoot, 'shared-http/bad.js'),
    "'use strict';\nconst gateway = require('@agroasys/gateway');\n",
  );
  result = runGuard(tmpRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shared package boundary guard failed/);
  assert.match(result.stderr, /shared-http\/bad\.js/);
  assert.match(result.stderr, /@agroasys\/gateway/);

  fs.rmSync(path.join(tmpRoot, 'shared-http/bad.js'));
  fs.writeFileSync(
    path.join(tmpRoot, 'shared-db/package.json'),
    JSON.stringify({ dependencies: { treasury: '1.0.0' } }, null, 2),
  );
  result = runGuard(tmpRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared-db\/package\.json/);
  assert.match(result.stderr, /treasury/);

  fs.rmSync(path.join(tmpRoot, 'shared-db/package.json'));
  fs.writeFileSync(
    path.join(tmpRoot, 'shared-risk/index.js'),
    "'use strict';\nimport '@agroasys/oracle';\n",
  );
  result = runGuard(tmpRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared-risk\/index\.js/);
  assert.match(result.stderr, /@agroasys\/oracle/);

  console.log('shared package boundary guard test: pass');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
