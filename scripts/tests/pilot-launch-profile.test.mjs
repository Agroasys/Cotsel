import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadPilotLaunchInputs, validatePilotLaunchProfile } from '../lib/pilot-launch-profile.mjs';
import { run } from '../validate-pilot-launch-profile.mjs';

const inputs = loadPilotLaunchInputs();
const schema = JSON.parse(readFileSync('integration/pilot-launch-profile.schema.json', 'utf8'));

function validate(mutate, options = {}) {
  const profile = structuredClone(inputs.profile);
  mutate?.(profile);
  return validatePilotLaunchProfile(profile, { ...inputs, ...options });
}

function fields(result) {
  return result.errors.map((error) => error.field);
}

// Minimal JSON Schema subset evaluator for the constructs this schema uses.
function schemaErrors(node, value, at = '$') {
  const resolved = node.$ref ? schema.$defs[node.$ref.replace('#/$defs/', '')] : node;
  const errors = [];
  if ('const' in resolved && value !== resolved.const) {
    errors.push(`${at} const`);
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${at} enum`);
  }
  if (
    resolved.pattern &&
    !(typeof value === 'string' && new RegExp(resolved.pattern).test(value))
  ) {
    errors.push(`${at} pattern`);
  }
  if (resolved.type === 'integer' && !Number.isInteger(value)) {
    errors.push(`${at} integer`);
  }
  if (resolved.type === 'array') {
    if (!Array.isArray(value) || value.length < (resolved.minItems ?? 0)) {
      return [...errors, `${at} array`];
    }
    value.forEach((item, index) => {
      if (resolved.items) {
        errors.push(...schemaErrors(resolved.items, item, `${at}[${index}]`));
      }
    });
  }
  if (resolved.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [...errors, `${at} object`];
    }
    for (const key of resolved.required ?? []) {
      if (!(key in value)) {
        errors.push(`${at}.${key} required`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (resolved.properties?.[key]) {
        errors.push(...schemaErrors(resolved.properties[key], child, `${at}.${key}`));
      } else if (resolved.additionalProperties === false) {
        errors.push(`${at}.${key} additional`);
      }
    }
  }
  return errors;
}

test('the committed Base Sepolia pilot profile is valid and conforms to its schema', () => {
  assert.deepEqual(validate().errors, []);
  assert.deepEqual(schemaErrors(schema, inputs.profile), []);
});

test('the schema rejects unknown fields and unsafe probe methods', () => {
  const profile = structuredClone(inputs.profile);
  profile.network.rpcUrl = 'https://example.invalid/key';
  profile.readiness.endpoint.method = 'POST';
  const errors = schemaErrors(schema, profile);
  assert.ok(errors.includes('$.network.rpcUrl additional'));
  assert.ok(errors.includes('$.readiness.endpoint.method enum'));
});

const DECISION = 'https://github.com/Agroasys/Cotsel/issues/613#issuecomment-1';

function acceptProfile(profile) {
  profile.status = 'accepted';
  profile.acceptance = {
    decision: 'ACCEPTED',
    acceptedBy: 'czpyioe',
    acceptedAt: '2026-12-01T10:00:00Z',
    candidateCommit: 'a'.repeat(40),
    evidence: DECISION,
  };
  profile.sponsorship.approval = { status: 'approved', authority: 'WP-0', evidence: DECISION };
}

test('a pending profile cannot gate a promotion', () => {
  const result = validate(undefined, { requirePromotable: true });
  assert.deepEqual(fields(result), ['status', 'sponsorship.approval.status']);

  const accepted = validate(acceptProfile, { requirePromotable: true });
  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(
    schemaErrors(
      schema,
      (() => {
        const profile = structuredClone(inputs.profile);
        acceptProfile(profile);
        return profile;
      })(),
    ),
    [],
  );
});

test('a bare accepted status without an acceptance record cannot promote', () => {
  const result = validate(
    (profile) => {
      acceptProfile(profile);
      delete profile.acceptance;
    },
    { requirePromotable: true },
  );
  assert.deepEqual(fields(result), ['acceptance']);
});

test('the acceptance record names a real decision by an approval-role holder', () => {
  for (const [mutate, field] of [
    [(p) => (p.acceptance.decision = 'PENDING'), 'acceptance.decision'],
    [(p) => (p.acceptance.acceptedBy = 'someone-else'), 'acceptance.acceptedBy'],
    [(p) => (p.acceptance.acceptedAt = 'yesterday'), 'acceptance.acceptedAt'],
    [(p) => (p.acceptance.candidateCommit = 'abc123'), 'acceptance.candidateCommit'],
    [
      (p) => (p.acceptance.evidence = 'https://github.com/Agroasys/Cotsel/issues/613'),
      'acceptance.evidence',
    ],
    [
      (p) => (p.acceptance.evidence = 'https://github.com/Agroasys/anything'),
      'acceptance.evidence',
    ],
  ]) {
    const result = validate((profile) => {
      acceptProfile(profile);
      mutate(profile);
    });
    assert.deepEqual(fields(result), [field], field);
  }
  const stale = validate((profile) => {
    acceptProfile(profile);
    profile.status = 'pending-acceptance';
  });
  assert.deepEqual(fields(stale), ['acceptance']);
});

test('an approval without a recorded decision link is rejected', () => {
  for (const evidence of [undefined, 'https://github.com/Agroasys/anything']) {
    const result = validate((profile) => {
      profile.sponsorship.approval.status = 'approved';
      profile.sponsorship.approval.evidence = evidence;
    });
    assert.deepEqual(fields(result), ['sponsorship.approval.evidence']);
  }
});

test('the commit source names the Terraform input that sets GATEWAY_COMMIT_SHA', () => {
  assert.deepEqual(fields(validate((p) => (p.release.commitSource = 'workflow_sha'))), [
    'release.commitSource',
  ]);
});

test('chain, contract, bytecode and acceptance drift fail closed', () => {
  for (const [mutate, field] of [
    [(p) => (p.network.chainId = 8453), 'network.chainId'],
    [(p) => (p.network.escrowAddress = `0x${'1'.repeat(40)}`), 'network.escrowAddress'],
    [(p) => (p.network.usdcAddress = `0x${'2'.repeat(40)}`), 'network.usdcAddress'],
    [(p) => (p.network.deploymentBlock = 1), 'network.deploymentBlock'],
    [
      (p) => (p.network.normalizedRuntimeBytecodeSha256 = '0'.repeat(64)),
      'network.normalizedRuntimeBytecodeSha256',
    ],
  ]) {
    assert.ok(fields(validate(mutate)).includes(field), field);
  }

  const withdrawn = structuredClone(inputs.stagingContract);
  withdrawn.acceptance.decision = 'WITHDRAWN';
  const result = validatePilotLaunchProfile(inputs.profile, {
    ...inputs,
    stagingContract: withdrawn,
  });
  assert.ok(fields(result).includes('network.contractIdentity'));

  const missing = validatePilotLaunchProfile(inputs.profile, {
    ...inputs,
    stagingContract: undefined,
  });
  assert.ok(fields(missing).includes('network.contractIdentity'));
});

test('callback contract drift from the release manifest is rejected', () => {
  const manifest = structuredClone(inputs.releaseManifest);
  manifest.contracts.settlementCallback = 'cotsel.settlement-callback.v2';
  const result = validatePilotLaunchProfile(inputs.profile, {
    ...inputs,
    releaseManifest: manifest,
  });
  assert.deepEqual(fields(result), ['callback.contract']);
  assert.ok(
    fields(validate((p) => (p.callback.url = 'http://api.staging.agroasys.com/cb'))).includes(
      'callback.url',
    ),
  );
  assert.ok(
    fields(validate((p) => (p.callback.url = 'https://u:p@api.staging.agroasys.com/cb'))).includes(
      'callback.url',
    ),
  );
});

test('embedded secret material is rejected in place of a secret reference', () => {
  const result = validate((profile) => {
    profile.rpc.primarySecretRef = 'https://base-sepolia.example/v2/abc123';
    profile.callback.credentialSecretRef = 'SECRET_VALUE';
  });
  assert.deepEqual(fields(result), ['rpc.primarySecretRef', 'callback.credentialSecretRef']);
  assert.ok(result.errors.every((error) => !error.message.includes('abc123')));
});

test('a promotion authority must be the named two-person profile', () => {
  assert.deepEqual(
    fields(validate((p) => (p.release.authorityProfileId = 'local-ci-non-promotable-v1'))),
    ['release.authorityProfileId'],
  );
  assert.deepEqual(fields(validate((p) => (p.release.authorityProfileId = 'unknown'))), [
    'release.authorityProfileId',
  ]);
});

test('unsafe service-auth, sponsorship and feature policy is rejected', () => {
  for (const [mutate, field] of [
    [
      (p) => (p.serviceAuth.insecureDownstreamAuthAllowed = true),
      'serviceAuth.insecureDownstreamAuthAllowed',
    ],
    [
      (p) => (p.serviceAuth.settlementIngress.maxSkewSeconds = 900),
      'serviceAuth.settlementIngress.maxSkewSeconds',
    ],
    [
      (p) => (p.serviceAuth.settlementIngress.nonceTtlSeconds = 300),
      'serviceAuth.settlementIngress.nonceTtlSeconds',
    ],
    [(p) => (p.rpc.fallbackSecretRef = p.rpc.primarySecretRef), 'rpc.fallbackSecretRef'],
    [(p) => (p.sponsorship.signerCustodyMode = 'raw_private_key'), 'sponsorship.signerCustodyMode'],
    [
      (p) => (p.sponsorship.ceilings.maxNativeCostWei = '1'),
      'sponsorship.ceilings.maxNativeCostWei',
    ],
    [
      (p) => (p.sponsorship.ceilings.maxFeePerGasWei = '1.5'),
      'sponsorship.ceilings.maxFeePerGasWei',
    ],
    [
      (p) => (p.featureFlags.immediateInspectionAcceptance = true),
      'featureFlags.immediateInspectionAcceptance',
    ],
    [(p) => (p.featureFlags.rateLimitFailOpen = true), 'featureFlags.rateLimitFailOpen'],
    [(p) => (p.unsupportedCapabilities = ['fiat-offramp']), 'unsupportedCapabilities'],
  ]) {
    assert.ok(fields(validate(mutate)).includes(field), field);
  }
});

test('only the gateway may be public and readiness stays side-effect free', () => {
  assert.ok(
    fields(
      validate((p) => {
        p.surfaces.find((s) => s.service === 'oracle').exposure = 'cloudfront-waf';
      }),
    ).some((field) => field.endsWith('.exposure')),
  );
  for (const [mutate, field] of [
    [(p) => (p.readiness.endpoint.method = 'POST'), 'readiness.endpoint.method'],
    [(p) => (p.readiness.endpoint.path = '/readyz'), 'readiness.endpoint.path'],
    [(p) => (p.readiness.livenessEndpoint = p.readiness.endpoint), 'readiness.livenessEndpoint'],
    [(p) => (p.readiness.sideEffects = 'bounded'), 'readiness.sideEffects'],
    [(p) => (p.readiness.requiredDependencies = ['postgres']), 'readiness.requiredDependencies'],
  ]) {
    assert.ok(fields(validate(mutate)).includes(field), field);
  }
});

test('every finding is reported in one run', () => {
  const result = validate((profile) => {
    profile.network.chainId = 1;
    profile.callback.enabled = false;
    profile.readiness.sideEffects = 'some';
  });
  assert.deepEqual(fields(result), [
    'network.chainId',
    'callback.enabled',
    'readiness.sideEffects',
  ]);
});

test('the CLI produces a digest-bound report and rejects unknown arguments', () => {
  const { ok, report } = run([]);
  assert.equal(ok, true);
  assert.equal(report.verdict, 'PASS');
  assert.match(report.profileSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.runtime, { checked: false });

  const promotion = run(['--require-promotable']);
  assert.equal(promotion.ok, false);
  assert.equal(promotion.report.verdict, 'FAIL');

  assert.throws(() => run(['--profile']), /requires a value/);
  assert.throws(() => run(['--candidate-commit']), /requires a value/);
  assert.throws(() => run(['--surprise']), /unknown argument/);
  assert.throws(() => run(['--runtime-env', '--env-file', 'x.env']), /either/);
});
