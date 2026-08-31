import { SessionService } from '../src/core/sessionService';
import { SessionController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';
import { AdminController } from '../src/api/adminController';
import express from 'express';

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function listRoutes(router: ReturnType<typeof createRouter>): string[] {
  const layers = (router as typeof router & { stack: RouterLayer[] }).stack;
  return layers
    .filter((layer) => Boolean(layer.route))
    .flatMap((layer) => {
      const route = layer.route! as unknown as {
        path: string;
        methods: Record<string, boolean>;
      };
      return Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${route.path}`);
    });
}

function createSessionController(): SessionController {
  return {
    exchangeTrustedSession: jest.fn(),
    getSession: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn(),
  } as unknown as SessionController;
}

function createAdminController(): AdminController {
  return {
    listAuthorityProfiles: jest.fn(),
    listAuditEvents: jest.fn(),
    provision: jest.fn(),
    deactivate: jest.fn(),
    grantBreakGlass: jest.fn(),
    revokeBreakGlass: jest.fn(),
    reviewBreakGlass: jest.fn(),
  } as unknown as AdminController;
}

describe('auth router', () => {
  const sessionService = {
    resolve: jest.fn(),
  } as unknown as SessionService;

  test('does not mount session exchange route when disabled', () => {
    const router = createRouter(createSessionController(), sessionService);

    expect(listRoutes(router)).not.toContain('POST /session/exchange/agroasys');
  });

  test('readiness fails closed without a configured database check', async () => {
    const app = express();
    app.use(createRouter(createSessionController(), sessionService));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not expose a TCP port');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ ready: false });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('readiness succeeds only after its database check succeeds', async () => {
    const readinessCheck = jest.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(createRouter(createSessionController(), sessionService, { readinessCheck }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not expose a TCP port');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
      expect(response.status).toBe(200);
      expect(readinessCheck).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('mounts session exchange route when enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      trustedSessionExchangeMiddleware: jest.fn(),
    });

    expect(listRoutes(router)).toContain('POST /session/exchange/agroasys');
  });

  test('mounts admin control routes when admin controls are enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      adminController: createAdminController(),
      adminControlMiddleware: jest.fn(),
    });

    const routes = listRoutes(router);
    expect(routes).toContain('GET /admin/profiles');
    expect(routes).toContain('GET /admin/audit-events');
    expect(routes).toContain('POST /admin/profiles/provision');
    expect(routes).toContain('POST /admin/profiles/deactivate');
    expect(routes).toContain('POST /admin/break-glass/grant');
    expect(routes).toContain('POST /admin/break-glass/revoke');
    expect(routes).toContain('POST /admin/break-glass/review');
    expect(routes).not.toContain('POST /admin/signers/provision');
    expect(routes).not.toContain('POST /admin/signers/revoke');
  });
});
