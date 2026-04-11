import fs from 'fs';
import path from 'path';
import { createMigrationPool } from './connection';

export async function runMigrations(): Promise<void> {
  const candidates = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(__dirname, '../../src/database/schema.sql'),
    path.resolve(process.cwd(), 'src/database/schema.sql'),
  ];

  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!schemaPath) {
    throw new Error('Unable to locate reconciliation schema.sql');
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const migrationPool = createMigrationPool();

  try {
    await migrationPool.query(sql);
  } finally {
    await migrationPool.end();
  }
}
