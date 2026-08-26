import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeTerraformFiles = [
  'infra/terraform/staging-platform/runtime-gateway-auth.tf',
  'infra/terraform/staging-platform/runtime-oracle-reconciliation.tf',
  'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
];

test('long-running Cotsel services cannot receive migration credentials', async () => {
  for (const file of runtimeTerraformFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /DB_MIGRATION_(?:USER|PASSWORD)/, file);
    assert.doesNotMatch(source, /database\/[^"]+\/migration/, file);
    assert.match(source, /DB_AUTO_MIGRATE", value = "false"/, file);
  }

  const gatewayIam = await readFile('infra/terraform/staging-platform/iam.tf', 'utf8');
  assert.doesNotMatch(gatewayIam, /database\/[^"]+\/migration/);

  const compose = [
    await readFile('docker-compose.services.yml', 'utf8'),
    await readFile('docker-compose.migrations.yml', 'utf8'),
  ].join('\n');
  const migrationServices = new Set([
    'auth-migrate',
    'gateway-migrate',
    'oracle-migrate',
    'reconciliation-migrate',
    'ricardian-migrate',
    'treasury-migrate',
  ]);
  const serviceBlocks = [
    ...compose.matchAll(
      /^ {2}([a-z0-9-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:|(?![\s\S]))/gm,
    ),
  ];

  for (const [, service, body] of serviceBlocks) {
    if (migrationServices.has(service) || service === 'postgres-init') continue;
    assert.doesNotMatch(body, /DB_MIGRATION_(?:USER|PASSWORD)/, service);
  }

  for (const migrationService of migrationServices) {
    const block = serviceBlocks.find(([, service]) => service === migrationService);
    assert.ok(block, `${migrationService} must exist`);
    assert.match(block[2], /command: \['node', 'shared-db\/migrate\.js'\]/);
    assert.match(block[2], /MIGRATION_DIRECTORY:/);
  }
});

test('every non-indexer schema has a dedicated one-off migration task', async () => {
  const source = await readFile('infra/terraform/staging-platform/service-migrations.tf', 'utf8');

  for (const service of ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury']) {
    assert.match(source, new RegExp(`\\n    ${service} = \\{`));
  }

  assert.match(source, /command\s+= \["node", "shared-db\/migrate\.js"\]/);
  assert.match(
    source,
    /resources = \[aws_secretsmanager_secret\.platform\["database\/\$\{each\.key\}\/migration"\]\.arn\]/,
  );
  assert.doesNotMatch(source, /task_role_arn/);
});

test('production service startup has no schema-mutation path', async () => {
  const serviceEntrypoints = [
    'auth/src/server.ts',
    'oracle/src/server.ts',
    'reconciliation/src/cli.ts',
    'ricardian/src/server.ts',
    'treasury/src/server.ts',
  ];

  for (const file of serviceEntrypoints) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /shouldAutoMigrateDatabase/);
    assert.doesNotMatch(source, /runMigrations/);
    assert.doesNotMatch(source, /DB_MIGRATION_(?:USER|PASSWORD)/);
  }

  const gatewayEntrypoint = await readFile('gateway/src/server.ts', 'utf8');
  assert.doesNotMatch(gatewayEntrypoint, /migrateGatewayDatabaseIfEnabled/);
  assert.doesNotMatch(gatewayEntrypoint, /runMigrations/);

  const operatorWorkflow = await readFile('scripts/gateway-dead-letter-workflow.mjs', 'utf8');
  assert.doesNotMatch(operatorWorkflow, /runMigrations/);
});

test('one-off migration jobs use ordered versioned directories and bounded execution', async () => {
  const source = await readFile('infra/terraform/staging-platform/service-migrations.tf', 'utf8');
  assert.match(source, /MIGRATION_DIRECTORY/);
  assert.match(source, /MIGRATION_LOCK_TIMEOUT_MS/);
  assert.match(source, /MIGRATION_STATEMENT_TIMEOUT_MS/);
  assert.doesNotMatch(source, /MIGRATION_SCHEMA_PATH/);

  const runner = await readFile('shared-db/migrationRunner.js', 'utf8');
  assert.match(runner, /pg_try_advisory_lock/);
  assert.match(runner, /cotsel_schema_migrations/);
  assert.match(runner, /checksum_sha256/);
  assert.match(runner, /await client\.query\('BEGIN'\)/);
  assert.match(runner, /await client\.query\('ROLLBACK'\)/);
});

test('long-running task definitions register replacements before deregistration', async () => {
  for (const file of [
    'infra/terraform/staging-platform/gateway-runtime.tf',
    'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /lifecycle\s*{\s*create_before_destroy\s*=\s*true\s*}/, file);
  }
});
