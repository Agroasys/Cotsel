#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { collectDocTargets, extractDocFieldNames } from './data-classification-guard.mjs';

const markdownFixture = `
## Allowed in generic logs and runbooks

- \`tradeId\`, \`actionKey\`, \`requestId\`

Redacted log keys:
- \`accessToken\`
- \`apiKey\`

| Field | Required |
| --- | --- |
| \`correlationId\` | yes |
`;

const yamlFixture = `
components:
  schemas:
    Example:
      properties:
        providerRef:
          type: string
        evidenceRef:
          type: string
`;

const markdownFields = extractDocFieldNames('docs/runbooks/example.md', markdownFixture);
assert.deepEqual(
  markdownFields,
  ['tradeId', 'actionKey', 'requestId', 'correlationId'],
  'markdown extraction should capture every backticked field while skipping deny-list bullets',
);

const yamlFields = extractDocFieldNames('docs/api/example.yml', yamlFixture);
assert.ok(yamlFields.includes('providerRef'));
assert.ok(yamlFields.includes('evidenceRef'));

const targets = collectDocTargets();
assert.ok(targets.includes('docs/api/cotsel-dashboard-gateway.openapi.yml'));
assert.ok(targets.includes('docs/runbooks/dashboard-gateway-operations.md'));

console.log('data-classification-guard test: pass');
