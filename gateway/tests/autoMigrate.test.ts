/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { shouldAutoMigrateDatabase } from '@agroasys/shared-db';
import { migrateGatewayDatabaseIfEnabled } from '../src/database/autoMigrate';
import { closeConnection, createPool } from '../src/database';
import { runMigrations } from '../src/database/migrations';
import { GatewayConfig } from '../src/config/env';

jest.mock('@agroasys/shared-db', () => ({
  shouldAutoMigrateDatabase: jest.fn(),
}));
jest.mock('../src/database', () => ({
  closeConnection: jest.fn(),
  createPool: jest.fn(),
}));
jest.mock('../src/database/migrations', () => ({
  runMigrations: jest.fn(),
}));
jest.mock('../src/logging/logger', () => ({
  Logger: { info: jest.fn() },
}));

const config = {} as GatewayConfig;
const migrationPool = {} as ReturnType<typeof createPool>;
const shouldAutoMigrate = jest.mocked(shouldAutoMigrateDatabase);
const createMigrationPool = jest.mocked(createPool);
const migrate = jest.mocked(runMigrations);
const closeMigrationPool = jest.mocked(closeConnection);

describe('migrateGatewayDatabaseIfEnabled', () => {
  test('does not create a privileged pool when auto-migration is disabled', async () => {
    shouldAutoMigrate.mockReturnValue(false);

    await migrateGatewayDatabaseIfEnabled(config);

    expect(createMigrationPool).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  test('uses a dedicated migration pool and closes it after success', async () => {
    shouldAutoMigrate.mockReturnValue(true);
    createMigrationPool.mockReturnValue(migrationPool);
    migrate.mockResolvedValue();
    closeMigrationPool.mockResolvedValue();

    await migrateGatewayDatabaseIfEnabled(config);

    expect(createMigrationPool).toHaveBeenCalledWith(config, 'migration');
    expect(migrate).toHaveBeenCalledWith(migrationPool);
    expect(closeMigrationPool).toHaveBeenCalledWith(migrationPool);
  });

  test('closes the migration pool when migration fails', async () => {
    const migrationFailure = new Error('migration failed');
    shouldAutoMigrate.mockReturnValue(true);
    createMigrationPool.mockReturnValue(migrationPool);
    migrate.mockRejectedValue(migrationFailure);
    closeMigrationPool.mockResolvedValue();

    await expect(migrateGatewayDatabaseIfEnabled(config)).rejects.toThrow(migrationFailure);
    expect(closeMigrationPool).toHaveBeenCalledWith(migrationPool);
  });
});
