import { SessionService } from '../src/core/sessionService';
import { LegacyWalletAuthController, SessionController } from '../src/api/controller';
import { createRouter } from '../src/api/routes';

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function listRoutes(router: ReturnType<typeof createRouter>): string[] {
  const layers = (router as typeof router & { stack: RouterLayer[] }).stack;
  return layers
    .filter((layer): layer is RouterLayer & { route: NonNullable<RouterLayer['route']> } =>
      Boolean(layer.route),
    )
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map(
        (method) => `${method.toUpperCase()} ${layer.route.path}`,
      ),
    );
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
});
