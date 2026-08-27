import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveProducingWorkflowIdentity } from '../resolve-release-image-provenance.mjs';

const base = {
  repository: 'Agroasys/Cotsel',
  runAttempt: '2',
  runId: '200',
  serverUrl: 'https://github.com',
};
const scriptPath = fileURLToPath(
  new URL('../resolve-release-image-provenance.mjs', import.meta.url),
);

function verificationResult(runInvocationURI) {
  return {
    verificationResult: {
      signature: { certificate: { runInvocationURI } },
    },
  };
}

test('new images bind provenance to the current producing run', () => {
  assert.deepEqual(resolveProducingWorkflowIdentity({ ...base, built: true }), {
    imageReused: false,
    producingRunId: '200',
    producingRunUri: 'https://github.com/Agroasys/Cotsel/actions/runs/200/attempts/2',
  });
});

test('reused images retain the one verified original producing run', () => {
  assert.deepEqual(
    resolveProducingWorkflowIdentity({
      ...base,
      built: false,
      verificationResults: [
        verificationResult('https://github.com/Agroasys/Cotsel/actions/runs/100/attempts/1'),
      ],
    }),
    {
      imageReused: true,
      producingRunId: '100',
      producingRunUri: 'https://github.com/Agroasys/Cotsel/actions/runs/100/attempts/1',
    },
  );
});

test('reused images fail closed on missing or ambiguous provenance', () => {
  assert.throws(
    () =>
      resolveProducingWorkflowIdentity({
        ...base,
        built: false,
        verificationResults: [],
      }),
    /exactly one verified producing run, found 0/u,
  );
  assert.throws(
    () =>
      resolveProducingWorkflowIdentity({
        ...base,
        built: false,
        verificationResults: [
          verificationResult('https://github.com/Agroasys/Cotsel/actions/runs/100/attempts/1'),
          verificationResult('https://github.com/Agroasys/Cotsel/actions/runs/101/attempts/1'),
        ],
      }),
    /exactly one verified producing run, found 2/u,
  );
});

test('reused images reject a producing run outside the governed repository', () => {
  assert.throws(
    () =>
      resolveProducingWorkflowIdentity({
        ...base,
        built: false,
        verificationResults: [
          verificationResult('https://github.com/attacker/repository/actions/runs/100/attempts/1'),
        ],
      }),
    /unexpected producing workflow URI/u,
  );
});

test('command writes redacted producing identity outputs for a reused image', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cotsel-image-provenance-'));
  try {
    const verificationPath = path.join(directory, 'verification.json');
    const outputPath = path.join(directory, 'github-output');
    writeFileSync(
      verificationPath,
      JSON.stringify([
        verificationResult('https://github.com/Agroasys/Cotsel/actions/runs/100/attempts/1'),
      ]),
    );
    writeFileSync(outputPath, '');

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BUILT: '',
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: base.repository,
        GITHUB_RUN_ATTEMPT: base.runAttempt,
        GITHUB_RUN_ID: base.runId,
        GITHUB_SERVER_URL: base.serverUrl,
        PROVENANCE_VERIFICATION: verificationPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      [
        'producing_run_id=100',
        'producing_run_uri=https://github.com/Agroasys/Cotsel/actions/runs/100/attempts/1',
        'image_reused=true',
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
