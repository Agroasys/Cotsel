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
