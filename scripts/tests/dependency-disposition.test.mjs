import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { matchesVerifiedDisposition } from '../dependency-disposition.mjs';

const disposition = {
  moduleName: 'minimatch',
  severity: 'moderate',
  versions: new Set(['3.1.5', '10.2.6']),
  vulnerableVersions: '<11.0.1',
  patchedVersions: '>=11.0.1',
  overviewHash: createHash('sha256').update('reviewed advisory text').digest('hex'),
};
const advisory = {
  module_name: 'minimatch',
  severity: 'moderate',
  vulnerable_versions: '<11.0.1',
  patched_versions: '>=11.0.1',
  overview: 'reviewed advisory text',
  findings: [{ version: '3.1.5' }, { version: '10.2.6' }],
};

test('only the inspected versions and advisory content match', () => {
  assert.equal(matchesVerifiedDisposition(advisory, disposition), true);
  for (const changed of [
    { overview: 'new advisory scope' },
    { severity: 'high' },
    { module_name: 'different' },
    { patched_versions: '>=12' },
    { vulnerable_versions: '<12' },
    { findings: [] },
    { findings: [{ version: '3.1.5' }, { version: '10.2.7' }] },
  ])
    assert.equal(matchesVerifiedDisposition({ ...advisory, ...changed }, disposition), false);
  assert.equal(matchesVerifiedDisposition(advisory, undefined), false);
});
