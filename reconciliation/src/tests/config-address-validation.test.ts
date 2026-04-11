import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const BASE_ENV: Record<string, string> = {
  RECONCILIATION_ENABLED: 'true',
  RECONCILIATION_DAEMON_INTERVAL_MS: '60000',
  RECONCILIATION_BATCH_SIZE: '100',
  RECONCILIATION_MAX_TRADES_PER_RUN: '1000',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'agroasys_reconciliation',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_MIGRATION_USER: '',
  DB_MIGRATION_PASSWORD: '',
  RPC_URL: 'http://127.0.0.1:8545',
  CHAIN_ID: '31337',
  ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  USDC_ADDRESS: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  INDEXER_GRAPHQL_URL: 'http://127.0.0.1:4350/graphql',
  RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL: 'false',
  NOTIFICATIONS_ENABLED: 'false',
  NOTIFICATIONS_WEBHOOK_URL: '',
  NOTIFICATIONS_COOLDOWN_MS: '300000',
  NOTIFICATIONS_REQUEST_TIMEOUT_MS: '5000',
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = { ...process.env };

  for (const key of Object.keys(BASE_ENV)) {
    delete process.env[key];
  }

  Object.assign(process.env, BASE_ENV);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    process.env = snapshot;
  }
}

function loadConfigModule(): typeof import('../config') {
  const modulePath = path.resolve(__dirname, '../config');
  const resolvedPath = require.resolve(modulePath);
  delete require.cache[resolvedPath];
  return require(resolvedPath) as typeof import('../config');
}

test('invalid address in config fails with explicit field-level error', () => {
  withEnv({ ESCROW_ADDRESS: 'invalid-address' }, () => {
    assert.throws(
      () => loadConfigModule(),
      /ESCROW_ADDRESS must be a valid EVM address, received "invalid-address"/,
    );
  });
});

test('valid lowercase config addresses are normalized and accepted', () => {
  withEnv({}, () => {
    const { loadConfig } = loadConfigModule();
    const config = loadConfig();

    assert.equal(config.escrowAddress, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    assert.equal(config.usdcAddress, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });
});

test('missing INDEXER_GRAPHQL_URL fails with explicit config error', () => {
  withEnv({ INDEXER_GRAPHQL_URL: undefined }, () => {
    assert.throws(() => loadConfigModule(), /INDEXER_GRAPHQL_URL is missing/);
  });
});

test('malformed RPC_URL fails with explicit config error', () => {
  withEnv({ RPC_URL: 'not-a-url' }, () => {
    assert.throws(() => loadConfigModule(), /RPC_URL must be a valid URL, received "not-a-url"/);
  });
});

test('container-safe indexer URL check rejects localhost when enabled', () => {
  withEnv(
    {
      RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL: 'true',
      INDEXER_GRAPHQL_URL: 'http://localhost:4350/graphql',
    },
    () => {
      assert.throws(
        () => loadConfigModule(),
        /INDEXER_GRAPHQL_URL must not use localhost\/loopback when RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL=true/,
      );
    },
  );
});

test('container-safe indexer URL check allows service DNS names when enabled', () => {
  withEnv(
    {
      RECONCILIATION_REQUIRE_CONTAINER_SAFE_INDEXER_URL: 'true',
      INDEXER_GRAPHQL_URL: 'http://indexer-graphql:4350/graphql',
    },
    () => {
      const { loadConfig } = loadConfigModule();
      const config = loadConfig();
      assert.equal(config.indexerGraphqlUrl, 'http://indexer-graphql:4350/graphql');
      assert.equal(config.enforceContainerSafeIndexerUrl, true);
    },
  );
});

test('migration credentials must be configured as a complete pair', () => {
  withEnv(
    { DB_MIGRATION_USER: 'reconciliation_migrator', DB_MIGRATION_PASSWORD: undefined },
    () => {
      assert.throws(
        () => loadConfigModule(),
        /DB_MIGRATION_USER and DB_MIGRATION_PASSWORD must be set together/,
      );
    },
  );
});
