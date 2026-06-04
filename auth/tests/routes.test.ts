import { SessionService } from '../src/core/sessionService';
import { SessionController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';
import { AdminController } from '../src/api/adminController';

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
    provisionSigner: jest.fn(),
    revokeSigner: jest.fn(),
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

  test('mounts session exchange route when enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      trustedSessionExchangeMiddleware: jest.fn(),
    });

    expect(listRoutes(router)).toContain('POST /session/exchange/agroasys');
  });

  test('mounts admin signer routes when admin controls are enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      adminController: createAdminController(),
      adminControlMiddleware: jest.fn(),
    });

    expect(listRoutes(router)).toContain('GET /admin/profiles');
    expect(listRoutes(router)).toContain('GET /admin/audit-events');
    expect(listRoutes(router)).toContain('POST /admin/signers/provision');
    expect(listRoutes(router)).toContain('POST /admin/signers/revoke');
  });
});
