import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerfiles = [
  'auth/Dockerfile',
  'gateway/Dockerfile',
  'indexer/Dockerfile',
  'oracle/Dockerfile',
  'reconciliation/Dockerfile',
  'ricardian/Dockerfile',
  'treasury/Dockerfile',
];

const bundleUrl = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const bundleChecksum = 'sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3';
const bundleDigest = bundleChecksum.slice('sha256:'.length);
const bundlePath = '/app/aws-rds-global-bundle.pem';

for (const dockerfile of dockerfiles) {
  test(`${dockerfile} installs the pinned AWS RDS trust bundle`, async () => {
    const source = await readFile(dockerfile, 'utf8');
    const runtimeStage = /^FROM node:20-(?:bookworm-slim|alpine) AS runtime$/m.exec(source);

    assert.ok(runtimeStage, `${dockerfile} must declare the expected runtime stage`);
    const runtimeSource = source.slice(runtimeStage.index);
    assert.match(runtimeSource, new RegExp(`ADD --checksum=${bundleChecksum}`));
    assert.ok(runtimeSource.includes(bundleUrl));
    assert.ok(runtimeSource.includes(bundlePath));
    assert.ok(
      runtimeSource.includes(`ENV NODE_EXTRA_CA_CERTS=${bundlePath}`),
      `${dockerfile} must expose the RDS roots to Node TLS clients`,
    );
    assert.doesNotMatch(runtimeSource, /NODE_TLS_REJECT_UNAUTHORIZED/);
  });
}

test('the database bootstrap verifies the pinned AWS RDS bundle before psql connects', async () => {
  const source = await readFile('infra/terraform/staging-platform/database-bootstrap.tf', 'utf8');

  assert.ok(source.includes(bundleUrl));
  assert.ok(source.includes(bundleDigest));
  assert.match(source, /export PGSSLMODE='verify-full'/);
  assert.match(source, /export PGSSLROOTCERT='\/tmp\/aws-rds-global-bundle\.pem'/);
  assert.match(source, /sha256sum -c -s/);
});

test('the database bootstrap sets default privileges as each migration role', async () => {
  const source = await readFile('infra/terraform/staging-platform/database-bootstrap.tf', 'utf8');

  assert.doesNotMatch(source, /ALTER DEFAULT PRIVILEGES FOR ROLE/);
  assert.match(source, /export PGUSER="\$\$\{RICARDIAN_MIGRATION_USERNAME\}"/);
  assert.match(source, /export PGUSER="\$\$\{TREASURY_MIGRATION_USERNAME\}"/);
  assert.match(
    source,
    /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_ricardian_runtime/,
  );
  assert.match(
    source,
    /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cotsel_treasury_runtime/,
  );
});
