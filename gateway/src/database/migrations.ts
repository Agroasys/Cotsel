/**
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  const candidates = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(__dirname, '../../src/database/schema.sql'),
    path.resolve(process.cwd(), 'gateway/src/database/schema.sql'),
    path.resolve(process.cwd(), 'src/database/schema.sql'),
  ];

  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!schemaPath) {
    throw new Error('Unable to locate gateway schema.sql');
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
