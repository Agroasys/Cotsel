import { closeConnection, testConnection } from './database/connection';
import { Logger } from './utils/logger';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runHealthcheck(): Promise<void> {
  try {
    await testConnection();
    Logger.info('Reconciliation healthcheck passed');
    await closeConnection();
    process.exit(0);
  } catch (error: unknown) {
    Logger.error('Reconciliation healthcheck failed', {
      error: getErrorMessage(error),
    });

    await closeConnection();
    process.exit(1);
  }
}

void runHealthcheck();
