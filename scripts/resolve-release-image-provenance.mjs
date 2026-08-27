import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function resolveProducingWorkflowIdentity({
  built,
  repository,
  runAttempt,
  runId,
  serverUrl,
  verificationResults = [],
}) {
  const normalizedRepository = requireValue(repository, 'repository');
  const normalizedServerUrl = requireValue(serverUrl, 'serverUrl').replace(/\/$/u, '');
  let producingRunUri = `${normalizedServerUrl}/${normalizedRepository}/actions/runs/${requireValue(runId, 'runId')}/attempts/${requireValue(runAttempt, 'runAttempt')}`;
  const imageReused = !built;

  if (imageReused) {
    if (!Array.isArray(verificationResults)) {
      throw new Error('verification results must be an array');
    }
    const runUris = new Set(
      verificationResults
        .map((result) => result?.verificationResult?.signature?.certificate?.runInvocationURI)
        .filter(Boolean),
    );
    if (runUris.size !== 1) {
      throw new Error(
        `reused image must have exactly one verified producing run, found ${runUris.size}`,
      );
    }
    [producingRunUri] = runUris;
  }

  const expectedUri = new RegExp(
    `^${escapeRegExp(normalizedServerUrl)}/${escapeRegExp(normalizedRepository)}/actions/runs/([0-9]+)/attempts/[0-9]+$`,
    'u',
  );
  const match = producingRunUri.match(expectedUri);
  if (!match) {
    throw new Error(`unexpected producing workflow URI: ${producingRunUri}`);
  }

  return {
    imageReused,
    producingRunId: match[1],
    producingRunUri,
  };
}

function main() {
  const built = Boolean(process.env.BUILT);
  const verificationResults = built
    ? []
    : JSON.parse(
        readFileSync(
          requireValue(process.env.PROVENANCE_VERIFICATION, 'PROVENANCE_VERIFICATION'),
          'utf8',
        ),
      );
  const result = resolveProducingWorkflowIdentity({
    built,
    repository: process.env.GITHUB_REPOSITORY,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runId: process.env.GITHUB_RUN_ID,
    serverUrl: process.env.GITHUB_SERVER_URL,
    verificationResults,
  });
  appendFileSync(
    requireValue(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT'),
    `producing_run_id=${result.producingRunId}\nproducing_run_uri=${result.producingRunUri}\nimage_reused=${result.imageReused}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
