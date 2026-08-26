'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadMigrationFiles, sha256, validateAppliedHistory } = require('./migrationRunner');

function withMigrationDirectory(files, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cotsel-migrations-'));
  try {
    for (const [filename, sql] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, filename), sql);
    }
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('loadMigrationFiles returns deterministic ordered identities and checksums', () => {
  withMigrationDirectory(
    {
      '0002_add_record.sql': 'ALTER TABLE records ADD COLUMN note TEXT;\n',
      '0001_baseline.sql': 'CREATE TABLE records (id BIGINT PRIMARY KEY);\n',
    },
    (directory) => {
      const migrations = loadMigrationFiles(directory);
      assert.deepEqual(
        migrations.map(({ id, sequence }) => ({ id, sequence })),
        [
          { id: '0001_baseline', sequence: 1 },
          { id: '0002_add_record', sequence: 2 },
        ],
      );
      assert.equal(
        migrations[0].checksum,
        sha256('CREATE TABLE records (id BIGINT PRIMARY KEY);\n'),
      );
    },
  );
});

test('loadMigrationFiles rejects invalid, duplicate, and empty migrations', () => {
  withMigrationDirectory({ 'baseline.sql': 'SELECT 1;\n' }, (directory) => {
    assert.throws(() => loadMigrationFiles(directory), /Invalid migration filename/);
  });
  withMigrationDirectory(
    { '0001_first.sql': 'SELECT 1;\n', '0001_second.sql': 'SELECT 2;\n' },
    (directory) => {
      assert.throws(() => loadMigrationFiles(directory), /Duplicate migration sequence/);
    },
  );
  withMigrationDirectory({ '0001_empty.sql': '  \n' }, (directory) => {
    assert.throws(() => loadMigrationFiles(directory), /is empty/);
  });
  withMigrationDirectory({ '0000_baseline.sql': 'SELECT 1;\n' }, (directory) => {
    assert.throws(() => loadMigrationFiles(directory), /must start at 0001/);
  });
});

test('validateAppliedHistory rejects changed, missing, or non-prefix release history', () => {
  const migrations = [
    { id: '0001_baseline', checksum: 'a'.repeat(64) },
    { id: '0002_add_record', checksum: 'b'.repeat(64) },
  ];

  assert.doesNotThrow(() =>
    validateAppliedHistory(new Map([['0001_baseline', 'a'.repeat(64)]]), migrations),
  );
  assert.throws(
    () => validateAppliedHistory(new Map([['0001_baseline', 'c'.repeat(64)]]), migrations),
    /Checksum mismatch/,
  );
  assert.throws(
    () => validateAppliedHistory(new Map([['0000_removed', 'd'.repeat(64)]]), migrations),
    /missing from the release artifact/,
  );
  assert.throws(
    () => validateAppliedHistory(new Map([['0002_add_record', 'b'.repeat(64)]]), migrations),
    /not a contiguous history prefix/,
  );
});
