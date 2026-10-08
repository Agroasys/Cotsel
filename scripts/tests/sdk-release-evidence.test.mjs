import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import { verifyPackageIntegrity, verifyPublishedIntegrity } from '../sdk-release-evidence.mjs';
import { evaluateSdkSourceChecks, sourceCheckContexts } from '../sdk-source-gate.mjs';

test('accepts only the same bytes in pack metadata and the published registry integrity', () => {
  const bytes = Buffer.from('validated sdk archive');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifyPackageIntegrity(bytes, integrity, integrity).sha256.length, 64);
  assert.throws(() => verifyPackageIntegrity(bytes, 'wrong', integrity), /pack record/);
  assert.throws(() => verifyPackageIntegrity(bytes, integrity, 'wrong'), /published package/);
});

test('registry reads retry transient failures and lag with bounded exponential backoff', async () => {
  const bytes = Buffer.from('validated sdk archive');
  const packedIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let attempts = 0;
  const delays = [];
  const result = await verifyPublishedIntegrity({
    bytes,
    packedIntegrity,
    version: '2.0.0',
    readIntegrity: (version) => {
      assert.equal(version, '2.0.0');
      attempts++;
      if (attempts === 1) throw new Error('temporary registry failure');
      if (attempts === 2) return null;
      if (attempts === 3) return {};
      if (attempts === 4) throw new SyntaxError('incomplete response');
      return packedIntegrity;
    },
    wait: async (delay) => delays.push(delay),
  });
  assert.equal(result.integrity, packedIntegrity);
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test('registry exhaustion fails closed and mismatched bytes fail without retrying', async () => {
  const bytes = Buffer.from('validated sdk archive');
  const packedIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let attempts = 0;
  const delays = [];
  await assert.rejects(
    verifyPublishedIntegrity({
      bytes,
      packedIntegrity,
      readIntegrity: () => {
        attempts++;
        throw new Error('unavailable');
      },
      wait: async (delay) => delays.push(delay),
    }),
    /unavailable after five attempts/u,
  );
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  attempts = 0;
  await assert.rejects(
    verifyPublishedIntegrity({
      bytes,
      packedIntegrity,
      readIntegrity: () => {
        attempts++;
        return `sha512-${createHash('sha512').update('different archive').digest('base64')}`;
      },
      wait: async () => assert.fail('digest mismatches must not retry'),
    }),
    /published package differs/u,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    verifyPublishedIntegrity({
      bytes,
      packedIntegrity: 'invalid',
      readIntegrity: () => assert.fail('bad pack metadata must not query the registry'),
    }),
    /pack record/u,
  );
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
  assert.match(workflow, /^ {2}checks: read$/mu);
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
