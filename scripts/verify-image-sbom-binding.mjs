import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export function verifyImageSbomBinding({ sbom, verificationResults, imageDigest, sourceCommit }) {
  assert.match(imageDigest ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(sbom?.spdxVersion, 'SPDX-2.3');
  assert.ok(Array.isArray(verificationResults) && verificationResults.length > 0);
  const identity =
    'https://github.com/Agroasys/Cotsel/.github/workflows/release-images.yml@refs/heads/main';
  const match = verificationResults.some(({ verificationResult: result }) => {
    const certificate = result?.signature?.certificate;
    const statement = result?.statement;
    return (
      certificate?.subjectAlternativeName === identity &&
      certificate.issuer === 'https://token.actions.githubusercontent.com' &&
      certificate.sourceRepositoryURI === 'https://github.com/Agroasys/Cotsel' &&
      certificate.sourceRepositoryDigest === sourceCommit &&
      certificate.sourceRepositoryRef === 'refs/heads/main' &&
      certificate.runnerEnvironment === 'github-hosted' &&
      statement?.predicateType === 'https://spdx.dev/Document/v2.3' &&
      statement.subject?.length === 1 &&
      statement.subject[0].digest?.sha256 === imageDigest.slice(7) &&
      isDeepStrictEqual(statement.predicate, sbom)
    );
  });
  assert.ok(
    match,
    'Recorded image SBOM must equal a verified signed predicate for this source and digest',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyImageSbomBinding({
    sbom: JSON.parse(readFileSync(`sbom-image-${process.env.SERVICE}.spdx.json`, 'utf8')),
    verificationResults: JSON.parse(
      readFileSync(`sbom-attestation-verification-${process.env.SERVICE}.json`, 'utf8'),
    ),
    imageDigest: process.env.IMAGE_DIGEST,
    sourceCommit: process.env.GITHUB_SHA,
  });
  console.log('Recorded image SBOM matches its verified signed predicate.');
}
