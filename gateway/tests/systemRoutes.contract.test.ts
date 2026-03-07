/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Server } from 'http';
import { createApp } from '../src/app';
import { loadOpenApiSpec } from '../src/openapi/spec';
import { createSchemaValidator, hasOperation } from '../src/openapi/contract';
import type { GatewayConfig } from '../src/config/env';

const config: GatewayConfig = {
  port: 3600,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'agroasys_gateway',
  dbUser: 'postgres',
  dbPassword: 'postgres',
  authBaseUrl: 'http://127.0.0.1:3005',
  authRequestTimeoutMs: 5000,
  enableMutations: false,
  writeAllowlist: [],
  commitSha: 'abc1234',
  buildTime: '2026-03-07T00:00:00.000Z',
  nodeEnv: 'test',
};

async function startServer(readinessCheck: () => Promise<any>) {
  const app = createApp(config, {
    version: '0.1.0',
    commitSha: config.commitSha,
    buildTime: config.buildTime,
    readinessCheck,
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve ephemeral server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/dashboard-gateway/v1`,
  };
}

describe('gateway system routes contract', () => {
  const spec = loadOpenApiSpec();
  const validateHealth = createSchemaValidator(spec, '#/components/schemas/HealthResponse');
  const validateReady = createSchemaValidator(spec, '#/components/schemas/ReadyResponse');
  const validateVersion = createSchemaValidator(spec, '#/components/schemas/VersionResponse');

  test('OpenAPI spec exposes PR-1 system endpoints', () => {
    expect(hasOperation(spec, 'get', '/healthz')).toBe(true);
    expect(hasOperation(spec, 'get', '/readyz')).toBe(true);
    expect(hasOperation(spec, 'get', '/version')).toBe(true);
  });

  test('GET /healthz matches OpenAPI schema and propagates request id', async () => {
    const { server, baseUrl } = await startServer(async () => [{ name: 'postgres', status: 'ok' }]);

    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers: { 'x-request-id': 'req-healthz' },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req-healthz');
      expect(validateHealth(payload)).toBe(true);
    } finally {
      server.close();
    }
  });

  test('GET /readyz returns 200 when dependencies are ready', async () => {
    const { server, baseUrl } = await startServer(async () => [
      { name: 'postgres', status: 'ok' },
      { name: 'auth-service', status: 'ok' },
    ]);

    try {
      const response = await fetch(`${baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateReady(payload)).toBe(true);
      expect(payload.data.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test('GET /readyz returns 503 with dependency detail when a dependency is unavailable', async () => {
    const { server, baseUrl } = await startServer(async () => [
      { name: 'postgres', status: 'ok' },
      { name: 'auth-service', status: 'unavailable', detail: 'connection refused' },
    ]);

    try {
      const response = await fetch(`${baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(validateReady(payload)).toBe(true);
      expect(payload.data.ready).toBe(false);
    } finally {
      server.close();
    }
  });

  test('GET /version matches OpenAPI schema', async () => {
    const { server, baseUrl } = await startServer(async () => [{ name: 'postgres', status: 'ok' }]);

    try {
      const response = await fetch(`${baseUrl}/version`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(validateVersion(payload)).toBe(true);
      expect(payload.data.commitSha).toBe(config.commitSha);
    } finally {
      server.close();
    }
  });
});
