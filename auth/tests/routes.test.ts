import { SessionService } from '../src/core/sessionService';
import { LegacyWalletAuthController, SessionController } from '../src/api/controller';
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

function createLegacyWalletController(): LegacyWalletAuthController {
  return {
    getChallenge: jest.fn(),
    login: jest.fn(),
  } as unknown as LegacyWalletAuthController;
}

function createAdminController(): AdminController {
  return {
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

  test('does not mount legacy wallet routes when disabled', () => {
    const router = createRouter(createSessionController(), sessionService);

    expect(listRoutes(router)).not.toContain('GET /challenge');
    expect(listRoutes(router)).not.toContain('POST /login');
  });

  test('mounts legacy wallet routes when explicitly enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      legacyWalletController: createLegacyWalletController(),
    });

    expect(listRoutes(router)).toContain('GET /challenge');
    expect(listRoutes(router)).toContain('POST /login');
  });

  test('mounts admin signer routes when admin controls are enabled', () => {
    const router = createRouter(createSessionController(), sessionService, {
      adminController: createAdminController(),
      adminControlMiddleware: jest.fn(),
    });

    expect(listRoutes(router)).toContain('POST /admin/signers/provision');
    expect(listRoutes(router)).toContain('POST /admin/signers/revoke');
  });
});
