import type { Pool } from 'pg';

export interface MigrationHistoryCheck {
  pool: Pool;
  serviceName: string;
  manifestPath: string;
}

export function assertMigrationHistory(input: MigrationHistoryCheck): Promise<void>;
