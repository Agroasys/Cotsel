import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { compareManifests, parseManifest } from '../compare-postgres-recovery-manifests.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const manifestScript = path.join(repoRoot, 'scripts', 'postgres-recovery-manifest.sh');
const services = [
  'auth',
  'gateway',
  'indexer',
  'oracle',
  'reconciliation',
  'ricardian',
  'treasury',
];

function fixtureManifest(changedService) {
  return services
    .flatMap((service) => {
      const tableHash = sha256(
        service === changedService ? `changed-${service}` : `table-${service}`,
      );
      const sequenceHash = sha256(`sequence-${service}`);
      const migrationTable = service === 'indexer' ? 'migrations' : 'cotsel_schema_migrations';
      const tableRecord = `DATABASE_RECOVERY_TABLE service=${service} database=cotsel_${service} schema=public table=${migrationTable} exact_rows=1 data_sha256=${tableHash}`;
      const sequenceRecord = `DATABASE_RECOVERY_SEQUENCE service=${service} database=cotsel_${service} schema=public sequence=fixture_id_seq state_sha256=${sequenceHash}`;
      const dataHash = sha256(`${[tableRecord, sequenceRecord].sort().join('\n')}\n`);
      return [
        tableRecord,
        sequenceRecord,
        `DATABASE_RECOVERY_SUMMARY service=${service} database=cotsel_${service} server_version=160013 tables=1 sequences=1 exact_rows=1 migration_tables=1 schema_sha256=${sha256(`schema-${service}`)} access_sha256=${sha256(`access-${service}`)} data_sha256=${dataHash}`,
      ];
    })
    .join('\n');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('manifest comparison accepts matching records for all seven databases', () => {
  const source = parseManifest(fixtureManifest(), 'source');
  const target = parseManifest(fixtureManifest(), 'target');
  assert.deepEqual(compareManifests(source, target), []);
});

test('manifest comparison reports a changed restored table without row data', () => {
  const source = parseManifest(fixtureManifest(), 'source');
  const target = parseManifest(fixtureManifest('gateway'), 'target');
  const differences = compareManifests(source, target);
  assert.equal(differences.length, 2);
  assert.equal(differences[0].result, 'mismatch');
  assert.ok(
    differences.every((difference) => !JSON.stringify(difference).includes('fixture-value')),
  );
});

test('manifest parser rejects malformed hashes', () => {
  assert.throws(
    () => parseManifest(fixtureManifest().replace(/[a-f0-9]{64}/, 'not-a-sha256'), 'source'),
    /invalid data_sha256/,
  );
});

test('manifest parser rejects inconsistent summary counts', () => {
  assert.throws(
    () => parseManifest(fixtureManifest().replace('tables=1', 'tables=2'), 'source'),
    /inconsistent auth tables summary/,
  );
});

test('manifest parser rejects a summary hash not derived from its records', () => {
  const invalidHash = '0'.repeat(64);
  assert.throws(
    () =>
      parseManifest(
        fixtureManifest().replace(
          /(migration_tables=1[^\n]*data_sha256=)[a-f0-9]{64}/,
          `$1${invalidHash}`,
        ),
        'source',
      ),
    /inconsistent auth data_sha256 summary/,
  );
});

test('manifest parser requires a migration ledger for every database', () => {
  assert.throws(
    () =>
      parseManifest(
        fixtureManifest().replace('table=cotsel_schema_migrations', 'table=projection'),
        'source',
      ),
    /missing the expected migration ledger for auth/,
  );
});

test('manifest parser requires the canonical migration ledger name', () => {
  assert.throws(
    () =>
      parseManifest(
        fixtureManifest().replace('table=cotsel_schema_migrations', 'table=legacy_migrations'),
        'source',
      ),
    /missing the expected migration ledger for auth/,
  );
});

test('manifest collection emits redacted exact-count evidence for all seven databases', async () => {
  const mockDirectory = await mkdtemp(path.join(tmpdir(), 'cotsel-recovery-manifest-'));
  const mockPsql = `#!/bin/sh
arguments="$*"
input="$(cat)"
case "$arguments $input" in
  *current_setting*) printf '%s\\n' '160013' ;;
  *'SELECT record_type'*) printf '%s\\n' 'current_role|fixture_runtime|login=true,superuser=false' ;;
  *"relkind = 'S'"*) printf '%s\\n' 'public|fixture_id_seq|public|fixture_id_seq' ;;
  *quote_ident*) printf '%s\\n' 'public|fixture|public|fixture' ;;
  *'SELECT last_value'*) printf '%s\\n' '1|true' ;;
  *'SELECT count(*)'*) printf '%s\\n' '1' ;;
  *'COPY ('*) printf '%s\\n' '{"id":1}' ;;
  *) printf 'unexpected psql call: %s\\n' "$arguments" >&2; exit 2 ;;
esac
`;
  const mockPgDump = `#!/bin/sh
printf '%s\\n' 'CREATE TABLE public.fixture (id bigint);'
`;
  const mockWget = `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-O' ]; then output="$2"; shift 2; else shift; fi
done
printf '%s\\n' 'fixture-ca' >"$output"
`;
  const mockSha256sum = `#!/bin/sh
case "\${1:-}" in
  -c) cat >/dev/null; exit 0 ;;
esac
shasum -a 256
`;

  await Promise.all(
    [
      ['psql', mockPsql],
      ['pg_dump', mockPgDump],
      ['wget', mockWget],
      ['sha256sum', mockSha256sum],
    ].map(async ([name, contents]) => {
      const executable = path.join(mockDirectory, name);
      await writeFile(executable, contents, 'utf8');
      await chmod(executable, 0o755);
    }),
  );

  const secretMarker = 'must-not-appear';
  const environment = {
    ...process.env,
    PATH: `${mockDirectory}:${process.env.PATH}`,
    COTSEL_POSTGRES_HOST: 'restored.internal',
  };
  for (const service of services) {
    environment[`${service.toUpperCase()}_RUNTIME_USERNAME`] = `${service}_runtime`;
    environment[`${service.toUpperCase()}_RUNTIME_PASSWORD`] = secretMarker;
  }

  const result = spawnSync(manifestScript, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(secretMarker), false);
  assert.equal(result.stdout.includes('restored.internal'), false);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_TABLE/g) ?? []).length, 7);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_SEQUENCE/g) ?? []).length, 7);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_SUMMARY/g) ?? []).length, 7);
  assert.match(result.stdout, /Cotsel recovery manifest collection passed/);
});

test('Terraform registers exact verifier commands with only a non-secret target-host override', async () => {
  const terraformRoot = path.join(repoRoot, 'infra', 'terraform', 'staging-platform');
  const [parity, entitlement] = await Promise.all([
    readFile(path.join(terraformRoot, 'database-parity-verification.tf'), 'utf8'),
    readFile(path.join(terraformRoot, 'database-entitlement-verification.tf'), 'utf8'),
  ]);

  assert.match(
    parity,
    /file\("\$\{path\.module\}\/\.\.\/\.\.\/\.\.\/scripts\/postgres-recovery-manifest\.sh"\)/,
  );
  assert.match(parity, /name = "COTSEL_POSTGRES_HOST", value = local\.postgres_host/);
  assert.doesNotMatch(parity, /task_role_arn/);
  assert.match(
    entitlement,
    /:\s+"\$\$\{COTSEL_POSTGRES_HOST:\?COTSEL_POSTGRES_HOST is required\}"/,
  );
  assert.match(entitlement, /name = "COTSEL_POSTGRES_HOST", value = local\.postgres_host/);
});
