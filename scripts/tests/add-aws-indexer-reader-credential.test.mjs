import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = 'scripts/add-aws-indexer-reader-credential.sh';

test('indexer reader credential update is account-bound, fail-closed, and value-redacted', async () => {
  const source = await readFile(scriptPath, 'utf8');

  assert.match(source, /expected_account_id='655177116834'/);
  assert.match(source, /aws_region="\$\{AWS_REGION:-ap-south-1\}"/);
  assert.match(source, /secret_id='\/agroasys\/staging\/cotsel\/database\/indexer\/runtime'/);
  assert.match(source, /Disable shell tracing/);
  assert.match(source, /ADD_COTSEL_INDEXER_READER/);
  assert.match(source, /has\("reader_username"\)/);
  assert.match(source, /has\("reader_password"\)/);
  assert.match(
    source,
    /The existing runtime username, password, database, and previous secret version were retained/,
  );
  assert.doesNotMatch(source, /echo.*reader_password/);
  assert.doesNotMatch(source, /set -x/);
});
