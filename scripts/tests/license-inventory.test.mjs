import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../generate-license-report.mjs', import.meta.url));
function inventory(trees) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-license-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'service'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@agroasys/cotsel', workspaces: ['service'] }),
    );
    fs.writeFileSync(path.join(root, 'service/package.json'), JSON.stringify({ name: 'service' }));
    fs.writeFileSync(path.join(root, 'trees.json'), JSON.stringify(trees));
    fs.writeFileSync(
      path.join(root, 'bin/pnpm'),
      `#!/usr/bin/env node\nconst fs=require('fs');\nif (!process.argv.includes('--recursive') || !process.argv.includes('--prod')) process.exit(2);\nprocess.stdout.write(fs.readFileSync('trees.json'));\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(root, 'bin/git'),
      '#!/bin/sh\nprintf aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      { mode: 0o700 },
    );
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      },
      stdio: 'pipe',
    });
    return JSON.parse(
      fs.readFileSync(path.join(root, 'reports/licenses/third-party-licenses.json'), 'utf8'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('includes production dependencies from every workspace using pnpm dependency-map names', () => {
  const dependency = { from: 'external', version: '1.0.0', license: 'MIT' };
  const report = inventory([
    { name: '@agroasys/cotsel', version: '1.0.0' },
    {
      name: 'service',
      version: '1.0.0',
      dependencies: {
        external: dependency,
        second: { version: '2.0.0', dependencies: { external: dependency } },
      },
    },
  ]);
  assert.equal(report.packageCount, 2);
  assert.deepEqual(
    report.packages.map((entry) => entry.name),
    ['external', 'second'],
  );
  assert.equal(report.packages[1].license, 'UNKNOWN');
  assert.equal(report.sourceCommit, 'a'.repeat(40));
});

test('rejects a missing workspace and an empty production dependency inventory', () => {
  assert.throws(() => inventory([{ name: '@agroasys/cotsel' }]), /Command failed/);
  assert.throws(
    () => inventory([{ name: '@agroasys/cotsel' }, { name: 'service' }]),
    /Command failed/,
  );
});
