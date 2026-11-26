import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const fixturePassword = 'fixture-password-must-not-appear';
const fixtureRowValue = 'fixture-row-must-not-appear';
const fixtureRow = JSON.stringify({ private: fixtureRowValue });
const fixtureError = 'fixture-database-error-must-not-appear';
const fixtureSchema = 'CREATE TABLE public.fixture (id bigint);';

async function manifestCollectionFixture(t) {
  const mockDirectory = await mkdtemp(path.join(tmpdir(), 'cotsel-recovery-manifest-'));
  t.after(() => rm(mockDirectory, { recursive: true, force: true }));
  const failIfRequested = `
fail_if_requested() {
  if [ "$FAILED_VERIFIER_STEP" = "$1" ]; then
    printf '%s\\n' '${fixtureError}' >&2
    exit 2
  fi
}
`;
  const mockPsql = `#!/bin/sh
${failIfRequested}
arguments="$*"
input="$(cat)"
case "$arguments $input" in
  *current_setting*) printf '%s\\n' '160013' ;;
  *'SELECT record_type'*) printf '%s\\n' 'current_role|fixture_runtime|login=true,superuser=false'; fail_if_requested access ;;
  *"relkind = 'S'"*) printf '%s\\n' 'public|fixture_id_seq|public|fixture_id_seq' ;;
  *quote_ident*)
    case "$arguments" in
      *cotsel_indexer*) printf '%s\\n' 'public|migrations|public|migrations' ;;
      *) printf '%s\\n' 'public|cotsel_schema_migrations|public|cotsel_schema_migrations' ;;
    esac
    ;;
  *'SELECT last_value'*) printf '%s\\n' '1|true'; fail_if_requested sequence ;;
  *'SELECT count(*)'*) printf '%s\\n' '1' ;;
  *'COPY ('*) printf '%s\\n' '${fixtureRow}'; fail_if_requested rows ;;
  *) printf 'unexpected psql call: %s\\n' "$arguments" >&2; exit 2 ;;
esac
`;
  const mockPgDump = `#!/bin/sh
${failIfRequested}
if [ "$VERIFY_SCHEMA_SCOPE" = '1' ]; then
  schemas=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --schema=*) schemas="$schemas \${1#*=}" ;;
      --schema|-n) shift; schemas="$schemas $1" ;;
    esac
    shift
  done
  case "$schemas" in
    ' public squid_processor'|' squid_processor public') ;;
    *) printf '%s\\n' 'permission denied for schema cotsel_adoption' >&2; exit 2 ;;
  esac
fi
printf '%s\\n' '${fixtureSchema}'
fail_if_requested schema
`;
  const mockSort = `#!/bin/sh
${failIfRequested}
command -p sort "$@" || exit $?
fail_if_requested sort
`;
  const mockWget = `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-O' ]; then output="$2"; shift 2; else shift; fi
done
printf '%s\\n' 'fixture-ca' >"$output"
`;
  const mockSha256sum = `#!/bin/sh
${failIfRequested}
case "\${1:-}" in
  -c) cat >/dev/null; exit 0 ;;
esac
shasum -a 256 || exit $?
fail_if_requested sha256
`;

  await Promise.all(
    [
      ['psql', mockPsql],
      ['pg_dump', mockPgDump],
      ['sort', mockSort],
      ['wget', mockWget],
      ['sha256sum', mockSha256sum],
    ].map(async ([name, contents]) => {
      const executable = path.join(mockDirectory, name);
      await writeFile(executable, contents, 'utf8');
      await chmod(executable, 0o755);
    }),
  );

  const environment = {
    ...process.env,
    PATH: `${mockDirectory}:${process.env.PATH}`,
    COTSEL_POSTGRES_HOST: 'restored.internal',
    TMPDIR: mockDirectory,
  };
  for (const service of services) {
    environment[`${service.toUpperCase()}_RUNTIME_USERNAME`] = `${service}_runtime`;
    environment[`${service.toUpperCase()}_RUNTIME_PASSWORD`] = fixturePassword;
  }

  return ({ failure = '', verifySchemaScope = false } = {}) =>
    spawnSync(manifestScript, [], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...environment,
        FAILED_VERIFIER_STEP: failure,
        VERIFY_SCHEMA_SCOPE: verifySchemaScope ? '1' : '',
      },
    });
}

function assertRedacted({ stdout, stderr }) {
  const output = stdout + stderr;
  for (const privateValue of [
    fixturePassword,
    fixtureRowValue,
    fixtureError,
    'restored.internal',
  ]) {
    assert.equal(output.includes(privateValue), false);
  }
}

test('manifest collection emits scoped redacted evidence for all seven databases', async (t) => {
  const runManifest = await manifestCollectionFixture(t);
  const result = runManifest({ verifySchemaScope: true });
  assert.equal(result.status, 0, result.stderr);
  assertRedacted(result);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_TABLE/g) ?? []).length, 7);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_SEQUENCE/g) ?? []).length, 7);
  assert.equal((result.stdout.match(/DATABASE_RECOVERY_SUMMARY/g) ?? []).length, 7);
  assert.equal(result.stdout.split(`schema_sha256=${sha256(`${fixtureSchema}\n`)}`).length - 1, 7);
  assert.equal(result.stdout.split(`data_sha256=${sha256(`${fixtureRow}\n`)}`).length - 1, 7);
  assert.equal(result.stdout.split(`state_sha256=${sha256('1|true\n')}`).length - 1, 7);
  assert.match(result.stdout, /Cotsel recovery manifest collection passed/);
  assert.doesNotThrow(() => parseManifest(result.stdout, 'collector'));
});

test('manifest collection rejects incomplete or failed fingerprint streams', async (t) => {
  const runManifest = await manifestCollectionFixture(t);
  for (const failure of ['schema', 'access', 'rows', 'sequence', 'sort', 'sha256']) {
    await t.test(failure, () => {
      const result = runManifest({ failure });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /DATABASE_RECOVERY_SUMMARY|collection passed/);
      assert.match(result.stderr, /Database recovery verification failed for service auth/);
      assertRedacted(result);
    });
  }
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
