import fs from 'fs';
import path from 'path';
import { createMigrationPool } from './connection';

export async function runMigrations(): Promise<void> {
  const migrationPool = createMigrationPool();
  const candidates = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(__dirname, '../../src/database/schema.sql'),
    path.resolve(process.cwd(), 'src/database/schema.sql'),
  ];

  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!schemaPath) {
    throw new Error('Unable to locate ricardian schema.sql');
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  try {
    await migrationPool.query(sql);
  } finally {
    await migrationPool.end();
  }
}
