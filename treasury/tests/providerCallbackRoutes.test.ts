/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * WP-4 H-16: the routes that accept external provider evidence are wired behind
 * provider-signature verification, and the routes that do not are left alone.
 */
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProviderCallbackMiddleware } from '../src/auth/providerCallback';
import { signProviderCallback, type ProviderWebhookSecret } from '../src/core/providerCallbackAuth';
import { createRouter } from '../src/api/routes';
import type { TreasuryController } from '../src/api/controller';

const SECRET = 'bridge-webhook-secret-value-that-is-long-enough';
const NOW = 1_800_000_000;
const secrets: ProviderWebhookSecret[] = [
  { partnerCode: 'bridge', keyId: 'bridge-live', secret: SECRET },
];

/**
 * `createRouter` binds every controller method, so the stub answers for any
 * name. Each handler echoes the verified provider context the middleware
 * attached, which is what these cases assert on.
 */
function stubController(): TreasuryController {
  const handlers = new Map<string, unknown>();

  return new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      if (!handlers.has(property)) {
        handlers.set(property, (req: Request, res: Response) => {
          res.status(200).json({
            success: true,
            route: property,
            providerCallback: (req as Request & { providerCallback?: unknown }).providerCallback,
          });
        });
      }

      return handlers.get(property);
    },
  }) as unknown as TreasuryController;
}

describe('treasury provider callback routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use(
      '/api/treasury/v1',
      createRouter(stubController(), {
        providerCallbackMiddleware: createProviderCallbackMiddleware({
          enabled: true,
          secrets,
          maxSkewSeconds: 300,
          resolvePartnerCode: (req) =>
            (req.body as { partnerCode?: string } | undefined)?.partnerCode ??
            req.header('x-webhook-partner') ??
            undefined,
          resolveBodyEventId: (req) =>
            (req.body as { providerEventId?: string } | undefined)?.providerEventId,
          nowSeconds: () => NOW,
        }),
      }),
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
    options: { sign?: boolean; headers?: Record<string, string> } = {},
  ) {
    const raw = Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.sign === false
        ? {}
        : { 'x-webhook-signature': `t=${NOW},v1=${signProviderCallback(SECRET, NOW, raw)}` }),
      ...(options.headers ?? {}),
    };

    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: raw });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const evidencePath = '/api/treasury/v1/internal/entries/11/partner-handoff/evidence';
  const depositsPath = '/api/treasury/v1/internal/deposits';
  const evidenceBody = { partnerCode: 'bridge', providerEventId: 'evt-1', eventType: 'payout' };

  it('accepts partner evidence the provider signed and exposes the verified context', async () => {
    const result = await post(evidencePath, evidenceBody);

    expect(result.status).toBe(200);
    expect(result.json.providerCallback).toEqual({
      partnerCode: 'bridge',
      keyId: 'bridge-live',
      eventId: 'evt-1',
      timestampSeconds: NOW,
    });
  });

  it('rejects partner evidence that arrives unsigned', async () => {
    const result = await post(evidencePath, evidenceBody, { sign: false });

    expect(result.status).toBe(401);
    expect(result.json.code).toBe('PROVIDER_SIGNATURE_MISSING');
  });

  it('rejects partner evidence whose body changed after signing', async () => {
    const raw = Buffer.from(JSON.stringify(evidenceBody));
    const response = await fetch(`${baseUrl}${evidencePath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': `t=${NOW},v1=${signProviderCallback(SECRET, NOW, raw)}`,
      },
      body: JSON.stringify({ ...evidenceBody, partnerStatus: 'COMPLETED' }),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('PROVIDER_SIGNATURE_INVALID');
  });

  it('identifies the fiat ramp from the delivery header when the body names no partner', async () => {
    const rampSecrets: ProviderWebhookSecret[] = [
      { partnerCode: 'ramp', keyId: 'ramp-live', secret: SECRET },
    ];
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use(
      '/api/treasury/v1',
      createRouter(stubController(), {
        providerCallbackMiddleware: createProviderCallbackMiddleware({
          enabled: true,
          secrets: rampSecrets,
          maxSkewSeconds: 300,
          resolvePartnerCode: (req) => req.header('x-webhook-partner') ?? undefined,
          resolveBodyEventId: (req) =>
            (req.body as { providerEventId?: string } | undefined)?.providerEventId,
          nowSeconds: () => NOW,
        }),
      }),
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const accepted = await post(
      depositsPath,
      { providerEventId: 'ramp-evt-1', rampReference: 'ramp-1' },
      { headers: { 'x-webhook-partner': 'ramp' } },
    );
    expect(accepted.status).toBe(200);

    const unidentified = await post(depositsPath, {
      providerEventId: 'ramp-evt-2',
      rampReference: 'ramp-2',
    });
    expect(unidentified.status).toBe(401);
    expect(unidentified.json.code).toBe('PROVIDER_UNKNOWN_PARTNER');
  });

  it('leaves operator-initiated treasury transitions on internal authentication alone', async () => {
    const result = await post(
      '/api/treasury/v1/internal/sweep-batches/7/approve',
      { metadata: {} },
      { sign: false },
    );

    expect(result.status).toBe(200);
    expect(result.json.route).toBe('approveSweepBatch');
    expect(result.json.providerCallback).toBeUndefined();
  });
});
