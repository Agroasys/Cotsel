// Cotsel#951: treasury refuses to start without verification keys whenever it
// reads the reconciliation database, and reconciliation must sign with the
// foundation's evidence key. Both are wired here, from the same key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = join(root, 'staging-platform');
const read = (dir, file) => readFileSync(join(dir, file), 'utf8');
const KEY_ARN = 'data.terraform_remote_state.foundation.outputs.reconciliation_finding_key_arn';

test('treasury, which verifies reconciliation runs, gets the verification key ring', () => {
  // Treasury's config requires the keys whenever RECONCILIATION_DB_NAME is set.
  // The oracle also reads that database, but only containments, never runs.
  const text = read(platform, 'runtime-treasury-ricardian.tf');
  assert.match(text, /name = "RECONCILIATION_DB_NAME"/u);
  assert.ok(
    text.includes(
      `{ name = "RECONCILIATION_FINDING_PUBLIC_KEYS", value = jsonencode({ (${KEY_ARN}) = data.terraform_remote_state.foundation.outputs.reconciliation_finding_public_key }) }`,
    ),
    'treasury reads RECONCILIATION_DB_NAME without RECONCILIATION_FINDING_PUBLIC_KEYS',
  );
});

test('reconciliation signs with the same foundation key, through KMS', () => {
  const runtime = read(platform, 'runtime-oracle-reconciliation.tf');
  assert.ok(
    runtime.includes(`{ name = "RECONCILIATION_FINDING_SIGNER", value = "kms:\${${KEY_ARN}}" }`),
    'reconciliation must sign with kms:<foundation key ARN>',
  );
  assert.doesNotMatch(runtime, /RECONCILIATION_FINDING_SIGNING_KEY/u);
  const foundation = read(join(root, 'staging-foundation'), 'reconciliation-findings-key.tf');
  assert.match(foundation, /customer_master_key_spec\s+= "ECC_NIST_P256"/u);
  assert.match(foundation, /prevent_destroy = true/u);
});
