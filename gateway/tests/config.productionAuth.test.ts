import { loadConfig } from '../src/config/env';
import { withEnv } from './helpers/gatewayConfigTestHarness';

describe('gateway production authentication config', () => {
  test.each(['staging', 'production', 'Staging', ' PRODUCTION '])(
    '%s cannot bypass downstream authentication with a development NODE_ENV',
    (environment) => {
      withEnv({ COTSEL_ENVIRONMENT: environment, NODE_ENV: 'development' }, () => {
        expect(() => loadConfig()).toThrow(
          `NODE_ENV must be production when COTSEL_ENVIRONMENT=${environment.trim().toLowerCase()}`,
        );
      });
    },
  );

  test('cannot explicitly enable insecure downstream authentication', () => {
    const snapshot = { ...process.env };
    process.env = {
      ...snapshot,
      NODE_ENV: 'production',
      PORT: '3600',
      DB_HOST: 'localhost',
      DB_NAME: 'gateway',
      DB_USER: 'gateway',
      DB_PASSWORD: 'test-password',
      GATEWAY_AUTH_BASE_URL: 'http://auth:3005',
      GATEWAY_INDEXER_GRAPHQL_URL: 'http://indexer:4350/graphql',
      GATEWAY_SETTLEMENT_RUNTIME: 'base-sepolia',
      GATEWAY_ESCROW_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH: 'true',
    };

    try {
      expect(() => loadConfig()).toThrow(
        'GATEWAY_ALLOW_INSECURE_DOWNSTREAM_AUTH=true is not allowed when NODE_ENV=production',
      );
    } finally {
      process.env = snapshot;
    }
  });
});
