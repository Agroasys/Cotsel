/**
 * Applies a valid reconciliation configuration to `process.env` on import.
 *
 * `src/config.ts` validates and freezes the configuration at module load, and
 * `src/database/connection.ts` builds the pool from it, so any test that
 * imports a database module transitively loads the config before a single test
 * body runs. Importing this module *first* is what makes that load succeed.
 *
 * The values are deliberately unreachable placeholders: a test that uses them
 * to reach the network should fail loudly rather than hit a real endpoint. A
 * Postgres test overrides the DB values and passes its own pool explicitly.
 */
export const BASE_TEST_ENV: Record<string, string> = {
  RECONCILIATION_ENABLED: 'true',
  RECONCILIATION_DAEMON_INTERVAL_MS: '60000',
  RECONCILIATION_BATCH_SIZE: '100',
  RECONCILIATION_MAX_TRADES_PER_RUN: '1000',
  RECONCILIATION_LEASE_TTL_MS: '60000',
  RECONCILIATION_LEASE_HEARTBEAT_MS: '10000',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_reconciliation',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL_MODE: 'disable',
  RPC_URL: 'http://127.0.0.1:8545',
  CHAIN_ID: '31337',
  ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  USDC_ADDRESS: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  INDEXER_GRAPHQL_URL: 'http://127.0.0.1:4350/graphql',
  RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL: 'false',
  NOTIFICATIONS_ENABLED: 'false',
  NOTIFICATIONS_COOLDOWN_MS: '300000',
  NOTIFICATIONS_REQUEST_TIMEOUT_MS: '5000',
};

for (const [key, value] of Object.entries(BASE_TEST_ENV)) {
  process.env[key] ??= value;
}
