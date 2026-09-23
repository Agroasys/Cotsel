import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeTerraformFiles = [
  'infra/terraform/staging-platform/runtime-gateway-auth.tf',
  'infra/terraform/staging-platform/runtime-oracle-reconciliation.tf',
  'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
];

test('AWS staging runs application services with production security semantics', async () => {
  const source = (
    await Promise.all(runtimeTerraformFiles.map((file) => readFile(file, 'utf8')))
  ).join('\n');

  assert.doesNotMatch(source, /name = "NODE_ENV", value = "staging"/);
  assert.equal(source.match(/name = "NODE_ENV", value = "production"/g)?.length, 6);
  assert.equal(source.match(/name = "COTSEL_ENVIRONMENT", value = "staging"/g)?.length, 6);
  assert.equal(source.match(/name = "AUTH_ENABLED", value = "true"/g)?.length, 2);
  assert.match(source, /name = "GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH", value = "false"/);
  assert.match(source, /name = "GATEWAY_RATE_LIMIT_ENABLED", value = "true"/);
  assert.match(source, /name = "GATEWAY_RATE_LIMIT_FAIL_OPEN", value = "false"/);
  assert.match(
    source,
    /name = "GATEWAY_RATE_LIMIT_REDIS_URL", value = "rediss:\/\/\$\{local\.redis_primary_endpoint\}:6379"/,
  );
  assert.doesNotMatch(source, /name = "GATEWAY_RATE_LIMIT_ENABLED", value = "false"/);
});

test('ECS publishes redacted reviewed configuration identities', async () => {
  const gatewayTask = await readFile('infra/terraform/staging-platform/gateway-runtime.tf', 'utf8');
  const privateTasks = await readFile(
    'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
    'utf8',
  );
  const outputs = await readFile('infra/terraform/staging-platform/outputs.tf', 'utf8');

  assert.match(gatewayTask, /gateway_reviewed_config_sha256 = sha256\(jsonencode/);
  assert.match(gatewayTask, /ReviewedConfigSha256 = local\.gateway_reviewed_config_sha256/);
  assert.match(privateTasks, /private_runtime_reviewed_config_sha256 = \{/);
  assert.match(
    privateTasks,
    /ReviewedConfigSha256 = local\.private_runtime_reviewed_config_sha256\[each\.key\]/,
  );
  assert.match(outputs, /reviewed_config_sha256 = local\.gateway_reviewed_config_sha256/);
  assert.match(
    outputs,
    /reviewed_config_sha256 = local\.private_runtime_reviewed_config_sha256\[name\]/,
  );
});

test('treasury staging carries the WP-4 settlement, freshness and control configuration', async () => {
  const source = await readFile(
    'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
    'utf8',
  );
  const treasuryEnvironment = source.match(/\n {4}treasury = \[([\s\S]*?)\n {4}\]\n {2}\}/)?.[1];
  assert.ok(treasuryEnvironment, 'treasury environment must be present');

  // WP-4 B-08 and FAIL-06: canonicality is re-derived from the chain, so the
  // task needs a settlement runtime. Without one every ingestion run refuses
  // and no reorganization can be detected on the deployed path.
  assert.match(treasuryEnvironment, /name = "SETTLEMENT_RUNTIME", value = "base-sepolia"/);
  assert.match(
    treasuryEnvironment,
    /name = "CHAIN_ID", value = tostring\(local\.base_sepolia_chain_id\)/,
  );
  assert.match(treasuryEnvironment, /name = "RPC_QUORUM", value = "2"/);

  // WP-4 B-09 and FAIL-10: the scheduled worker is the only thing that advances
  // chain evidence, and it may not be disabled in a production runtime.
  assert.match(treasuryEnvironment, /name = "TREASURY_INGESTION_WORKER_ENABLED", value = "true"/);
  assert.doesNotMatch(
    treasuryEnvironment,
    /name = "TREASURY_INGESTION_WORKER_ENABLED", value = "false"/,
  );
  assert.match(treasuryEnvironment, /name = "TREASURY_INGEST_INTERVAL_MS", value = "(\d+)"/);
  assert.match(treasuryEnvironment, /name = "TREASURY_INGEST_MAX_AGE_SECONDS", value = "(\d+)"/);
  assert.match(treasuryEnvironment, /name = "TREASURY_INGEST_MAX_LAG_BLOCKS", value = "(\d+)"/);

  // Treasury refuses to start when the threshold cannot outlive the schedule.
  // Catch that here rather than in a crash loop on a deployed task.
  const intervalMs = Number(
    treasuryEnvironment.match(/name = "TREASURY_INGEST_INTERVAL_MS", value = "(\d+)"/)[1],
  );
  const maxAgeSeconds = Number(
    treasuryEnvironment.match(/name = "TREASURY_INGEST_MAX_AGE_SECONDS", value = "(\d+)"/)[1],
  );
  assert.ok(
    maxAgeSeconds * 1000 > intervalMs,
    'TREASURY_INGEST_MAX_AGE_SECONDS must exceed TREASURY_INGEST_INTERVAL_MS',
  );

  // WP-4 H-25: realization reads the accepted reconciliation run's watermark.
  assert.match(
    treasuryEnvironment,
    /name = "RECONCILIATION_DB_NAME", value = "cotsel_reconciliation"/,
  );
  assert.match(treasuryEnvironment, /name = "RECONCILIATION_DB_SSL_MODE", value = "verify-full"/);

  // WP-4 H-16: the delegation exception is reviewed configuration, and provider
  // callbacks are verified in a production runtime.
  assert.match(
    treasuryEnvironment,
    /name = "TREASURY_OPERATOR_DELEGATION_API_KEYS", value = var\.treasury_gateway_api_key_id/,
  );
  assert.match(
    treasuryEnvironment,
    /name = "TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED", value = "true"/,
  );
  assert.doesNotMatch(
    treasuryEnvironment,
    /name = "TREASURY_PROVIDER_CALLBACK_AUTH_ENABLED", value = "false"/,
  );
});

test('treasury reads reconciliation evidence with the dedicated reader identity', async () => {
  const source = await readFile(
    'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
    'utf8',
  );
  const treasurySecrets = source.match(/\n {4}treasury = concat\(\[([\s\S]*?)\n {2}\}/)?.[1];
  assert.ok(treasurySecrets, 'treasury secrets must be present');

  assert.match(treasurySecrets, /database\/reconciliation\/reader/);
  assert.doesNotMatch(treasurySecrets, /database\/reconciliation\/runtime/);
  assert.doesNotMatch(treasurySecrets, /database\/reconciliation\/migration/);
  assert.match(
    treasurySecrets,
    /name = "RPC_URL", valueFrom = aws_secretsmanager_secret\.platform\["rpc-base-sepolia-primary"\]/,
  );
  assert.match(
    treasurySecrets,
    /name = "RPC_FALLBACK_URLS", valueFrom = aws_secretsmanager_secret\.platform\["rpc-base-sepolia-fallback"\]/,
  );
});
