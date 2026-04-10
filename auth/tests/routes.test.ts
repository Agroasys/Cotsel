import { createRouter } from '../src/api/routes';

function listRoutes(router: ReturnType<typeof createRouter>): string[] {
  return (router as any).stack
    .filter((layer: any) => layer.route)
    .flatMap((layer: any) =>
      Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`),
    );
}

function createSessionController() {
  return {
    exchangeTrustedSession: jest.fn(),
    getSession: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn(),
  } as any;
}

function createLegacyWalletController() {
  return {
    getChallenge: jest.fn(),
    login: jest.fn(),
  } as any;
}

describe('auth router', () => {
  const sessionService = {
    resolve: jest.fn(),
  } as any;

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
