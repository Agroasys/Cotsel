// Every migration a service registers must be in its build output: the
// packaged service loads dist/database/migrations.json at startup, and a file
// the build did not copy stops it with ENOENT. Source tests cannot see this.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury'];

for (const service of SERVICES) {
  test(`${service} packages every registered migration`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, service, 'package.json'), 'utf8'));
    // Only the steps that write dist/database; other copies (OpenAPI) are not migrations.
    const steps = pkg.scripts['copy-files']
      .split('&&')
      .map((step) => step.trim())
      .filter((step) => step.includes('dist/database'));
    assert.ok(steps.length > 0, `${service}: no copy step writes dist/database`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), `packaging-${service}-`));
    try {
      fs.cpSync(path.join(ROOT, service, 'src', 'database'), path.join(work, 'src', 'database'), {
        recursive: true,
      });
      execFileSync('sh', ['-c', steps.join(' && ')], { cwd: work });
      const dist = path.join(work, 'dist', 'database');
      const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'migrations.json'), 'utf8'));
      for (const migration of manifest.migrations) {
        assert.ok(
          fs.existsSync(path.join(dist, migration.file)),
          `${service}: ${migration.file} is registered but not packaged`,
        );
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
