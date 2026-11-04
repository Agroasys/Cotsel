import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../staging-platform/database-entitlement-verification.tf', import.meta.url),
  'utf8',
);
const functions = source.match(
  / {4}verify_restricted_role\(\) \{[\s\S]*?(?= {4}verify_indexer\(\))/,
)?.[0];
assert.ok(functions, 'database verification functions are missing');

test('negative connection checks do not change the service database for subsequent checks', () => {
  const shell = `set -eu
psql() {
  case "$PGUSER:$2" in
    migrator:cotsel_ricardian|runtime:cotsel_ricardian) ;;
    *) return 1 ;;
  esac
  case " $* " in
    *" --tuples-only "*) echo 1 ;;
    *" -c "*) return 0 ;;
    *) [ "$PGUSER" = migrator ] ;;
  esac
}
${functions.replace(/^ {4}/gm, '').replaceAll('$${', '${')}
verify_service cotsel_ricardian cotsel_treasury migrator test runtime test
`;
  const result = spawnSync('sh', ['-ec', shell], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
