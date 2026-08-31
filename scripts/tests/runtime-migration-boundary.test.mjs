import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const runtimeTerraformFiles = [
  'infra/terraform/staging-platform/runtime-gateway-auth.tf',
  'infra/terraform/staging-platform/runtime-oracle-reconciliation.tf',
  'infra/terraform/staging-platform/runtime-treasury-ricardian.tf',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function loadAndValidateManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.migrations));
  assert.ok(manifest.migrations.length > 0);

  let priorVersion = '';
  for (const migration of manifest.migrations) {
    assert.match(migration.version, /^\d{12,14}$/);
    assert.ok(migration.version > priorVersion);
    assert.match(migration.name, /^[a-z0-9][a-z0-9_-]*$/);
    assert.match(migration.file, /^(?!\/)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/);
    assert.match(migration.sha256, /^[a-f0-9]{64}$/);
    const migrationSql = await readFile(
      path.join(path.dirname(manifestPath), migration.file),
      'utf8',
    );
    assert.equal(sha256(migrationSql), migration.sha256);
    priorVersion = migration.version;
  }

  return manifest;
}

test('long-running Cotsel services cannot receive migration credentials', async () => {
  for (const file of runtimeTerraformFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /DB_MIGRATION_(?:USER|PASSWORD)/, file);
    assert.doesNotMatch(source, /database\/[^"]+\/migration/, file);
  }

  const gatewayIam = await readFile('infra/terraform/staging-platform/iam.tf', 'utf8');

  const compose = await readFile('docker-compose.services.yml', 'utf8');
  for (const service of ['ricardian', 'auth', 'gateway', 'treasury', 'oracle', 'reconciliation']) {
    const [, remainder] = compose.split(`\n  ${service}:\n`);
    assert.ok(remainder, `missing compose service ${service}`);
    const [serviceBlock] = remainder.split(/\n {2}[a-z][a-z0-9-]*:\n/, 1);
    assert.doesNotMatch(serviceBlock, /DB_MIGRATION_(?:USER|PASSWORD)/, service);
  }
  assert.doesNotMatch(gatewayIam, /database\/[^"]+\/migration/);
  const indexerCompose = await readFile('docker-compose.indexer.yml', 'utf8');
  const indexerServiceBlocks = [
    ...indexerCompose.matchAll(
      /^ {2}([a-z0-9-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:|(?![\s\S]))/gm,
    ),
  ];

  for (const [, service, body] of indexerServiceBlocks) {
    if (service === 'indexer-migrate') continue;
    assert.doesNotMatch(body, /DB_MIGRATION_(?:USER|PASSWORD)/, service);
  }

  const indexerMigration = indexerServiceBlocks.find(
    ([, service]) => service === 'indexer-migrate',
  );
  assert.ok(indexerMigration, 'indexer-migrate must exist');
  assert.match(indexerMigration[2], /DB_USER: '\$\{INDEXER_DB_MIGRATION_USER\}'/);
  assert.match(indexerMigration[2], /node', 'migrate\.js/);
});

test('indexer pipeline and GraphQL use distinct non-migration identities', async () => {
  const runtime = await readFile('infra/terraform/staging-platform/runtime-indexer.tf', 'utf8');
  assert.doesNotMatch(runtime, /database\/indexer\/migration/);
  assert.match(runtime, /indexer_pipeline_secrets[\s\S]*:username::/);
  assert.match(runtime, /indexer_graphql_secrets[\s\S]*database\/indexer\/reader/);
  assert.doesNotMatch(runtime, /indexer_graphql_secrets[\s\S]*database\/indexer\/runtime/);

  const gatewayIam = await readFile('infra/terraform/staging-platform/iam.tf', 'utf8');
  assert.match(gatewayIam, /database\/indexer\/reader/);

  const migration = await readFile('infra/terraform/staging-platform/indexer-migration.tf', 'utf8');
  assert.match(migration, /database\/indexer\/migration/);
  assert.doesNotMatch(migration, /task_role_arn/);

  const entrypoint = await readFile('indexer/src/main.ts', 'utf8');
  assert.match(entrypoint, /new TypeormDatabase\(\{ initializeStateSchema: false \}\)/);
});

test('every non-indexer schema has a dedicated one-off migration task', async () => {
  const source = await readFile('infra/terraform/staging-platform/service-migrations.tf', 'utf8');

  for (const service of ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury']) {
    assert.match(source, new RegExp(`\\n    ${service} = \\{`));
  }

  assert.match(source, /command\s+= \["node", "shared-db\/migrate\.js"\]/);
  assert.match(source, /MIGRATION_MANIFEST_PATH/);
  assert.match(source, /MIGRATION_LOCK_TIMEOUT_MS/);
  assert.match(source, /MIGRATION_STATEMENT_TIMEOUT_MS/);
  assert.doesNotMatch(source, /MIGRATION_SCHEMA_PATH/);
  assert.match(
    source,
    /resources = \[aws_secretsmanager_secret\.platform\["database\/\$\{each\.key\}\/migration"\]\.arn\]/,
  );
  assert.doesNotMatch(source, /task_role_arn/);
});

test('local runtimes wait for their dedicated migration jobs', async () => {
  const compose = await readFile('docker-compose.services.yml', 'utf8');
  const migrations = await readFile('docker-compose.migrations.yml', 'utf8');

  assert.match(compose, /include:\n {2}- docker-compose\.migrations\.yml/);
  for (const service of ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury']) {
    assert.match(
      compose,
      new RegExp(`${service}-migrate:\\n        condition: service_completed_successfully`),
    );
    assert.match(migrations, new RegExp(`\\n  ${service}-migrate:`));
    assert.match(
      migrations,
      new RegExp(`MIGRATION_MANIFEST_PATH: /app/${service}/dist/database/migrations\\.json`),
    );
  }

  assert.doesNotMatch(migrations, /MIGRATION_DIRECTORY/);
});

test('service migration manifests pin immutable schema checksums', async () => {
  for (const service of ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury']) {
    const manifest = await loadAndValidateManifest(`${service}/src/database/migrations.json`);
    assert.equal(manifest.migrations[0].baseline, true);
    assert.equal(manifest.migrations[0].adopt_existing_schema, true);
    assert.match(manifest.migrations[0].schema_sha256, /^[a-f0-9]{64}$/);
  }
});

test('dedicated migration runner locks, checksums, journals, and rolls back', async () => {
  const source = await readFile('shared-db/migrate.js', 'utf8');
  assert.match(source, /pg_advisory_lock/);
  assert.match(source, /cotsel_schema_migrations/);
  assert.match(source, /checksum does not match its manifest/);
  assert.match(source, /await client\.query\('BEGIN'\)/);
  assert.match(source, /await client\.query\('COMMIT'\)/);
  assert.match(source, /rollbackQuietly/);
  assert.match(source, /GRANT SELECT ON TABLE cotsel_schema_migrations/);
  assert.match(source, /WITH application_objects/);
  assert.match(source, /adopt_existing_schema/);
  assert.match(source, /application_mode/);
  assert.match(source, /computePublicSchemaFingerprint/);
  assert.match(source, /does not match the adoption fingerprint/);
});

test('indexer migration job validates history and serializes TypeORM execution', async () => {
  const terraform = await readFile('infra/terraform/staging-platform/indexer-migration.tf', 'utf8');
  const runner = await readFile('indexer/migrate.js', 'utf8');
  const manifest = await loadAndValidateManifest('indexer/db/migrations.json');

  assert.match(terraform, /command\s+= \["node", "migrate\.js"\]/);
  assert.match(terraform, /MIGRATION_LOCK_TIMEOUT_MS/);
  assert.match(terraform, /MIGRATION_STATEMENT_TIMEOUT_MS/);
  assert.match(runner, /loadMigrationManifest/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /checksum CHAR\(64\)/);
  assert.match(runner, /reviewed adoption design/);
  const migrationFiles = (await readdir('indexer/db/migrations'))
    .filter((file) => /^\d{13}-.*\.js$/.test(file))
    .map((file) => `migrations/${file}`)
    .sort();
  assert.deepEqual(manifest.migrations.map((migration) => migration.file).sort(), migrationFiles);
  assert.equal(manifest.migrations.length, 18);
});

test('runtime readiness requires the exact applied migration history', async () => {
  const connectionFiles = [
    'auth/src/database/connection.ts',
    'gateway/src/database/index.ts',
    'oracle/src/database/connection.ts',
    'reconciliation/src/database/connection.ts',
    'ricardian/src/database/connection.ts',
    'treasury/src/database/connection.ts',
  ];
  for (const file of connectionFiles) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /assertMigrationHistory/, file);
    assert.match(source, /migrations\.json/, file);
  }

  const authRoutes = await readFile('auth/src/api/routes.ts', 'utf8');
  const authServer = await readFile('auth/src/server.ts', 'utf8');
  assert.match(authRoutes, /await options\.readinessCheck\(\)/);
  assert.match(authRoutes, /status\(503\)/);
  assert.match(authServer, /readinessCheck: testConnection/);
});

test('every service image and migration task use the built immutable manifest', async () => {
  const services = ['auth', 'gateway', 'oracle', 'reconciliation', 'ricardian', 'treasury'];
  const terraform = await readFile(
    'infra/terraform/staging-platform/service-migrations.tf',
    'utf8',
  );

  for (const service of services) {
    const packageJson = JSON.parse(await readFile(`${service}/package.json`, 'utf8'));
    const dockerfile = await readFile(`${service}/Dockerfile`, 'utf8');
    assert.match(packageJson.scripts.build, /copy-files/, service);
    assert.match(packageJson.scripts['copy-files'], /dist\/database/, service);
    assert.match(dockerfile, new RegExp(`/app/${service}/dist`), service);
    assert.match(
      terraform,
      new RegExp(`manifest_path = "/app/${service}/dist/database/migrations\\.json"`),
      service,
    );
  }
});

test('long-running service startup cannot execute schema migrations', async () => {
  const serviceEntrypoints = [
    'auth/src/server.ts',
    'gateway/src/server.ts',
    'oracle/src/server.ts',
    'reconciliation/src/cli.ts',
    'ricardian/src/server.ts',
    'treasury/src/server.ts',
  ];

  for (const file of serviceEntrypoints) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /runMigrations/);
    assert.doesNotMatch(source, /shouldAutoMigrateDatabase/);
    assert.doesNotMatch(source, /DB_AUTO_MIGRATE/);
  }

  const connectionFiles = [
    'auth/src/database/connection.ts',
    'gateway/src/database/index.ts',
    'oracle/src/database/connection.ts',
    'reconciliation/src/database/connection.ts',
    'ricardian/src/database/connection.ts',
    'treasury/src/database/connection.ts',
  ];
  for (const file of connectionFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /createMigrationPool/);
    assert.doesNotMatch(source, /resolveMigrationCredentials/);
  }

  const gatewayEntrypoint = await readFile('gateway/src/server.ts', 'utf8');
  assert.doesNotMatch(gatewayEntrypoint, /migrateGatewayDatabaseIfEnabled/);
  assert.doesNotMatch(gatewayEntrypoint, /runMigrations/);

  const operatorWorkflow = await readFile('scripts/gateway-dead-letter-workflow.mjs', 'utf8');
  assert.doesNotMatch(operatorWorkflow, /runMigrations/);
});

test('runtime evidence queries do not use the Postgres administrator for indexer data', async () => {
  const source = await readFile('scripts/runtime-gate.sh', 'utf8');
  const helper = await readFile('scripts/run-indexer-psql.sh', 'utf8');

  assert.match(source, /INDEXER_DB_RUNTIME_USER/);
  assert.match(source, /INDEXER_DB_READER_USER/);
  assert.match(source, /scripts\/run-indexer-psql\.sh INDEXER_DB_RUNTIME_PASSWORD/);
  assert.match(source, /scripts\/run-indexer-psql\.sh INDEXER_DB_READER_PASSWORD/);
  assert.doesNotMatch(source, /psql -U "\$\{POSTGRES_USER\}" -d "\$\{INDEXER_DB_NAME\}"/);
  assert.match(helper, /INDEXER_DB_RUNTIME_PASSWORD \| INDEXER_DB_READER_PASSWORD/);
  assert.match(helper, /IFS= read -r PGPASSWORD/);
  assert.doesNotMatch(helper, /echo\s+"\$\{password\}"/);
  assert.doesNotMatch(helper, /set -x/);
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
