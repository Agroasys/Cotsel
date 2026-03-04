/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './connection';
import { Logger } from '../utils/logger';

export async function runMigrations(): Promise<void> {
  try {
    Logger.info('Starting database migrations...');
    const schemaPath = join(__dirname, 'schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf-8');
    await pool.query(schemaSql);
    Logger.info('Database migrations completed successfully');
  } catch (error) {
    Logger.error('Database migration failed', error);
    throw error;
  }
}
