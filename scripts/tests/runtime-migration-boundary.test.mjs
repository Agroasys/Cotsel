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

test('production service startup makes auto-migration an explicit decision', async () => {
  const serviceEntrypoints = [
    'auth/src/server.ts',
    'oracle/src/server.ts',
    'reconciliation/src/cli.ts',
    'ricardian/src/server.ts',
    'treasury/src/server.ts',
  ];

  for (const file of serviceEntrypoints) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /shouldAutoMigrateDatabase/);
    assert.match(source, /rawValue: process\.env\.DB_AUTO_MIGRATE/);
  }

  const gatewayEntrypoint = await readFile('gateway/src/server.ts', 'utf8');
  const gatewayMigrationPolicy = await readFile('gateway/src/database/autoMigrate.ts', 'utf8');
  assert.match(gatewayEntrypoint, /migrateGatewayDatabaseIfEnabled\(config\)/);
  assert.match(gatewayMigrationPolicy, /shouldAutoMigrateDatabase/);
  assert.match(gatewayMigrationPolicy, /rawValue: process\.env\.DB_AUTO_MIGRATE/);
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
