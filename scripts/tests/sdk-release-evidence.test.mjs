import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import { verifyPackageIntegrity } from '../sdk-release-evidence.mjs';
import { evaluateSdkSourceChecks, sourceCheckContexts } from '../sdk-source-gate.mjs';

test('accepts only the same bytes in pack metadata and the published registry integrity', () => {
  const bytes = Buffer.from('validated sdk archive');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifyPackageIntegrity(bytes, integrity, integrity).sha256.length, 64);
  assert.throws(() => verifyPackageIntegrity(bytes, 'wrong', integrity), /pack record/);
  assert.throws(() => verifyPackageIntegrity(bytes, integrity, 'wrong'), /published package/);
});

test('SDK publication uses protected main, attests the archive, and publishes without rebuilding', () => {
  const workflow = fs.readFileSync(
    new URL('../../.github/workflows/sdk-publish.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /test "\$GITHUB_REF" = refs\/heads\/main/u);
  assert.match(workflow, /npm pack --ignore-scripts --json/u);
  assert.match(workflow, /npm publish "\$PACKAGE_FILE" --ignore-scripts/u);
  assert.match(workflow, /subject-path: \$\{\{ steps.package.outputs.path \}\}/u);
  assert.match(workflow, /--source-digest "\$GITHUB_SHA"/u);
  assert.match(workflow, /node scripts\/sdk-release-evidence.mjs/u);
  assert.match(workflow, /node scripts\/sdk-source-gate.mjs/u);
});

test('publication rejects each missing, skipped, failed, cancelled, pending, or spoofed source check', () => {
  const checks = () =>
    sourceCheckContexts.map((name, id) => ({
      name,
      id,
      app: { id: 15368 },
      status: 'completed',
      conclusion: 'success',
    }));
  assert.equal(evaluateSdkSourceChecks(checks()).passed, true);
  for (const name of sourceCheckContexts) {
    assert.equal(
      evaluateSdkSourceChecks(checks().filter((check) => check.name !== name)).passed,
      false,
    );
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
      const runs = checks();
      runs.find((check) => check.name === name).conclusion = conclusion;
      assert.equal(evaluateSdkSourceChecks(runs).passed, false);
    }
    const runs = checks();
    runs.find((check) => check.name === name).app.id = 999;
    assert.equal(evaluateSdkSourceChecks(runs).passed, false);
  }
});

test('a failed new attempt cannot reuse a previous successful source check', () => {
  const checks = sourceCheckContexts.map((name, id) => ({
    name,
    id,
    app: { id: 15368 },
    status: 'completed',
    conclusion: 'success',
  }));
  checks.push({ ...checks[0], id: 1000, conclusion: 'failure' });
  assert.equal(evaluateSdkSourceChecks(checks).passed, false);
});
