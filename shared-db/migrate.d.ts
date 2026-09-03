import type { Pool } from 'pg';

export interface MigrationHistoryCheck {
  pool: Pool;
  serviceName: string;
  manifestPath: string;
}

export function assertMigrationHistory(input: MigrationHistoryCheck): Promise<void>;

export interface VersionedMigrationInput extends MigrationHistoryCheck {
  runtimeDbUser: string;
  lockTimeoutMs?: number | string;
  statementTimeoutMs?: number | string;
}

export function runVersionedMigrations(input: VersionedMigrationInput): Promise<unknown>;
